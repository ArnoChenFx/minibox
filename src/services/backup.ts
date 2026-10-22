import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

import { type DatabaseSource, writeArchive } from "../backup/create";
import { writeAll } from "../backup/io";
import { BACKUP_EXTENSION, BACKUP_VERSION, type BackupRecord, BackupStore } from "../backup/store";
import type { ByteStream } from "../lib/body";
import { badRequest, conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";

export interface BackupView {
  id: string;
  origin: BackupRecord["origin"];
  targetId: string | null;
  createdBy: string | null;
  bytes: number;
  sha256: string;
  entries: number;
  createdAt: string;
  url: string;
}

export function backupView(record: BackupRecord): BackupView {
  return {
    id: record.id,
    origin: record.origin,
    targetId: record.targetId,
    createdBy: record.createdBy,
    bytes: record.bytes,
    sha256: record.sha256,
    entries: record.entries,
    createdAt: record.createdAt,
    url: `/api/backups/${record.id}/download`,
  };
}

export interface BackupServiceOptions {
  readonly dataDir: string;
  /** The SQLite stores copied with `VACUUM INTO`. A store without a file, `:memory:`, is left out. */
  readonly databases: readonly DatabaseSource[];
}

/**
 * Makes and keeps backups of DATA_DIR. An archive is written under a partial name, renamed into place, and given its
 * record last, so a listing never shows an archive that is still being written. The passphrase goes to the archive
 * writer and nowhere else: it is not kept, logged or returned.
 */
export class BackupService {
  readonly store: BackupStore;
  private readonly receiving = new Set<string>();

  constructor(private readonly options: BackupServiceOptions) {
    this.store = new BackupStore(options.dataDir);
  }

  /** Removes what a crash left behind. Runs once at startup, before any backup can be running. */
  sweepPartial(): number {
    return this.store.sweepPartial();
  }

  async create(passphrase: string, createdBy: string | null, progress?: (line: string) => void): Promise<BackupRecord> {
    this.store.ensureDir();
    const id = this.store.allocateId();
    try {
      const summary = await writeArchive({
        dataDir: this.options.dataDir,
        databases: this.options.databases,
        passphrase,
        output: this.store.partialPath(id),
        log: progress,
      });
      this.store.commitArchive(id);
      const record: BackupRecord = {
        version: BACKUP_VERSION,
        id,
        origin: "create",
        targetId: null,
        createdBy,
        bytes: summary.bytes,
        sha256: summary.sha256,
        entries: summary.entries,
        createdAt: new Date().toISOString(),
      };
      this.store.write(record);
      log.info("backup.created", { id, bytes: record.bytes, entries: record.entries });
      return record;
    } catch (e) {
      this.store.remove(id);
      throw e;
    }
  }

  list(): BackupRecord[] {
    return this.store.list();
  }

  /** The record of a backup whose archive is whole, or null. A record without its archive is not a backup. */
  whole(id: string): BackupRecord | null {
    const record = this.store.read(id);
    return record !== null && this.store.fileBytes(id) === record.bytes ? record : null;
  }

  /** A backup whose archive is whole. Anything else is not found. */
  stored(id: string): BackupRecord {
    const record = this.whole(id);
    if (!record) throw notFound(msg("backup_not_found", { id }));
    return record;
  }

  open(record: BackupRecord): ByteStream {
    return {
      kind: "bytes",
      filename: `${record.id}${BACKUP_EXTENSION}`,
      contentType: "application/octet-stream",
      length: record.bytes,
      body: Bun.file(this.store.pathFor(record.id)).stream(),
    };
  }

  remove(id: string): void {
    if (!this.store.read(id)) throw notFound(msg("backup_not_found", { id }));
    this.store.remove(id);
    log.info("backup.removed", { id });
  }

  /**
   * Stores an archive pulled from a target. The record is the one the target kept beside it, and the bytes must match
   * it, so a damaged or substituted archive is refused and leaves nothing behind. A leftover from an interrupted receive
   * is replaced; a whole backup with the same id is not, and neither is a second receive of an id already in flight.
   */
  async receive(record: BackupRecord, source: AsyncIterable<Uint8Array>): Promise<BackupRecord> {
    if (this.receiving.has(record.id) || this.whole(record.id) !== null) {
      throw conflict(msg("backup_exists", { id: record.id }));
    }
    this.receiving.add(record.id);
    try {
      this.store.remove(record.id);
      this.store.ensureDir();
      const received = await writeStream(this.store.partialPath(record.id), source, record.bytes);
      if (received.bytes !== record.bytes || received.sha256 !== record.sha256) {
        throw badRequest(msg("backup_invalid", { reason: "the archive does not match its record" }));
      }
      this.store.commitArchive(record.id);
      this.store.write(record);
      log.info("backup.received", { id: record.id, bytes: record.bytes, origin: record.origin });
      return record;
    } catch (e) {
      this.store.remove(record.id);
      throw e;
    } finally {
      this.receiving.delete(record.id);
    }
  }
}

/** Writes a stream to a new file and hashes it. A stream longer than `limit` is cut off and refused. */
async function writeStream(
  path: string,
  source: AsyncIterable<Uint8Array>,
  limit: number,
): Promise<{ bytes: number; sha256: string }> {
  const handle = await open(path, "wx", 0o600);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of source) {
      bytes += chunk.byteLength;
      if (bytes > limit) throw badRequest(msg("backup_invalid", { reason: "the archive is longer than its record" }));
      hash.update(chunk);
      await writeAll(handle, chunk);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { bytes, sha256: hash.digest("hex") };
}
