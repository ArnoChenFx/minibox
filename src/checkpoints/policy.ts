import type { CheckpointRecord } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How automatic checkpoints are kept, and how much repository space they may use. A zero bound is off: `keepDays` of 0
 * keeps automatic checkpoints whatever their age, and `capacityBytes` of 0 sets no limit.
 */
export interface CheckpointPolicy {
  /** Automatic checkpoints kept per box, newest first. */
  readonly keepLast: number;
  /** Automatic checkpoints older than this many days are removed. */
  readonly keepDays: number;
  /** Repository size in bytes at which new automatic checkpoints are refused. */
  readonly capacityBytes: number;
  /** Days a deleted box or volume stays in the recycle bin. */
  readonly trashKeepDays: number;
}

/** The share of the capacity limit from which usage is reported as a warning. */
const CAPACITY_WARN_RATIO = 0.8;

export type CapacityState = "unlimited" | "ok" | "warning" | "exceeded";

export function capacityStateOf(bytes: number, limitBytes: number): CapacityState {
  if (limitBytes === 0) return "unlimited";
  if (bytes >= limitBytes) return "exceeded";
  if (bytes >= limitBytes * CAPACITY_WARN_RATIO) return "warning";
  return "ok";
}

/** When a recycle bin entry taken at `now` expires under a retention of `keepDays`. */
export function trashExpiresAt(now: number, keepDays: number): string {
  return new Date(now + keepDays * DAY_MS).toISOString();
}

/** The recycle bin entries whose retention has ended by `now`. Nothing else is a candidate. */
export function expiredTrash(records: readonly CheckpointRecord[], now: number): CheckpointRecord[] {
  return records.filter((record) => record.trash !== null && Date.parse(record.trash.expiresAt) <= now);
}

/**
 * The automatic checkpoints the policy removes. Manual and pinned checkpoints are never candidates. Among a box's
 * candidates the newest `keepLast` stay, and any older than `keepDays` go. A checkpoint in `held` always stays: it is the
 * only copy of the data a pending rollback replaced.
 */
export function expiredAutomatic(
  records: readonly CheckpointRecord[],
  policy: CheckpointPolicy,
  now: number,
  held: ReadonlySet<string>,
): CheckpointRecord[] {
  const byBox = new Map<string, CheckpointRecord[]>();
  for (const record of records) {
    if (record.trash !== null || !record.auto || record.pinned || record.boxId === null) continue;
    const group = byBox.get(record.boxId) ?? [];
    group.push(record);
    byBox.set(record.boxId, group);
  }
  const ageLimitMs = policy.keepDays > 0 ? policy.keepDays * DAY_MS : null;
  const expired: CheckpointRecord[] = [];
  for (const group of byBox.values()) {
    group.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id));
    group.forEach((record, rank) => {
      const overCount = rank >= policy.keepLast;
      const tooOld = ageLimitMs !== null && now - Date.parse(record.createdAt) > ageLimitMs;
      if ((overCount || tooOld) && !held.has(record.id)) expired.push(record);
    });
  }
  return expired;
}
