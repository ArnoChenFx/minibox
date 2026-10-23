import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Config } from "../src/config";
import type { HostMetrics } from "../src/host/metrics";
import { RuntimeError } from "../src/runtime";
import { CheckpointSweep } from "../src/services/checkpoint-retention";
import { remeasureHostDisk } from "../src/volumes/disk";
import { silenceLogs } from "./support/app";
import {
  call,
  finishedTask,
  type Harness,
  mint,
  refused,
  type Reply,
  startHarness,
  type TrashEntryBody,
  type TrashRefBody,
} from "./support/tokens";

const DAY_MS = 24 * 60 * 60 * 1000;
const GB = 1024 ** 3;
/** A host with room for every request here, so the capacity check never decides an answer. */
const ROOMY_HOST = { cpu: { cores: 64 }, memory: { total: 64 * GB } } as unknown as HostMetrics;

function start(overrides: Partial<Config> = {}): Harness {
  const harness = startHarness(overrides);
  harness.app.monitor.snapshot = async () => ROOMY_HOST;
  return harness;
}

async function makeBox(harness: Harness, name: string, token?: string): Promise<string> {
  const reply = await call(harness.base, "/api/boxes", { token, body: { name, cpus: 1, memoryMb: 256 } });
  expect(reply.status).toBe(201);
  return reply.json.box?.boxId ?? "";
}

function engineAt(harness: Harness, boxId: string, path: string): string {
  const mount = harness.app.hosts
    .get()
    .specs.read(boxId)
    ?.mounts.find((item) => item.path === path);
  if (!mount) throw new Error(`no mount at ${path}`);
  return mount.volume;
}

function seed(harness: Harness, volume: string, path: string, text: string): void {
  harness.runtime.seedVolumeFile(volume, path, {
    type: "file",
    content: Buffer.from(text),
    mode: 0o644,
    uid: 1000,
    gid: 1000,
  });
}

function filesOf(harness: Harness, volume: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, entry] of harness.runtime.filesOf(volume)) {
    if (path !== "" && entry.type === "file") out[path] = entry.content?.toString() ?? "";
  }
  return out;
}

/** The id of the entry a delete kept in the recycle bin, or an empty string when it kept none. */
function keptId(reply: Reply): string {
  return (reply.json.trash as TrashRefBody | null | undefined)?.id ?? "";
}

async function trashOf(harness: Harness, token?: string): Promise<TrashEntryBody[]> {
  const reply = await call(harness.base, "/api/trash", { token });
  return (reply.json.trash ?? []) as TrashEntryBody[];
}

async function checkpointsOf(harness: Harness) {
  return (await call(harness.base, "/api/checkpoints")).json.checkpoints ?? [];
}

async function eventOps(harness: Harness): Promise<string[]> {
  const reply = await call(harness.base, "/api/events");
  return (reply.json.events ?? []).map((event) => event.op);
}

function removeBox(harness: Harness, boxId: string, query = "", token?: string): Promise<Reply> {
  return call(harness.base, `/api/boxes/${boxId}${query}`, { method: "DELETE", token });
}

function restoreEntry(harness: Harness, id: string, body: Record<string, unknown> = {}): Promise<Reply> {
  return call(harness.base, `/api/trash/${id}/restore`, { method: "POST", body });
}

function rebuildBox(harness: Harness, boxId: string, body: Record<string, unknown>, revision = 1): Promise<Reply> {
  return call(harness.base, `/api/boxes/${boxId}/rebuild`, {
    method: "POST",
    body,
    headers: { "if-match": String(revision) },
  });
}

describe("the recycle bin over HTTP", () => {
  let harness: Harness;
  let restoreLogs: () => void;

  beforeEach(() => {
    restoreLogs = silenceLogs();
    harness = start();
  });

  afterEach(() => {
    harness.stop();
    restoreLogs();
  });

  test("deleting a box keeps its data, and restoring the entry brings the files back as a new box", async () => {
    const boxId = await makeBox(harness, "alpha");
    const workspace = engineAt(harness, boxId, "/workspace");
    seed(harness, workspace, "src/app.ts", "console.log(1)");

    const deleted = await removeBox(harness, boxId, "?deleteVolume=true");

    expect(deleted.status).toBe(200);
    const kept = deleted.json.trash as { id: string; expiresAt: string } | null;
    expect(kept?.id).toMatch(/^ck_/);
    const [entry] = await trashOf(harness);
    expect(entry).toMatchObject({ id: kept?.id, kind: "box", sourceId: boxId, sourceName: "alpha" });
    expect(entry?.bytes).toBeGreaterThan(0);
    expect(Date.parse(entry?.expiresAt ?? "") - Date.parse(entry?.deletedAt ?? "")).toBe(7 * DAY_MS);
    expect(harness.runtime.volumes.has(workspace)).toBe(false);
    expect((await call(harness.base, `/api/boxes/${boxId}`)).status).toBe(404);

    const restored = await restoreEntry(harness, entry?.id ?? "", { name: "alpha-back", cpus: 1, memoryMb: 256 });
    expect(restored.status).toBe(202);
    const done = await finishedTask(harness.base, restored.json.taskId ?? "");
    expect(done.status).toBe("succeeded");
    expect(done.result?.box?.name).toBe("alpha-back");
    const restoredId = done.result?.box?.boxId ?? "";
    expect(filesOf(harness, engineAt(harness, restoredId, "/workspace"))).toEqual({
      "src/app.ts": "console.log(1)",
    });

    expect(await trashOf(harness)).toEqual([]);
    expect(await eventOps(harness)).toEqual(expect.arrayContaining(["box.trashed", "trash.restored"]));
  });

  test("a box deleted without deleteVolume keeps its volume and still keeps a copy in the bin", async () => {
    const boxId = await makeBox(harness, "alpha");
    const workspace = engineAt(harness, boxId, "/workspace");

    const deleted = await removeBox(harness, boxId);

    expect(deleted.json.trash).toMatchObject({ id: expect.stringMatching(/^ck_/) });
    expect(harness.runtime.volumes.has(workspace)).toBe(true);
    expect(await trashOf(harness)).toHaveLength(1);
  });

  test("a delete whose container cannot be removed leaves the box running, with no copy left in the bin", async () => {
    const boxId = await makeBox(harness, "alpha");
    harness.runtime.fail("removeContainer", new RuntimeError("engine", "boom", "boom"));

    const failed = await removeBox(harness, boxId);

    expect(failed.status).toBe(502);
    expect(harness.app.hosts.get().checkpoints.list()).toEqual([]);
    expect(await trashOf(harness)).toEqual([]);
    expect((await call(harness.base, `/api/boxes/${boxId}`)).json.box).toMatchObject({ running: true });
  });

  test("restoring into the name of a box that exists is refused before a task starts, and the entry stays", async () => {
    const boxId = await makeBox(harness, "alpha");
    const id = keptId(await removeBox(harness, boxId));
    await makeBox(harness, "alpha");

    const reply = await restoreEntry(harness, id, {});

    expect(refused(reply)).toEqual({ status: 409, key: "box_exists" });
    expect(await trashOf(harness)).toHaveLength(1);
    expect((await call(harness.base, "/api/tasks")).json.tasks?.map((task) => task.id)).toEqual([]);
  });

  test("a volume keeps its data when it is deleted, and restores as a new volume with the same files", async () => {
    const created = await call(harness.base, "/api/volumes", { body: { name: "notes", confirm: true } });
    expect(created.status).toBe(201);
    const volume = created.json.volume;
    seed(harness, volume?.engineName ?? "", "todo.md", "buy milk");

    const deleted = await call(harness.base, `/api/volumes/${volume?.id ?? ""}?confirm=true`, { method: "DELETE" });

    expect(deleted.status).toBe(200);
    expect(deleted.json.trash).toMatchObject({ id: expect.stringMatching(/^ck_/) });
    expect(await trashOf(harness)).toEqual([expect.objectContaining({ kind: "volume", sourceName: "notes" })]);
    expect(harness.runtime.volumes.has(volume?.engineName ?? "")).toBe(false);

    const [entry] = await trashOf(harness);
    const restored = await restoreEntry(harness, entry?.id ?? "", { name: "notes-back" });
    const done = await finishedTask(harness.base, restored.json.taskId ?? "");
    expect(done.status).toBe("succeeded");
    expect(done.result?.volume?.name).toBe("notes-back");
    expect(filesOf(harness, done.result?.volume?.engineName ?? "")).toEqual({ "todo.md": "buy milk" });
    expect(await eventOps(harness)).toEqual(expect.arrayContaining(["volume.trashed", "trash.restored"]));
  });

  test("purging an entry removes the data it kept, and a purged entry cannot be restored", async () => {
    const boxId = await makeBox(harness, "alpha");
    const id = keptId(await removeBox(harness, boxId));
    const stored = () => harness.app.hosts.get().checkpoints.list();
    expect(stored().filter((record) => record.trash !== null)).toHaveLength(1);
    expect(await checkpointsOf(harness)).toEqual([]);
    expect(refused(await call(harness.base, `/api/checkpoints/${id}`))).toEqual({
      status: 404,
      key: "checkpoint_not_found",
    });

    const purged = await call(harness.base, `/api/trash/${id}`, { method: "DELETE" });
    expect(purged.status).toBe(202);
    expect((await finishedTask(harness.base, purged.json.taskId ?? "")).status).toBe("succeeded");

    expect(await trashOf(harness)).toEqual([]);
    expect(stored()).toEqual([]);
    expect(await eventOps(harness)).toContain("trash.purged");
    expect(refused(await restoreEntry(harness, id, {}))).toEqual({ status: 404, key: "trash_not_found" });
  });

  test("the retention sweep keeps an entry until its retention has ended, then removes it", async () => {
    const boxId = await makeBox(harness, "alpha");
    await removeBox(harness, boxId);
    const sweep = new CheckpointSweep(harness.app.hosts);

    await sweep.run(Date.now() + DAY_MS);
    expect(await trashOf(harness)).toHaveLength(1);

    await sweep.run(Date.now() + 8 * DAY_MS);
    expect(await trashOf(harness)).toEqual([]);
    expect(await checkpointsOf(harness)).toEqual([]);
  });

  test("a token must hold trash:skip to delete without a copy, and the admin preset does not hold it", async () => {
    const operator = mint(harness.app, { name: "operator", preset: "operator" });
    const admin = mint(harness.app, { name: "admin", preset: "admin" });
    const boxId = await makeBox(harness, "mine", operator.secret);

    expect(refused(await removeBox(harness, boxId, "?skipTrash=true", operator.secret))).toEqual({
      status: 403,
      key: "trash_skip_forbidden",
    });
    expect(refused(await removeBox(harness, boxId, "?skipTrash=true", admin.secret))).toEqual({
      status: 403,
      key: "trash_skip_forbidden",
    });
    expect((await call(harness.base, `/api/boxes/${boxId}`, { token: operator.secret })).status).toBe(200);
    expect(await trashOf(harness)).toEqual([]);
  });

  test("a token with the trash:skip scope deletes without keeping a copy", async () => {
    const boxId = await makeBox(harness, "alpha");
    const skipper = mint(harness.app, {
      name: "skipper",
      scopes: ["box:read", "box:delete", "trash:skip"],
      boxes: { type: "ids", ids: [boxId] },
    });

    const deleted = await removeBox(harness, boxId, "?skipTrash=true", skipper.secret);

    expect(deleted.status).toBe(200);
    expect(deleted.json.trash).toBeNull();
    expect(await trashOf(harness)).toEqual([]);
    expect(await checkpointsOf(harness)).toEqual([]);
  });

  test("the recycle bin is for the owner only, so a token cannot list, restore or purge an entry", async () => {
    const boxId = await makeBox(harness, "alpha");
    const id = keptId(await removeBox(harness, boxId));
    const admin = mint(harness.app, { name: "admin", preset: "admin" });

    expect(refused(await call(harness.base, "/api/trash", { token: admin.secret }))).toEqual({
      status: 403,
      key: "operation_forbidden",
    });
    expect(
      refused(await call(harness.base, `/api/trash/${id}/restore`, { method: "POST", body: {}, token: admin.secret })),
    ).toEqual({ status: 403, key: "operation_forbidden" });
    expect(refused(await call(harness.base, `/api/trash/${id}`, { method: "DELETE", token: admin.secret }))).toEqual({
      status: 403,
      key: "operation_forbidden",
    });
    expect(await trashOf(harness)).toHaveLength(1);
  });

  test("revoking a token with deleteCreated keeps the boxes it made in the recycle bin", async () => {
    const maker = mint(harness.app, { name: "maker", preset: "operator" });
    await makeBox(harness, "made", maker.secret);

    const revoked = await call(harness.base, `/api/tokens/${maker.id}?deleteCreated=true`, { method: "DELETE" });

    expect(revoked.status).toBe(200);
    expect(revoked.json.deletedBoxes).toEqual(["made"]);
    expect(await trashOf(harness)).toEqual([expect.objectContaining({ kind: "box", sourceName: "made" })]);
  });
});

describe("the recycle bin capacity", () => {
  let harness: Harness;
  let restoreLogs: () => void;

  beforeEach(() => {
    restoreLogs = silenceLogs();
    harness = start({ checkpointCapacityMb: 1 });
  });

  afterEach(() => {
    harness.stop();
    restoreLogs();
  });

  test("a delete that would pass CHECKPOINT_CAPACITY_MB purges the oldest entries first, then keeps the new one", async () => {
    const first = await makeBox(harness, "first");
    seed(harness, engineAt(harness, first, "/workspace"), "big.bin", "x".repeat(700_000));
    await removeBox(harness, first);
    const second = await makeBox(harness, "second");
    seed(harness, engineAt(harness, second, "/workspace"), "big.bin", "y".repeat(700_000));

    const deleted = await removeBox(harness, second);

    expect(deleted.status).toBe(200);
    expect(deleted.json.trash).toMatchObject({ id: expect.stringMatching(/^ck_/) });
    expect((await trashOf(harness)).map((entry) => entry.sourceName)).toEqual(["second"]);
    expect(await eventOps(harness)).toContain("trash.purged");
  });

  test("a delete that does not fit even after the bin is emptied is refused with the reason, and the box stays", async () => {
    const big = await makeBox(harness, "huge");
    seed(harness, engineAt(harness, big, "/workspace"), "big.bin", "z".repeat(1_500_000));

    const refusedDelete = await removeBox(harness, big);

    expect(refused(refusedDelete)).toEqual({ status: 409, key: "trash_capacity_exceeded" });
    expect((await call(harness.base, `/api/boxes/${big}`)).status).toBe(200);
    expect(await trashOf(harness)).toEqual([]);
  });
});

describe("the recycle bin and the host disk", () => {
  let harness: Harness;
  let restoreLogs: () => void;

  beforeEach(() => {
    restoreLogs = silenceLogs();
    harness = start();
  });

  afterEach(() => {
    harness.stop();
    restoreLogs();
  });

  test("a delete that would keep a copy is refused with 507 while the host disk is below its floor, and the box stays", async () => {
    const boxId = await makeBox(harness, "low");
    harness.runtime.disk = { totalBytes: 100 * GB, freeBytes: 1 * GB };
    await remeasureHostDisk(harness.app.hosts.get());

    const refusedDelete = await removeBox(harness, boxId);

    expect(refused(refusedDelete)).toEqual({ status: 507, key: "host_disk_low" });
    expect((await call(harness.base, `/api/boxes/${boxId}`)).status).toBe(200);
    expect(await trashOf(harness)).toEqual([]);
  });

  test("a delete with skipTrash goes ahead while the host disk is below its floor, since it keeps no copy", async () => {
    const boxId = await makeBox(harness, "quick");
    harness.runtime.disk = { totalBytes: 100 * GB, freeBytes: 1 * GB };
    await remeasureHostDisk(harness.app.hosts.get());

    const deleted = await removeBox(harness, boxId, "?skipTrash=true");

    expect(deleted.status).toBe(200);
    expect(keptId(deleted)).toBe("");
    expect((await call(harness.base, `/api/boxes/${boxId}`)).status).toBe(404);
  });
});

describe("the safety checkpoint before a rebuild", () => {
  let harness: Harness;
  let restoreLogs: () => void;

  beforeEach(() => {
    restoreLogs = silenceLogs();
    harness = start();
  });

  afterEach(() => {
    harness.stop();
    restoreLogs();
  });

  test("a confirmed rebuild takes a safety checkpoint by default, returns it, and keeps it", async () => {
    const boxId = await makeBox(harness, "alpha");
    seed(harness, engineAt(harness, boxId, "/workspace"), "notes.txt", "keep me");

    const rebuilt = await rebuildBox(harness, boxId, { profile: "strict", confirm: true });

    expect(rebuilt.status).toBe(200);
    expect(rebuilt.json.box?.profile).toBe("strict");
    expect(rebuilt.json.safety).toMatchObject({ id: expect.stringMatching(/^ck_/), label: "Before rebuild" });
    const safetyId = rebuilt.json.safety?.id ?? "";
    const listed = await checkpointsOf(harness);
    expect(listed.map((item) => item.id)).toEqual([safetyId]);
    expect(listed[0]?.data.map((layer) => layer.path)).toEqual(["/workspace", "/home/dev"]);
  });

  test("a rebuild with safetyCheckpoint false takes no checkpoint and reports none", async () => {
    const boxId = await makeBox(harness, "alpha");

    const rebuilt = await rebuildBox(harness, boxId, { profile: "strict", confirm: true, safetyCheckpoint: false });

    expect(rebuilt.status).toBe(200);
    expect(rebuilt.json.safety).toBeNull();
    expect(await checkpointsOf(harness)).toEqual([]);
  });

  test("a rebuild that fails and is rolled back discards its safety checkpoint and leaves the box as it was", async () => {
    const boxId = await makeBox(harness, "alpha");
    harness.runtime.fail("startContainer", new RuntimeError("engine", "boom", "boom"));

    const failed = await rebuildBox(harness, boxId, { profile: "strict", confirm: true });

    expect(failed.status).toBe(502);
    expect(await checkpointsOf(harness)).toEqual([]);
    const box = (await call(harness.base, `/api/boxes/${boxId}`)).json.box;
    expect(box).toMatchObject({ revision: 1, profile: "standard", running: true });
  });

  test("a rebuild that cannot be rolled back keeps its safety checkpoint and answers 502", async () => {
    const boxId = await makeBox(harness, "alpha");
    harness.runtime.fail("startContainer", new RuntimeError("engine", "boom", "boom"));
    harness.runtime.fail("startContainer", new RuntimeError("engine", "restart boom", "restart boom"));

    const failed = await rebuildBox(harness, boxId, { profile: "strict", confirm: true });

    expect(refused(failed)).toEqual({ status: 502, key: "rebuild_failed_safety_kept" });
    const listed = await checkpointsOf(harness);
    expect(listed.map((item) => item.label)).toEqual(["Before rebuild"]);
  });

  test("attaching a volume takes a safety checkpoint, and detaching with safetyCheckpoint false takes none", async () => {
    const boxId = await makeBox(harness, "alpha");
    const created = await call(harness.base, "/api/volumes", { body: { name: "extra", confirm: true } });
    const volumeId = created.json.volume?.id ?? "";

    const attached = await call(harness.base, `/api/volumes/${volumeId}/attach`, {
      method: "POST",
      body: { box: boxId, path: "/data", mode: "rw", confirm: true },
      headers: { "if-match": "1" },
    });
    expect(attached.status).toBe(200);
    expect(attached.json.safety).toMatchObject({ label: "Before rebuild" });

    const detached = await call(harness.base, `/api/volumes/${volumeId}/detach`, {
      method: "POST",
      body: { box: boxId, path: "/data", confirm: true, safetyCheckpoint: false },
      headers: { "if-match": "2" },
    });
    expect(detached.status).toBe(200);
    expect(detached.json.safety).toBeNull();
    expect(await checkpointsOf(harness)).toHaveLength(1);
  });
});
