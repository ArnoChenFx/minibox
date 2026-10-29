import { log } from "../lib/logger";
import type { BackupRecord, BackupStore } from "./store";

/** What one pass of `BACKUP_KEEP` did. `kept` counts the whole backups that are left. */
export interface RetentionResult {
  readonly removed: readonly BackupRecord[];
  readonly kept: number;
}

export interface RetentionOptions {
  /**
   * A backup that this pass must keep, such as the one it runs after. Two backups can share a millisecond, and the one
   * just written is the newest by any reading, so a tie must never delete it and leave the caller with an id that is
   * already gone.
   */
  readonly protect?: string;
}

/** Newest first: by `createdAt`, then by id, so a pass is deterministic even when timestamps collide. */
function compareRecords(a: BackupRecord, b: BackupRecord): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Keeps the newest `keep` backups in `store` and removes the older ones. `keep` of 0 or less keeps everything, which is
 * what `BACKUP_KEEP` unset or blank means, and what an invalid value falls back to: a typo must never delete an archive.
 *
 * Only a backup whose archive is whole counts as one and can be removed. A record whose archive is gone or short, a
 * partial archive, and a file this tool did not write are left alone, so a folder that holds other things keeps them.
 * A backup that cannot be removed is logged and left for the next pass. Enumeration errors propagate to BackupService,
 * which isolates maintenance failures from startup and from the completed archive.
 */
export function applyBackupRetention(
  store: BackupStore,
  keep: number,
  options: RetentionOptions = {},
): RetentionResult {
  const whole = store.list().filter((record) => store.fileBytes(record.id) === record.bytes);
  if (!Number.isInteger(keep) || keep <= 0) return { removed: [], kept: whole.length };
  const ordered = whole.toSorted(compareRecords);
  const pinned = options.protect === undefined ? undefined : ordered.find((record) => record.id === options.protect);
  const ranked = pinned ? [pinned, ...ordered.filter((record) => record !== pinned)] : ordered;
  const kept = new Set(ranked.slice(0, keep).map((record) => record.id));
  const removed: BackupRecord[] = [];
  for (const record of ranked) {
    if (kept.has(record.id)) continue;
    try {
      store.remove(record.id);
      removed.push(record);
    } catch (e) {
      log.error("backup.retention_failed", { id: record.id, error: String(e) });
    }
  }
  if (removed.length > 0) {
    log.info("backup.retention_applied", { keep, removed: removed.length, ids: removed.map((record) => record.id) });
  }
  return { removed, kept: whole.length - removed.length };
}
