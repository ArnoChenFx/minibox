import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Server } from "bun";

import { generateKeyPairPem } from "../src/agent/identity";
import { AGENT_PAIR_PATH, AGENT_PROTOCOL } from "../src/agent/protocol";
import { type App, createApp } from "../src/app";
import { newCheckpointId } from "../src/checkpoints/id";
import { SCHEDULE_VERSION } from "../src/checkpoints/schedule";
import { ROLLBACK_VERSION } from "../src/checkpoints/types";
import { hostsPath } from "../src/data-dir";
import { setLogSink } from "../src/lib/logger";
import { startServer } from "../src/server";
import { newBoxId } from "../src/specs/revision";
import { requiredScopes, scopeAllowed } from "../src/tokens/model";
import type { SocketData } from "../src/ws/socket";
import { silenceLogs, TEST_KEY, testConfig } from "./support/app";
import { FakeRuntime } from "./support/fake-runtime";
import { FakeCheckpointEngine } from "./support/fake-snapshots";

const GIB = 1024 ** 3;
const EDGE_SOCKET = "/run/minibox-test/force-remove-edge.sock";

let app: App;
let server: Server<SocketData>;
let base: string;
let local: FakeRuntime;
let edge: FakeRuntime;
let restoreLogs: () => void;
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "minibox-force-remove-"));
  dirs.push(dir);
  return dir;
}

function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${TEST_KEY}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers });
}

const post = (path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });

type ErrorBody = {
  code: string;
  key?: string;
  details?: {
    preview?: {
      host: { id: string; name: string };
      counts: { boxes: number; volumes: number; checkpoints: number };
      boxes: { id: string; name: string }[];
      volumes: { name: string; engineName: string }[];
      checkpoints: { id: string; label: string }[];
      digest: string;
    };
  };
};

async function errorOf(res: Response): Promise<ErrorBody> {
  return ((await res.json()) as { error: ErrorBody }).error;
}

async function waitForTask(taskId: string): Promise<string> {
  for (;;) {
    const view = (await (await api(`/api/tasks/${taskId}`)).json()) as { status: string };
    if (view.status !== "running") return view.status;
    await Bun.sleep(5);
  }
}

async function boxOn(host: string | undefined, name: string) {
  const res = await post("/api/boxes", { name, cpus: 1, memoryMb: 256, host });
  expect(res.status).toBe(201);
  return ((await res.json()) as { box: { id: string; boxId: string; hostId?: string } }).box;
}

async function takeCheckpoint(boxId: string) {
  const started = await post(`/api/boxes/${boxId}/checkpoints`, { label: "before-loss" });
  expect(started.status).toBe(202);
  const { taskId } = (await started.json()) as { taskId: string };
  expect(await waitForTask(taskId)).toBe("succeeded");
  const done = (await (await api(`/api/tasks/${taskId}`)).json()) as {
    result: { checkpoint: { id: string; label: string; hostId: string } };
  };
  return done.result.checkpoint;
}

/** Waits until `condition` holds, so a test can be sure an engine call it held has been reached. */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

/** A spec of one host to clone, so a test can write a record the preview did not see. */
function straySpec(hostId: string, name: string) {
  const host = app.hosts.get(hostId);
  const source = host.specs.list().find((spec) => spec.hostId === hostId);
  if (!source) throw new Error(`no spec on ${hostId} to clone`);
  return {
    ...source,
    id: newBoxId(),
    name,
    createdName: name,
    containerName: `mbfrc-${name}`,
    containerId: "a".repeat(64),
    revision: 1,
    history: [],
  };
}

/** A checkpoint schedule on one box, written directly so a test can set one up without the scheduler. */
function writeSchedule(hostId: string, boxId: string): void {
  const now = new Date().toISOString();
  app.hosts.get(hostId).checkpoints.writeSchedule({
    version: SCHEDULE_VERSION,
    hostId,
    boxId,
    mode: "interval",
    everyHours: 6,
    at: null,
    timezone: null,
    createdBy: "owner",
    createdAt: now,
    updatedAt: now,
    nextRunAt: now,
    lastRun: null,
  });
}

/** A rollback waiting for its confirm or undo, written directly, with no volumes to replace. */
function writePendingRollback(hostId: string, boxId: string): void {
  const checkpointId = newCheckpointId();
  app.hosts.get(hostId).checkpoints.writePendingRollback({
    version: ROLLBACK_VERSION,
    hostId,
    boxId,
    boxName: "pending",
    checkpointId,
    checkpointLabel: "before-loss",
    safetyCheckpointId: checkpointId,
    createdBy: "owner",
    createdAt: new Date().toISOString(),
    replaced: [],
    restored: [],
  });
}

/** What the shared stores still record for one host, read without any host context. */
function recordsOf(hostId: string) {
  const store = app.hosts.get();
  return {
    specs: store.specs
      .list()
      .filter((spec) => spec.hostId === hostId)
      .map((spec) => spec.id)
      .toSorted(),
    volumes: store.volumes
      .list()
      .filter((volume) => volume.hostId === hostId)
      .map((volume) => volume.id)
      .toSorted(),
    checkpoints: store.checkpoints
      .list()
      .filter((checkpoint) => checkpoint.hostId === hostId)
      .map((checkpoint) => checkpoint.id)
      .toSorted(),
  };
}

/** The host list as the hosts file holds it, so a removal can be checked to have reached the file too. */
function hostsFile(): string {
  return readFileSync(hostsPath(app.cfg.dataDir), "utf8");
}

beforeEach(async () => {
  restoreLogs = silenceLogs();
  local = new FakeRuntime();
  edge = new FakeRuntime();
  edge.engine = { cpus: 2, memoryBytes: 4 * GIB };
  app = createApp(testConfig({ labelPrefix: "mbfrc", dataDir: tempDir() }), "0.0.0-test", {
    runtime: local,
    connect: () => edge,
    checkpointEngine: new FakeCheckpointEngine(),
    eventsPath: ":memory:",
  });
  const keys = app.hosts.get().keys;
  for (const runtime of [local, edge]) {
    runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
  }
  server = startServer(app);
  base = `http://127.0.0.1:${server.port}`;
  const added = await post("/api/hosts", { id: "edge", endpoint: `unix://${EDGE_SOCKET}` });
  expect(added.status).toBe(201);
});

afterEach(() => {
  app.hostAdmin.close();
  app.sessions.stop();
  app.tokens.stop();
  server.stop(true);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  restoreLogs();
});

describe("force removal is the owner's, and only for a host that is gone", () => {
  test("a token is refused whichever scopes it carries: host:manage maps to no token scope", async () => {
    const made = await post("/api/tokens", { name: "admin", preset: "admin" });
    expect(made.status).toBe(201);
    const secret = ((await made.json()) as { token: string }).token;
    const res = await fetch(`${base}/api/hosts/edge/force-remove`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.status).toBe(403);
    expect(app.hosts.has("edge")).toBe(true);
    // Even a stored grant that named the operation's scope would not pass: the mapping leaves host:manage to the owner.
    expect(requiredScopes("host:manage")).toBe("owner");
    expect(scopeAllowed({ scopes: ["host:manage"], storageAdmin: true } as never, "host:manage")).toBe(false);
  });

  test("a host that answers is refused, and the refusal says to remove it the ordinary way", async () => {
    const refused = await post("/api/hosts/edge/force-remove", { confirm: true });
    expect(refused.status).toBe(409);
    expect(await errorOf(refused)).toMatchObject({ code: "conflict", key: "host_not_offline" });
    expect(app.hosts.has("edge")).toBe(true);
  });

  test("the local host is refused, and an unknown id is not found", async () => {
    const atHome = await post("/api/hosts/local/force-remove", { confirm: true });
    expect(atHome.status).toBe(409);
    expect(await errorOf(atHome)).toMatchObject({ code: "conflict", key: "host_is_local" });

    const missing = await post("/api/hosts/nowhere/force-remove", { confirm: true });
    expect(missing.status).toBe(404);
    expect(await errorOf(missing)).toMatchObject({ code: "not_found", key: "host_not_found" });
  });
});

describe("a forced removal previews, then discards only that host's records", () => {
  test("without confirm nothing changes, and the 409 preview lists the boxes, volumes and checkpoints", async () => {
    const box = await boxOn("edge", "alpha");
    const checkpoint = await takeCheckpoint(box.boxId);
    edge.down = true;
    await app.hostAdmin.refresh();
    expect(app.hosts.get("edge").host.status).toBe("offline");

    const before = recordsOf("edge");
    const file = hostsFile();
    const volumeRecords = app.hosts
      .get("edge")
      .volumes.list()
      .filter((volume) => volume.hostId === "edge");

    const res = await post("/api/hosts/edge/force-remove", {});
    expect(res.status).toBe(409);
    const error = await errorOf(res);
    expect(error).toMatchObject({
      code: "confirmation_required",
      key: "host_force_remove_confirm",
      details: {
        preview: {
          host: { id: "edge", name: "edge" },
          counts: {
            boxes: 1,
            volumes: volumeRecords.length,
            checkpoints: 1,
          },
          boxes: [{ id: box.boxId, name: "alpha" }],
          checkpoints: [{ id: checkpoint.id, label: "before-loss" }],
        },
      },
    });
    const previewVolumes = error.details?.preview?.volumes ?? [];
    expect(
      previewVolumes
        .map(({ name, engineName }) => ({ name, engineName }))
        .toSorted((a, b) => a.engineName.localeCompare(b.engineName)),
    ).toEqual(
      volumeRecords
        .map(({ name, engineName }) => ({ name, engineName }))
        .toSorted((a, b) => a.engineName.localeCompare(b.engineName)),
    );

    // The preview is a refusal: the host, its records and the hosts file are as they were.
    expect(app.hosts.has("edge")).toBe(true);
    expect(recordsOf("edge")).toEqual(before);
    expect(hostsFile()).toBe(file);
    const listed = (await (await api("/api/boxes")).json()) as { boxes: { name: string }[] };
    expect(listed.boxes.map((item) => item.name)).toContain("alpha");
  });

  test("with confirm the host and its records go, no engine is called, and another host's records are untouched", async () => {
    const lost = await boxOn("edge", "alpha");
    const kept = await boxOn("local", "beta");
    const lostCheckpoint = await takeCheckpoint(lost.boxId);
    const keptCheckpoint = await takeCheckpoint(kept.boxId);
    const keptRecords = recordsOf("local");
    const lostVolumes = app.hosts
      .get("edge")
      .volumes.list()
      .filter((volume) => volume.hostId === "edge");
    const lostVolumeIds = lostVolumes.map((volume) => volume.id).toSorted();

    edge.down = true;
    await app.hostAdmin.refresh();
    expect(app.hosts.get("edge").host.status).toBe("offline");

    const callsBefore = edge.calls.length;
    const lines: string[] = [];
    const restore = setLogSink((_level, line) => lines.push(line));
    let body: {
      host: { id: string; name: string; status: string; boxes: number };
      discarded: {
        boxes: { id: string; name: string }[];
        volumes: { name: string; engineName: string }[];
        checkpoints: { id: string; label: string }[];
      };
    };
    try {
      const res = await post("/api/hosts/edge/force-remove", { confirm: true });
      expect(res.status).toBe(200);
      body = (await res.json()) as typeof body;
    } finally {
      restore();
    }

    // Nothing was sent to the machine: not a ping, not an inspect, and nothing to remove the container or volume with.
    expect(edge.calls.length).toBe(callsBefore);
    expect(app.hosts.has("edge")).toBe(false);
    expect(body.host).toMatchObject({ id: "edge", status: "offline" });
    // The view is taken before the records go, so it still counts the box the discard then forgets.
    expect(body.host.boxes).toBe(body.discarded.boxes.length);
    expect(body.discarded.boxes).toEqual([{ id: lost.boxId, name: "alpha" }]);
    expect(body.discarded.volumes.map((volume) => volume.engineName).toSorted()).toEqual(
      lostVolumes.map((volume) => volume.engineName).toSorted(),
    );
    expect(body.discarded.checkpoints).toEqual([{ id: lostCheckpoint.id, label: "before-loss" }]);

    // The rest of the control plane no longer names the host or anything it held.
    const hosts = (await (await api("/api/hosts")).json()) as { hosts: { id: string }[] };
    expect(hosts.hosts.map((host) => host.id)).toEqual(["local"]);
    const boxes = (await (await api("/api/boxes")).json()) as { boxes: { name: string; hostId?: string }[] };
    expect(boxes.boxes.map((box) => box.name)).toEqual(["beta"]);
    const store = app.hosts.get();
    expect(store.specs.read(lost.boxId)).toBeNull();
    expect(store.checkpoints.read(lostCheckpoint.id)).toBeNull();
    expect(store.volumes.list().filter((volume) => lostVolumeIds.includes(volume.id))).toEqual([]);
    expect(hostsFile()).not.toContain('"edge"');

    // The other host's box, volumes and checkpoint are every one of them still there.
    expect(recordsOf("local")).toEqual(keptRecords);
    expect(store.specs.read(kept.boxId)?.name).toBe("beta");
    expect(store.checkpoints.read(keptCheckpoint.id)?.hostId).toBe("local");

    // The log records what left, at warn level, and the audit event carries the same list.
    const forced = lines.filter((line) => line.includes('"msg":"host.force_removed"'));
    expect(forced).toHaveLength(1);
    const logged = JSON.parse(forced[0] ?? "{}") as Record<string, unknown> & { volumes: string[] };
    expect(logged).toMatchObject({
      level: "warn",
      host: "edge",
      boxes: [{ id: lost.boxId, name: "alpha" }],
      checkpoints: [lostCheckpoint.id],
    });
    expect(logged.volumes.toSorted()).toEqual(lostVolumes.map((volume) => volume.name).toSorted());
    const events = (
      (await (await api("/api/events?op=host.remove.force&limit=10")).json()) as {
        events: { status: string; detail?: Record<string, unknown> }[];
      }
    ).events;
    const removed = events.find((event) => event.status === "ok");
    const detail = removed?.detail as
      | { host: string; boxes: unknown; volumes: { name: string; engineName: string }[]; checkpoints: unknown }
      | undefined;
    expect(detail).toMatchObject({
      host: "edge",
      boxes: [{ id: lost.boxId, name: "alpha" }],
      checkpoints: [{ id: lostCheckpoint.id, label: "before-loss" }],
    });
    expect(detail?.volumes.toSorted((a, b) => a.engineName.localeCompare(b.engineName))).toEqual(
      lostVolumes
        .map(({ name, engineName }) => ({ name, engineName }))
        .toSorted((a, b) => a.engineName.localeCompare(b.engineName)),
    );
  });

  test("an agent host's agent is forgotten with it, so it cannot connect again", async () => {
    const issued = await post("/api/hosts/pairing", { id: "edge2", name: "Edge lab" });
    expect(issued.status).toBe(201);
    const { code } = (await issued.json()) as { code: string };
    const keys = generateKeyPairPem();
    const paired = await fetch(`${base}${AGENT_PAIR_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, publicKey: keys.publicKeyPem, version: "0.4.0", protocol: AGENT_PROTOCOL }),
    });
    expect(paired.status).toBe(201);
    const { agentId, hostId } = (await paired.json()) as { agentId: string; hostId: string };
    expect(app.agents.record(agentId)).toBeDefined();
    // No agent is connected, so its engine answers nothing and the host is offline.
    await app.hostAdmin.refresh();
    expect(app.hosts.get(hostId).host.status).toBe("offline");

    const res = await post(`/api/hosts/${hostId}/force-remove`, { confirm: true });
    expect(res.status).toBe(200);
    expect(app.hosts.has(hostId)).toBe(false);
    // Forgotten, not merely revoked: there is no record left to authenticate with.
    expect(app.agents.record(agentId)).toBeUndefined();
    expect(app.agents.status(agentId)).toBeNull();
  });
});

describe("a record written while the removal runs cannot come back", () => {
  test("a create held before its spec writes nothing after the host is removed", async () => {
    const gate = edge.hold("runHelper");
    const creating = post("/api/boxes", { name: "late", cpus: 1, memoryMb: 256, host: "edge" });
    // The create has written its volume records and is held in a helper, before its spec lock.
    await until(() => edge.callsTo("runHelper").length > 0, "the create to reach its helper");
    app.hosts.get("edge").host.status = "offline";

    const forced = await post("/api/hosts/edge/force-remove", { confirm: true });
    expect(forced.status).toBe(200);
    gate.release();

    const late = await creating;
    expect(late.status).toBe(409);
    expect(await errorOf(late)).toMatchObject({ key: "host_gone" });
    expect(recordsOf("edge")).toEqual({ specs: [], volumes: [], checkpoints: [] });

    // Adding the id again lists no ghost of the box the held create would have made.
    const readded = await post("/api/hosts", { id: "edge", endpoint: `unix://${EDGE_SOCKET}` });
    expect(readded.status).toBe(201);
    const listed = (await (await api("/api/boxes")).json()) as { boxes: { name: string }[] };
    expect(listed.boxes.map((box) => box.name)).not.toContain("late");
  });

  test("each store refuses a write for a closed host on its own, and takes it again once the host is reopened", async () => {
    const box = await boxOn("edge", "alpha");
    await takeCheckpoint(box.boxId);
    const store = app.hosts.get("edge");
    const spec = store.specs.list().find((item) => item.hostId === "edge");
    const volume = store.volumes.list().find((item) => item.hostId === "edge");
    const checkpoint = store.checkpoints.list().find((item) => item.hostId === "edge");
    if (!spec || !volume || !checkpoint)
      throw new Error("the edge host holds no spec, volume or checkpoint to write back");
    // Each store is closed alone, so a guard that the other two cover would not hide a missing one.
    const stores = [
      { name: "spec", target: store.specs, write: () => store.specs.write(spec) },
      { name: "volume", target: store.volumes, write: () => store.volumes.write(volume) },
      { name: "checkpoint", target: store.checkpoints, write: () => store.checkpoints.write(checkpoint) },
    ];
    for (const { name, target, write } of stores) {
      target.closeHost("edge");
      expect(write, `${name} write while closed`).toThrow(expect.objectContaining({ key: "host_gone" }));
      target.openHost("edge");
      expect(write, `${name} write once reopened`).not.toThrow();
    }
  });

  test("a spec that moved to another host before the discard is left alone", async () => {
    const box = await boxOn("edge", "alpha");
    edge.down = true;
    await app.hostAdmin.refresh();
    const host = app.hosts.get("edge");
    const spec = host.specs.read(box.boxId);
    if (!spec) throw new Error("the box spec is missing");
    // commitMove writes the spec with the target's hostId, between the preview and the locked discard.
    host.specs.write({ ...spec, hostId: "local" });

    const res = await post("/api/hosts/edge/force-remove", { confirm: true });
    expect(res.status).toBe(200);
    // The spec is not this host's record any more, so it stays: only edge's other records go.
    expect(host.specs.read(box.boxId)?.hostId).toBe("local");
    expect(recordsOf("edge")).toEqual({ specs: [], volumes: [], checkpoints: [] });
  });
});

describe("a confirmation names the set of records its preview saw", () => {
  test("a changed digest answers 409 host_records_changed and discards nothing", async () => {
    await boxOn("edge", "alpha");
    edge.down = true;
    await app.hostAdmin.refresh();
    const previewed = await errorOf(await post("/api/hosts/edge/force-remove", {}));
    const digest = previewed.details?.preview?.digest ?? "";
    expect(digest).toMatch(/^[0-9a-f]{16}$/);

    const host = app.hosts.get("edge");
    const sneaked = straySpec("edge", "sneaked");
    host.specs.write(sneaked);
    const before = recordsOf("edge");

    const changed = await post("/api/hosts/edge/force-remove", { confirm: true, digest });
    expect(changed.status).toBe(409);
    const refused = await errorOf(changed);
    expect(refused).toMatchObject({ code: "conflict", key: "host_records_changed" });
    expect(refused.details?.preview?.digest).not.toBe(digest);
    expect(refused.details?.preview?.boxes.map((box) => box.name).toSorted()).toEqual(["alpha", "sneaked"]);
    // Nothing was removed, the host is still listed and its stores accept writes again.
    expect(recordsOf("edge")).toEqual(before);
    expect(app.hosts.has("edge")).toBe(true);
    expect(host.specs.isClosed("edge")).toBe(false);

    // The fresh preview's digest confirms, and both records go.
    const fresh = await errorOf(await post("/api/hosts/edge/force-remove", {}));
    const done = await post("/api/hosts/edge/force-remove", {
      confirm: true,
      digest: fresh.details?.preview?.digest,
    });
    expect(done.status).toBe(200);
    const body = (await done.json()) as { discarded: { boxes: { name: string }[] } };
    expect(body.discarded.boxes.map((box) => box.name).toSorted()).toEqual(["alpha", "sneaked"]);
    expect(recordsOf("edge")).toEqual({ specs: [], volumes: [], checkpoints: [] });
  });

  test("without a digest the call still discards whatever the host holds, and reports it", async () => {
    await boxOn("edge", "alpha");
    edge.down = true;
    await app.hostAdmin.refresh();
    expect((await post("/api/hosts/edge/force-remove", {})).status).toBe(409);

    app.hosts.get("edge").specs.write(straySpec("edge", "sneaked"));
    const done = await post("/api/hosts/edge/force-remove", { confirm: true });
    expect(done.status).toBe(200);
    const body = (await done.json()) as { host: { boxes: number }; discarded: { boxes: { name: string }[] } };
    expect(body.discarded.boxes.map((box) => box.name).toSorted()).toEqual(["alpha", "sneaked"]);
    expect(body.host.boxes).toBe(2);
    expect(recordsOf("edge")).toEqual({ specs: [], volumes: [], checkpoints: [] });
  });
});

describe("the linked records a forced removal and a box delete clear", () => {
  test("a forced removal clears the box's checkpoint schedule and pending rollback", async () => {
    const box = await boxOn("edge", "scheduled");
    await takeCheckpoint(box.boxId);
    const host = app.hosts.get("edge");
    writeSchedule("edge", box.boxId);
    writePendingRollback("edge", box.boxId);
    expect(host.checkpoints.readSchedule(box.boxId)).not.toBeNull();
    expect(host.checkpoints.pendingRollback(box.boxId)).not.toBeNull();

    edge.down = true;
    await app.hostAdmin.refresh();
    expect((await post("/api/hosts/edge/force-remove", { confirm: true })).status).toBe(200);
    expect(host.checkpoints.readSchedule(box.boxId)).toBeNull();
    expect(host.checkpoints.pendingRollback(box.boxId)).toBeNull();
    expect(host.checkpoints.schedules().filter((item) => item.hostId === "edge")).toEqual([]);
    expect(host.checkpoints.pendingRollbacks().filter((item) => item.hostId === "edge")).toEqual([]);
  });

  test("stale schedules and rollbacks that name the host go too when their box is already gone", async () => {
    const ghost = newBoxId();
    writeSchedule("edge", ghost);
    writePendingRollback("edge", ghost);
    // The box itself is not in the specs store: only the host id ties these two records to it.
    expect(app.hosts.get("edge").specs.read(ghost)).toBeNull();
    edge.down = true;
    await app.hostAdmin.refresh();

    expect((await post("/api/hosts/edge/force-remove", { confirm: true })).status).toBe(200);
    expect(app.hosts.get().checkpoints.schedules()).toEqual([]);
    expect(app.hosts.get().checkpoints.pendingRollbacks()).toEqual([]);
  });

  test("deleting a box clears its checkpoint schedule and pending rollback", async () => {
    const box = await boxOn("local", "planned");
    await takeCheckpoint(box.boxId);
    writeSchedule("local", box.boxId);
    writePendingRollback("local", box.boxId);
    const host = app.hosts.get();
    expect(host.checkpoints.readSchedule(box.boxId)).not.toBeNull();
    expect(host.checkpoints.pendingRollback(box.boxId)).not.toBeNull();

    const deleted = await api(`/api/boxes/${box.boxId}?skipTrash=true`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(host.checkpoints.readSchedule(box.boxId)).toBeNull();
    expect(host.checkpoints.pendingRollback(box.boxId)).toBeNull();
  });
});
