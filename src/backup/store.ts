import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { ensureDataDir, ensurePrivateDir, isWithinDir, writeFileAtomic } from "../data-dir";
import { log } from "../lib/logger";
import { isEnoent } from "./io";

export const BACKUP_EXTENSION = ".mbbak";
export const BACKUP_VERSION = 1;
const BACKUP_ID_RE = /^bk_[0-9a-z]{8,32}$/;
const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function isBackupId(value: string): boolean {
  return BACKUP_ID_RE.test(value);
}

/** A stable id for a backup. It names no box and no time, so it can be listed and pushed to a target. */
export function newBackupId(): string {
  let id = "bk_";
  for (const byte of randomBytes(16)) id += ID_ALPHABET[byte % ID_ALPHABET.length] ?? "0";
  return id;
}

/** What is known about a stored backup. The archive is `<id>.mbbak`, and this `<id>.json` is written after it. */
export const BackupRecordSchema = z.strictObject({
  version: z.literal(BACKUP_VERSION),
  id: z.string().refine(isBackupId, "not a backup id"),
  origin: z.enum(["create", "target"]),
  targetId: z.string().nullable(),
  createdBy: z.string().nullable(),
  bytes: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  entries: z.number().int().min(0),
  createdAt: z.iso.datetime(),
});

export type BackupRecord = z.infer<typeof BackupRecordSchema>;

export interface BackupStoreOptions {
  /** The folder the archives and records live in. Defaults to `DATA_DIR/backups`. */
  readonly dir?: string;
}

/**
 * Backups kept in one folder: `DATA_DIR/backups` by default, or `BACKUP_DIR` when that is set. An archive is written under
 * a dot-prefixed name and renamed into place, and its record is written last, so a listing never shows an archive that is
 * still being written. Nothing expires on its own: a backup stays until it is deleted, or until `BACKUP_KEEP` removes it.
 */
export class BackupStore {
  private readonly archiveDir: string;

  constructor(
    private readonly dataDir: string,
    options: BackupStoreOptions = {},
  ) {
    this.archiveDir = options.dir ?? join(dataDir, "backups");
  }

  /** The folder the archives live in, which is `BACKUP_DIR` when that is set. */
  dir(): string {
    return this.archiveDir;
  }

  /** Whether the archives sit in `DATA_DIR/backups`, and so are left out of a backup of `DATA_DIR`. */
  insideDataDir(): boolean {
    return isWithinDir(this.archiveDir, join(this.dataDir, "backups"));
  }

  pathFor(id: string): string {
    if (!isBackupId(id)) throw new Error(`refusing a backup path for ${id}`);
    return join(this.dir(), `${id}${BACKUP_EXTENSION}`);
  }

  partialPath(id: string): string {
    if (!isBackupId(id)) throw new Error(`refusing a backup path for ${id}`);
    return join(this.dir(), `.${id}.part`);
  }

  /** New backup folders are private; an existing custom folder retains the operator’s chosen permissions. */
  ensureDir(): void {
    ensureDataDir(this.dataDir);
    if (this.insideDataDir()) ensurePrivateDir(this.dir());
    else {
      const created = mkdirSync(this.dir(), { recursive: true, mode: 0o700 });
      if (created === undefined && (statSync(this.dir()).mode & 0o077) !== 0) {
        log.warn("backup.directory_shared", { path: this.dir() });
      }
    }
  }

  allocateId(): string {
    let id = newBackupId();
    for (let attempt = 0; attempt < 5 && this.exists(id); attempt++) id = newBackupId();
    if (this.exists(id)) throw new Error("could not allocate a backup id");
    return id;
  }

  read(id: string): BackupRecord | null {
    if (!isBackupId(id)) return null;
    let text: string;
    try {
      text = readFileSync(this.recordPath(id), "utf8");
    } catch (e) {
      if (!isEnoent(e)) log.warn("backup.record_unreadable", { id, error: String(e) });
      return null;
    }
    try {
      const parsed = BackupRecordSchema.safeParse(JSON.parse(text));
      if (parsed.success && parsed.data.id === id) return parsed.data;
      log.warn("backup.record_unreadable", { id, error: "not a backup record" });
    } catch (e) {
      log.warn("backup.record_unreadable", { id, error: String(e) });
    }
    return null;
  }

  /** Stored backups, newest first. A record that cannot be read is skipped and logged. */
  list(): BackupRecord[] {
    const records: BackupRecord[] = [];
    for (const name of this.names()) {
      if (name.startsWith(".") || !name.endsWith(".json")) continue;
      const record = this.read(name.slice(0, -".json".length));
      if (record) records.push(record);
    }
    return records.toSorted((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  /** Moves a finished archive into place. The record is written separately, once the archive is complete. */
  commitArchive(id: string): void {
    renameSync(this.partialPath(id), this.pathFor(id));
  }

  write(record: BackupRecord): void {
    this.ensureDir();
    writeFileAtomic(this.recordPath(record.id), `${JSON.stringify(record, null, 2)}\n`);
  }

  /** Removes the archive and its record. A missing one is not an error, so a retry can finish the job. */
  remove(id: string): void {
    for (const path of [this.pathFor(id), this.recordPath(id), this.partialPath(id)]) {
      try {
        unlinkSync(path);
      } catch (e) {
        if (!isEnoent(e)) throw e;
      }
    }
  }

  /** The size of the stored archive, read from disk rather than trusted from the record. Null when it is gone. */
  fileBytes(id: string): number | null {
    try {
      return statSync(this.pathFor(id)).size;
    } catch (e) {
      if (!isEnoent(e)) log.warn("backup.record_unreadable", { id, error: String(e) });
      return null;
    }
  }

  /**
   * Removes what a crash left behind: partial archives, staging folders, temporary records, and archives whose record was
   * never written. Called once at startup, before any backup can be running.
   */
  sweepPartial(): number {
    let removed = 0;
    const names = this.names();
    for (const name of names) {
      const orphan = this.isOrphanArchive(name, names);
      const partial = name.startsWith(".") && name.endsWith(".part") && isBackupId(name.slice(1, -5));
      const temporaryRecord = /^\.bk_[0-9a-z]{8,32}\.json\.[0-9a-f]+\.tmp$/.test(name);
      const snapshot = /^\.snapshot-[A-Za-z0-9]+$/.test(name);
      if (!partial && !temporaryRecord && !snapshot && !orphan) continue;
      rmSync(join(this.dir(), name), { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }

  exists(id: string): boolean {
    return existsSync(this.recordPath(id)) || existsSync(this.pathFor(id));
  }

  private recordPath(id: string): string {
    if (!isBackupId(id)) throw new Error(`refusing a backup record path for ${id}`);
    return join(this.dir(), `${id}.json`);
  }

  private names(): string[] {
    try {
      return readdirSync(this.dir());
    } catch (e) {
      if (isEnoent(e)) return [];
      throw e;
    }
  }

  private isOrphanArchive(name: string, names: string[]): boolean {
    if (!name.endsWith(BACKUP_EXTENSION)) return false;
    const id = name.slice(0, -BACKUP_EXTENSION.length);
    return isBackupId(id) && !names.includes(`${id}.json`);
  }
}
