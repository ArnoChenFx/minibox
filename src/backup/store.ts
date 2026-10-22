import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { DIR_MODE, ensureDataDir, writeFileAtomic } from "../data-dir";
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

/**
 * Backups kept under `DATA_DIR/backups`. An archive is written under a dot-prefixed name and renamed into place, and its
 * record is written last, so a listing never shows an archive that is still being written. Nothing expires: a backup
 * stays until it is deleted.
 */
export class BackupStore {
  constructor(private readonly dataDir: string) {}

  dir(): string {
    return join(this.dataDir, "backups");
  }

  pathFor(id: string): string {
    if (!isBackupId(id)) throw new Error(`refusing a backup path for ${id}`);
    return join(this.dir(), `${id}${BACKUP_EXTENSION}`);
  }

  partialPath(id: string): string {
    if (!isBackupId(id)) throw new Error(`refusing a backup path for ${id}`);
    return join(this.dir(), `.${id}.part`);
  }

  /** The directory exists before anything is written into it. */
  ensureDir(): void {
    ensureDataDir(this.dataDir);
    mkdirSync(this.dir(), { recursive: true, mode: DIR_MODE });
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
      if (isEnoent(e)) return null;
      throw e;
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
      if (isEnoent(e)) return null;
      throw e;
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
      if (!name.startsWith(".") && !orphan) continue;
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
