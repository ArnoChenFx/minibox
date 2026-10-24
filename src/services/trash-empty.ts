import type { TrashKind } from "../checkpoints/types";
import type { HostCtx } from "../host/registry";
import { msg } from "../lib/messages";
import type { TaskReader } from "../tasks/types";
import { listTrash, purgeEntry, type TrashEntry, trashEntryOf } from "./trash";
import type { RecordNote } from "./volume-owner";
import { errorOutcome, hostOffline, messageOutcome, type OutcomeError } from "./volume-refs";
import type { StoragePreview } from "./volumes";

/** The operations that hold a recycle bin entry while they run. An entry one of them names is never purged under it. */
const HOLDING_OPS: ReadonlySet<string> = new Set(["trash.restore", "trash.purge"]);

/** Why an entry is left in the recycle bin: an export or copy of it runs, a restore or purge runs, or its host is offline. */
export type TrashBlock = "exporting" | "busy" | "offline";

export type EmptiedStatus = "candidate" | "removed" | "refused" | "failed";

/** One recycle bin entry an empty looked at. A preview row is a `candidate`, or `refused` with the reason it stays. */
export interface EmptiedEntry {
  id: string;
  hostId: string;
  kind: TrashKind;
  sourceId: string;
  sourceName: string;
  bytes: number;
  status: EmptiedStatus;
  blocked: TrashBlock | null;
  error: OutcomeError | null;
}

/** An entry after the purge: what happened to it. */
export type PurgedEntry = EmptiedEntry & { status: Exclude<EmptiedStatus, "candidate"> };

export interface EmptiedHost {
  hostId: string;
  name: string;
  status: "checked" | "offline" | "failed";
  error: OutcomeError | null;
}

export interface EmptyScan {
  entries: EmptiedEntry[];
  hosts: EmptiedHost[];
}

export interface EmptyOptions {
  /**
   * The entries to consider, by id. Null considers every entry. An id that is no longer in the recycle bin, because it
   * expired or was purged in the meantime, is skipped: it is already gone.
   */
  readonly ids: readonly string[] | null;
  readonly tasks?: TaskReader;
  readonly record?: RecordNote;
  /** Called for each entry a purge was tried on, whatever its outcome, so the caller can report it. */
  readonly onPurge?: (entry: PurgedEntry) => void;
}

interface Block {
  code: TrashBlock;
  error: OutcomeError;
}

function rowOf(entry: TrashEntry, block: Block | null): EmptiedEntry {
  return {
    id: entry.id,
    hostId: entry.hostId,
    kind: entry.kind,
    sourceId: entry.sourceId,
    sourceName: entry.sourceName,
    bytes: entry.bytes,
    status: block ? "refused" : "candidate",
    blocked: block?.code ?? null,
    error: block?.error ?? null,
  };
}

/** Whether a restore or a purge of this entry is queued or running, so it must be left to that task. */
function heldByTask(entryId: string, tasks: TaskReader | undefined): boolean {
  if (!tasks) return false;
  for (const status of ["running", "queued"] as const) {
    const held = tasks.list({ status, limit: 1000 });
    if (held.some((task) => HOLDING_OPS.has(task.op) && task.target?.id === entryId)) return true;
  }
  return false;
}

/** Why an entry cannot be purged right now, or null when it can. */
function blockedReason(host: HostCtx, entry: TrashEntry, tasks: TaskReader | undefined): Block | null {
  if (host.checkpoints.exporting.has(entry.id)) {
    return { code: "exporting", error: messageOutcome(msg("checkpoint_exporting", { id: entry.id })) };
  }
  if (heldByTask(entry.id, tasks)) {
    return { code: "busy", error: messageOutcome(msg("trash_busy", { name: entry.sourceName })) };
  }
  return null;
}

/**
 * Reads the recycle bin of every host and says which entries an empty would purge: each is a `candidate`, or `refused`
 * with its reason, namely an export or copy of it is running, a restore or purge of it is running, or its host is
 * offline. Nothing is changed. An id the request names that is not in the recycle bin is left out.
 */
export async function scanTrash(hosts: readonly HostCtx[], opts: EmptyOptions): Promise<EmptyScan> {
  const wanted = opts.ids === null ? null : new Set(opts.ids);
  const scan: EmptyScan = { entries: [], hosts: [] };
  for (const host of hosts) {
    const hostId = host.host.id;
    const name = host.host.name;
    let listed: TrashEntry[];
    try {
      listed = await listTrash(host);
    } catch (e) {
      scan.hosts.push({ hostId, name, status: "failed", error: errorOutcome(e) });
      continue;
    }
    const offline = hostOffline(host);
    const error = offline ? messageOutcome(msg("trash_host_offline", { host: name })) : null;
    const gone: Block | null = error ? { code: "offline", error } : null;
    scan.hosts.push({ hostId, name, status: offline ? "offline" : "checked", error });
    for (const entry of listed) {
      if (wanted && !wanted.has(entry.id)) continue;
      scan.entries.push(rowOf(entry, gone ?? blockedReason(host, entry, opts.tasks)));
    }
  }
  return scan;
}

/** The entry as it is now, or null when it has gone since the scan: it expired, or something purged it. */
function stillKept(host: HostCtx, id: string): TrashEntry | null {
  try {
    return trashEntryOf(host, id);
  } catch {
    return null;
  }
}

/**
 * Purges the entries a scan listed as candidates, one at a time, and returns every row the scan listed with its
 * outcome. A candidate is checked again just before its purge, because a restore may have begun since the scan. An
 * entry that cannot be purged is reported and the rest go on.
 */
export async function purgeScanned(
  hosts: readonly HostCtx[],
  scan: EmptyScan,
  opts: EmptyOptions,
): Promise<PurgedEntry[]> {
  const byId = new Map(hosts.map((host) => [host.host.id, host]));
  const rows: PurgedEntry[] = [];
  for (const row of scan.entries) {
    const host = byId.get(row.hostId);
    if (row.status !== "candidate" || !host) {
      const left: PurgedEntry = { ...row, status: row.status === "candidate" ? "refused" : row.status };
      rows.push(left);
      opts.onPurge?.(left);
      continue;
    }
    const current = stillKept(host, row.id);
    if (!current) continue;
    const reason = blockedReason(host, current, opts.tasks);
    let done: PurgedEntry;
    if (reason) {
      done = { ...row, status: "refused", blocked: reason.code, error: reason.error };
    } else {
      try {
        await purgeEntry(host, row.id, "emptied", opts.record);
        done = { ...row, status: "removed" };
      } catch (e) {
        done = { ...row, status: "failed", error: errorOutcome(e) };
      }
    }
    rows.push(done);
    opts.onPurge?.(done);
  }
  return rows;
}

/** What an unconfirmed empty reports: the entries it would purge and the ones it would leave, with why. */
export function previewEmptyTrash(scan: EmptyScan): StoragePreview {
  const going = scan.entries.filter((row) => row.status === "candidate");
  return {
    action: "empty_trash",
    count: going.length,
    bytes: going.reduce((sum, row) => sum + row.bytes, 0),
    entries: scan.entries.map((row) => ({
      id: row.id,
      hostId: row.hostId,
      kind: row.kind,
      sourceName: row.sourceName,
      bytes: row.bytes,
      blocked: row.blocked,
    })),
  };
}
