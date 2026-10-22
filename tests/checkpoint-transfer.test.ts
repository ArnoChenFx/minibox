import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PACKAGE_EXTENSION, PACKAGE_TTL_MS } from "../src/checkpoints/package";
import { PackageStore } from "../src/checkpoints/packages";
import type { Config } from "../src/config";
import type { HostMetrics } from "../src/host/metrics";
import { assertExportable } from "../src/services/checkpoint-transfer";
import type { CheckpointView } from "../src/services/checkpoints";
import { rejectionOf, silenceLogs, TEST_KEY } from "./support/app";
import {
  type Body,
  type CheckpointBody,
  call,
  type Harness,
  mint,
  refused,
  type Reply,
  startHarness,
} from "./support/tokens";

const MB = 1024 * 1024;
const PASSPHRASE = "correct horse battery staple";
const ROOMY_HOST = { cpu: { cores: 64 }, memory: { total: 64 * 1024 ** 3 } } as unknown as HostMetrics;

interface PackageBody {
  id: string;
  checkpointId: string | null;
  origin: "export" | "upload";
  bytes: number;
  sha256: string;
  createdAt: string;
  expiresAt: string;
  url: string;
}

interface TaskResult {
  package?: PackageBody;
  checkpoint?: CheckpointBody;
  box?: { boxId: string; name: string };
}

interface TaskView {
  status: string;
  result?: TaskResult;
  error?: { code: string; status: number; message: string; key?: string };
}

const harnesses: Harness[] = [];
let restoreLogs: () => void;

beforeEach(() => {
  restoreLogs = silenceLogs();
});

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.stop();
  restoreLogs();
});

function open(overrides: Partial<Config> = {}): Harness {
  const harness = startHarness(overrides);
  harness.app.monitor.snapshot = async () => ROOMY_HOST;
  harnesses.push(harness);
  return harness;
}

async function settle(harness: Harness, taskId: string): Promise<TaskView> {
  for (;;) {
    const view = await call(harness.base, `/api/tasks/${taskId}`);
    const task = view.json as unknown as TaskView;
    if (task.status !== "running") return task;
    await Bun.sleep(5);
  }
}

async function makeBox(harness: Harness, name: string): Promise<string> {
  const reply = await call(harness.base, "/api/boxes", { body: { name, cpus: 1, memoryMb: 256 } });
  expect(reply.status).toBe(201);
  return reply.json.box?.boxId ?? "";
}

function volumeOf(harness: Harness, boxId: string, path: string): string {
  const mount = harness.app.hosts
    .get()
    .specs.read(boxId)
    ?.mounts.find((item) => item.path === path);
  if (!mount) throw new Error(`no mount at ${path}`);
  return mount.volume;
}

function seed(harness: Harness, volume: string, path: string, content: Buffer): void {
  harness.runtime.seedVolumeFile(volume, path, { type: "file", content, mode: 0o644, uid: 1000, gid: 1000 });
}

function filesOf(harness: Harness, volume: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, entry] of harness.runtime.filesOf(volume)) {
    if (path !== "" && entry.type === "file") out[path] = entry.content?.toString() ?? "";
  }
  return out;
}

async function take(harness: Harness, boxId: string): Promise<CheckpointBody> {
  const started = await call(harness.base, `/api/boxes/${boxId}/checkpoints`, { method: "POST", body: {} });
  expect(started.status).toBe(202);
  const done = await settle(harness, started.json.taskId ?? "");
  expect(done.status).toBe("succeeded");
  const checkpoint = done.result?.checkpoint;
  if (!checkpoint) throw new Error("the take returned no checkpoint");
  return checkpoint;
}

async function exportOf(harness: Harness, checkpointId: string, passphrase = PASSPHRASE): Promise<PackageBody> {
  const started = await call(harness.base, `/api/checkpoints/${checkpointId}/export`, {
    method: "POST",
    body: { passphrase },
  });
  expect(started.status).toBe(202);
  const done = await settle(harness, started.json.taskId ?? "");
  expect(done.status).toBe("succeeded");
  const pkg = done.result?.package;
  if (!pkg) throw new Error("the export returned no package");
  return pkg;
}

async function downloaded(
  harness: Harness,
  id: string,
  token = TEST_KEY,
): Promise<{ status: number; bytes: Buffer; headers: Headers }> {
  const res = await fetch(`${harness.base}/api/packages/${id}/download`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}

async function upload(
  harness: Harness,
  bytes: Uint8Array,
  contentType = "application/octet-stream",
  token = TEST_KEY,
): Promise<Reply> {
  const res = await fetch(`${harness.base}/api/packages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": contentType },
    body: bytes,
  });
  const text = await res.text();
  return { status: res.status, json: (text === "" ? {} : JSON.parse(text)) as Body, headers: res.headers };
}

function uploaded(reply: Reply): PackageBody {
  const pkg = (reply.json as unknown as { package?: PackageBody }).package;
  if (!pkg) throw new Error("the upload returned no package");
  return pkg;
}

async function importOf(harness: Harness, id: string, passphrase = PASSPHRASE, host?: string): Promise<TaskView> {
  const started = await call(harness.base, `/api/packages/${id}/import`, {
    method: "POST",
    body: host === undefined ? { passphrase } : { passphrase, host },
  });
  expect(started.status).toBe(202);
  return settle(harness, started.json.taskId ?? "");
}

function packagesOf(harness: Harness): PackageStore {
  return harness.app.hosts.get().checkpoints.packages;
}

describe("exporting a checkpoint", () => {
  test("an export answers 202, and its package downloads as the sealed bytes the task described", async () => {
    const source = open();
    const boxId = await makeBox(source, "alpha");
    const checkpoint = await take(source, boxId);

    const pkg = await exportOf(source, checkpoint.id);
    expect(pkg).toMatchObject({
      origin: "export",
      checkpointId: checkpoint.id,
      url: `/api/packages/${pkg.id}/download`,
    });
    expect(Date.parse(pkg.expiresAt) - Date.parse(pkg.createdAt)).toBe(PACKAGE_TTL_MS);

    const got = await downloaded(source, pkg.id);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("application/octet-stream");
    expect(got.headers.get("content-length")).toBe(String(pkg.bytes));
    expect(got.headers.get("content-disposition")).toBe(`attachment; filename="${pkg.id}${PACKAGE_EXTENSION}"`);
    expect(got.bytes.length).toBe(pkg.bytes);
    expect(createHash("sha256").update(got.bytes).digest("hex")).toBe(pkg.sha256);
    expect(got.bytes.includes(Buffer.from(PASSPHRASE))).toBe(false);
  });

  test("an export of a checkpoint that does not exist is a 404, and starts no task", async () => {
    const harness = open();
    const reply = await call(harness.base, "/api/checkpoints/ck_neverexisted/export", {
      method: "POST",
      body: { passphrase: PASSPHRASE },
    });
    expect(refused(reply)).toEqual({ status: 404, key: "checkpoint_not_found" });
    expect(packagesOf(harness).list()).toEqual([]);
  });

  test("a passphrase outside 12 to 1024 characters is refused before anything is sealed", async () => {
    const harness = open();
    const boxId = await makeBox(harness, "alpha");
    const checkpoint = await take(harness, boxId);
    const reply = await call(harness.base, `/api/checkpoints/${checkpoint.id}/export`, {
      method: "POST",
      body: { passphrase: "too short" },
    });
    expect(refused(reply)).toEqual({ status: 400, key: "package_passphrase_invalid" });
    expect(packagesOf(harness).list()).toEqual([]);
  });

  test("a legacy checkpoint, one with no data, or one with a system layer is refused by the export check", async () => {
    const legacy = { id: "ck_legacyone", legacy: true, data: [] } as unknown as CheckpointView;
    expect(await rejectionOf(Promise.resolve().then(() => assertExportable(legacy)))).toMatchObject({
      status: 409,
      key: "checkpoint_export_legacy",
    });
    const empty = { id: "ck_emptyone", legacy: false, data: [] } as unknown as CheckpointView;
    expect(await rejectionOf(Promise.resolve().then(() => assertExportable(empty)))).toMatchObject({
      status: 409,
      key: "checkpoint_export_empty",
    });
    const withSystem = {
      id: "ck_systemone",
      legacy: false,
      data: [{ volumeId: "v" }],
      system: { image: "minibox-checkpoint:ck_systemone", imageId: "sha256:x" },
    } as unknown as CheckpointView;
    expect(await rejectionOf(Promise.resolve().then(() => assertExportable(withSystem)))).toMatchObject({
      status: 409,
      key: "checkpoint_export_system",
    });
  });

  test("a checkpoint with a system layer is refused before a task starts, since a package does not carry the image", async () => {
    const harness = open();
    const boxId = await makeBox(harness, "alpha");
    const taken = await call(harness.base, `/api/boxes/${boxId}/checkpoints`, {
      method: "POST",
      body: { include: { system: true, volumes: [] } },
    });
    expect(taken.status).toBe(202);
    const withSystem = await settle(harness, taken.json.taskId ?? "");
    expect(withSystem.result?.checkpoint?.system).not.toBeNull();
    const checkpointId = withSystem.result?.checkpoint?.id ?? "";

    const reply = await call(harness.base, `/api/checkpoints/${checkpointId}/export`, {
      method: "POST",
      body: { passphrase: PASSPHRASE },
    });
    expect(refused(reply)).toEqual({ status: 409, key: "checkpoint_export_system" });
    expect(packagesOf(harness).list()).toEqual([]);
  });

  test("a package over the size limit fails its export with payload_too_large, and the checkpoint stays as it was", async () => {
    const harness = open({ checkpointPackageMaxMb: 1 });
    const boxId = await makeBox(harness, "alpha");
    seed(harness, volumeOf(harness, boxId, "/workspace"), "big.bin", Buffer.alloc(2 * MB, 7));
    const checkpoint = await take(harness, boxId);

    const started = await call(harness.base, `/api/checkpoints/${checkpoint.id}/export`, {
      method: "POST",
      body: { passphrase: PASSPHRASE },
    });
    expect(started.status).toBe(202);
    const done = await settle(harness, started.json.taskId ?? "");
    expect(done.status).toBe("failed");
    expect(done.error).toMatchObject({ code: "payload_too_large", status: 413, key: "package_too_large" });
    expect(packagesOf(harness).list()).toEqual([]);
    expect(harness.app.hosts.get().checkpoints.exporting.size).toBe(0);
    expect((await call(harness.base, `/api/checkpoints/${checkpoint.id}`)).status).toBe(200);
  });

  test("an export runs on the host its checkpoint was taken on, not on the local host", async () => {
    const harness = open();
    const local = harness.app.hosts.get();
    harness.app.hosts.add({ ...local, host: { ...local.host, id: "lab", name: "Lab" } });
    const boxId = await makeBox(harness, "alpha");
    const checkpoint = await take(harness, boxId);
    const record = local.checkpoints.read(checkpoint.id);
    if (!record) throw new Error("the checkpoint has no record");
    local.checkpoints.write({ ...record, hostId: "lab" });
    const pack = spyOn(local.checkpointEngine, "pack");

    const pkg = await exportOf(harness, checkpoint.id);

    expect(pkg.checkpointId).toBe(checkpoint.id);
    expect(pack.mock.calls.map(([host]) => host.host.id)).toEqual(["lab"]);
  });

  test("only the owner exports: an admin token that holds every checkpoint scope is refused with operation_forbidden", async () => {
    const harness = open();
    const boxId = await makeBox(harness, "alpha");
    const checkpoint = await take(harness, boxId);
    const admin = mint(harness.app, { name: "admin", preset: "admin" });

    const exported = await call(harness.base, `/api/checkpoints/${checkpoint.id}/export`, {
      method: "POST",
      body: { passphrase: PASSPHRASE },
      token: admin.secret,
    });
    expect(refused(exported)).toEqual({ status: 403, key: "operation_forbidden" });
    expect(packagesOf(harness).list()).toEqual([]);

    const imported = await call(harness.base, "/api/packages/pk_neverexisted/import", {
      method: "POST",
      body: { passphrase: PASSPHRASE },
      token: admin.secret,
    });
    expect(refused(imported)).toEqual({ status: 403, key: "operation_forbidden" });
    expect((await upload(harness, new Uint8Array(4), "application/octet-stream", admin.secret)).status).toBe(403);
  });
});

describe("uploading a package", () => {
  test("an upload is stored as an upload, is listed by its id, and answers 201", async () => {
    const source = open();
    const target = open();
    const boxId = await makeBox(source, "alpha");
    const pkg = await exportOf(source, (await take(source, boxId)).id);
    const bytes = (await downloaded(source, pkg.id)).bytes;

    const reply = await upload(target, bytes);
    expect(reply.status).toBe(201);
    expect(uploaded(reply)).toMatchObject({
      origin: "upload",
      checkpointId: null,
      bytes: bytes.length,
      sha256: pkg.sha256,
      url: `/api/packages/${uploaded(reply).id}/download`,
    });
    expect(
      packagesOf(target)
        .list()
        .map((meta) => meta.id),
    ).toEqual([uploaded(reply).id]);
  });

  test("an upload with another content type is refused with 415 package_upload_type", async () => {
    const harness = open();
    const reply = await upload(harness, new TextEncoder().encode("text"), "text/plain");
    expect(reply.status).toBe(415);
    expect(reply.json.error?.key).toBe("package_upload_type");
  });

  test("an upload over the size limit is refused with 413, and no file is left behind", async () => {
    const harness = open({ checkpointPackageMaxMb: 1 });
    const reply = await upload(harness, new Uint8Array((3 * MB) / 2));
    expect(refused(reply)).toEqual({ status: 413, key: "package_too_large" });
    expect(packagesOf(harness).list()).toEqual([]);
    const dir = packagesOf(harness).dir();
    expect(existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(PACKAGE_EXTENSION)) : []).toEqual([]);
  });

  test("a streamed upload with no declared length is cut at the size limit as it arrives, and leaves no file", async () => {
    const harness = open({ checkpointPackageMaxMb: 1 });
    const chunk = new Uint8Array(256 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 6) return controller.close();
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const res = await fetch(`${harness.base}/api/packages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_KEY}`, "content-type": "application/octet-stream" },
      body,
    });
    const reply: Reply = { status: res.status, json: (await res.json()) as Body, headers: res.headers };
    // The scanner refuses the zero blocks first or the counter refuses the length; either way nothing is stored.
    expect([400, 413]).toContain(reply.status);
    expect(packagesOf(harness).list()).toEqual([]);
    const dir = packagesOf(harness).dir();
    expect(existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(PACKAGE_EXTENSION)) : []).toEqual([]);
  });

  test("bytes that are not a package are refused with package_invalid, and leave no file", async () => {
    const harness = open();
    const reply = await upload(harness, new TextEncoder().encode("hello, this is not a package"));
    expect(refused(reply)).toEqual({ status: 400, key: "package_invalid" });
    expect(packagesOf(harness).list()).toEqual([]);
  });

  test("an upload cut short is refused with package_invalid, and leaves no file", async () => {
    const source = open();
    const target = open();
    const boxId = await makeBox(source, "alpha");
    const bytes = (await downloaded(source, (await exportOf(source, (await take(source, boxId)).id)).id)).bytes;

    const reply = await upload(target, bytes.subarray(0, bytes.length - 1024));
    expect(refused(reply)).toEqual({ status: 400, key: "package_invalid" });
    expect(readdirSync(packagesOf(target).dir()).filter((name) => name.endsWith(PACKAGE_EXTENSION))).toEqual([]);
  });

  test("downloading a package that does not exist is a 404", async () => {
    const harness = open();
    expect((await downloaded(harness, "pk_neverexisted")).status).toBe(404);
  });
});

describe("importing a package", () => {
  test("a checkpoint exported on one instance imports on another with its files, and forks with them", async () => {
    const source = open();
    const target = open();
    const boxId = await makeBox(source, "alpha");
    seed(source, volumeOf(source, boxId, "/workspace"), "src/app.ts", Buffer.from("console.log(1)"));
    const checkpoint = await take(source, boxId);
    const pkg = await exportOf(source, checkpoint.id);
    const bytes = (await downloaded(source, pkg.id)).bytes;

    const stored = uploaded(await upload(target, bytes));
    const imported = await importOf(target, stored.id, PASSPHRASE, "local");
    expect(imported.status).toBe("succeeded");
    const restored = imported.result?.checkpoint;
    expect(restored).toMatchObject({ id: checkpoint.id, boxId, label: checkpoint.label, pinned: false });
    expect(restored?.data.map((layer) => layer.path)).toEqual(["/workspace", "/home/dev"]);

    expect((await call(target.base, "/api/checkpoints")).json.checkpoints?.map((item) => item.id)).toEqual([
      checkpoint.id,
    ]);
    expect((await downloaded(target, stored.id)).status).toBe(404);

    const forked = await call(target.base, `/api/checkpoints/${checkpoint.id}/fork`, {
      method: "POST",
      body: { name: "beta", cpus: 1, memoryMb: 256 },
    });
    expect(forked.status).toBe(202);
    const box = (await settle(target, forked.json.taskId ?? "")).result?.box;
    if (!box) throw new Error("the fork returned no box");
    expect(filesOf(target, volumeOf(target, box.boxId, "/workspace"))).toEqual({ "src/app.ts": "console.log(1)" });
  });

  test("a wrong passphrase fails the import with package_passphrase_wrong, and the package stays for another try", async () => {
    const source = open();
    const target = open();
    const boxId = await makeBox(source, "alpha");
    const pkg = await exportOf(source, (await take(source, boxId)).id);
    const stored = uploaded(await upload(target, (await downloaded(source, pkg.id)).bytes));

    const wrong = await importOf(target, stored.id, "not the right passphrase");
    expect(wrong.status).toBe("failed");
    expect(wrong.error).toMatchObject({ status: 400, key: "package_passphrase_wrong" });
    expect((await downloaded(target, stored.id)).status).toBe(200);
    expect((await call(target.base, "/api/checkpoints")).json.checkpoints).toEqual([]);

    expect((await importOf(target, stored.id)).status).toBe("succeeded");
  });

  test("a package changed after it was received is refused with package_invalid, and nothing is imported", async () => {
    const source = open();
    const target = open();
    const boxId = await makeBox(source, "alpha");
    const pkg = await exportOf(source, (await take(source, boxId)).id);
    const stored = uploaded(await upload(target, (await downloaded(source, pkg.id)).bytes));

    const path = packagesOf(target).pathFor(stored.id);
    const file = readFileSync(path);
    const middle = Math.floor(file.length / 2);
    file[middle] = (file[middle] ?? 0) ^ 0x20;
    writeFileSync(path, file);

    const changed = await importOf(target, stored.id);
    expect(changed.status).toBe("failed");
    expect(changed.error).toMatchObject({ status: 400, key: "package_invalid" });
    expect((await call(target.base, "/api/checkpoints")).json.checkpoints).toEqual([]);
  });

  test("a record that cannot be written leaves no snapshots behind, so the same package imports on the next try", async () => {
    const source = open();
    const target = open();
    const boxId = await makeBox(source, "alpha");
    const checkpoint = await take(source, boxId);
    const pkg = await exportOf(source, checkpoint.id);
    const stored = uploaded(await upload(target, (await downloaded(source, pkg.id)).bytes));

    const local = target.app.hosts.get();
    const failing = spyOn(local.checkpoints, "write").mockImplementationOnce(() => {
      throw new Error("the disk is full");
    });
    const failed = await importOf(target, stored.id);
    failing.mockRestore();
    expect(failed.status).toBe("failed");
    expect(await local.checkpointEngine.tagged(local, `checkpoint:${checkpoint.id}`)).toEqual([]);
    expect((await downloaded(target, stored.id)).status).toBe(200);

    expect((await importOf(target, stored.id)).status).toBe("succeeded");
  });

  test("a package whose checkpoint is already here is refused with checkpoint_import_exists, and the checkpoint is untouched", async () => {
    const harness = open();
    const boxId = await makeBox(harness, "alpha");
    const checkpoint = await take(harness, boxId);
    const pkg = await exportOf(harness, checkpoint.id);
    const copy = uploaded(await upload(harness, (await downloaded(harness, pkg.id)).bytes));

    const refusedImport = await importOf(harness, copy.id);
    expect(refusedImport.status).toBe("failed");
    expect(refusedImport.error).toMatchObject({ status: 409, key: "checkpoint_import_exists" });
    expect((await call(harness.base, `/api/checkpoints/${checkpoint.id}`)).status).toBe(200);
    expect((await downloaded(harness, copy.id)).status).toBe(200);
  });

  test("an import on a host that does not exist is a 404 host_not_found", async () => {
    const harness = open();
    const reply = await call(harness.base, "/api/packages/pk_neverexisted/import", {
      method: "POST",
      body: { passphrase: PASSPHRASE, host: "nowhere" },
    });
    expect(refused(reply)).toEqual({ status: 404, key: "host_not_found" });
  });
});

describe("packages are kept for a day", () => {
  test("a package is swept once its day is over, and then cannot be downloaded", async () => {
    const harness = open();
    const boxId = await makeBox(harness, "alpha");
    const pkg = await exportOf(harness, (await take(harness, boxId)).id);
    const store = packagesOf(harness);

    await harness.app.checkpointSweep.run(Date.now());
    expect((await downloaded(harness, pkg.id)).status).toBe(200);

    await harness.app.checkpointSweep.run(Date.now() + PACKAGE_TTL_MS + MB);
    expect((await downloaded(harness, pkg.id)).status).toBe(404);
    expect(store.list()).toEqual([]);
    expect(store.fileBytes(pkg.id)).toBeNull();
  });

  test("a package that is being written is not swept, even when its day has passed", () => {
    const store = new PackageStore(mkdtempSync(join(tmpdir(), "mbpkg-")), MB);
    const id = store.allocateId();
    store.begin(id);
    writeFileSync(store.pathFor(id), "partial");

    expect(store.sweep(Date.now() + 2 * PACKAGE_TTL_MS)).toEqual([]);
    expect(existsSync(store.pathFor(id))).toBe(true);

    store.end(id);
    expect(store.sweep(Date.now())).toEqual([id]);
    expect(existsSync(store.pathFor(id))).toBe(false);
  });
});

describe("the audit trail and the task record", () => {
  test("export, upload and import leave the passphrase in neither the events nor the tasks", async () => {
    const SENTINEL = "sentinel passphrase 9f2c71";
    const WRONG = "a wrong sentinel passphrase";
    const source = open();
    const target = open();
    const boxId = await makeBox(source, "alpha");
    const checkpoint = await take(source, boxId);
    const pkg = await exportOf(source, checkpoint.id, SENTINEL);
    const stored = uploaded(await upload(target, (await downloaded(source, pkg.id)).bytes));
    expect((await importOf(target, stored.id, WRONG)).status).toBe("failed");
    expect((await importOf(target, stored.id, SENTINEL)).status).toBe("succeeded");

    for (const harness of [source, target]) {
      const events = JSON.stringify((await call(harness.base, "/api/events")).json);
      const tasks = JSON.stringify((await call(harness.base, "/api/tasks")).json);
      for (const secret of [SENTINEL, WRONG]) {
        expect(events).not.toContain(secret);
        expect(tasks).not.toContain(secret);
      }
    }
    expect(JSON.stringify((await call(source.base, "/api/events")).json)).toContain("checkpoint.export");
    const targetEvents = JSON.stringify((await call(target.base, "/api/events")).json);
    expect(targetEvents).toContain("checkpoint.package_upload");
    expect(targetEvents).toContain("checkpoint.import");
  });
});
