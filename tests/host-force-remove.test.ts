import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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
import { sharedStore } from "../src/host/gone";
import { setLogSink } from "../src/lib/logger";
import { startServer } from "../src/server";
import { createBox } from "../src/services/box-create";
import { newBoxId } from "../src/specs/revision";
import { requiredScopes, scopeAllowed } from "../src/tokens/model";
import { reserveVolumeRemoval, reserveVolumeSnapshot } from "../src/volumes/activity";
import type { SocketData } from "../src/ws/socket";
import { silenceLogs, rejectionOf, TEST_KEY, testConfig } from "./support/app";
import { FakeRuntime, type Op } from "./support/fake-runtime";
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

/** A stored S3 target for the remote checkpoint repository of a host. No copy is run, so nothing is reached. */
function archiveTarget(): string {
  return app.targets.add("archive", {
    kind: "s3",
    path: "minibox",
    endpoint: "https://s3.example.com",
    region: "us-east-1",
    bucket: "archive",
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "test-only-secret-key",
  }).id;
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

test("a create finishing after force removal cannot restore its self token", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  const originalStart = edge.startContainer.bind(edge);
  edge.startContainer = async (id) => {
    entered = true;
    await held;
    await originalStart(id);
  };
  const creating = post("/api/boxes", { name: "late-token", cpus: 1, memoryMb: 256, host: "edge", selfToken: true });
  await until(() => entered, "start to be held");
  const box = app.hosts
    .get("edge")
    .specs.list()
    .find((s) => s.name === "late-token")!;
  expect(box).toBeDefined();
  app.hosts.get("edge").host.status = "offline";
  expect((await post("/api/hosts/edge/force-remove", { confirm: true })).status).toBe(200);
  release();
  expect((await creating).status).toBe(409);
  expect(app.selfTokens.has(box.id)).toBe(false);
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
    // Reusing the id must not revive the old request's registration.
    const readded = await post("/api/hosts", { id: "edge", endpoint: `unix://${EDGE_SOCKET}` });
    expect(readded.status).toBe(201);
    gate.release();

    const late = await creating;
    expect(late.status).toBe(409);
    expect(await errorOf(late)).toMatchObject({ key: "host_gone" });
    expect(recordsOf("edge")).toEqual({ specs: [], volumes: [], checkpoints: [] });
    // The container is not made at all: the registration it holds is gone, though a host of the same id is back.
    expect(edge.callsTo("createContainer")).toEqual([]);

    // Adding the id again lists no ghost of the box the held create would have made.
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

  test("old host views remain fenced after re-registration while the new host can write", async () => {
    const box = await boxOn("edge", "alpha");
    await takeCheckpoint(box.boxId);
    const old = app.hosts.get("edge");
    writeSchedule("edge", box.boxId);
    writePendingRollback("edge", box.boxId);
    const schedule = old.checkpoints.readSchedule(box.boxId)!;
    const pending = old.checkpoints.pendingRollback(box.boxId)!;
    const spec = old.specs.read(box.boxId)!;
    const volume = old.volumes.list().find((item) => item.hostId === "edge")!;
    const checkpoint = old.checkpoints.list().find((item) => item.hostId === "edge")!;
    edge.down = true;
    await app.hostAdmin.refresh();
    expect((await post("/api/hosts/edge/force-remove", { confirm: true })).status).toBe(200);
    edge.down = false;
    expect((await post("/api/hosts", { id: "edge", endpoint: `unix://${EDGE_SOCKET}` })).status).toBe(201);
    const fresh = app.hosts.get("edge");
    for (const write of [
      () => old.specs.write(spec),
      () => old.volumes.write(volume),
      () => old.checkpoints.write(checkpoint),
      () => old.checkpoints.writeSchedule(schedule),
      () => old.checkpoints.writePendingRollback(pending),
      () => old.selfTokens.issue(box.boxId, "alpha"),
    ])
      expect(write).toThrow(expect.objectContaining({ key: "host_gone" }));
    expect(() => fresh.specs.write(spec)).not.toThrow();
    expect(() => fresh.volumes.write(volume)).not.toThrow();
    expect(() => fresh.checkpoints.write(checkpoint)).not.toThrow();
    expect(() => fresh.checkpoints.writeSchedule(schedule)).not.toThrow();
    expect(() => fresh.checkpoints.writePendingRollback(pending)).not.toThrow();
    expect(fresh.selfTokens.issue(box.boxId, "alpha")).toBeString();
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

describe("removing a host clears its remote checkpoint repository", () => {
  test("an ordinary removal drops the host's remote record, and its target can be removed", async () => {
    const targetId = archiveTarget();
    app.targets.setRemote("edge", { targetId });
    expect(app.targets.remoteOf("edge")).not.toBeNull();

    expect((await api("/api/hosts/edge", { method: "DELETE" })).status).toBe(200);

    expect(app.hosts.has("edge")).toBe(false);
    expect(app.targets.remoteOf("edge")).toBeNull();
    app.targets.remove(targetId);
    expect(app.targets.list()).toEqual([]);
  });

  test("a forced removal of a remote-only host drops its record too, and its target can be removed", async () => {
    const targetId = archiveTarget();
    app.targets.setRemote("edge", { targetId, mode: "only" });
    const box = await boxOn("edge", "alpha");
    await takeCheckpoint(box.boxId);
    expect(
      app.hosts
        .get("edge")
        .checkpoints.list()
        .filter((record) => record.hostId === "edge"),
    ).toHaveLength(1);
    edge.down = true;
    await app.hostAdmin.refresh();

    expect((await post("/api/hosts/edge/force-remove", { confirm: true })).status).toBe(200);

    expect(app.targets.remoteOf("edge")).toBeNull();
    app.targets.remove(targetId);
    expect(app.targets.list()).toEqual([]);
  });

  test("the copy state kept for a removed host in memory goes with it", async () => {
    const targetId = archiveTarget();
    app.targets.setRemote("edge", { targetId });
    const box = await boxOn("edge", "alpha");
    await takeCheckpoint(box.boxId);
    const host = app.hosts.get("edge");
    const engine = host.checkpointEngine as FakeCheckpointEngine;
    engine.failRemoteCopy = true;
    expect(await rejectionOf(app.checkpointRemote.syncHost(host))).toBeInstanceOf(Error);
    expect(app.checkpointRemote.stateOf("edge").failures).toBe(1);

    edge.down = true;
    await app.hostAdmin.refresh();
    expect((await post("/api/hosts/edge/force-remove", { confirm: true })).status).toBe(200);

    expect(app.checkpointRemote.stateOf("edge")).toEqual({ failures: 0, lastFailure: null });
  });

  test("a record that cannot be dropped does not keep the copy state or hold the removal", async () => {
    const targetId = archiveTarget();
    app.targets.setRemote("edge", { targetId });
    const box = await boxOn("edge", "alpha");
    await takeCheckpoint(box.boxId);
    const host = app.hosts.get("edge");
    (host.checkpointEngine as FakeCheckpointEngine).failRemoteCopy = true;
    expect(await rejectionOf(app.checkpointRemote.syncHost(host))).toBeInstanceOf(Error);
    expect(app.checkpointRemote.stateOf("edge").failures).toBe(1);
    spyOn(app.targets, "forgetHost").mockImplementation(() => {
      throw new Error("targets.json cannot be written");
    });

    edge.down = true;
    await app.hostAdmin.refresh();
    expect((await post("/api/hosts/edge/force-remove", { confirm: true })).status).toBe(200);

    expect(app.hosts.has("edge")).toBe(false);
    expect(app.checkpointRemote.stateOf("edge")).toEqual({ failures: 0, lastFailure: null });
  });
});

/** Takes the edge host away, then adds the same id again, so a request holding the old registration meets a live host. */
async function removeAndReadd(): Promise<void> {
  app.hosts.get("edge").host.status = "offline";
  expect((await post("/api/hosts/edge/force-remove", { confirm: true })).status).toBe(200);
  expect((await post("/api/hosts", { id: "edge", endpoint: `unix://${EDGE_SOCKET}` })).status).toBe(201);
}

/** The engine calls that make something. A request on a removed registration must make none after the removal. */
const MAKING: readonly Op[] = ["createVolume", "runHelper", "createContainer", "startContainer"];
const madeSince = (from: number): Op[] =>
  edge.calls
    .slice(from)
    .map((call) => call.op)
    .filter((op) => MAKING.includes(op));

/**
 * Makes the first call of `runtime` to `method` wait until `release`. `hold` can gate only the engine calls that
 * FakeRuntime awaits a gate in, and these two are not among them.
 */
function stallOnce(runtime: FakeRuntime, method: "ensureBridgeNetwork" | "setHostIngressBlock") {
  const original = runtime[method].bind(runtime) as (...args: unknown[]) => Promise<unknown>;
  let reached = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  (runtime as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
    if (reached) return original(...args);
    reached = true;
    await gate;
    return original(...args);
  };
  return { reached: () => reached, release };
}

describe("a create that holds a removed registration stops at its next step", () => {
  test("a create begun on the old registration makes nothing once the id is back", async () => {
    const old = app.hosts.get("edge");
    await removeAndReadd();
    const from = edge.calls.length;
    await expect(createBox(old, { name: "stale", cpus: 1, memoryMb: 256 })).rejects.toMatchObject({ key: "host_gone" });
    expect(madeSince(from)).toEqual([]);
    // Not even the shared network is made for it.
    expect(edge.callsTo("ensureBridgeNetwork")).toEqual([]);
  });

  test("a create held before its first lock makes no volume or container once the id is back", async () => {
    // The create is on its way to the first spec lock, with the box network still to be checked.
    const stall = stallOnce(edge, "ensureBridgeNetwork");
    const creating = post("/api/boxes", { name: "early", cpus: 1, memoryMb: 256, host: "edge" });
    await until(stall.reached, "the create to reach the box network");
    await removeAndReadd();
    const from = edge.calls.length;
    stall.release();

    const late = await creating;
    expect(late.status).toBe(409);
    expect(await errorOf(late)).toMatchObject({ key: "host_gone" });
    expect(madeSince(from)).toEqual([]);
    expect(recordsOf("edge")).toEqual({ specs: [], volumes: [], checkpoints: [] });
  });

  test("a create held after its volumes, before its spec lock, makes no container once the id is back", async () => {
    // The helper that hands the new volumes to the box's user runs after the last volume is made, before the spec lock.
    const gate = edge.hold("runHelper", () => edge.callsTo("createVolume").length > 0);
    const creating = post("/api/boxes", { name: "volumes", cpus: 1, memoryMb: 256, host: "edge" });
    await until(() => {
      const made = edge.calls.findIndex((call) => call.op === "createVolume");
      return made >= 0 && edge.calls.slice(made).some((call) => call.op === "runHelper");
    }, "the volume helper");
    await removeAndReadd();
    const from = edge.calls.length;
    gate.release();

    const late = await creating;
    expect(late.status).toBe(409);
    expect(await errorOf(late)).toMatchObject({ key: "host_gone" });
    expect(madeSince(from)).toEqual([]);
  });

  test("a create held after its spec never starts its container once the id is back", async () => {
    const stall = stallOnce(edge, "setHostIngressBlock");
    const creating = post("/api/boxes", {
      name: "walled",
      cpus: 1,
      memoryMb: 256,
      host: "edge",
      egress: { mode: "proxy-only", presets: ["agent-default"] },
    });
    await until(stall.reached, "the create to reach the host firewall");
    await removeAndReadd();
    const from = edge.calls.length;
    stall.release();

    const late = await creating;
    expect(late.status).toBe(409);
    expect(await errorOf(late)).toMatchObject({ key: "host_gone" });
    expect(madeSince(from)).toEqual([]);
  });

  test("a create whose host goes while it finishes is taken back, not left running with no record", async () => {
    let entered = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The last step of a create: the container is started and the spec written, and the box is about to be read back.
    app.hosts.get("edge").sampler.observe = async () => {
      entered = true;
      await held;
    };
    const creating = post("/api/boxes", { name: "finishing", cpus: 1, memoryMb: 256, host: "edge" });
    await until(() => entered, "the create to reach its last step");
    expect(edge.containers.size).toBe(1);
    // The id is added again, and the new registration takes in the engine volumes this create made.
    await removeAndReadd();
    release();

    const late = await creating;
    expect(late.status).toBe(409);
    expect(await errorOf(late)).toMatchObject({ key: "host_gone" });
    expect(edge.containers.size).toBe(0);
    expect(edge.volumes.size).toBe(0);
    expect(recordsOf("edge")).toEqual({ specs: [], volumes: [], checkpoints: [] });
  });
});

describe("a registration that is gone stays gone", () => {
  test("an ordinary removal retires it too: the old context cannot write once the id is added again", async () => {
    const local = await boxOn(undefined, "base");
    const spec = { ...app.hosts.get().specs.read(local.boxId)!, hostId: "edge" };
    const old = app.hosts.get("edge");
    expect((await api("/api/hosts/edge", { method: "DELETE" })).status).toBe(200);
    expect((await post("/api/hosts", { id: "edge", endpoint: `unix://${EDGE_SOCKET}` })).status).toBe(201);

    expect(() => old.specs.write(spec)).toThrow(expect.objectContaining({ key: "host_gone" }));
    expect(() => app.hosts.get("edge").specs.write(spec)).not.toThrow();
  });

  test("what is kept per store outlives a registration: a snapshot reserved on the old one still blocks a removal", async () => {
    const releaseSnapshot = reserveVolumeSnapshot(app.hosts.get("edge"), "mbfrc-vol");
    expect(releaseSnapshot).not.toBeNull();
    await removeAndReadd();
    const fresh = app.hosts.get("edge");
    expect(sharedStore(fresh.volumes)).toBe(sharedStore(app.hosts.get().volumes));
    expect(reserveVolumeRemoval(fresh, "mbfrc-vol")).toBeNull();
    releaseSnapshot?.();
    const removal = reserveVolumeRemoval(fresh, "mbfrc-vol");
    expect(removal).not.toBeNull();
    removal?.();
  });
});
