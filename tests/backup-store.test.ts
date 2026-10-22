import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BACKUP_VERSION, type BackupRecord, BackupStore, isBackupId, newBackupId } from "../src/backup/store";
import { silenceLogs } from "./support/app";

function recordFor(id: string, createdAt: string): BackupRecord {
  return {
    version: BACKUP_VERSION,
    id,
    origin: "create",
    targetId: null,
    createdBy: "owner",
    bytes: 7,
    sha256: "a".repeat(64),
    entries: 3,
    createdAt,
  };
}

describe("backup store", () => {
  let dataDir: string;
  let store: BackupStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "minibox-backups-"));
    store = new BackupStore(dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function finish(id: string, createdAt: string): void {
    store.ensureDir();
    writeFileSync(store.partialPath(id), "archive");
    store.commitArchive(id);
    store.write(recordFor(id, createdAt));
  }

  test("ids have one shape, and anything else is refused as a path", () => {
    expect(isBackupId(newBackupId())).toBe(true);
    expect(newBackupId().startsWith("bk_")).toBe(true);
    expect(isBackupId("../escape")).toBe(false);
    expect(() => store.pathFor("../escape")).toThrow("refusing");
    expect(store.read("../escape")).toBeNull();
  });

  test("an archive is listed only once its record is written, newest first", () => {
    const older = store.allocateId();
    finish(older, "2026-10-01T00:00:00.000Z");
    const newer = store.allocateId();
    store.ensureDir();
    writeFileSync(store.partialPath(newer), "archive");
    store.commitArchive(newer);
    expect(store.list().map((record) => record.id)).toEqual([older]);

    store.write(recordFor(newer, "2026-10-02T00:00:00.000Z"));
    expect(store.list().map((record) => record.id)).toEqual([newer, older]);
    expect(store.fileBytes(newer)).toBe("archive".length);
  });

  test("a record that does not parse is skipped, and listing goes on", () => {
    const restoreLogs = silenceLogs();
    try {
      store.ensureDir();
      const broken = store.allocateId();
      writeFileSync(join(store.dir(), `${broken}.json`), "{ not json");
      finish(store.allocateId(), "2026-10-03T00:00:00.000Z");
      expect(store.read(broken)).toBeNull();
      expect(store.list()).toHaveLength(1);
    } finally {
      restoreLogs();
    }
  });

  test("a record whose id does not match its file name is not trusted", () => {
    store.ensureDir();
    const named = store.allocateId();
    const other = store.allocateId();
    writeFileSync(join(store.dir(), `${named}.json`), JSON.stringify(recordFor(other, "2026-10-04T00:00:00.000Z")));
    expect(store.read(named)).toBeNull();
  });

  test("sweepPartial removes what a crash left behind and keeps finished backups", () => {
    const finished = store.allocateId();
    finish(finished, "2026-10-05T00:00:00.000Z");
    const crashed = store.allocateId();
    writeFileSync(store.partialPath(crashed), "half");
    writeFileSync(join(store.dir(), ".snapshot-abc123"), "staging");
    writeFileSync(join(store.dir(), `.${finished}.json.beef.tmp`), "temporary record");

    expect(store.sweepPartial()).toBe(3);
    expect(readdirSync(store.dir()).toSorted()).toEqual([`${finished}.json`, `${finished}.mbbak`]);
    expect(store.list().map((record) => record.id)).toEqual([finished]);
  });

  test("remove deletes the archive and its record, and a retry is harmless", () => {
    const id = store.allocateId();
    finish(id, "2026-10-06T00:00:00.000Z");
    store.remove(id);
    expect(existsSync(store.pathFor(id))).toBe(false);
    expect(store.read(id)).toBeNull();
    expect(() => store.remove(id)).not.toThrow();
    expect(store.fileBytes(id)).toBeNull();
  });
});
