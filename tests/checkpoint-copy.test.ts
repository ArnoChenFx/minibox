import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";

import type { Server } from "bun";

import { type App, createApp } from "../src/app";
import { PACKAGE_EXTENSION } from "../src/checkpoints/package";
import type { Config } from "../src/config";
import type { HostCtx } from "../src/host/registry";
import type { LabelKeys } from "../src/labels";
import { startServer } from "../src/server";
import { assertCopyable } from "../src/services/checkpoint-transfer";
import type { CheckpointView } from "../src/services/checkpoints";
import type { TaskView } from "../src/tasks/types";
import type { SocketData } from "../src/ws/socket";
import { rejectionOf, silenceLogs, testConfig } from "./support/app";
import { FakeRuntime } from "./support/fake-runtime";
import { FakeCheckpointEngine } from "./support/fake-snapshots";
import { call, type CheckpointBody, mint, type Reply, refused } from "./support/tokens";

const GIB = 1024 ** 3;
const MB = 1024 * 1024;
const EDGE = "edge";
const EDGE_SOCKET = "/run/minibox-test/edge-docker.sock";
const THIRD = "third";
const THIRD_SOCKET = "/run/minibox-test/third-docker.sock";
const GOLD = "mbtest-template:gold";

interface CheckpointJson extends CheckpointBody {
  hostId: string;
  bytes: number;
  createdAt: string;
  boxName: string | null;
  specRevision: number | null;
  spec: unknown;
  pinned: boolean;
}

let app: App;
let server: Server<SocketData>;
let base: string;
let local: FakeRuntime;
let edge: FakeRuntime;
let third: FakeRuntime;
let engine: FakeCheckpointEngine;
let keys: LabelKeys;
let restoreLogs: () => void;

/** Starts the local host, with the edge and third hosts it can add, each over its own engine. */
async function start(overrides: Partial<Config> = {}): Promise<void> {
  local = new FakeRuntime();
  edge = new FakeRuntime();
  edge.engine = { cpus: 2, memoryBytes: 4 * GIB };
  third = new FakeRuntime();
  third.engine = { cpus: 2, memoryBytes: 4 * GIB };
  engine = new FakeCheckpointEngine();
  app = createApp(testConfig({ labelPrefix: "mbtest", ...overrides }), "0.0.0-test", {
    runtime: local,
    connect: (target) => ("socketPath" in target && target.socketPath === THIRD_SOCKET ? third : edge),
    checkpointEngine: engine,
    eventsPath: ":memory:",
  });
  keys = app.hosts.get().keys;
  for (const runtime of [local, edge, third]) {
    runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
  }
  server = startServer(app);
  base = `http://127.0.0.1:${server.port}`;
  const added = await call(base, "/api/hosts", { body: { id: EDGE, endpoint: `unix://${EDGE_SOCKET}` } });
  expect(added.status).toBe(201);
}

beforeEach(() => {
  restoreLogs = silenceLogs();
});

afterEach(() => {
  app.hostAdmin.close();
  app.sessions.stop();
  app.tokens.stop();
  server.stop(true);
  restoreLogs();
});

async function settle(taskId: string): Promise<TaskView> {
  await app.tasks.drain();
  const view = app.tasks.get(taskId, { output: true });
  if (!view) throw new Error(`no task ${taskId}`);
  return view;
}

function logOf(task: TaskView): string {
  return task.output ?? "";
}

function checkpointOf(task: TaskView): CheckpointJson {
  const checkpoint = (task.result as { checkpoint?: CheckpointJson } | undefined)?.checkpoint;
  if (!checkpoint) throw new Error(`task ${task.op} returned no checkpoint`);
  return checkpoint;
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

async function boxOn(host: string | undefined, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const reply = await call(base, "/api/boxes", { body: { name, cpus: 1, memoryMb: 256, host, ...extra } });
  expect(reply.status).toBe(201);
  return reply.json.box?.boxId ?? "";
}

function volumeOn(host: HostCtx, boxId: string, path: string): string {
  const mount = host.specs.read(boxId)?.mounts.find((item) => item.path === path);
  if (!mount) throw new Error(`no mount at ${path}`);
  return mount.volume;
}

function seed(runtime: FakeRuntime, volume: string, path: string, content: Buffer): void {
  runtime.seedVolumeFile(volume, path, { type: "file", content, mode: 0o644, uid: 1000, gid: 1000 });
}

function filesOf(runtime: FakeRuntime, volume: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, entry] of runtime.filesOf(volume)) {
    if (path !== "" && entry.type === "file") out[path] = entry.content?.toString() ?? "";
  }
  return out;
}

async function take(boxId: string, body: Record<string, unknown> = {}): Promise<CheckpointJson> {
  const started = await call(base, `/api/boxes/${boxId}/checkpoints`, { body });
  expect(started.status).toBe(202);
  const done = await settle(started.json.taskId ?? "");
  expect(done.status).toBe("succeeded");
  return checkpointOf(done);
}

function copyTo(checkpointId: string, host: string, token?: string): Promise<Reply> {
  return call(base, `/api/checkpoints/${checkpointId}/copy`, { body: { host }, token });
}

async function copied(checkpointId: string, host: string): Promise<CheckpointJson> {
  const started = await copyTo(checkpointId, host);
  expect(started.status).toBe(202);
  const done = await settle(started.json.taskId ?? "");
  expect(done.status).toBe("succeeded");
  return checkpointOf(done);
}

function snapshotsHeldBy(hostId: string): number {
  return [...engine.snapshots.values()].filter((snapshot) => snapshot.host === hostId).length;
}

function packageFiles(): string[] {
  const dir = app.hosts.get().checkpoints.packages.dir();
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(PACKAGE_EXTENSION)) : [];
}

function copyTasks(): TaskView[] {
  return app.tasks.list({ limit: 50 }).filter((task) => task.op === "checkpoint.copy");
}

describe("copying a checkpoint to another host", () => {
  test("a copy answers 202, and is a new checkpoint on the target that keeps the box, the settings and the creation time", async () => {
    await start();
    const boxId = await boxOn(undefined, "alpha");
    seed(local, volumeOn(app.hosts.get(), boxId, "/workspace"), "src/app.ts", Buffer.from("console.log(1)"));
    const origin = await take(boxId, { label: "before the refactor", pinned: true });

    const started = await copyTo(origin.id, EDGE);
    expect(started.status).toBe(202);
    const copy = checkpointOf(await settle(started.json.taskId ?? ""));

    expect(copy.id).not.toBe(origin.id);
    expect(copy).toMatchObject({
      hostId: EDGE,
      boxId: origin.boxId,
      boxName: origin.boxName,
      label: origin.label,
      reason: origin.reason,
      pinned: true,
      consistency: origin.consistency,
      specRevision: origin.specRevision,
      spec: origin.spec,
      createdAt: origin.createdAt,
      bytes: origin.bytes,
    });
    expect(copy.data.map(({ volumeId, path, ownership, bytes }) => [volumeId, path, ownership, bytes])).toEqual(
      origin.data.map(({ volumeId, path, ownership, bytes }) => [volumeId, path, ownership, bytes]),
    );
    expect(copy.data.map((layer) => engine.snapshots.get(layer.snapshotId)?.host)).toEqual(origin.data.map(() => EDGE));
    expect(copy.data.map((layer) => layer.snapshotId)).not.toEqual(origin.data.map((layer) => layer.snapshotId));

    expect(app.hosts.get(EDGE).checkpoints.read(copy.id)?.hostId).toBe(EDGE);
    expect(app.hosts.get().checkpoints.read(origin.id)?.hostId).toBe("local");
    expect(snapshotsHeldBy(EDGE)).toBe(origin.data.length);
    expect(snapshotsHeldBy("local")).toBe(origin.data.length);
    expect(packageFiles()).toEqual([]);
    expect(app.hosts.get().checkpoints.exporting.size).toBe(0);

    const listed = (await call(base, "/api/checkpoints")).json as unknown as { checkpoints: CheckpointJson[] };
    expect(listed.checkpoints.map((item) => [item.id, item.hostId])).toEqual(
      expect.arrayContaining([
        [origin.id, "local"],
        [copy.id, EDGE],
      ]),
    );
    expect(JSON.stringify((await call(base, "/api/events")).json)).toContain("checkpoint.copy");
  });

  test("a box forked from the copy on the target has the files the checkpoint held", async () => {
    await start();
    const boxId = await boxOn(undefined, "alpha");
    seed(local, volumeOn(app.hosts.get(), boxId, "/workspace"), "src/app.ts", Buffer.from("console.log(1)"));
    const origin = await take(boxId);
    const copy = await copied(origin.id, EDGE);

    const forked = await call(base, `/api/checkpoints/${copy.id}/fork`, {
      body: { name: "beta", cpus: 1, memoryMb: 256 },
    });
    expect(forked.status).toBe(202);
    const task = await settle(forked.json.taskId ?? "");
    expect(task.status).toBe("succeeded");
    const box = (task.result as { box?: { boxId: string } } | undefined)?.box;
    if (!box) throw new Error("the fork returned no box");

    const edgeHost = app.hosts.get(EDGE);
    expect(edgeHost.specs.read(box.boxId)?.hostId).toBe(EDGE);
    expect(filesOf(edge, volumeOn(edgeHost, box.boxId, "/workspace"))).toEqual({ "src/app.ts": "console.log(1)" });
    expect(filesOf(local, volumeOn(app.hosts.get(), boxId, "/workspace"))).toEqual({
      "src/app.ts": "console.log(1)",
    });
  });

  test("deleting the origin once its copy is made leaves the copy whole on the target", async () => {
    await start();
    const boxId = await boxOn(undefined, "alpha");
    seed(local, volumeOn(app.hosts.get(), boxId, "/workspace"), "notes.md", Buffer.from("kept"));
    const origin = await take(boxId);
    const copy = await copied(origin.id, EDGE);

    const deleted = await call(base, `/api/checkpoints/${origin.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(202);
    expect((await settle(deleted.json.taskId ?? "")).status).toBe("succeeded");
    expect(snapshotsHeldBy("local")).toBe(0);
    expect(snapshotsHeldBy(EDGE)).toBe(copy.data.length);

    const forked = await call(base, `/api/checkpoints/${copy.id}/fork`, {
      body: { name: "beta", cpus: 1, memoryMb: 256 },
    });
    expect(forked.status).toBe(202);
    expect((await settle(forked.json.taskId ?? "")).status).toBe("succeeded");
  });

  test("a template the target lacks is copied there first, and the task log says so", async () => {
    await start();
    local.seedImage(GOLD, { [keys.template]: "true", [keys.templateName]: "gold" });
    const boxId = await boxOn(undefined, "alpha", { template: GOLD });
    const origin = await take(boxId);

    const started = await copyTo(origin.id, EDGE);
    expect(started.status).toBe(202);
    const task = await settle(started.json.taskId ?? "");
    expect(task.status).toBe("succeeded");
    expect(logOf(task)).toContain(`Copying template ${GOLD} to ${EDGE}…`);
    expect(edge.callsTo("loadImage")).toHaveLength(1);
    expect(checkpointOf(task).spec).toMatchObject({ template: { ref: GOLD } });
  });

  test("a template the target already holds is not copied again, and the log has no copy line", async () => {
    await start();
    const boxId = await boxOn(undefined, "alpha");
    const origin = await take(boxId);

    const task = await settle((await copyTo(origin.id, EDGE)).json.taskId ?? "");
    expect(task.status).toBe("succeeded");
    expect(logOf(task)).not.toContain("Copying template");
    expect(edge.callsTo("loadImage")).toHaveLength(0);
  });

  test("a target without the base template gets it from a holder first, so a fork there can set its volumes' owners", async () => {
    await start();
    local.seedImage(GOLD, { [keys.template]: "true", [keys.templateName]: "gold" });
    const boxId = await boxOn(undefined, "alpha", { template: GOLD });
    const origin = await take(boxId);
    await edge.removeImage(app.cfg.baseTemplateTag, { force: true });

    const task = await settle((await copyTo(origin.id, EDGE)).json.taskId ?? "");
    expect(task.status).toBe("succeeded");
    expect(logOf(task)).toContain(`Copying template ${app.cfg.baseTemplateTag} to ${EDGE}…`);
    expect(logOf(task)).toContain(`Copying template ${GOLD} to ${EDGE}…`);
    expect((await edge.inspectImage(app.cfg.baseTemplateTag)).id).toBe(
      (await local.inspectImage(app.cfg.baseTemplateTag)).id,
    );

    const copy = checkpointOf(task);
    const forked = await call(base, `/api/checkpoints/${copy.id}/fork`, {
      body: { name: "beta", cpus: 1, memoryMb: 256 },
    });
    expect(forked.status).toBe(202);
    expect((await settle(forked.json.taskId ?? "")).status).toBe("succeeded");
  });

  test("the task log shows each step, and a copy of more than 16 MB logs the bytes it moves", async () => {
    await start();
    const boxId = await boxOn(undefined, "alpha");
    seed(local, volumeOn(app.hosts.get(), boxId, "/workspace"), "data.bin", Buffer.alloc(17 * MB, 7));
    const origin = await take(boxId);

    const task = await settle((await copyTo(origin.id, EDGE)).json.taskId ?? "");
    expect(task.status).toBe("succeeded");
    const output = logOf(task);
    expect(output).toContain(`Packing ${origin.label}…`);
    expect(output).toContain(`Restoring ${origin.label} on ${EDGE}…`);
    expect(output).toMatch(/Packed \d+ MB…/);
    expect(output).toMatch(/Sent \d+ MB…/);
    expect(output.indexOf("Packing")).toBeLessThan(output.indexOf("Restoring"));
  });

  test("a copy that cannot write its record on the target leaves no snapshots, package or mark behind, and can be made again", async () => {
    await start();
    const boxId = await boxOn(undefined, "alpha");
    const origin = await take(boxId);
    const target = app.hosts.get(EDGE);
    const failing = spyOn(target.checkpoints, "write").mockImplementationOnce(() => {
      throw new Error("the disk is full");
    });

    const failed = await settle((await copyTo(origin.id, EDGE)).json.taskId ?? "");
    failing.mockRestore();
    expect(failed.status).toBe("failed");
    expect(snapshotsHeldBy(EDGE)).toBe(0);
    expect(packageFiles()).toEqual([]);
    expect(app.hosts.get().checkpoints.exporting.size).toBe(0);

    const retried = await copied(origin.id, EDGE);
    expect(retried.hostId).toBe(EDGE);
  });

  test("a package over the size limit fails the copy with payload_too_large, and the checkpoint stays as it was", async () => {
    await start({ checkpointPackageMaxMb: 1 });
    const boxId = await boxOn(undefined, "alpha");
    seed(local, volumeOn(app.hosts.get(), boxId, "/workspace"), "big.bin", Buffer.alloc(2 * MB, 7));
    const origin = await take(boxId);

    const started = await copyTo(origin.id, EDGE);
    expect(started.status).toBe(202);
    const failed = await settle(started.json.taskId ?? "");
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatchObject({ code: "payload_too_large", status: 413, key: "package_too_large" });
    expect(packageFiles()).toEqual([]);
    expect(snapshotsHeldBy(EDGE)).toBe(0);
    expect(app.hosts.get().checkpoints.exporting.size).toBe(0);
    expect((await call(base, `/api/checkpoints/${origin.id}`)).status).toBe(200);
  });

  test("a checkpoint with a system layer is refused before a task starts, since a copy does not carry the image", async () => {
    await start();
    const boxId = await boxOn(undefined, "alpha");
    const taken = await call(base, `/api/boxes/${boxId}/checkpoints`, {
      body: { include: { system: true, volumes: [] } },
    });
    expect(taken.status).toBe(202);
    const withSystem = checkpointOf(await settle(taken.json.taskId ?? ""));

    expect(refused(await copyTo(withSystem.id, EDGE))).toEqual({ status: 409, key: "checkpoint_copy_system" });
    expect(copyTasks()).toEqual([]);
  });

  test("a copy to the host the checkpoint is on is refused with checkpoint_copy_same_host, before a task starts", async () => {
    await start();
    const boxId = await boxOn(undefined, "alpha");
    const origin = await take(boxId);

    expect(refused(await copyTo(origin.id, "local"))).toEqual({ status: 409, key: "checkpoint_copy_same_host" });
    expect(copyTasks()).toEqual([]);
  });

  test("a copy to a host that is not added is a 404 host_not_found, before a task starts", async () => {
    await start();
    const boxId = await boxOn(undefined, "alpha");
    const origin = await take(boxId);

    expect(refused(await copyTo(origin.id, "nowhere"))).toEqual({ status: 404, key: "host_not_found" });
    expect(copyTasks()).toEqual([]);
  });

  test("a copy of a checkpoint that does not exist is a 404 checkpoint_not_found, and starts no task", async () => {
    await start();

    expect(refused(await copyTo("ck_neverexisted", EDGE))).toEqual({ status: 404, key: "checkpoint_not_found" });
    expect(copyTasks()).toEqual([]);
  });

  test("a second copy to a host that already holds one is refused with checkpoint_copy_exists, before a task starts", async () => {
    await start();
    const boxId = await boxOn(undefined, "alpha");
    const origin = await take(boxId);
    await copied(origin.id, EDGE);

    expect(refused(await copyTo(origin.id, EDGE))).toEqual({ status: 409, key: "checkpoint_copy_exists" });
    expect(copyTasks()).toHaveLength(1);
  });

  test("while a copy is packing, its checkpoint cannot be deleted or copied again, since the copy holds it", async () => {
    await start();
    const boxId = await boxOn(undefined, "alpha");
    const origin = await take(boxId);
    const gate = engine.hold("pack");

    const started = await copyTo(origin.id, EDGE);
    expect(started.status).toBe(202);
    await until(() => gate.blocked() === 1, "the copy to pack");

    const deleted = await call(base, `/api/checkpoints/${origin.id}`, { method: "DELETE" });
    expect(refused(deleted)).toEqual({ status: 409, key: "task_busy" });
    expect(refused(await copyTo(origin.id, EDGE))).toEqual({ status: 409, key: "task_busy" });

    gate.release();
    expect((await settle(started.json.taskId ?? "")).status).toBe("succeeded");
    expect(app.hosts.get().checkpoints.read(origin.id)).not.toBeNull();
  });

  test("a copy back to the host its origin is on is refused with checkpoint_copy_exists, and the origin keeps its snapshots", async () => {
    await start();
    const boxId = await boxOn(undefined, "alpha");
    const origin = await take(boxId);
    const onEdge = await copied(origin.id, EDGE);
    const localBefore = snapshotsHeldBy("local");

    const started = await copyTo(onEdge.id, "local");
    expect(started.status).toBe(202);
    const failed = await settle(started.json.taskId ?? "");
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatchObject({ status: 409, key: "checkpoint_copy_exists" });
    expect(snapshotsHeldBy("local")).toBe(localBefore);
    expect(snapshotsHeldBy(EDGE)).toBe(onEdge.data.length);
    const listed = (await call(base, "/api/checkpoints")).json as unknown as { checkpoints: CheckpointJson[] };
    expect(listed.checkpoints.map((item) => item.id).toSorted()).toEqual([origin.id, onEdge.id].toSorted());
    expect(app.hosts.get().checkpoints.exporting.size).toBe(0);
    expect(packageFiles()).toEqual([]);
  });

  test("a copy of a copy goes on to a third host, and the origin is then refused there as already held", async () => {
    await start();
    const added = await call(base, "/api/hosts", { body: { id: THIRD, endpoint: `unix://${THIRD_SOCKET}` } });
    expect(added.status).toBe(201);
    const boxId = await boxOn(undefined, "alpha");
    const origin = await take(boxId);
    const onEdge = await copied(origin.id, EDGE);

    const onThird = await copied(onEdge.id, THIRD);
    expect(onThird).toMatchObject({ hostId: THIRD, boxId: origin.boxId, createdAt: origin.createdAt });
    expect(snapshotsHeldBy(THIRD)).toBe(origin.data.length);
    expect(refused(await copyTo(origin.id, THIRD))).toEqual({ status: 409, key: "checkpoint_copy_exists" });
  });

  test("only the owner copies: an admin token that holds every checkpoint scope is refused with operation_forbidden", async () => {
    await start();
    const boxId = await boxOn(undefined, "alpha");
    const origin = await take(boxId);
    const admin = mint(app, { name: "admin", preset: "admin" });

    expect(refused(await copyTo(origin.id, EDGE, admin.secret))).toEqual({ status: 403, key: "operation_forbidden" });
    expect(copyTasks()).toEqual([]);
  });
});

function viewOf(fields: Partial<CheckpointView>): CheckpointView {
  return {
    id: "ck_copyme",
    legacy: false,
    data: [{ volumeId: "v" }],
    system: null,
    boxId: "bx_a",
    spec: {},
    ...fields,
  } as unknown as CheckpointView;
}

describe("the copy check", () => {
  test("a legacy checkpoint, one with no data, one with a system layer, and one with no box are refused", async () => {
    expect(await rejectionOf(Promise.resolve().then(() => assertCopyable(viewOf({ legacy: true }))))).toMatchObject({
      status: 409,
      key: "checkpoint_copy_legacy",
    });
    expect(await rejectionOf(Promise.resolve().then(() => assertCopyable(viewOf({ data: [] }))))).toMatchObject({
      status: 409,
      key: "checkpoint_copy_empty",
    });
    expect(
      await rejectionOf(
        Promise.resolve().then(() =>
          assertCopyable(viewOf({ system: { image: "minibox-checkpoint:ck_copyme", imageId: "sha256:x" } })),
        ),
      ),
    ).toMatchObject({ status: 409, key: "checkpoint_copy_system" });
    expect(await rejectionOf(Promise.resolve().then(() => assertCopyable(viewOf({ boxId: null }))))).toMatchObject({
      status: 409,
      key: "checkpoint_copy_no_box",
    });
  });
});
