import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listEntries } from "../src/backup/layout";
import { restoreArchive } from "../src/backup/restore";
import { applyBackupRetention } from "../src/backup/retention";
import { BACKUP_VERSION, type BackupRecord, BackupStore } from "../src/backup/store";
import { DIR_MODE } from "../src/data-dir";
import { log } from "../src/lib/logger";
import { BackupService } from "../src/services/backup";
import { createTestApp, silenceLogs } from "./support/app";

const PASSPHRASE = "correct horse battery staple";

let root: string;
let dataDir: string;
let restoreLogs: () => void;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "minibox-backup-retention-"));
  dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true, mode: DIR_MODE });
  restoreLogs = silenceLogs();
});

afterEach(() => {
  restoreLogs();
  rmSync(root, { recursive: true, force: true });
});

const mode = (path: string) => statSync(path).mode & 0o777;

function recordFor(id: string, createdAt: string, bytes = 7): BackupRecord {
  return {
    version: BACKUP_VERSION,
    id,
    origin: "create",
    targetId: null,
    createdBy: "owner",
    bytes,
    sha256: "a".repeat(64),
    entries: 3,
    createdAt,
  };
}

/** Writes a whole backup into `store`: the archive first, then the record, as a real backup does. */
function stored(store: BackupStore, id: string, createdAt: string, bytes = 7): BackupRecord {
  const record = recordFor(id, createdAt, bytes);
  store.ensureDir();
  writeFileSync(store.partialPath(id), "x".repeat(bytes));
  store.commitArchive(id);
  store.write(record);
  return record;
}

describe("BACKUP_KEEP retention", () => {
  let store: BackupStore;

  beforeEach(() => {
    store = new BackupStore(dataDir);
  });

  test("exactly N backups are all kept", () => {
    const ids = ["bk_aaaa000000000001", "bk_aaaa000000000002", "bk_aaaa000000000003"];
    ids.forEach((id, at) => stored(store, id, `2026-10-0${at + 1}T00:00:00.000Z`));

    const result = applyBackupRetention(store, 3);
    expect(result.removed).toEqual([]);
    expect(result.kept).toBe(3);
    expect(store.list().map((record) => record.id)).toEqual(ids.toReversed());
  });

  test("one over N removes the oldest, newest first", () => {
    stored(store, "bk_aaaa000000000001", "2026-10-01T00:00:00.000Z");
    stored(store, "bk_aaaa000000000002", "2026-10-02T00:00:00.000Z");
    stored(store, "bk_aaaa000000000003", "2026-10-03T00:00:00.000Z");

    const result = applyBackupRetention(store, 2);
    expect(result.removed.map((record) => record.id)).toEqual(["bk_aaaa000000000001"]);
    expect(result.kept).toBe(2);
    expect(store.list().map((record) => record.id)).toEqual(["bk_aaaa000000000003", "bk_aaaa000000000002"]);
    expect(existsSync(store.pathFor("bk_aaaa000000000001"))).toBe(false);
    expect(existsSync(join(store.dir(), "bk_aaaa000000000001.json"))).toBe(false);
  });

  test("several over N removes all but the newest N, and a second pass removes nothing", () => {
    for (let day = 1; day <= 6; day++) stored(store, `bk_aaaa00000000000${day}`, `2026-10-0${day}T00:00:00.000Z`);

    const first = applyBackupRetention(store, 2);
    expect(first.removed.map((record) => record.id)).toEqual([
      "bk_aaaa000000000004",
      "bk_aaaa000000000003",
      "bk_aaaa000000000002",
      "bk_aaaa000000000001",
    ]);
    expect(store.list().map((record) => record.id)).toEqual(["bk_aaaa000000000006", "bk_aaaa000000000005"]);

    const second = applyBackupRetention(store, 2);
    expect(second.removed).toEqual([]);
    expect(second.kept).toBe(2);
  });

  test("backups with the same timestamp are ordered by id, so the newest N is stable", () => {
    const at = "2026-10-01T00:00:00.000Z";
    stored(store, "bk_aaaa00000000000a", at);
    stored(store, "bk_aaaa00000000000b", at);
    stored(store, "bk_aaaa00000000000c", at);

    const first = applyBackupRetention(store, 2);
    expect(first.removed.map((record) => record.id)).toEqual(["bk_aaaa00000000000a"]);
    expect(
      store
        .list()
        .map((record) => record.id)
        .toSorted(),
    ).toEqual(["bk_aaaa00000000000b", "bk_aaaa00000000000c"]);

    // A pass over what is left must not pick a different two: the order does not depend on the directory listing.
    expect(applyBackupRetention(store, 2).removed).toEqual([]);
  });

  test("a tie never removes the backup that triggered the pass, even when its id sorts last", () => {
    const at = "2026-10-01T00:00:00.000Z";
    stored(store, "bk_aaaa00000000000a", at);
    stored(store, "bk_aaaa00000000000b", at);
    stored(store, "bk_aaaa000000000001", at);

    // The newest id is `bk_aaaa00000000000b`, but the pass runs for `bk_aaaa000000000001`, which must survive.
    const result = applyBackupRetention(store, 2, { protect: "bk_aaaa000000000001" });
    expect(result.removed.map((record) => record.id)).toEqual(["bk_aaaa00000000000a"]);
    expect(
      store
        .list()
        .map((record) => record.id)
        .toSorted(),
    ).toEqual(["bk_aaaa000000000001", "bk_aaaa00000000000b"]);
  });

  test("N of 0, or less, keeps every backup, which is what unset means", () => {
    stored(store, "bk_aaaa000000000001", "2026-10-01T00:00:00.000Z");
    stored(store, "bk_aaaa000000000002", "2026-10-02T00:00:00.000Z");

    expect(applyBackupRetention(store, 0)).toEqual({ removed: [], kept: 2 });
    expect(applyBackupRetention(store, -1)).toEqual({ removed: [], kept: 2 });
    expect(store.list()).toHaveLength(2);
  });

  test("a fractional N keeps everything, since it cannot be a count", () => {
    stored(store, "bk_aaaa000000000001", "2026-10-01T00:00:00.000Z");
    stored(store, "bk_aaaa000000000002", "2026-10-02T00:00:00.000Z");
    expect(applyBackupRetention(store, 1.5).removed).toEqual([]);
    expect(store.list()).toHaveLength(2);
  });

  test("files this tool did not write are left alone", () => {
    stored(store, "bk_aaaa000000000001", "2026-10-01T00:00:00.000Z");
    stored(store, "bk_aaaa000000000002", "2026-10-02T00:00:00.000Z");
    writeFileSync(join(store.dir(), "notes.txt"), "mine");
    writeFileSync(join(store.dir(), "bk_manual.mbbak"), "not a backup id");
    writeFileSync(join(store.dir(), "README"), "keep me");
    mkdirSync(join(store.dir(), "keep", "nested"), { recursive: true });

    const result = applyBackupRetention(store, 1);
    expect(result.removed.map((record) => record.id)).toEqual(["bk_aaaa000000000001"]);
    for (const kept of ["notes.txt", "bk_manual.mbbak", "README", "keep/nested"]) {
      expect(existsSync(join(store.dir(), kept))).toBe(true);
    }
  });

  test("a record without its archive is not counted and not touched", () => {
    stored(store, "bk_aaaa000000000001", "2026-10-01T00:00:00.000Z");
    stored(store, "bk_aaaa000000000002", "2026-10-02T00:00:00.000Z");
    // A record whose archive never arrived: a crash between the archive and the record, or a copy that lost a file.
    store.write(recordFor("bk_aaaa000000000003", "2026-10-03T00:00:00.000Z"));

    const result = applyBackupRetention(store, 1);
    expect(result.removed.map((record) => record.id)).toEqual(["bk_aaaa000000000001"]);
    expect(store.read("bk_aaaa000000000003")).not.toBeNull();
  });

  test("a record whose archive is shorter than it says is not counted either", () => {
    stored(store, "bk_aaaa000000000001", "2026-10-01T00:00:00.000Z");
    stored(store, "bk_aaaa000000000002", "2026-10-02T00:00:00.000Z");
    const damaged = stored(store, "bk_aaaa000000000003", "2026-10-03T00:00:00.000Z", 20);
    writeFileSync(store.pathFor(damaged.id), "short");

    expect(applyBackupRetention(store, 1).removed.map((record) => record.id)).toEqual(["bk_aaaa000000000001"]);
    expect(existsSync(store.pathFor(damaged.id))).toBe(true);
  });

  test("partial archives and staging folders are not backups, and are not removed by a pass", () => {
    stored(store, "bk_aaaa000000000001", "2026-10-01T00:00:00.000Z");
    stored(store, "bk_aaaa000000000002", "2026-10-02T00:00:00.000Z");
    writeFileSync(join(store.dir(), ".bk_aaaa000000000009.part"), "half");
    mkdirSync(join(store.dir(), ".snapshot-abc"), { recursive: true });

    expect(applyBackupRetention(store, 1).removed.map((record) => record.id)).toEqual(["bk_aaaa000000000001"]);
    expect(existsSync(join(store.dir(), ".bk_aaaa000000000009.part"))).toBe(true);
    expect(existsSync(join(store.dir(), ".snapshot-abc"))).toBe(true);
  });
});

describe("the folder the archives live in", () => {
  test.skipIf(process.getuid?.() === 0)(
    "an EACCES record is skipped and logged without deleting the committed backup",
    async () => {
      const service = new BackupService({ dataDir, databases: [], keep: 1 });
      service.store.ensureDir();
      const id = "bk_aaaa000000000001";
      const path = join(service.store.dir(), `${id}.json`);
      writeFileSync(path, JSON.stringify(recordFor(id, "2026-10-01T00:00:00.000Z")));
      chmodSync(path, 0);
      const warnings = spyOn(log, "warn").mockImplementation(() => {});
      try {
        const record = await service.create(PASSPHRASE, "owner");
        expect(service.list().map((item) => item.id)).toEqual([record.id]);
        expect(service.whole(record.id)).not.toBeNull();
        expect(
          warnings.mock.calls.some(
            ([event, detail]) =>
              event === "backup.record_unreadable" && detail?.id === id && String(detail.error).includes("EACCES"),
          ),
        ).toBe(true);
      } finally {
        warnings.mockRestore();
        chmodSync(path, 0o600);
      }
    },
  );

  test.skipIf(process.getuid?.() === 0)(
    "an unreadable custom directory fails listing but maintenance stays best effort",
    () => {
      const backupDir = join(root, "unreadable");
      mkdirSync(backupDir);
      const service = new BackupService({ dataDir, backupDir, databases: [], keep: 1 });
      chmodSync(backupDir, 0);
      const errors = spyOn(log, "error").mockImplementation(() => {});
      try {
        expect(() => service.list()).toThrow(/EACCES/);
        expect(service.sweepPartial()).toBe(0);
        expect(service.applyRetention()).toEqual({ removed: [], kept: 0 });
        expect(errors.mock.calls.map(([event]) => event)).toEqual(["backup.sweep_failed", "backup.retention_failed"]);
      } finally {
        errors.mockRestore();
        chmodSync(backupDir, 0o700);
      }
    },
  );

  test("BACKUP_DIR moves the archives and their records out of DATA_DIR/backups", () => {
    const backupDir = join(root, "archives");
    const store = new BackupStore(dataDir, { dir: backupDir });
    stored(store, "bk_aaaa000000000001", "2026-10-01T00:00:00.000Z");

    expect(store.dir()).toBe(backupDir);
    expect(store.insideDataDir()).toBe(false);
    expect(readdirSync(backupDir).toSorted()).toEqual(["bk_aaaa000000000001.json", "bk_aaaa000000000001.mbbak"]);
    expect(existsSync(join(dataDir, "backups"))).toBe(false);
  });

  test("a new custom backup folder is private", () => {
    const store = new BackupStore(dataDir, { dir: join(root, "archives") });
    store.ensureDir();
    expect(mode(store.dir())).toBe(DIR_MODE);
  });

  test("an existing custom backup folder retains the operator's permissions", () => {
    const backupDir = join(root, "archives");
    mkdirSync(backupDir, { recursive: true });
    chmodSync(backupDir, 0o755);
    const store = new BackupStore(dataDir, { dir: backupDir });
    store.ensureDir();
    expect(mode(backupDir)).toBe(0o755);
  });

  test("an existing default backup folder is tightened to 700", () => {
    const backupDir = join(dataDir, "backups");
    mkdirSync(backupDir, { recursive: true });
    chmodSync(backupDir, 0o755);
    const store = new BackupStore(dataDir);
    store.ensureDir();
    expect(mode(backupDir)).toBe(DIR_MODE);
  });

  test("a store under DATA_DIR/backups counts as inside, and a sibling folder does not", () => {
    expect(new BackupStore(dataDir).insideDataDir()).toBe(true);
    expect(new BackupStore(dataDir, { dir: join(dataDir, "backups") }).insideDataDir()).toBe(true);
    expect(new BackupStore(dataDir, { dir: join(dataDir, "archives") }).insideDataDir()).toBe(false);
    expect(new BackupStore(dataDir, { dir: root }).insideDataDir()).toBe(false);
  });
});

describe("a backup with BACKUP_DIR set", () => {
  test("an archive written outside DATA_DIR holds no copy of itself", async () => {
    writeFileSync(join(dataDir, "tokens.json"), "{}");
    const backupDir = join(root, "archives");
    const service = new BackupService({ dataDir, backupDir, keep: 0, databases: [] });

    const first = await service.create(PASSPHRASE, "owner");
    const second = await service.create(PASSPHRASE, "owner");
    expect(service.store.dir()).toBe(backupDir);
    expect(readdirSync(backupDir).toSorted()).toEqual(
      [`${first.id}.json`, `${first.id}.mbbak`, `${second.id}.json`, `${second.id}.mbbak`].toSorted(),
    );

    const restored = await restoreArchive(service.store.pathFor(second.id), join(root, "restored"), PASSPHRASE);
    expect(restored).toBeGreaterThan(0);
    expect(existsSync(join(root, "restored", "tokens.json"))).toBe(true);
    expect(existsSync(join(root, "restored", "archives"))).toBe(false);
  });

  test("a BACKUP_DIR inside DATA_DIR is left out of the archive, so backups never nest", async () => {
    writeFileSync(join(dataDir, "tokens.json"), "{}");
    const backupDir = join(dataDir, "archives");
    const service = new BackupService({ dataDir, backupDir, keep: 0, databases: [] });

    const first = await service.create(PASSPHRASE, "owner");
    const entries = (await listEntries(dataDir, { exclude: [backupDir] })).map((entry) => entry.rel);
    expect(entries).toContain("tokens.json");
    expect(entries.filter((rel) => rel.startsWith("archives"))).toEqual([]);

    await restoreArchive(service.store.pathFor(first.id), join(root, "restored"), PASSPHRASE);
    expect(readdirSync(join(root, "restored"))).not.toContain("archives");
    expect(existsSync(join(root, "restored", "tokens.json"))).toBe(true);
  });

  test("DATA_DIR/backups is still left out when BACKUP_DIR is elsewhere", async () => {
    mkdirSync(join(dataDir, "backups"), { recursive: true });
    writeFileSync(join(dataDir, "backups", "bk_aaaa000000000001.mbbak"), "an older archive");
    const service = new BackupService({ dataDir, backupDir: join(root, "archives"), databases: [] });

    const made = await service.create(PASSPHRASE, "owner");
    await restoreArchive(service.store.pathFor(made.id), join(root, "restored"), PASSPHRASE);
    expect(existsSync(join(root, "restored", "backups"))).toBe(false);
  });
});

describe("BACKUP_KEEP after a backup succeeds", () => {
  test("only the newest N archives remain, and the backup just made is one of them", async () => {
    const service = new BackupService({ dataDir, backupDir: join(root, "archives"), keep: 2, databases: [] });
    const made = [
      await service.create(PASSPHRASE, "owner"),
      await service.create(PASSPHRASE, "owner"),
      await service.create(PASSPHRASE, "owner"),
    ];
    // `createdAt` has a millisecond resolution, so quick backups can share a timestamp; the id then decides, and the
    // newest backup is protected either way.
    const remaining = service.list().map((record) => record.id);
    expect(remaining).toHaveLength(2);
    expect(remaining).toContain(made[2]?.id ?? "");
    for (const older of made.filter((record) => !remaining.includes(record.id))) {
      expect(existsSync(service.store.pathFor(older.id))).toBe(false);
      expect(existsSync(join(service.store.dir(), `${older.id}.json`))).toBe(false);
    }
    expect(readdirSync(service.store.dir())).toHaveLength(4);
  });

  test("a backup that fails does not trigger a pass, so nothing older is removed", async () => {
    const corrupt = join(root, "events.db");
    writeFileSync(corrupt, "not a SQLite database");
    const backupDir = join(root, "archives");
    const service = new BackupService({
      dataDir,
      backupDir,
      keep: 1,
      databases: [{ name: "events.db", path: corrupt }],
    });
    const store = service.store;
    stored(store, "bk_aaaa000000000001", "2026-10-01T00:00:00.000Z");
    stored(store, "bk_aaaa000000000002", "2026-10-02T00:00:00.000Z");

    await expect(service.create(PASSPHRASE, "owner")).rejects.toThrow();
    expect(store.list().map((record) => record.id)).toEqual(["bk_aaaa000000000002", "bk_aaaa000000000001"]);
  });

  test("keep 0 keeps every backup after each create", async () => {
    const service = new BackupService({ dataDir, backupDir: join(root, "archives"), keep: 0, databases: [] });
    await service.create(PASSPHRASE, "owner");
    await service.create(PASSPHRASE, "owner");
    expect(service.list()).toHaveLength(2);
  });
});

describe("BACKUP_KEEP at startup", () => {
  test("the server applies the limit when it starts, before any backup runs", () => {
    const backupDir = join(dataDir, "backups");
    const seed = new BackupStore(dataDir);
    for (let day = 1; day <= 3; day++) stored(seed, `bk_aaaa00000000000${day}`, `2026-10-0${day}T00:00:00.000Z`);

    const { app } = createTestApp({ dataDir, backupDir, backupKeep: 1 });
    expect(app.backups.list().map((record) => record.id)).toEqual(["bk_aaaa000000000003"]);
    expect(readdirSync(backupDir).toSorted()).toEqual(["bk_aaaa000000000003.json", "bk_aaaa000000000003.mbbak"]);
  });

  test("an unset or invalid limit removes nothing at startup", () => {
    const seed = new BackupStore(dataDir);
    stored(seed, "bk_aaaa000000000001", "2026-10-01T00:00:00.000Z");
    stored(seed, "bk_aaaa000000000002", "2026-10-02T00:00:00.000Z");

    const { app } = createTestApp({ dataDir, backupDir: join(dataDir, "backups"), backupKeep: 0 });
    expect(app.backups.list()).toHaveLength(2);
  });

  test("a BACKUP_DIR outside DATA_DIR is pruned too, since it is the folder the server writes", () => {
    const backupDir = join(root, "archives");
    const seed = new BackupStore(dataDir, { dir: backupDir });
    stored(seed, "bk_aaaa000000000001", "2026-10-01T00:00:00.000Z");
    stored(seed, "bk_aaaa000000000002", "2026-10-02T00:00:00.000Z");

    const { app } = createTestApp({ dataDir, backupDir, backupKeep: 1 });
    expect(app.backups.store.dir()).toBe(backupDir);
    expect(app.backups.list().map((record) => record.id)).toEqual(["bk_aaaa000000000002"]);
  });
});
