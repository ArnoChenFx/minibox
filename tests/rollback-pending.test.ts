import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
import type { HostMetrics } from "../src/host/metrics";
import type { HostCtx } from "../src/host/registry";
import { OWNER, type OperationContext } from "../src/operations/types";
import { RuntimeError } from "../src/runtime";
import * as boxes from "../src/services/boxes";
import type { Box } from "../src/services/boxes";
import {
  type CheckpointView,
  deleteCheckpoint,
  getCheckpoint,
  listCheckpoints,
  type RollbackResult,
  rollbackBox,
  takeCheckpoint,
  type TakeCheckpointInput,
} from "../src/services/checkpoints";
import { rebuildBox } from "../src/services/rebuild";
import { reconcileHost } from "../src/services/reconcile";
import { confirmRollback, pendingRollbackView, undoRollback } from "../src/services/rollback";
import { deleteVolume } from "../src/services/volumes";
import { createTestApp, rejectionOf, silenceLogs } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";
import type { FakeCheckpointEngine } from "./support/fake-snapshots";
import { call, finishedTask, type Harness, mint, refused, startHarness } from "./support/tokens";

const NOTHING: TakeCheckpointInput = {
  pinned: false,
  include: { system: false, volumes: [] },
  consistency: "live",
};

let app: App;
let runtime: FakeRuntime;
let engine: FakeCheckpointEngine;
let host: HostCtx;
let restoreLogs: () => void;

beforeEach(() => {
  restoreLogs = silenceLogs();
  ({ app, runtime, checkpoints: engine } = createTestApp({ labelPrefix: "mbtest" }));
  host = app.hosts.get();
  runtime.seedImage(host.baseTemplateTag, { [host.keys.template]: "true", [host.keys.templateName]: "base" });
});

afterEach(() => restoreLogs());

const ctx = (): OperationContext => ({
  host,
  principal: OWNER,
  source: "rest",
  events: app.events,
  tokens: app.tokens,
  execs: app.execs,
  terminals: app.terminals,
});

function makeBox(name: string): Promise<Box> {
  return boxes.createBox(host, { name, cpus: 1, memoryMb: 512, createdBy: "owner" });
}

function take(ref: string): Promise<CheckpointView> {
  return takeCheckpoint(host, ref, NOTHING, "owner");
}

function rollback(boxId: string, checkpoint: string): Promise<RollbackResult> {
  const revision = host.specs.read(boxId)?.revision ?? 0;
  return rollbackBox(host, boxId, { checkpoint, confirm: true, revision }, "owner");
}

function engineAt(boxId: string, path: string): string {
  const mount = host.specs.read(boxId)?.mounts.find((item) => item.path === path);
  if (!mount) throw new Error(`no mount at ${path}`);
  return mount.volume;
}

function seed(volume: string, path: string, text: string): void {
  runtime.seedVolumeFile(volume, path, { type: "file", content: Buffer.from(text), mode: 0o644, uid: 1000, gid: 1000 });
}

function filesOf(volume: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, entry] of runtime.filesOf(volume)) {
    if (path !== "" && entry.type === "file") out[path] = entry.content?.toString() ?? "";
  }
  return out;
}

/**
 * A box rolled back to a checkpoint taken before any change, so the rollback waits. A default checkpoint holds the
 * workspace and the home, so both are replaced and both restored. `original` is the workspace the box had before, and
 * `before` seeds it ahead of the checkpoint.
 */
async function rolledBack(name: string, before?: (workspace: string) => void) {
  const box = await makeBox(name);
  const original = engineAt(box.boxId, "/workspace");
  const originalHome = engineAt(box.boxId, "/home/dev");
  before?.(original);
  const view = await take(box.boxId);
  const result = await rollback(box.boxId, view.id);
  const restored = engineAt(box.boxId, "/workspace");
  const pending = host.checkpoints.pendingRollback(box.boxId);
  if (!pending) throw new Error("the rollback left no record");
  return { box, original, originalHome, restored, view, result, pending };
}

describe("a rollback that waits for its confirm or undo", () => {
  test("the record names the volumes it replaced and restored, and a safety checkpoint of the replaced data comes first", async () => {
    const box = await makeBox("alpha");
    const workspace = engineAt(box.boxId, "/workspace");
    seed(workspace, "kept.txt", "from the checkpoint");
    const view = await take(box.boxId);
    seed(workspace, "later.txt", "written after the checkpoint");

    const result = await rollback(box.boxId, view.id);

    const restored = engineAt(box.boxId, "/workspace");
    expect(restored).not.toBe(workspace);
    expect(runtime.volumes.has(workspace)).toBe(true);
    expect(host.checkpoints.pendingRollback(box.boxId)).toMatchObject({
      boxId: box.boxId,
      checkpointId: view.id,
      checkpointLabel: view.label,
      safetyCheckpointId: result.safety.id,
      createdBy: "owner",
      replaced: [
        expect.objectContaining({ name: "alpha-workspace", engineName: workspace, path: "/workspace" }),
        expect.objectContaining({ name: "alpha-home", path: "/home/dev" }),
      ],
      restored: [
        expect.objectContaining({ engineName: restored, path: "/workspace" }),
        expect.objectContaining({ path: "/home/dev" }),
      ],
    });
    expect(host.checkpoints.read(result.safety.id)).toMatchObject({ auto: true, pinned: false, boxId: box.boxId });
    const safety = await getCheckpoint(host, result.safety.id);
    const layer = safety.data.find((item) => item.path === "/workspace");
    expect(engine.snapshots.get(layer?.snapshotId ?? "")?.files.has("later.txt")).toBe(true);
    expect(filesOf(restored)).toEqual({ "kept.txt": "from the checkpoint" });
  });

  test("a second rollback is refused while the first waits, and nothing is taken or changed", async () => {
    const { box, view } = await rolledBack("alpha");
    const second = await take(box.boxId);
    const volumes = runtime.volumes.size;
    const checkpoints = (await listCheckpoints(host)).length;

    const error = await rejectionOf(rollback(box.boxId, second.id));

    expect(error).toMatchObject({ status: 409, key: "rollback_pending" });
    expect(runtime.volumes.size).toBe(volumes);
    expect((await listCheckpoints(host)).length).toBe(checkpoints);
    expect(host.checkpoints.pendingRollback(box.boxId)?.checkpointId).toBe(view.id);
  });

  test("confirm deletes the replaced volumes and clears the record, and keeps the safety checkpoint", async () => {
    const { box, original, originalHome, restored, result, pending } = await rolledBack("alpha");

    const done = await confirmRollback(host, box.boxId);

    expect(done.removed).toEqual(pending.replaced.map((volume) => ({ id: volume.volumeId, name: volume.name })));
    expect(runtime.volumes.has(original)).toBe(false);
    expect(runtime.volumes.has(originalHome)).toBe(false);
    for (const volume of pending.replaced) expect(host.volumes.read(volume.volumeId)).toBeNull();
    expect(runtime.volumes.has(restored)).toBe(true);
    expect(engineAt(box.boxId, "/workspace")).toBe(restored);
    expect(host.checkpoints.pendingRollback(box.boxId)).toBeNull();
    expect(pendingRollbackView(host, box.boxId)).toBeNull();
    expect(host.checkpoints.read(result.safety.id)).not.toBeNull();
  });

  test("a confirm skips a replaced volume that is already gone, and still clears the record", async () => {
    const { box, pending } = await rolledBack("alpha");
    await deleteVolume(host, pending.replaced[0]?.volumeId ?? "");

    const done = await confirmRollback(host, box.boxId);

    expect(done.removed.map((volume) => volume.name)).toEqual(["alpha-home"]);
    expect(host.checkpoints.pendingRollback(box.boxId)).toBeNull();
  });

  test("a confirm with no rollback waiting is refused with rollback_none", async () => {
    const box = await makeBox("alpha");

    const error = await rejectionOf(confirmRollback(host, box.boxId));

    expect(error).toMatchObject({ status: 409, key: "rollback_none" });
  });

  test("undo mounts the replaced volumes again, deletes the restored ones, and drops what was written since", async () => {
    const { box, original, originalHome, restored, pending } = await rolledBack("alpha", (workspace) =>
      seed(workspace, "kept.txt", "from the checkpoint"),
    );
    seed(restored, "after.txt", "written after the rollback");
    const revision = host.specs.read(box.boxId)?.revision ?? 0;

    await undoRollback(host, box.boxId, { revision });

    expect(engineAt(box.boxId, "/workspace")).toBe(original);
    expect(engineAt(box.boxId, "/home/dev")).toBe(originalHome);
    expect(runtime.volumes.has(restored)).toBe(false);
    for (const volume of pending.restored) expect(runtime.volumes.has(volume.engineName)).toBe(false);
    expect(filesOf(original)).toEqual({ "kept.txt": "from the checkpoint" });
    expect(host.checkpoints.pendingRollback(box.boxId)).toBeNull();
    expect(host.specs.read(box.boxId)?.revision).toBe(revision + 1);
  });

  test("undo with a stale revision is a 412 that changes nothing", async () => {
    const { box, restored } = await rolledBack("alpha");
    const revision = host.specs.read(box.boxId)?.revision ?? 0;

    const error = await rejectionOf(undoRollback(host, box.boxId, { revision: revision + 5 }));

    expect(error).toMatchObject({ status: 412, key: "revision_mismatch" });
    expect(engineAt(box.boxId, "/workspace")).toBe(restored);
    expect(host.checkpoints.pendingRollback(box.boxId)).not.toBeNull();
  });

  test("undo after a confirm is refused with rollback_none", async () => {
    const { box } = await rolledBack("alpha");
    await confirmRollback(host, box.boxId);
    const revision = host.specs.read(box.boxId)?.revision ?? 0;

    const error = await rejectionOf(undoRollback(host, box.boxId, { revision }));

    expect(error).toMatchObject({ status: 409, key: "rollback_none" });
  });

  test("undo is refused, and the restored volume is kept, when a replaced volume no longer exists", async () => {
    const { box, restored, pending } = await rolledBack("alpha");
    await deleteVolume(host, pending.replaced[0]?.volumeId ?? "");
    const revision = host.specs.read(box.boxId)?.revision ?? 0;

    const error = await rejectionOf(undoRollback(host, box.boxId, { revision }));

    expect(error).toMatchObject({ status: 409, key: "rollback_undo_gone" });
    expect(engineAt(box.boxId, "/workspace")).toBe(restored);
    expect(runtime.volumes.has(restored)).toBe(true);
    expect(host.checkpoints.pendingRollback(box.boxId)).not.toBeNull();
  });

  test("a rollback whose rebuild fails leaves no record, keeps the old mounts, and makes no volume", async () => {
    const box = await makeBox("alpha");
    const workspace = engineAt(box.boxId, "/workspace");
    const view = await take(box.boxId);
    const volumes = runtime.volumes.size;
    runtime.fail("createContainer", new RuntimeError("engine", "create refused"));

    await rejectionOf(rollback(box.boxId, view.id));

    expect(host.checkpoints.pendingRollback(box.boxId)).toBeNull();
    expect(engineAt(box.boxId, "/workspace")).toBe(workspace);
    expect(runtime.volumes.size).toBe(volumes);
    expect((await boxes.getBox(host, box.boxId)).running).toBe(true);
  });

  test("deleting the box with its volumes removes the replaced volume and the record", async () => {
    const { box, pending } = await rolledBack("alpha");

    const result = await boxes.deleteBox(host, box.boxId, true);

    expect(result.volumeDeleted).toBe(true);
    for (const volume of pending.replaced) expect(runtime.volumes.has(volume.engineName)).toBe(false);
    expect(host.checkpoints.pendingRollback(box.boxId)).toBeNull();
  });

  test("the safety checkpoint cannot be deleted while its rollback waits, and can once the rollback is confirmed", async () => {
    const { box, result } = await rolledBack("alpha");

    const error = await rejectionOf(deleteCheckpoint(host, result.safety.id));

    expect(error).toMatchObject({ status: 409, key: "checkpoint_held_by_rollback" });
    expect(host.checkpoints.read(result.safety.id)).not.toBeNull();

    await confirmRollback(host, box.boxId);
    await deleteCheckpoint(host, result.safety.id);
    expect(host.checkpoints.read(result.safety.id)).toBeNull();
  });

  test("box.rollback.get reads the waiting rollback, and reads null once it is settled", async () => {
    const { box, view } = await rolledBack("alpha");

    const waiting = (await app.operations.run("box.rollback.get", ctx(), { id: box.boxId })) as {
      rollback: { checkpoint: { id: string }; replaced: { name: string }[] } | null;
    };
    expect(waiting.rollback).toMatchObject({
      checkpoint: { id: view.id },
      replaced: [expect.objectContaining({ name: "alpha-workspace" }), expect.objectContaining({ name: "alpha-home" })],
    });

    await confirmRollback(host, box.boxId);
    expect(await app.operations.run("box.rollback.get", ctx(), { id: box.boxId })).toEqual({ rollback: null });
  });

  test("box.rollback.undo without confirm is a 409 preview that says what it would remount and delete", async () => {
    const { box, restored } = await rolledBack("alpha");
    const revision = host.specs.read(box.boxId)?.revision ?? 0;

    const error = await rejectionOf(
      app.operations.run("box.rollback.undo", ctx(), { id: box.boxId, expectedRevision: String(revision) }),
    );

    expect(error).toMatchObject({ status: 409, code: "confirmation_required" });
    const preview = (error as { details?: { preview?: unknown } }).details?.preview;
    expect(preview).toMatchObject({
      action: "undo_rollback",
      remount: [
        { path: "/workspace", volume: "alpha-workspace" },
        { path: "/home/dev", volume: "alpha-home" },
      ],
      delete: [expect.objectContaining({ path: "/workspace" }), expect.objectContaining({ path: "/home/dev" })],
      revision: { current: revision, next: revision + 1 },
    });
    expect(engineAt(box.boxId, "/workspace")).toBe(restored);
    expect(host.checkpoints.pendingRollback(box.boxId)).not.toBeNull();
  });

  test("box.rollback.confirm without confirm is a 409 preview that deletes nothing, and with confirm runs as a task", async () => {
    const { box, original, originalHome } = await rolledBack("alpha");

    const error = await rejectionOf(app.operations.run("box.rollback.confirm", ctx(), { id: box.boxId }));

    expect(error).toMatchObject({ status: 409, code: "confirmation_required" });
    const preview = (error as { details?: { preview?: unknown } }).details?.preview;
    expect(preview).toMatchObject({
      action: "confirm_rollback",
      box: "alpha",
      delete: [expect.objectContaining({ name: "alpha-workspace" }), expect.objectContaining({ name: "alpha-home" })],
    });
    expect(runtime.volumes.has(original)).toBe(true);
    expect(runtime.volumes.has(originalHome)).toBe(true);
    expect(host.checkpoints.pendingRollback(box.boxId)).not.toBeNull();

    await app.operations.run("box.rollback.confirm", ctx(), { id: box.boxId, confirm: true });
    await app.tasks.drain();

    expect(runtime.volumes.has(original)).toBe(false);
    expect(runtime.volumes.has(originalHome)).toBe(false);
    expect(host.checkpoints.pendingRollback(box.boxId)).toBeNull();
  });
});

/** What an undo does up to its rebuild, without the steps after it: as if the server stopped right there. */
async function undoCutShortAfterRebuild(boxId: string): Promise<void> {
  const spec = host.specs.read(boxId);
  const pending = host.checkpoints.pendingRollback(boxId);
  if (!spec || !pending) throw new Error("no rollback waits");
  const mounts = spec.mounts.map((mount) => {
    const back = pending.replaced.find((item) => item.path === mount.path);
    return back ? { ...mount, volume: back.engineName } : mount;
  });
  await rebuildBox(host, boxId, spec.revision, { mounts }, true);
}

describe("rollback records a crash left behind", () => {
  test("a confirm keeps a replaced volume a box mounts again, and still clears the record", async () => {
    const { box, original, originalHome } = await rolledBack("alpha");
    await undoCutShortAfterRebuild(box.boxId);

    const done = await confirmRollback(host, box.boxId);

    expect(done.removed).toEqual([]);
    expect(runtime.volumes.has(original)).toBe(true);
    expect(runtime.volumes.has(originalHome)).toBe(true);
    expect(engineAt(box.boxId, "/workspace")).toBe(original);
    expect(host.checkpoints.pendingRollback(box.boxId)).toBeNull();
  });

  test("startup finishes an undo cut short after its rebuild: the record goes and the restored volumes are deleted", async () => {
    const { box, original, restored, pending } = await rolledBack("alpha");
    await undoCutShortAfterRebuild(box.boxId);

    const report = await reconcileHost(host);

    expect(report.rollbacksSettled).toEqual([box.boxId]);
    expect(host.checkpoints.pendingRollback(box.boxId)).toBeNull();
    expect(engineAt(box.boxId, "/workspace")).toBe(original);
    expect(runtime.volumes.has(original)).toBe(true);
    expect(runtime.volumes.has(restored)).toBe(false);
    for (const volume of pending.restored) expect(host.volumes.read(volume.volumeId)).toBeNull();
  });

  test("startup leaves a rollback that still waits as it is", async () => {
    const { box, original, restored } = await rolledBack("alpha");

    const report = await reconcileHost(host);

    expect(report.rollbacksSettled).toEqual([]);
    expect(host.checkpoints.pendingRollback(box.boxId)).not.toBeNull();
    expect(runtime.volumes.has(original)).toBe(true);
    expect(runtime.volumes.has(restored)).toBe(true);
  });

  test("startup drops the record of a box that is gone, and deletes no volume", async () => {
    const { box, pending } = await rolledBack("alpha");
    const kept = host.checkpoints.pendingRollback(box.boxId);
    await boxes.deleteBox(host, box.boxId, false);
    if (kept) host.checkpoints.writePendingRollback(kept);

    const report = await reconcileHost(host);

    expect(report.rollbacksSettled).toEqual([box.boxId]);
    expect(host.checkpoints.pendingRollback(box.boxId)).toBeNull();
    for (const volume of pending.replaced) expect(runtime.volumes.has(volume.engineName)).toBe(true);
  });
});

describe("a rollback over HTTP belongs to the token that started it", () => {
  const GB = 1024 ** 3;
  /** A host with room for every request here, so the capacity check never decides an answer. */
  const ROOMY_HOST = { cpu: { cores: 64 }, memory: { total: 64 * GB } } as unknown as HostMetrics;

  let harness: Harness;
  let restoreLogs: () => void;

  beforeEach(() => {
    restoreLogs = silenceLogs();
    harness = startHarness();
    harness.app.monitor.snapshot = async () => ROOMY_HOST;
  });

  afterEach(() => {
    harness.stop();
    restoreLogs();
  });

  async function makeBoxOver(name: string, token?: string): Promise<string> {
    const reply = await call(harness.base, "/api/boxes", { token, body: { name, cpus: 1, memoryMb: 256 } });
    expect(reply.status).toBe(201);
    return reply.json.box?.boxId ?? "";
  }

  async function takeOver(boxId: string, token?: string): Promise<string> {
    const started = await call(harness.base, `/api/boxes/${boxId}/checkpoints`, { method: "POST", body: {}, token });
    expect(started.status).toBe(202);
    const done = await finishedTask(harness.base, started.json.taskId ?? "");
    const id = done.result?.checkpoint?.id;
    if (!id) throw new Error("the take returned no checkpoint");
    return id;
  }

  test("only the token that started a rollback may confirm it, and a token that sees the box may read it", async () => {
    const maker = mint(harness.app, { name: "maker", preset: "operator" });
    const boxId = await makeBoxOver("mine", maker.secret);
    const checkpoint = await takeOver(boxId, maker.secret);

    const started = await call(harness.base, `/api/boxes/${boxId}/rollback`, {
      method: "POST",
      token: maker.secret,
      body: { checkpoint, confirm: true },
      headers: { "if-match": "1" },
    });
    expect(started.status).toBe(202);
    expect((await finishedTask(harness.base, started.json.taskId ?? "")).status).toBe("succeeded");

    const watcher = mint(harness.app, { name: "watcher", preset: "operator", boxes: { type: "ids", ids: [boxId] } });
    const read = await call(harness.base, `/api/boxes/${boxId}/rollback`, { token: watcher.secret });
    expect(read.status).toBe(200);
    expect((read.json as unknown as { rollback: { checkpoint: { id: string } } | null }).rollback?.checkpoint.id).toBe(
      checkpoint,
    );
    expect(
      refused(
        await call(harness.base, `/api/boxes/${boxId}/rollback/confirm`, {
          token: watcher.secret,
          method: "POST",
          body: { confirm: true },
        }),
      ),
    ).toEqual({ status: 403, key: "rollback_out_of_scope" });

    const stranger = mint(harness.app, { name: "stranger", preset: "operator" });
    expect(
      refused(
        await call(harness.base, `/api/boxes/${boxId}/rollback/confirm`, {
          token: stranger.secret,
          method: "POST",
          body: { confirm: true },
        }),
      ),
    ).toEqual({ status: 403, key: "box_out_of_scope" });

    const confirmed = await call(harness.base, `/api/boxes/${boxId}/rollback/confirm`, {
      token: maker.secret,
      method: "POST",
      body: { confirm: true },
    });
    expect(confirmed.status).toBe(202);
    expect((await finishedTask(harness.base, confirmed.json.taskId ?? "")).status).toBe("succeeded");
    const after = await call(harness.base, `/api/boxes/${boxId}/rollback`);
    expect((after.json as unknown as { rollback: unknown }).rollback).toBeNull();
  });
});
