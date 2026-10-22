import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { App } from "../src/app";
import { restoreArchive, RestoreRefused } from "../src/backup/restore";
import { isByteStream } from "../src/lib/body";
import { AppError } from "../src/lib/errors";
import type { AuditEvent } from "../src/operations/executor";
import type { OperationContext, Principal } from "../src/operations/types";
import { BackupService } from "../src/services/backup";
import { compileToken } from "../src/tokens/model";
import { createTestApp, rejectionOf, silenceLogs } from "./support/app";
import { FakeRuntime } from "./support/fake-runtime";

const PASSPHRASE = "correct horse battery staple";
const OWNER: Principal = { type: "owner", id: "owner", name: "owner" };

let restoreLogs: () => void;
let scratch: string;

beforeEach(() => {
  restoreLogs = silenceLogs();
  scratch = mkdtempSync(join(tmpdir(), "minibox-backup-service-"));
});

afterEach(() => {
  restoreLogs();
  rmSync(scratch, { recursive: true, force: true });
});

function ctxOf(app: App, principal: Principal = OWNER): OperationContext {
  return {
    host: app.hosts.get(),
    principal,
    source: "rest",
    events: app.events,
    tokens: app.tokens,
    execs: app.execs,
    terminals: app.terminals,
  };
}

async function backupOf(app: App, ctx: OperationContext): Promise<{ id: string; sha256: string; bytes: number }> {
  const started = (await app.operations.run("backup.create", ctx, { passphrase: PASSPHRASE })) as { taskId: string };
  await app.tasks.drain();
  const task = app.tasks.get(started.taskId, { output: true });
  expect(task?.status).toBe("succeeded");
  const result = task?.result as { backup: { id: string; sha256: string; bytes: number } } | undefined;
  if (!result) throw new Error("the backup task has no result");
  return result.backup;
}

async function bytesOf(app: App, ctx: OperationContext, id: string): Promise<Uint8Array> {
  const stream = await app.operations.run("backup.download", ctx, { id });
  if (!isByteStream(stream)) throw new Error("the download is not a byte stream");
  return new Uint8Array(await new Response(stream.body).arrayBuffer());
}

/** Every file under `dir` whose bytes contain `text`. Archives are binary, so the match is on raw bytes. */
function filesContaining(dir: string, text: string): string[] {
  const needle = Buffer.from(text);
  const found: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) found.push(...filesContaining(path, text));
    else if (readFileSync(path).includes(needle)) found.push(path);
  }
  return found;
}

describe("backup.create and the stored backups", () => {
  test("a backup is listed with its checksum, and its archive downloads whole", async () => {
    const { app } = createTestApp();
    const ctx = ctxOf(app);
    const backup = await backupOf(app, ctx);

    const { backups } = (await app.operations.run("backup.list", ctx, {})) as { backups: { id: string }[] };
    expect(backups.map((item) => item.id)).toEqual([backup.id]);

    const archive = await bytesOf(app, ctx, backup.id);
    expect(archive.byteLength).toBe(backup.bytes);
    expect(createHash("sha256").update(archive).digest("hex")).toBe(backup.sha256);
    expect(new TextDecoder().decode(archive.subarray(0, 8))).toBe("MBBACKUP");
  });

  test("the passphrase is in neither the record, the archive, the task nor the audit events", async () => {
    const events: AuditEvent[] = [];
    const { app } = createTestApp({}, undefined, { audit: (event) => events.push(event) });
    const ctx = ctxOf(app);
    const started = (await app.operations.run("backup.create", ctx, { passphrase: PASSPHRASE })) as { taskId: string };
    await app.tasks.drain();

    const task = app.tasks.get(started.taskId, { output: true });
    expect(JSON.stringify(task)).not.toContain(PASSPHRASE);
    expect(JSON.stringify(events)).not.toContain(PASSPHRASE);
    expect(events.map((event) => [event.op, event.status])).toEqual([
      ["backup.create", "started"],
      ["backup.create", "ok"],
    ]);
    expect(filesContaining(app.cfg.dataDir, PASSPHRASE)).toEqual([]);
  });

  test("a backup that cannot be written leaves neither an archive, a partial file nor a record", async () => {
    const dataDir = join(scratch, "data");
    mkdirSync(dataDir, { recursive: true });
    const corrupt = join(scratch, "events.db");
    writeFileSync(corrupt, "this is not a SQLite database, so it cannot be copied");
    const service = new BackupService({
      dataDir,
      databases: [{ name: "events.db", path: corrupt }],
    });

    await expect(service.create(PASSPHRASE, "owner")).rejects.toThrow();
    expect(service.list()).toEqual([]);
    expect(readdirSync(service.store.dir())).toEqual([]);
  });

  test("a stored backup is deleted with its archive, and deleting it again is not found", async () => {
    const { app } = createTestApp();
    const ctx = ctxOf(app);
    const backup = await backupOf(app, ctx);
    await app.operations.run("backup.delete", ctx, { id: backup.id });

    const { backups } = (await app.operations.run("backup.list", ctx, {})) as { backups: unknown[] };
    expect(backups).toEqual([]);
    const refusal = await rejectionOf(app.operations.run("backup.download", ctx, { id: backup.id }));
    expect(refusal).toBeInstanceOf(AppError);
    expect((refusal as AppError).status).toBe(404);
    const again = await rejectionOf(app.operations.run("backup.delete", ctx, { id: backup.id }));
    expect((again as AppError).status).toBe(404);
  });

  test("a token without backup:manage may not list or download backups", async () => {
    const { app } = createTestApp();
    const ctx = ctxOf(app);
    const backup = await backupOf(app, ctx);
    const { secret, record } = app.tokens.create(compileToken({ name: "admin", preset: "admin" }), "owner");
    const principal = app.tokens.authenticate(secret, "127.0.0.1");
    expect(principal?.id).toBe(record.id);
    const agent = { ...ctx, principal: principal ?? OWNER };

    expect(await app.operations.run("backup.list", agent, {}).catch((e: unknown) => e)).toBeInstanceOf(AppError);
    expect(
      await app.operations.run("backup.download", agent, { id: backup.id }).catch((e: unknown) => e),
    ).toBeInstanceOf(AppError);
  });
});

describe("restoring a backup", () => {
  test("backup → clear DATA_DIR → restore → Boxes and tokens still usable", async () => {
    const dataDir = join(scratch, "data");
    mkdirSync(dataDir, { recursive: true });
    const runtime = new FakeRuntime();
    const { app } = createTestApp({ dataDir }, runtime);
    const keys = app.hosts.get().keys;
    runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
    const ctx = ctxOf(app);
    const { box } = (await app.operations.run("box.create", ctx, { name: "alpha", cpus: 1, memoryMb: 256 })) as {
      box: { id: string };
    };
    const { secret } = app.tokens.create(compileToken({ name: "ci", preset: "admin" }), "owner");

    const backup = await backupOf(app, ctx);
    const archive = join(scratch, "backup.mbbak");
    writeFileSync(archive, await bytesOf(app, ctx, backup.id));

    rmSync(dataDir, { recursive: true, force: true });
    const entries = await restoreArchive(archive, dataDir, PASSPHRASE);
    expect(entries).toBeGreaterThan(0);

    const restored = createTestApp({ dataDir }, runtime).app;
    const principal = restored.tokens.authenticate(secret, "127.0.0.1");
    expect(principal).not.toBeNull();
    const agent = ctxOf(restored, principal ?? OWNER);
    const found = (await restored.operations.run("box.get", agent, { id: box.id })) as { box: { name: string } };
    expect(found.box.name).toBe("alpha");
  });

  test("a restore refuses a DATA_DIR that already holds files", async () => {
    const { app } = createTestApp();
    const ctx = ctxOf(app);
    const backup = await backupOf(app, ctx);
    const archive = join(scratch, "backup.mbbak");
    writeFileSync(archive, await bytesOf(app, ctx, backup.id));

    const occupied = join(scratch, "occupied");
    mkdirSync(occupied);
    writeFileSync(join(occupied, "keep.txt"), "keep me");
    await expect(restoreArchive(archive, occupied, PASSPHRASE)).rejects.toBeInstanceOf(RestoreRefused);
    expect(readFileSync(join(occupied, "keep.txt"), "utf8")).toBe("keep me");
  });

  test("a restore with the wrong passphrase writes nothing into DATA_DIR", async () => {
    const { app } = createTestApp();
    const ctx = ctxOf(app);
    const backup = await backupOf(app, ctx);
    const archive = join(scratch, "backup.mbbak");
    writeFileSync(archive, await bytesOf(app, ctx, backup.id));

    const target = join(scratch, "target");
    await expect(restoreArchive(archive, target, "not the passphrase at all")).rejects.toThrow();
    expect(readdirSync(target)).toEqual([]);
  });
});

describe("startup and crash recovery", () => {
  test("partial archives and staging folders left by a crash are removed when the server starts", async () => {
    const dataDir = join(scratch, "data");
    mkdirSync(dataDir, { recursive: true });
    const { app } = createTestApp({ dataDir });
    const backupsDir = app.backups.store.dir();
    mkdirSync(join(backupsDir, ".snapshot-abc"), { recursive: true });
    writeFileSync(join(backupsDir, ".bk_0000000000000000.part"), "half written");
    const kept = await backupOf(app, ctxOf(app));

    const restarted = createTestApp({ dataDir }).app;
    expect(restarted.backups.list().map((record) => record.id)).toEqual([kept.id]);
    expect(readdirSync(backupsDir).filter((name) => name.startsWith("."))).toEqual([]);
    expect(statSync(join(backupsDir, `${kept.id}.mbbak`)).size).toBe(kept.bytes);
  });
});

describe("receiving a backup pulled from a target", () => {
  test("an archive whose bytes match its record is stored with origin target", async () => {
    const { app } = createTestApp();
    const ctx = ctxOf(app);
    const backup = await backupOf(app, ctx);
    const archive = await bytesOf(app, ctx, backup.id);
    await app.operations.run("backup.delete", ctx, { id: backup.id });

    const record = {
      version: 1 as const,
      id: backup.id,
      origin: "target" as const,
      targetId: "tgt_test",
      createdBy: "owner",
      bytes: archive.byteLength,
      sha256: backup.sha256,
      entries: 1,
      createdAt: new Date().toISOString(),
    };
    await app.backups.receive(
      record,
      (async function* () {
        yield archive;
      })(),
    );
    expect(app.backups.list()).toEqual([
      expect.objectContaining({ id: backup.id, origin: "target", targetId: "tgt_test" }),
    ]);
    expect(await bytesOf(app, ctx, backup.id)).toEqual(archive);
  });

  test("an archive that does not match its record is refused and leaves nothing behind", async () => {
    const { app } = createTestApp();
    const ctx = ctxOf(app);
    const backup = await backupOf(app, ctx);
    const archive = await bytesOf(app, ctx, backup.id);
    await app.operations.run("backup.delete", ctx, { id: backup.id });
    const tampered = archive.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;

    const record = {
      version: 1 as const,
      id: backup.id,
      origin: "target" as const,
      targetId: "tgt_test",
      createdBy: "owner",
      bytes: archive.byteLength,
      sha256: backup.sha256,
      entries: 1,
      createdAt: new Date().toISOString(),
    };
    const refused = await rejectionOf(
      app.backups.receive(
        record,
        (async function* () {
          yield tampered;
        })(),
      ),
    );
    expect((refused as AppError).status).toBe(400);
    expect(app.backups.list()).toEqual([]);
    expect(readdirSync(app.backups.store.dir())).toEqual([]);
  });
});
