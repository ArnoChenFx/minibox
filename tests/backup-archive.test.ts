import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DatabaseSource, writeArchive } from "../src/backup/create";
import { includedEntry, listEntries } from "../src/backup/layout";
import { restoreArchive, RestoreRefused } from "../src/backup/restore";
import { ArchiveRejected } from "../src/backup/seal";
import { DIR_MODE, SECRET_FILE_MODE, writeFileAtomic } from "../src/data-dir";

const PASSPHRASE = "archive passphrase for tests";
const FAST_LOG_N = 10;
const SENTINEL_TOKEN = "tok_sentinel_0123456789abcdef";
const SENTINEL_SECRET = "sk-sentinel-9876543210fedcba";
const PAIR_ROUNDS = 200_000;
const PAIR_WRITER = join(import.meta.dir, "support", "pair-writer.ts");

const mode = (path: string) => statSync(path).mode & 0o777;

function sha256Of(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function databasesOf(dataDir: string): DatabaseSource[] {
  return [
    { name: "events.db", path: join(dataDir, "events.db") },
    { name: "tasks.db", path: join(dataDir, "tasks.db") },
  ];
}

function seedEvents(path: string, rows: string[]): void {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO events (body) VALUES (?)");
  for (const row of rows) insert.run(row);
  insert.finalize();
  db.close();
}

function countRows(path: string, table: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

function populate(dataDir: string): void {
  for (const dir of ["boxes/nested/deeper", "secrets/env", "checkpoints", "exec", "packages", "cli", "backups"]) {
    mkdirSync(join(dataDir, dir), { recursive: true, mode: DIR_MODE });
  }
  writeFileSync(join(dataDir, "access_key"), `ak_${SENTINEL_TOKEN}`, { mode: SECRET_FILE_MODE });
  writeFileSync(join(dataDir, "tokens.json"), JSON.stringify({ tokens: [{ token: SENTINEL_TOKEN }] }));
  writeFileSync(join(dataDir, "boxes/box-a.json"), '{"id":"box-a"}');
  writeFileSync(join(dataDir, "boxes/nested/deeper/notes.txt"), "deep note");
  writeFileSync(join(dataDir, "secrets/env/OPENAI_KEY"), SENTINEL_SECRET, { mode: SECRET_FILE_MODE });
  writeFileSync(join(dataDir, "checkpoints/index.json"), "[]");
  writeFileSync(join(dataDir, "exec/out.log"), "exec output");
  writeFileSync(join(dataDir, "packages/pk_abc.mbckpt"), "package bytes");
  writeFileSync(join(dataDir, "cli/minibox"), "cli binary");
  writeFileSync(join(dataDir, "backups/bk_old.mbbak"), "an earlier backup");
  writeFileSync(join(dataDir, ".tokens.json.abc123.tmp"), "half written");
  seedEvents(join(dataDir, "events.db"), ["one", "two", "three"]);
  const tasks = new Database(join(dataDir, "tasks.db"), { create: true });
  tasks.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY)");
  tasks.run("INSERT INTO tasks (id) VALUES ('task-1')");
  tasks.close();
}

async function backup(dataDir: string, output: string, passphrase = PASSPHRASE) {
  return writeArchive({
    dataDir,
    databases: databasesOf(dataDir),
    passphrase,
    output,
    logN: FAST_LOG_N,
  });
}

describe("backup archives", () => {
  let root: string;
  let dataDir: string;
  let output: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "minibox-archive-"));
    dataDir = join(root, "data");
    mkdirSync(dataDir, { mode: DIR_MODE });
    mkdirSync(join(dataDir, "backups"), { mode: DIR_MODE });
    output = join(dataDir, "backups", ".bk_test00000001.part");
    populate(dataDir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("a restore brings back the data, the stores, and none of the excluded folders", async () => {
    const summary = await backup(dataDir, output);
    const target = join(root, "restored");
    const restored = await restoreArchive(output, target, PASSPHRASE);

    expect(restored).toBe(summary.entries);
    expect(readFileSync(join(target, "boxes/box-a.json"), "utf8")).toBe('{"id":"box-a"}');
    expect(readFileSync(join(target, "boxes/nested/deeper/notes.txt"), "utf8")).toBe("deep note");
    expect(readFileSync(join(target, "tokens.json"), "utf8")).toBe(
      JSON.stringify({ tokens: [{ token: SENTINEL_TOKEN }] }),
    );
    for (const gone of ["exec/out.log", "packages", "cli", "backups", ".tokens.json.abc123.tmp", "events.db-wal"]) {
      expect(existsSync(join(target, gone))).toBe(false);
    }
    expect(countRows(join(target, "events.db"), "events")).toBe(3);
    expect(countRows(join(target, "tasks.db"), "tasks")).toBe(1);
  });

  test("the sealed file keeps every sentinel value out of sight", async () => {
    await backup(dataDir, output);
    const sealed = readFileSync(output);
    expect(sealed.includes(Buffer.from(SENTINEL_TOKEN))).toBe(false);
    expect(sealed.includes(Buffer.from(SENTINEL_SECRET))).toBe(false);
    expect(sealed.includes(Buffer.from("box-a"))).toBe(false);
    expect(sealed.includes(Buffer.from("MBBACKUP"))).toBe(true);
  });

  test("the summary describes the sealed file it wrote", async () => {
    const summary = await backup(dataDir, output);
    expect(summary.bytes).toBe(statSync(output).size);
    expect(summary.sha256).toBe(sha256Of(output));
    expect(mode(output)).toBe(0o600);
  });

  test("a restored file keeps its private mode, and the folder is created private", async () => {
    await backup(dataDir, output);
    const target = join(root, "fresh");
    await restoreArchive(output, target, PASSPHRASE);
    expect(mode(target)).toBe(DIR_MODE);
    expect(mode(join(target, "secrets/env/OPENAI_KEY"))).toBe(SECRET_FILE_MODE);
    expect(mode(join(target, "tokens.json"))).toBe(SECRET_FILE_MODE);
  });

  test("rows that are not committed are left out, and the live journals are not archived", async () => {
    const writer = new Database(join(dataDir, "events.db"));
    writer.exec("PRAGMA journal_mode = WAL");
    writer.run("BEGIN IMMEDIATE");
    writer.run("INSERT INTO events (body) VALUES ('ghost')");
    try {
      await backup(dataDir, output);
    } finally {
      writer.run("ROLLBACK");
      writer.close();
    }
    const target = join(root, "uncommitted");
    await restoreArchive(output, target, PASSPHRASE);
    expect(countRows(join(target, "events.db"), "events")).toBe(3);
    expect(existsSync(join(target, "events.db-wal"))).toBe(false);
    expect(existsSync(join(target, "events.db-shm"))).toBe(false);
  });

  test("a child process writing pairs of rows while the backup runs never tears a pair", async () => {
    const events = join(dataDir, "events.db");
    const child = Bun.spawn([process.execPath, PAIR_WRITER, events, String(PAIR_ROUNDS)], {
      stdout: "ignore",
      stderr: "inherit",
    });
    try {
      for (let waited = 0; countPairs(events) === 0; waited += 10) {
        if (waited > 15_000) throw new Error("the pair writer never started");
        await Bun.sleep(10);
      }
      await backup(dataDir, output);
    } finally {
      child.kill();
      await child.exited;
    }
    const target = join(root, "pairs");
    await restoreArchive(output, target, PASSPHRASE);
    const db = new Database(join(target, "events.db"), { readonly: true });
    try {
      const torn = db.query("SELECT n FROM pairs GROUP BY n HAVING count(*) <> 2").all();
      expect(torn).toEqual([]);
      expect((db.query("SELECT count(*) AS n FROM pairs").get() as { n: number }).n).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test("a file rewritten atomically during the backup is archived whole, in one version or the other", async () => {
    const first = JSON.stringify({ version: "first", padding: "a".repeat(200_000) });
    const second = JSON.stringify({ version: "second", padding: "b".repeat(200_000) });
    writeFileAtomic(join(dataDir, "sessions.json"), first);
    const rewrites = (async () => {
      for (let i = 0; i < 100; i++) {
        writeFileAtomic(join(dataDir, "sessions.json"), i % 2 === 0 ? second : first);
        await Bun.sleep(0);
      }
    })();
    await Promise.all([backup(dataDir, output), rewrites]);
    const target = join(root, "rewritten");
    await restoreArchive(output, target, PASSPHRASE);
    const archived = readFileSync(join(target, "sessions.json"), "utf8");
    expect([first, second]).toContain(archived);
  });

  test("a restore refuses a DATA_DIR that already holds files, and touches nothing", async () => {
    await backup(dataDir, output);
    const target = join(root, "occupied");
    mkdirSync(target, { mode: DIR_MODE });
    writeFileSync(join(target, "keep.txt"), "keep me");
    await expect(restoreArchive(output, target, PASSPHRASE)).rejects.toBeInstanceOf(RestoreRefused);
    expect(readdirSync(target)).toEqual(["keep.txt"]);
  });

  test("a wrong passphrase restores nothing and says so", async () => {
    await backup(dataDir, output);
    const target = join(root, "wrong");
    const refusal = await restoreArchive(output, target, "a different passphrase").catch((e) => e);
    expect(refusal).toBeInstanceOf(ArchiveRejected);
    expect((refusal as ArchiveRejected).reason).toBe("passphrase");
    expect(existsSync(target) ? readdirSync(target) : []).toEqual([]);
  });

  test("a damaged archive restores nothing, not even part of it", async () => {
    await backup(dataDir, output);
    const damaged = readFileSync(output);
    const middle = Math.floor(damaged.length / 2);
    damaged.writeUInt8(damaged.readUInt8(middle) ^ 0x01, middle);
    const path = join(root, "damaged.mbbak");
    writeFileSync(path, damaged);
    const target = join(root, "damaged");
    const refusal = await restoreArchive(path, target, PASSPHRASE).catch((e) => e);
    expect(refusal).toBeInstanceOf(ArchiveRejected);
    expect((refusal as ArchiveRejected).reason).toBe("invalid");
    expect(existsSync(target) ? readdirSync(target) : []).toEqual([]);
  });

  test("a truncated archive is refused", async () => {
    await backup(dataDir, output);
    const cut = readFileSync(output).subarray(0, statSync(output).size - 200);
    const path = join(root, "cut.mbbak");
    writeFileSync(path, cut);
    const refusal = await restoreArchive(path, join(root, "cut"), PASSPHRASE).catch((e) => e);
    expect((refusal as ArchiveRejected).reason).toBe("invalid");
  });

  test("an existing output file is never overwritten", async () => {
    writeFileSync(output, "someone else's file");
    await expect(backup(dataDir, output)).rejects.toThrow();
    expect(readFileSync(output, "utf8")).toBe("someone else's file");
  });

  test("a failed snapshot leaves no staging folder behind", async () => {
    rmSync(join(dataDir, "events.db-wal"), { force: true });
    rmSync(join(dataDir, "events.db-shm"), { force: true });
    writeFileSync(join(dataDir, "events.db"), "not a database at all");
    await expect(backup(dataDir, output)).rejects.toThrow();
    expect(readdirSync(join(dataDir, "backups")).filter((name) => name.startsWith(".snapshot-"))).toEqual([]);
  });

  test("the archive covers a DATA_DIR with no stores yet", async () => {
    rmSync(join(dataDir, "events.db"));
    rmSync(join(dataDir, "tasks.db"));
    const summary = await writeArchive({
      dataDir,
      databases: [{ name: "events.db", path: ":memory:" }],
      passphrase: PASSPHRASE,
      output,
      logN: FAST_LOG_N,
    });
    const target = join(root, "no-stores");
    expect(await restoreArchive(output, target, PASSPHRASE)).toBe(summary.entries);
    expect(existsSync(join(target, "events.db"))).toBe(false);
    expect(readFileSync(join(target, "tokens.json"), "utf8")).toContain(SENTINEL_TOKEN);
  });
});

function countPairs(path: string): number {
  if (!existsSync(path)) return 0;
  const db = new Database(path, { readonly: true });
  try {
    return (db.query("SELECT count(*) AS n FROM pairs").get() as { n: number }).n;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

describe("archive layout", () => {
  test("includedEntry keeps the data and leaves out the excluded folders, journals and temporary files", () => {
    for (const rel of ["tokens.json", "access_key", "boxes", "boxes/a.json", "secrets/env/KEY", "events.db.bak"]) {
      expect(includedEntry(rel)).toBe(true);
    }
    for (const rel of [
      "backups",
      "exec",
      "exec/out.log",
      "packages",
      "cli",
      "events.db",
      "tasks.db",
      "events.db-wal",
      "tasks.db-shm",
      "tasks.db-journal",
      ".tokens.json.x.tmp",
      "boxes/.hidden",
    ]) {
      expect(includedEntry(rel)).toBe(false);
    }
  });

  test("listEntries walks nested folders parents first, and follows a link to a folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "minibox-layout-"));
    try {
      mkdirSync(join(root, "boxes/nested"), { recursive: true });
      writeFileSync(join(root, "boxes/nested/file.txt"), "x");
      writeFileSync(join(root, "tokens.json"), "{}");
      symlinkSync(join(root, "boxes/nested"), join(root, "linked"));
      const entries = await listEntries(root);
      expect(entries.map((entry) => entry.rel)).toEqual([
        "boxes",
        "boxes/nested",
        "boxes/nested/file.txt",
        "linked",
        "linked/file.txt",
        "tokens.json",
      ]);
      expect(entries.find((entry) => entry.rel === "linked")?.kind).toBe("dir");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
