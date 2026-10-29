/**
 * An agent host against a real Docker engine. The control plane issues a pairing code, an agent spends it and dials in
 * over a real WebSocket, and a box created on that host is a real container that runs through the agent. The agent and
 * the control plane share one engine here, so the recorded calls show which path each operation took.
 *
 *   bun run test:docker
 *
 * That script (scripts/docker-integration.ts) picks the label prefix and sweeps what the run left behind. To run this
 * file directly: MINIBOX_TEST_DOCKER=1 MINIBOX_TEST_PREFIX=mbit<id> bun test tests/docker-agent.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Server } from "bun";
import Docker from "dockerode";

import { AgentClient } from "../src/agent/client";
import { generateKeyPairPem, loadIdentity, type StoredIdentity, saveIdentity } from "../src/agent/identity";
import { pairWith } from "../src/agent/main";
import { AGENT_PROTOCOL } from "../src/agent/protocol";
import { AgentScope, freshScope, loadScope, OWNER_LABEL } from "../src/agent/scope";
import { type ServedRuntime, scopedRuntime } from "../src/agent/scoped-runtime";
import { findSelf } from "../src/agent/self";
import { type App, createApp } from "../src/app";
import { createDockerRuntime } from "../src/docker/runtime";
import { boxNetworkName, labelKeys } from "../src/labels";
import { type Runtime, RuntimeError } from "../src/runtime";
import { startServer } from "../src/server";
import type { SocketData } from "../src/ws/socket";
import { TEST_KEY, testConfig } from "./support/app";

const enabled = process.env.MINIBOX_TEST_DOCKER === "1";
const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const PREFIX_PATTERN = /^mbit[a-z0-9-]{3,40}$/;
const prefix = process.env.MINIBOX_TEST_PREFIX ?? `mbit${Date.now().toString(36)}`;
if (enabled && !PREFIX_PATTERN.test(prefix)) throw new Error(`MINIBOX_TEST_PREFIX must match ${PREFIX_PATTERN}`);
const IMAGE = process.env.MINIBOX_TEST_IMAGE ?? "alpine:3.20";
const LONG = 120_000;
const AGENT_VERSION = "0.4.0";
const keys = labelKeys(prefix);
const docker = new Docker({ socketPath: SOCKET });

let app: App;
let server: Server<SocketData>;
let base: string;
let client: AgentClient | null = null;
let clientDone: Promise<void> | null = null;
let stored: StoredIdentity | null = null;
/** The engine as the agent serves it: behind its scope, which is what the control plane talks to. */
let scoped: ServedRuntime | null = null;
const agentCalls: string[] = [];
const dirs: string[] = [];

interface BoxJson {
  id: string;
  name: string;
  hostId?: string;
}

/** The engine runtime with every operation recorded, so a test can see which calls the agent ran. */
function recording(runtime: Runtime, calls: string[]): Runtime {
  return new Proxy(runtime, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(property));
        return value.apply(target, args);
      };
    },
  });
}

/** The agent's engine, once the first test has paired it. */
function scopedEngine(): ServedRuntime {
  if (!scoped) throw new Error("the agent has not been paired yet");
  return scoped;
}

/** Runs `call` and returns the `RuntimeError` the agent refuses it with, and fails when it goes through. */
async function refusal(call: () => Promise<unknown>): Promise<RuntimeError> {
  const outcome = await call().then(
    () => null,
    (e: unknown) => e,
  );
  if (!(outcome instanceof RuntimeError))
    throw new Error(`the agent was expected to refuse, and answered ${String(outcome)}`);
  return outcome;
}

/** The id of the box container the control plane made on the agent host. */
async function boxContainerId(): Promise<string> {
  const id = (await containersNamed("agent-box"))[0]?.Id;
  if (id === undefined) throw new Error("the box has no container");
  return id;
}

function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${TEST_KEY}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers });
}

const post = (path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });

async function containersNamed(name: string) {
  return docker.listContainers({
    all: true,
    filters: { label: [`${keys.box}=true`, `${keys.name}=${name}`] },
  });
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = LONG): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

beforeAll(async () => {
  if (!enabled) return;
  const dataDir = mkdtempSync(join(tmpdir(), "minibox-agent-test-"));
  dirs.push(dataDir);
  const cfg = testConfig({
    labelPrefix: prefix,
    dockerSocket: SOCKET,
    baseTemplateTag: `${prefix}-template:base`,
    dataDir,
  });
  app = createApp(cfg, "0.0.0-test", { runtime: createDockerRuntime(SOCKET), eventsPath: ":memory:" });
  server = startServer(app);
  base = `http://127.0.0.1:${server.port}`;
}, LONG);

afterAll(async () => {
  if (!enabled) return;
  client?.stop();
  await clientDone;
  app?.hostAdmin.close();
  app?.sessions.stop();
  app?.tokens.stop();
  app?.events.close();
  server?.stop(true);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  for (const container of await containersNamed("agent-box")) {
    await docker
      .getContainer(container.Id)
      .remove({ force: true })
      .catch(() => {});
  }
}, LONG);

describe.skipIf(!enabled)("an agent host, against a real engine", () => {
  let boxId = "";

  test(
    "an agent spends a pairing code, dials in, and its host goes online with the engine's version",
    async () => {
      const issued = await post("/api/hosts/pairing", { id: "edge", name: "Edge engine" });
      expect(issued.status).toBe(201);
      const { code } = (await issued.json()) as { code: string };

      const keys = generateKeyPairPem();
      const reply = await pairWith(base, {
        code,
        publicKey: keys.publicKeyPem,
        version: AGENT_VERSION,
        protocol: AGENT_PROTOCOL,
      });
      const dir = mkdtempSync(join(tmpdir(), "minibox-agent-edge-"));
      dirs.push(dir);
      saveIdentity(
        dir,
        { agentId: reply.agentId, hostId: reply.hostId, server: base, pairedAt: new Date().toISOString() },
        keys.privateKeyPem,
      );
      stored = loadIdentity(dir);
      if (!stored) throw new Error("the identity was not saved");

      // What `minibox-agent` does: the control plane is served through the agent's scope. This agent was paired by a
      // version that labels what it creates, so its scope is a fresh one with nothing from before to adopt. The test
      // process is not in a container, so there is no container of the agent's own to keep out of reach.
      const engine = recording(createDockerRuntime(SOCKET), agentCalls);
      const scope = new AgentScope({
        hostId: stored.identity.hostId,
        dataDir: dir,
        runtime: engine,
        record: freshScope(stored.identity.hostId, new Date()),
        findSelf: async () => null,
      });
      scoped = scopedRuntime(engine, scope);
      client = new AgentClient({
        server: base,
        agentId: stored.identity.agentId,
        privateKey: stored.privateKey,
        runtime: scoped,
        scope,
        version: AGENT_VERSION,
      });
      clientDone = client.run();

      // Online comes from the link, and the engine's version from the check the connection starts, so the version is
      // waited for as well: a read in between sees an online host that has not been asked yet.
      await waitFor(
        () => typeof app.hostAdmin.list().find((host) => host.id === "edge")?.dockerVersion === "string",
        "the agent host to go online with the engine's version",
      );
      const hosts = (await (await api("/api/hosts")).json()) as { hosts: Array<Record<string, unknown>> };
      const version = await docker.version();
      expect(hosts.hosts.find((host) => host.id === "edge")).toMatchObject({
        transport: "agent",
        status: "online",
        dockerVersion: version.Version,
        agent: { connected: true, version: AGENT_VERSION, upgradeRequired: false, revoked: false },
      });
    },
    LONG,
  );

  test(
    "a box created on the agent host is a real container, and the agent ran its create",
    async () => {
      const made = await post("/api/boxes", {
        name: "agent-box",
        template: IMAGE,
        cpus: 0.5,
        memoryMb: 128,
        mounts: [],
        host: "edge",
      });
      expect(made.status).toBe(201);
      const { box } = (await made.json()) as { box: BoxJson };
      expect(box).toMatchObject({ name: "agent-box", hostId: "edge" });
      boxId = box.id;

      const containers = await containersNamed("agent-box");
      expect(containers).toHaveLength(1);
      expect(containers[0]?.State).toBe("running");
      expect(agentCalls).toContain("createContainer");
    },
    LONG,
  );

  test(
    "a command in the box runs through the agent and returns its output and exit code",
    async () => {
      const res = await post(`/api/boxes/${boxId}/exec`, {
        cmd: "echo agent-$((40 + 2)); echo to-stderr >&2; exit 3",
        user: "root",
        cwd: "/",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ exitCode: 3, stdout: "agent-42\n", stderr: "to-stderr\n" });
      expect(agentCalls).toContain("startExec");
    },
    LONG,
  );

  test(
    "what the agent makes carries its label, whatever labels the request gave, and so does the network the box is on",
    async () => {
      const agent = scopedEngine();
      const own = (await containersNamed("agent-box"))[0];
      expect(own?.Labels[OWNER_LABEL]).toBe("edge");
      const network = await docker.getNetwork(boxNetworkName(prefix)).inspect();
      expect(network.Labels?.[OWNER_LABEL]).toBe("edge");

      const name = `${prefix}-agent-made-vol`;
      // A request that names the label for another host gets this agent's, and the install's own label stays.
      await agent.createVolume(name, { [OWNER_LABEL]: "somebody-else", [prefix]: "true" });
      try {
        expect((await docker.getVolume(name).inspect()).Labels).toEqual({ [OWNER_LABEL]: "edge", [prefix]: "true" });
        expect((await agent.listVolumes()).map((volume) => volume.name)).toContain(name);
      } finally {
        await agent.removeVolume(name).catch(() => {});
      }
      await expect(docker.getVolume(name).inspect()).rejects.toThrow();
    },
    LONG,
  );

  test(
    "a container that is not MiniBox's is out of the agent's reach: not in its lists, refused as not found, left as it was",
    async () => {
      const agent = scopedEngine();
      const name = `${prefix}-agent-foreign`;
      // The install's own label, so the sweep finds it if this test dies. It is no claim on the agent's label.
      const foreign = await docker.createContainer({
        Image: IMAGE,
        name,
        Cmd: ["sleep", "300"],
        Labels: { [prefix]: "true" },
      });
      try {
        await foreign.start();
        const own = await boxContainerId();
        const listed = (await agent.listContainers({ labels: {} })).map((info) => info.id);
        expect(listed).toContain(own);
        expect(listed).not.toContain(foreign.id);

        // By id and by name alike: the agent asks the engine what the reference is before it acts on it.
        for (const reference of [foreign.id, name]) {
          for (const call of [
            () => agent.inspectContainer(reference),
            () => agent.pauseContainer(reference),
            () => agent.renameContainer(reference, `${name}-taken`),
            () => agent.stopContainer(reference, { timeoutSec: 1 }),
            () => agent.startExec(reference, { cmd: ["true"], env: [], workingDir: "/", user: "root", tty: false }),
            () => agent.removeContainer(reference, { force: true }),
          ]) {
            expect((await refusal(call)).kind).toBe("not_found");
          }
        }
        expect(await foreign.inspect()).toMatchObject({ Name: `/${name}`, State: { Running: true, Paused: false } });
      } finally {
        await foreign.remove({ force: true }).catch(() => {});
      }
    },
    LONG,
  );

  test(
    "a volume that is not MiniBox's is not listed, inspected, removed, recreated or mounted, and none is made on the spot",
    async () => {
      const agent = scopedEngine();
      const name = `${prefix}-agent-foreign-vol`;
      const missing = `${prefix}-agent-missing-vol`;
      const thief = `${prefix}-agent-thief`;
      await docker.createVolume({ Name: name, Labels: { [prefix]: "true" } });
      try {
        expect((await agent.listVolumes()).map((volume) => volume.name)).not.toContain(name);
        for (const call of [
          () => agent.inspectVolume(name),
          () => agent.removeVolume(name),
          () => agent.setVolumeRootOwner(name, { uid: 1000, gid: 1000 }, IMAGE),
          () => agent.createContainer({ image: IMAGE, name: thief, mounts: [{ source: name, target: "/stolen" }] }),
          // A name the engine would make on the spot, unlabelled and so nobody's, is refused as well.
          () => agent.createContainer({ image: IMAGE, name: thief, mounts: [{ source: missing, target: "/made" }] }),
        ]) {
          expect((await refusal(call)).kind).toBe("not_found");
        }
        // Creating a volume that exists succeeds and keeps it as it is, and the caller would then mount it.
        expect((await refusal(() => agent.createVolume(name, {}))).kind).toBe("conflict");

        await expect(docker.getVolume(missing).inspect()).rejects.toThrow();
        expect(await docker.listContainers({ all: true, filters: { name: [thief] } })).toEqual([]);
        expect((await docker.getVolume(name).inspect()).Labels).toEqual({ [prefix]: "true" });
      } finally {
        await docker
          .getVolume(name)
          .remove()
          .catch(() => {});
      }
    },
    LONG,
  );

  test(
    "a network that is not MiniBox's is not listed, removed, joined or taken over",
    async () => {
      const agent = scopedEngine();
      const name = `${prefix}-agent-foreign-net`;
      const foreign = await docker.createNetwork({ Name: name, Labels: { [prefix]: "true" } });
      try {
        const listed = (await agent.listNetworks()).map((network) => network.name);
        expect(listed).toContain(boxNetworkName(prefix));
        expect(listed).not.toContain(name);
        const own = await boxContainerId();
        for (const call of [
          () => agent.removeNetwork(name),
          () => agent.connectNetwork(own, name),
          () => agent.reattachNetwork(own, name),
        ]) {
          expect((await refusal(call)).kind).toBe("not_found");
        }
        expect((await refusal(() => agent.ensureBridgeNetwork(name, { interContainerComm: true }))).kind).toBe(
          "conflict",
        );
        expect((await foreign.inspect()).Labels).toEqual({ [prefix]: "true" });
      } finally {
        await foreign.remove().catch(() => {});
      }
    },
    LONG,
  );

  test(
    "the engine's events reach the control plane for MiniBox's containers only",
    async () => {
      const agent = scopedEngine();
      const ownId = await boxContainerId();
      const own = docker.getContainer(ownId);
      const foreign = await docker.createContainer({
        Image: IMAGE,
        name: `${prefix}-agent-foreign-events`,
        Cmd: ["sleep", "300"],
        Labels: { [prefix]: "true" },
      });
      const abort = new AbortController();
      try {
        // The engine replays what it still holds from `since`, so the events can happen before anyone listens.
        const since = Math.floor(Date.now() / 1000);
        await foreign.start();
        await foreign.pause();
        await foreign.unpause();
        await own.pause();
        await own.unpause();

        const seen: Array<{ id: string; action: string; owner: string | undefined }> = [];
        const timer = setTimeout(() => abort.abort(), 30_000);
        try {
          for await (const event of agent.events({ types: ["container"], since }, abort.signal)) {
            seen.push({ id: event.id, action: event.action, owner: event.attributes[OWNER_LABEL] });
            if (event.id === ownId && event.action === "unpause") break;
          }
        } finally {
          clearTimeout(timer);
        }
        expect(seen.some((event) => event.id === ownId && event.action === "pause")).toBe(true);
        expect(seen.some((event) => event.id === foreign.id)).toBe(false);
        expect(seen.every((event) => event.owner === "edge")).toBe(true);
      } finally {
        abort.abort();
        await foreign.remove({ force: true }).catch(() => {});
      }
    },
    LONG,
  );

  test(
    "an agent paired before containers carried the label adopts what MiniBox made until then, once, and nothing else",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "minibox-agent-adopt-"));
      dirs.push(dir);
      const engine = createDockerRuntime(SOCKET);
      const network = `${prefix}-egress-legacy`;
      const create = (name: string, labels: Record<string, string>) =>
        docker.createContainer({ Image: IMAGE, name, Cmd: ["sleep", "300"], Labels: labels });
      // What an older MiniBox made on this host: the install's labels and no label of the agent's.
      const legacy = await create(`${prefix}-agent-legacy`, { [prefix]: "true", [keys.box]: "true" });
      // Somebody else's container, which carries nothing of MiniBox's.
      const stranger = await create(`${prefix}-agent-stranger`, {});
      const created: Docker.Container[] = [legacy, stranger];
      await docker.createNetwork({ Name: network });
      try {
        const scope = new AgentScope({
          hostId: "edge",
          dataDir: dir,
          runtime: engine,
          record: null,
          findSelf: async () => null,
        });
        const agent = scopedRuntime(engine, scope);
        const ids = async () => (await agent.listContainers({ labels: {} })).map((info) => info.id);

        // Until the control plane welcomes the agent and names its prefix, nothing that was there before is its own.
        expect(await ids()).not.toContain(legacy.id);

        scope.begin(prefix);
        expect(await ids()).toContain(legacy.id);
        expect(await ids()).not.toContain(stranger.id);
        // A network made before networks were labelled is known by its name.
        expect((await agent.listNetworks()).map((listed) => listed.name)).toContain(network);
        expect(loadScope(dir, "edge")?.adopted.containers).toContain(legacy.id);

        // It adopts once: what carries the prefix after that is nobody's.
        const newer = await create(`${prefix}-agent-later`, { [prefix]: "true" });
        created.push(newer);
        expect(await ids()).not.toContain(newer.id);

        // What it adopted it can manage, and what it did not adopt it cannot.
        await agent.removeContainer(legacy.id, { force: true });
        expect(await docker.listContainers({ all: true, filters: { id: [legacy.id] } })).toEqual([]);
        expect((await refusal(() => agent.removeContainer(stranger.id, { force: true }))).kind).toBe("not_found");
        expect(await docker.listContainers({ all: true, filters: { id: [stranger.id] } })).toHaveLength(1);
      } finally {
        for (const container of created) await container.remove({ force: true }).catch(() => {});
        await docker
          .getNetwork(network)
          .remove()
          .catch(() => {});
      }
    },
    LONG,
  );

  test(
    "the agent finds the container it runs in from its mount table, and the volumes that container mounts",
    async () => {
      const volume = `${prefix}-agent-self-vol`;
      await docker.createVolume({ Name: volume, Labels: { [prefix]: "true" } });
      const self = await docker.createContainer({
        Image: IMAGE,
        name: `${prefix}-agent-self`,
        Cmd: ["sleep", "300"],
        Labels: { [prefix]: "true" },
        HostConfig: { Binds: [`${volume}:/data`] },
      });
      try {
        // An engine bind-mounts a container's hostname file from a directory named for it, which is what a process in
        // the container finds in its own mount table.
        const mountinfo = `1 2 0:1 /var/lib/docker/containers/${self.id}/hostname /etc/hostname rw,relatime - ext4 /dev/sda1 rw\n`;
        const found = await findSelf(createDockerRuntime(SOCKET), {
          mountinfo: () => mountinfo,
          hostname: () => "not-an-id",
        });
        expect(found?.containerId).toBe(self.id);
        expect(found?.volumes.has(volume)).toBe(true);
      } finally {
        await self.remove({ force: true }).catch(() => {});
        await docker
          .getVolume(volume)
          .remove()
          .catch(() => {});
      }
    },
    LONG,
  );

  test(
    "revoking the agent drops it at once: its box stays on the engine, and a command on it is refused",
    async () => {
      const revoked = await api("/api/hosts/edge/revoke", { method: "POST" });
      expect(revoked.status).toBe(200);
      await waitFor(() => client?.connectionState === "dormant", "the agent to go dormant", 10_000);
      expect(app.hosts.get("edge").host.status).toBe("offline");

      expect((await containersNamed("agent-box")).length).toBe(1);
      const res = await post(`/api/boxes/${boxId}/exec`, { cmd: "true", user: "root", cwd: "/" });
      expect(res.status).not.toBe(200);
    },
    LONG,
  );
});
