import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentExecutor, type AgentSink } from "../src/agent/executor";
import type { AgentErrorInfo } from "../src/agent/protocol";
import {
  type AgentSelf,
  AgentScope,
  freshScope,
  loadScope,
  OWNER_LABEL,
  SCOPE_FILE,
  saveScope,
  type ScopeRecord,
} from "../src/agent/scope";
import { type ServedRuntime, scopedRuntime } from "../src/agent/scoped-runtime";
import { containerIdsIn, findSelf } from "../src/agent/self";
import { setLogSink } from "../src/lib/logger";
import { RuntimeError, type RuntimeErrorKind } from "../src/runtime";
import { FakeRuntime } from "./support/fake-runtime";

const HOST = "edge";
const PREFIX = "mbtest";
const IMAGE = "alpine:3.20";
const MINE = { [OWNER_LABEL]: HOST };
/** What an engine holds that was never MiniBox's: no label at all, or one that names another host. */
const NOT_MINE = {};
const OTHER_HOST = { [OWNER_LABEL]: "other-host" };

let scratch: string;
let restoreLog: () => void;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "minibox-agent-scope-"));
  restoreLog = setLogSink(() => {});
});

afterEach(() => {
  restoreLog();
  rmSync(scratch, { recursive: true, force: true });
});

interface Setup {
  readonly runtime: FakeRuntime;
  readonly scope: AgentScope;
  readonly scoped: ServedRuntime;
}

/** An engine, a scope over it and the engine behind that scope. `record` null is an agent with no scope file, as one
 * paired before scopes existed. */
function setup(
  options: {
    record?: ScopeRecord | null;
    self?: AgentSelf | null;
    allowedRuntimes?: string[];
  } = {},
): Setup {
  const runtime = new FakeRuntime();
  runtime.seedImage(IMAGE);
  const scope = new AgentScope({
    hostId: HOST,
    dataDir: scratch,
    runtime,
    record: options.record === undefined ? freshScope(HOST) : options.record,
    findSelf: async () => options.self ?? null,
  });
  return { runtime, scope, scoped: scopedRuntime(runtime, scope, { allowedRuntimes: options.allowedRuntimes }) };
}

const container = (runtime: FakeRuntime, name: string, labels: Record<string, string>) =>
  runtime.seedContainer({ image: IMAGE, name, running: true, labels });

/** Waits until `condition` holds, for a stream that subscribes after its first await, or a consumer that has to catch up. */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(1);
  }
}

/** The network the control plane puts every box on, made through the agent as it would be, so it is MiniBox's. */
const BOX_NETWORK = "mbtest-boxes";
const boxNetwork = async (scoped: ServedRuntime): Promise<{ network: string }> => {
  await scoped.ensureBridgeNetwork(BOX_NETWORK, { interContainerComm: false });
  return { network: BOX_NETWORK };
};

const refusedAs = async (promise: Promise<unknown>, kind: RuntimeErrorKind): Promise<void> => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RuntimeError);
  expect((error as RuntimeError).kind).toBe(kind);
};

/** The calls that change the engine, so a test can say none was made. */
const MUTATING = [
  "createContainer",
  "startContainer",
  "stopContainer",
  "restartContainer",
  "pauseContainer",
  "unpauseContainer",
  "removeContainer",
  "renameContainer",
  "updateContainer",
  "startExec",
  "createVolume",
  "removeVolume",
  "setVolumeRootOwner",
  "ensureBridgeNetwork",
  "removeNetwork",
  "connectNetwork",
  "reattachNetwork",
] as const;

const mutations = (runtime: FakeRuntime) => runtime.ops().filter((op) => (MUTATING as readonly string[]).includes(op));

/** The first item of a stream, or nothing once the stream has ended. */
const firstOf = (stream: AsyncIterable<string>) => stream[Symbol.asyncIterator]().next();

/** Every operation that names a container, with the call that makes it. */
const CONTAINER_OPERATIONS: Array<[string, (rt: ServedRuntime, id: string) => Promise<unknown>]> = [
  ["inspectContainer", (rt, id) => rt.inspectContainer(id)],
  ["inspectEnv", (rt, id) => rt.inspectEnv(id)],
  ["startContainer", (rt, id) => rt.startContainer(id)],
  ["stopContainer", (rt, id) => rt.stopContainer(id, { timeoutSec: 1 })],
  ["restartContainer", (rt, id) => rt.restartContainer(id, { timeoutSec: 1 })],
  ["pauseContainer", (rt, id) => rt.pauseContainer(id)],
  ["unpauseContainer", (rt, id) => rt.unpauseContainer(id)],
  ["removeContainer", (rt, id) => rt.removeContainer(id, { force: true })],
  ["renameContainer", (rt, id) => rt.renameContainer(id, "taken-over")],
  ["updateContainer", (rt, id) => rt.updateContainer(id, { cpus: 1 })],
  ["containerLogs", (rt, id) => rt.containerLogs(id, { tail: 10, timestamps: false })],
  ["containerStats", (rt, id) => rt.containerStats(id)],
  ["containerDiff", (rt, id) => rt.containerDiff(id)],
  ["startExec", (rt, id) => rt.startExec(id, { cmd: ["true"], env: [], workingDir: "/", user: "root", tty: false })],
  // A live container's log has no end, so the stream is let go of after a moment.
  [
    "followLogs",
    (rt, id) => firstOf(rt.followLogs(id, { tail: 1, timestamps: false, signal: AbortSignal.timeout(50) })),
  ],
];

describe("a container that is not MiniBox's", () => {
  test.each(CONTAINER_OPERATIONS)("%s is refused as not found, and nothing is done to it", async (name, run) => {
    const { runtime, scoped } = setup();
    const foreign = container(runtime, "someone-elses", NOT_MINE);
    const before = [...runtime.containers.values()].map((c) => [c.id, c.name, c.running, c.paused]);
    const calls = runtime.calls.length;

    await refusedAs(run(scoped, foreign), "not_found");
    // Only the engine's answer about the container was asked for: the call that acts on it never ran.
    expect(mutations(runtime)).toEqual([]);
    // Asking the engine what the container is, `inspectContainer`, is how it is judged. Every other call is an action.
    if (name !== "inspectContainer") expect(runtime.calls.slice(calls).map((call) => call.op)).not.toContain(name);
    expect([...runtime.containers.values()].map((c) => [c.id, c.name, c.running, c.paused])).toEqual(before);
  });

  test("a container of another host's agent on the same engine is refused as well", async () => {
    const { runtime, scoped } = setup();
    const other = container(runtime, "from-another-agent", OTHER_HOST);
    await refusedAs(scoped.stopContainer(other, { timeoutSec: 1 }), "not_found");
    expect(runtime.containers.get(other)?.running).toBe(true);
  });

  test("a name works no better than an id, since the name is only resolved to the id the engine gives", async () => {
    const { runtime, scoped } = setup();
    container(runtime, "someone-elses", NOT_MINE);
    await refusedAs(scoped.removeContainer("someone-elses", { force: true }), "not_found");
    expect(mutations(runtime)).toEqual([]);
  });

  test("a container that is not there at all is not found the way it was before", async () => {
    const { scoped } = setup();
    await refusedAs(scoped.inspectContainer("missing"), "not_found");
  });

  test("a label in a request cannot make anything MiniBox's: the agent judges by what the engine holds", async () => {
    const { runtime, scoped } = setup();
    const foreign = container(runtime, "someone-elses", NOT_MINE);
    // The engine's record of the container is what counts; there is no way to hand the agent a label to believe.
    await refusedAs(scoped.inspectContainer(foreign), "not_found");
    const made = await scoped.createContainer({
      image: IMAGE,
      name: "mine",
      labels: { [OWNER_LABEL]: "other-host", "mbtest.box": "true" },
      ...(await boxNetwork(scoped)),
    });
    const info = await scoped.inspectContainer(made.id);
    expect(info.labels).toMatchObject({ [OWNER_LABEL]: HOST, "mbtest.box": "true" });
    expect(runtime.containers.get(foreign)?.labels[OWNER_LABEL]).toBeUndefined();
  });
});

describe("a container that is MiniBox's", () => {
  test("it is served as before: inspected, started, stopped, renamed, read and removed", async () => {
    const { runtime, scoped } = setup();
    const mine = runtime.seedContainer({ image: IMAGE, name: "mine", running: false, labels: MINE });
    expect((await scoped.inspectContainer(mine)).name).toBe("mine");
    await scoped.startContainer(mine);
    expect(runtime.containers.get(mine)?.running).toBe(true);
    await scoped.renameContainer(mine, "renamed");
    expect(runtime.containers.get(mine)?.name).toBe("renamed");
    await scoped.containerLogs(mine, { tail: 5, timestamps: false });
    await scoped.stopContainer(mine, { timeoutSec: 1 });
    expect(runtime.containers.get(mine)?.running).toBe(false);
    await scoped.removeContainer(mine, { force: true });
    expect(runtime.containers.has(mine)).toBe(false);
  });

  test.each(CONTAINER_OPERATIONS.filter(([name]) => name !== "inspectContainer"))(
    "%s acts on the id the engine gave for a name, not on the name",
    async (name, run) => {
      const { runtime, scoped } = setup();
      const mine = container(runtime, "mine", MINE);
      // An engine may refuse some of these for the state the container is in. What matters is the call that was made.
      await run(scoped, "mine").catch(() => {});
      expect(runtime.calls.find((call) => call.op === name)?.args[0]).toBe(mine);
    },
  );

  test("a command can be run in it", async () => {
    const { runtime, scoped } = setup();
    const mine = container(runtime, "mine", MINE);
    const session = await scoped.startExec(mine, { cmd: ["true"], env: [], workingDir: "/", user: "root", tty: false });
    expect(session.id).toBeTruthy();
  });
});

describe("the agent's own container and the volumes it runs on", () => {
  const SELF_VOLUME = "minibox-agent";

  test("they are refused even when they carry the label", async () => {
    const own = new FakeRuntime();
    own.seedImage(IMAGE);
    const self = own.seedContainer({ image: IMAGE, name: "the-agent", running: true, labels: MINE });
    own.volumes.set(SELF_VOLUME, { name: SELF_VOLUME, labels: MINE });
    const scope = new AgentScope({
      hostId: HOST,
      dataDir: scratch,
      runtime: own,
      record: freshScope(HOST),
      findSelf: async () => ({ containerId: self, volumes: new Set([SELF_VOLUME]) }),
    });
    const scoped = scopedRuntime(own, scope);
    await refusedAs(scoped.removeContainer(self, { force: true }), "not_found");
    await refusedAs(scoped.inspectVolume(SELF_VOLUME), "not_found");
    await refusedAs(scoped.removeVolume(SELF_VOLUME), "not_found");
    await refusedAs(
      scoped.createContainer({ image: IMAGE, mounts: [{ source: SELF_VOLUME, target: "/key" }] }),
      "not_found",
    );
    expect(own.containers.has(self)).toBe(true);
    expect(own.volumes.has(SELF_VOLUME)).toBe(true);
    expect(mutations(own)).toEqual([]);
  });

  test("an agent that cannot tell which container it is goes by the label alone", async () => {
    const { runtime, scoped } = setup({ self: null });
    const mine = container(runtime, "mine", MINE);
    expect((await scoped.inspectContainer(mine)).id).toBe(mine);
  });

  test("an engine that cannot say which container the agent is fails the call, and is asked again", async () => {
    const rt = new FakeRuntime();
    rt.seedImage(IMAGE);
    const self = rt.seedContainer({ image: IMAGE, name: "the-agent", running: true, labels: MINE });
    let asked = 0;
    const scope = new AgentScope({
      hostId: HOST,
      dataDir: scratch,
      runtime: rt,
      record: freshScope(HOST),
      findSelf: async () => {
        asked += 1;
        if (asked === 1) throw new RuntimeError("unavailable", "the engine is busy");
        return { containerId: self, volumes: new Set<string>() };
      },
    });
    const scoped = scopedRuntime(rt, scope);
    // "Cannot tell" is not "not in a container": the first answer fails the call instead of leaving the agent free to
    // manage itself, and is not kept as an answer.
    await refusedAs(scoped.inspectContainer(self), "unavailable");
    // Asked again, the engine says which container it is, and that one is not managed.
    await refusedAs(scoped.inspectContainer(self), "not_found");
    expect(asked).toBe(2);
  });

  test("the container is found from the mount table, then from the hostname", async () => {
    const rt = new FakeRuntime();
    rt.seedImage(IMAGE);
    const id = rt.seedContainer({ image: IMAGE, name: "the-agent", running: true, labels: NOT_MINE });
    const mountinfo = `36 24 0:34 /docker/containers/${id}/hostname /etc/hostname rw - ext4 /dev/sda1 rw\n`;
    expect(containerIdsIn(mountinfo)).toEqual([id]);
    expect((await findSelf(rt, { mountinfo: () => mountinfo, hostname: () => "no" }))?.containerId).toBe(id);
    // Without a mount table, a hostname that is the short id of a container the engine knows is the container.
    const viaHostname = await findSelf(rt, {
      mountinfo: () => {
        throw new Error("no /proc here");
      },
      hostname: () => id.slice(0, 12),
    });
    expect(viaHostname?.containerId).toBe(id);
    // A candidate the engine does not know is not accepted, and neither is a hostname that is not a short id.
    expect(
      await findSelf(rt, { mountinfo: () => `/containers/${"a".repeat(64)}/x`, hostname: () => "web-1" }),
    ).toBeNull();
  });

  test("an engine that cannot answer is an error, and one that does not know the container is not", async () => {
    const rt = new FakeRuntime();
    const sources = {
      mountinfo: () =>
        `36 24 0:34 /docker/containers/${"a".repeat(64)}/hostname /etc/hostname rw - ext4 /dev/sda1 rw\n`,
      hostname: () => "web-1",
    };
    // The engine does not know the container, so the agent is not in one that it can see: null, and a fact worth keeping.
    expect(await findSelf(rt, sources)).toBeNull();
    // An engine that is busy has said nothing of the sort, and taking its silence for that would leave the agent free to
    // manage itself.
    rt.fail("inspectContainer", new RuntimeError("unavailable", "the engine is busy"));
    await expect(findSelf(rt, sources)).rejects.toThrow("the engine is busy");
  });

  test("the volumes mounted into it are the ones it runs on", async () => {
    const rt = new FakeRuntime();
    rt.seedImage(IMAGE);
    rt.volumes.set(SELF_VOLUME, { name: SELF_VOLUME, labels: NOT_MINE });
    const id = rt.seedContainer({
      image: IMAGE,
      name: "the-agent",
      running: true,
      labels: NOT_MINE,
      mounts: [{ source: SELF_VOLUME, target: "/data" }],
    });
    const self = await findSelf(rt, { mountinfo: () => `/containers/${id}/x`, hostname: () => "x" });
    expect([...(self?.volumes ?? [])]).toContain(SELF_VOLUME);
  });
});

describe("volumes", () => {
  test("a volume that is not MiniBox's cannot be inspected, removed or have its owner set", async () => {
    const { runtime, scoped } = setup();
    runtime.volumes.set("theirs", { name: "theirs", labels: NOT_MINE });
    await refusedAs(scoped.inspectVolume("theirs"), "not_found");
    await refusedAs(scoped.removeVolume("theirs"), "not_found");
    await refusedAs(scoped.setVolumeRootOwner("theirs", { uid: 1000, gid: 1000 }, IMAGE), "not_found");
    expect(runtime.volumes.has("theirs")).toBe(true);
    expect(mutations(runtime)).toEqual([]);
  });

  test("a volume the agent made is MiniBox's, whatever labels the request gave it", async () => {
    const { runtime, scoped } = setup();
    await scoped.createVolume("mine", { "mbtest.volume": "true", [OWNER_LABEL]: "other-host" });
    expect(runtime.volumes.get("mine")?.labels).toEqual({ "mbtest.volume": "true", [OWNER_LABEL]: HOST });
    expect((await scoped.inspectVolume("mine")).name).toBe("mine");
    await scoped.removeVolume("mine");
    expect(runtime.volumes.has("mine")).toBe(false);
  });

  test("creating a volume that is someone else's is a conflict, not a success that would then be mounted", async () => {
    const { runtime, scoped } = setup();
    runtime.volumes.set("theirs", { name: "theirs", labels: NOT_MINE });
    await refusedAs(scoped.createVolume("theirs", {}), "conflict");
    expect(runtime.volumes.get("theirs")?.labels).toEqual({});
    // One of its own is created again as before: the engine keeps it as it is.
    await scoped.createVolume("mine", {});
    await scoped.createVolume("mine", {});
  });

  test("a list holds only MiniBox's volumes", async () => {
    const { runtime, scoped } = setup();
    runtime.volumes.set("mine", { name: "mine", labels: MINE });
    runtime.volumes.set("theirs", { name: "theirs", labels: NOT_MINE });
    runtime.volumes.set("another-agents", { name: "another-agents", labels: OTHER_HOST });
    expect((await scoped.listVolumes()).map((volume) => volume.name)).toEqual(["mine"]);
  });
});

describe("networks", () => {
  test("one the agent makes is MiniBox's, and an existing one that is not is a conflict", async () => {
    const { runtime, scoped } = setup();
    await scoped.ensureBridgeNetwork("mbtest-boxes", { interContainerComm: false });
    expect(runtime.networks.get("mbtest-boxes")?.labels).toEqual({ [OWNER_LABEL]: HOST });
    await scoped.ensureBridgeNetwork("mbtest-boxes", { interContainerComm: false });

    runtime.seedNetwork("theirs", {}, "bridge", {});
    await refusedAs(scoped.ensureBridgeNetwork("theirs", { interContainerComm: true }), "conflict");
    expect(runtime.networks.get("theirs")?.labels).toEqual({});
  });

  test("a network that is not MiniBox's cannot be removed, joined or re-joined", async () => {
    const { runtime, scoped } = setup();
    const mine = container(runtime, "mine", MINE);
    runtime.seedNetwork("theirs");
    await refusedAs(scoped.removeNetwork("theirs"), "not_found");
    await refusedAs(scoped.connectNetwork(mine, "theirs"), "not_found");
    await refusedAs(scoped.reattachNetwork(mine, "theirs"), "not_found");
    expect(runtime.networks.has("theirs")).toBe(true);
    expect(mutations(runtime)).toEqual([]);
  });

  test("a container that is not MiniBox's cannot be joined to one that is", async () => {
    const { runtime, scoped } = setup();
    await scoped.ensureBridgeNetwork("mbtest-boxes", { interContainerComm: false });
    const foreign = container(runtime, "someone-elses", NOT_MINE);
    await refusedAs(scoped.connectNetwork(foreign, "mbtest-boxes"), "not_found");
    await refusedAs(scoped.reattachNetwork(foreign, "mbtest-boxes"), "not_found");
  });

  test("a network the agent made can be joined, and a network that is not there is not found", async () => {
    const { runtime, scoped } = setup();
    const mine = container(runtime, "mine", MINE);
    await scoped.ensureBridgeNetwork("mbtest-egress-a", { interContainerComm: false });
    await scoped.connectNetwork(mine, "mbtest-egress-a", { alias: "proxy" });
    expect(runtime.callsTo("connectNetwork")).toHaveLength(1);
    await refusedAs(scoped.connectNetwork(mine, "missing"), "not_found");
    // Removing one that is not there leaves it alone, as the engine does.
    await scoped.removeNetwork("missing");
    await scoped.removeContainer(mine, { force: true });
    await scoped.removeNetwork("mbtest-egress-a");
    expect(runtime.networks.has("mbtest-egress-a")).toBe(false);
  });

  test("a list holds only MiniBox's networks", async () => {
    const { runtime, scoped } = setup();
    runtime.seedNetwork("mine", {}, "bridge", MINE);
    runtime.seedNetwork("theirs");
    runtime.seedNetwork("bridge");
    expect((await scoped.listNetworks()).map((network) => network.name)).toEqual(["mine"]);
  });
});

describe("creating a container", () => {
  test("it gets the label, and keeps the labels the control plane gave it", async () => {
    const { runtime, scoped } = setup();
    const on = await boxNetwork(scoped);
    const made = await scoped.createContainer({ image: IMAGE, name: "box", labels: { "mbtest.box": "true" }, ...on });
    expect(runtime.containers.get(made.id)?.labels).toEqual({ "mbtest.box": "true", [OWNER_LABEL]: HOST });
    const bare = await scoped.createContainer({ image: IMAGE, name: "bare", ...on });
    expect(runtime.containers.get(bare.id)?.labels).toEqual({ [OWNER_LABEL]: HOST });
  });

  test("a volume it mounts must exist and be MiniBox's, or nothing is created", async () => {
    const { runtime, scoped } = setup();
    runtime.volumes.set("theirs", { name: "theirs", labels: NOT_MINE });
    runtime.volumes.set("mine", { name: "mine", labels: MINE });
    const before = runtime.containers.size;

    await refusedAs(
      scoped.createContainer({ image: IMAGE, mounts: [{ source: "theirs", target: "/data" }] }),
      "not_found",
    );
    // A name the engine would make on the spot, unlabelled and so nobody's, is refused too.
    await refusedAs(
      scoped.createContainer({ image: IMAGE, mounts: [{ source: "new-one", target: "/data" }] }),
      "not_found",
    );
    expect(runtime.volumes.has("new-one")).toBe(false);
    expect(runtime.containers.size).toBe(before);

    await scoped.createContainer({
      image: IMAGE,
      name: "ok",
      mounts: [{ source: "mine", target: "/data" }],
      ...(await boxNetwork(scoped)),
    });
    expect(runtime.containers.size).toBe(before + 1);
  });

  test("it is on a network of MiniBox's and on no other: not the engine's default one, not a stranger's, not none", async () => {
    const { runtime, scoped } = setup();
    await boxNetwork(scoped);
    runtime.seedNetwork("theirs");
    // The engine's own network, which whatever else runs on the machine is on too.
    runtime.seedNetwork("bridge");
    const before = runtime.containers.size;
    await scoped.createContainer({ image: IMAGE, name: "a", network: BOX_NETWORK });
    for (const network of ["bridge", "theirs", "missing"]) {
      await refusedAs(scoped.createContainer({ image: IMAGE, name: "b", network }), "not_found");
    }
    // A request that names no network would be put on the engine's default one.
    await refusedAs(scoped.createContainer({ image: IMAGE, name: "c" }), "invalid");
    expect(runtime.containers.size).toBe(before + 1);
  });

  test("a container runtime has to be allowed: runc always, the others only when the operator says so", async () => {
    const strict = setup();
    const on = await boxNetwork(strict.scoped);
    await strict.scoped.createContainer({ image: IMAGE, name: "a", hardening: { runtime: "runc" }, ...on });
    await strict.scoped.createContainer({ image: IMAGE, name: "b", ...on });
    const refusal = await strict.scoped
      .createContainer({ image: IMAGE, name: "c", hardening: { runtime: "runsc" }, ...on })
      .then(
        () => null,
        (e: unknown) => e as RuntimeError,
      );
    expect(refusal?.kind).toBe("invalid");
    expect(refusal?.detail).toContain("AGENT_ALLOWED_RUNTIMES");
    expect(strict.runtime.containers.size).toBe(2);

    const open = setup({ allowedRuntimes: ["runsc"] });
    const there = await boxNetwork(open.scoped);
    await open.scoped.createContainer({ image: IMAGE, name: "c", hardening: { runtime: "runsc" }, ...there });
    await refusedAs(
      open.scoped.createContainer({ image: IMAGE, name: "d", hardening: { runtime: "kata" }, ...there }),
      "invalid",
    );
  });
});

describe("lists and events", () => {
  test("the agent's own container and volumes are in no list or event, though they carry the label", async () => {
    const runtime = new FakeRuntime();
    runtime.seedImage(IMAGE);
    const own = container(runtime, "the-agent", MINE);
    const mine = container(runtime, "mine", MINE);
    runtime.volumes.set("minibox-agent", { name: "minibox-agent", labels: MINE });
    runtime.volumes.set("mine-volume", { name: "mine-volume", labels: MINE });
    const scope = new AgentScope({
      hostId: HOST,
      dataDir: scratch,
      runtime,
      record: freshScope(HOST),
      findSelf: async () => ({ containerId: own, volumes: new Set(["minibox-agent"]) }),
    });
    const scoped = scopedRuntime(runtime, scope);
    expect((await scoped.listContainers({ labels: {} })).map((info) => info.id)).toEqual([mine]);
    expect((await scoped.listVolumes()).map((volume) => volume.name)).toEqual(["mine-volume"]);

    const abort = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of scoped.events({}, abort.signal)) seen.push(event.id);
    })();
    await until(() => runtime.watching() > 0);
    // The last event is MiniBox's: events arrive in order, so once it has, the agent's own has been let go.
    for (const id of [own, mine]) {
      runtime.emitEvent({
        type: "container",
        action: "die",
        id,
        attributes: { ...MINE },
        time: new Date().toISOString(),
        timeNano: Date.now() * 1_000_000,
      });
    }
    await until(() => seen.length > 0);
    abort.abort();
    await pump;
    expect(seen).toEqual([mine]);
  });

  test("a container list holds only MiniBox's containers, and the filter the control plane gave still applies", async () => {
    const { runtime, scoped } = setup();
    const mine = container(runtime, "mine", { ...MINE, "mbtest.box": "true" });
    container(runtime, "mine-unmarked", MINE);
    container(runtime, "theirs", { "mbtest.box": "true" });
    container(runtime, "another-agents", { ...OTHER_HOST, "mbtest.box": "true" });
    const listed = await scoped.listContainers({ labels: { "mbtest.box": "true" } });
    expect(listed.map((info) => info.id)).toEqual([mine]);
  });

  test("events are the container events of MiniBox's containers, and nothing else", async () => {
    const { runtime, scoped } = setup();
    const abort = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of scoped.events({}, abort.signal)) {
        seen.push(`${event.type}:${event.attributes.name}`);
      }
    })();
    await until(() => runtime.watching() > 0);
    container(runtime, "theirs", NOT_MINE);
    container(runtime, "another-agents", OTHER_HOST);
    const mine = container(runtime, "mine", MINE);
    runtime.emitEvent({
      type: "volume",
      action: "create",
      id: "mine-volume",
      attributes: { ...MINE, name: "mine-volume" },
      time: new Date().toISOString(),
      timeNano: Date.now() * 1_000_000,
    });
    // MiniBox's own, last: events arrive in order, so once it has, everything before it has been judged.
    runtime.emitEvent({
      type: "container",
      action: "die",
      id: mine,
      attributes: { ...MINE, name: "mine" },
      time: new Date().toISOString(),
      timeNano: Date.now() * 1_000_000,
    });
    await until(() => seen.length >= 3);
    abort.abort();
    await pump;
    expect(seen).toEqual(["container:mine", "container:mine", "container:mine"]);
  });
});

describe("the owner of the host's firewall rule", () => {
  test("it is the MiniBox the agent was paired with, and another install's chain cannot be named", async () => {
    const { runtime, scoped } = setup({ record: freshScope(HOST, PREFIX) });
    runtime.seedNetwork("mbtest-egress-abc", {}, "bridge", MINE);
    await scoped.setHostIngressBlock(PREFIX, []);
    expect(runtime.callsTo("setHostIngressBlock")).toHaveLength(1);
    await refusedAs(scoped.setHostIngressBlock("another-install", []), "invalid");
    expect(runtime.callsTo("setHostIngressBlock")).toHaveLength(1);
  });

  test("an agent that was never told the prefix leaves the owner as the control plane gives it", async () => {
    const { runtime, scoped } = setup();
    await scoped.setHostIngressBlock("whatever", []);
    expect(runtime.callsTo("setHostIngressBlock")).toHaveLength(1);
  });

  test("an agent that has no scope file writes one at the welcome, and its owner is then the prefix the welcome named", async () => {
    const { runtime, scope, scoped } = setup({ record: null });
    expect(scope.ingressOwner()).toBeNull();
    scope.begin(PREFIX);
    expect(loadScope(scratch, HOST)).toEqual(freshScope(HOST, PREFIX));
    expect(scope.ingressOwner()).toBe(PREFIX);
    await scoped.setHostIngressBlock(PREFIX, []);
    expect(runtime.callsTo("setHostIngressBlock")).toHaveLength(1);
    await refusedAs(scoped.setHostIngressBlock("another-install", []), "invalid");
    expect(runtime.callsTo("setHostIngressBlock")).toHaveLength(1);
  });

  test("a welcome that names another prefix is logged, and changes nothing", async () => {
    const lines: string[] = [];
    const restore = setLogSink((_level, line) => lines.push(line));
    try {
      const { scope } = setup({ record: freshScope(HOST, PREFIX) });
      scope.begin("somebody-else");
      scope.begin(PREFIX);
    } finally {
      restore();
    }
    const differs = lines.filter((line) => line.includes("agent.scope_prefix_differs"));
    expect(differs).toHaveLength(1);
    expect(JSON.parse(differs[0] ?? "{}")).toMatchObject({ kept: PREFIX, reported: "somebody-else" });
  });
});

describe("the scope file", () => {
  test("an empty one is an error, not an agent that never had a scope and would have one written over it", () => {
    writeFileSync(join(scratch, SCOPE_FILE), "", { mode: 0o600 });
    expect(() => loadScope(scratch, HOST)).toThrow("is empty");
  });

  test("it is written and read back, and holds the host and the prefix its MiniBox uses", () => {
    const record = freshScope(HOST, PREFIX);
    saveScope(scratch, record);
    expect(loadScope(scratch, HOST)).toEqual(record);
    expect(loadScope(scratch, HOST)).toEqual({ version: 1, hostId: HOST, labelPrefix: PREFIX });
  });

  test("an agent that has none reads null, and a welcome then writes one", () => {
    const { scope } = setup({ record: null });
    expect(loadScope(scratch, HOST)).toBeNull();
    scope.begin(PREFIX);
    expect(existsSync(join(scratch, SCOPE_FILE))).toBe(true);
    expect(loadScope(scratch, HOST)).toEqual(freshScope(HOST, PREFIX));
  });

  test("a file written for another host is an error that says what to do, not a scope to trust", () => {
    saveScope(scratch, freshScope("another-host"));
    expect(() => loadScope(scratch, HOST)).toThrow("Remove the data volume and pair again");
  });

  test("a file that is not a scope is an error, not an empty scope", () => {
    writeFileSync(join(scratch, SCOPE_FILE), JSON.stringify({ version: 2 }));
    expect(() => loadScope(scratch, HOST)).toThrow();
  });
});

describe("through the executor, which is what the control plane talks to", () => {
  interface Reply {
    ok: boolean;
    result?: unknown;
    error?: AgentErrorInfo;
  }

  /** The executor over the scoped engine, and a way to ask it for one operation and read the one answer. */
  function served(options: Parameters<typeof setup>[0] = {}) {
    const made = setup(options);
    const replies = new Map<string, Reply>();
    const sink: AgentSink = {
      respond: (id, outcome) => replies.set(id, outcome as Reply),
      item: () => {},
      data: () => {},
      end: () => {},
    };
    const executor = new AgentExecutor(made.scoped, sink);
    let next = 0;
    const ask = async (op: string, args: unknown): Promise<Reply> => {
      next += 1;
      const id = `r${next}`;
      await executor.request(id, op, args);
      const reply = replies.get(id);
      if (!reply) throw new Error(`no answer to ${op}`);
      return reply;
    };
    return { ...made, ask };
  }

  test("a request for a container that is not MiniBox's is answered not found, and does nothing", async () => {
    const { runtime, ask } = served();
    const foreign = container(runtime, "someone-elses", NOT_MINE);
    expect(await ask("removeContainer", { id: foreign, force: true })).toMatchObject({
      ok: false,
      error: { kind: "not_found" },
    });
    expect(runtime.containers.has(foreign)).toBe(true);
    expect(mutations(runtime)).toEqual([]);
  });

  test("a bind mount, a privilege, a device or a host namespace is refused before anything runs", async () => {
    const { runtime, ask } = served();
    const refused = [
      { image: IMAGE, mounts: [{ source: "/etc", target: "/host-etc" }] },
      { image: IMAGE, mounts: [{ source: "/var/run/docker.sock", target: "/var/run/docker.sock", kind: "bind" }] },
      { image: IMAGE, privileged: true },
      { image: IMAGE, devices: ["/dev/sda"] },
      { image: IMAGE, pidMode: "host" },
      { image: IMAGE, ipcMode: "host" },
      { image: IMAGE, network: "host" },
      { image: IMAGE, hardening: { capAdd: ["SYS_ADMIN"] } },
    ];
    for (const spec of refused) {
      expect(await ask("createContainer", { spec })).toMatchObject({ ok: false, error: { kind: "invalid" } });
    }
    expect(runtime.containers.size).toBe(0);
  });

  test("a source for the ingress block must be MiniBox's network, not a stranger's", async () => {
    const { runtime, ask } = served();
    runtime.seedNetwork("strangers", {}, "bridge", {});
    const stranger = runtime.networks.get("strangers");
    if (!stranger) throw new Error("the stranger's network was not seeded");
    stranger.subnets = ["10.9.0.0/24"];
    runtime.seedNetwork("mine", {}, "bridge", MINE);
    const own = runtime.networks.get("mine");
    if (!own) throw new Error("the agent's network was not seeded");
    own.subnets = ["10.8.0.0/24"];
    expect(await ask("setHostIngressBlock", { owner: PREFIX, sources: ["10.9.0.0/24"] })).toMatchObject({
      ok: false,
      error: { kind: "invalid" },
    });
    expect(await ask("setHostIngressBlock", { owner: PREFIX, sources: ["10.8.0.0/24"] })).toMatchObject({ ok: true });
  });

  test("the control plane's ordinary flow works: a volume, a network, a box on them, a command in it", async () => {
    const { runtime, ask } = served();
    expect(await ask("createVolume", { name: "mbtest-ws-a", labels: { "mbtest.volume": "true" } })).toMatchObject({
      ok: true,
    });
    expect(
      await ask("ensureBridgeNetwork", { name: "mbtest-boxes", opts: { interContainerComm: false } }),
    ).toMatchObject({
      ok: true,
    });
    const created = await ask("createContainer", {
      spec: {
        image: IMAGE,
        name: "mbtest-a",
        labels: { "mbtest.box": "true" },
        mounts: [{ source: "mbtest-ws-a", target: "/workspace" }],
        network: "mbtest-boxes",
      },
    });
    expect(created.ok).toBe(true);
    const id = (created.result as { id: string }).id;
    expect(await ask("startContainer", { id })).toMatchObject({ ok: true });
    expect(await ask("listContainers", { labels: { "mbtest.box": "true" } })).toMatchObject({ ok: true });
    expect(((await ask("listContainers", { labels: { "mbtest.box": "true" } })).result as unknown[]).length).toBe(1);
    expect(runtime.containers.get(id)?.labels[OWNER_LABEL]).toBe(HOST);
  });
});
