import type { TrashRef } from "../checkpoints/types";
import type { HostCtx } from "../host/registry";
import { conflict } from "../lib/errors";
import { msg } from "../lib/messages";
import type { TaskReader } from "../tasks/types";
import { claimEngineVolumes } from "../volumes/engine";
import { removeEngine } from "../volumes/provision";
import type { VolumeRecord } from "../volumes/types";
import { measureTree } from "../volumes/usage";
import { discardCopy, keepsVolume, trashVolume } from "./trash";
import type { RecordNote } from "./volume-owner";
import { errorOutcome, hostOffline, messageOutcome, type OutcomeError, volumesInUse } from "./volume-refs";

/** A volume is left alone until it was created, and last used, this long ago, so a box that is being set up keeps its volumes. */
export const PRUNE_GRACE_MS = 5 * 60 * 1000;

/** Operations whose volumes are still filling when they start. A prune on the same host waits for them to finish. */
const FILLING_OPS: ReadonlySet<string> = new Set([
  "box.move",
  "box.rollback",
  "checkpoint.fork",
  "checkpoint.import",
  "trash.restore",
]);

export type PruneStatus = "candidate" | "removed" | "refused" | "failed";

export interface PrunedVolume {
  id: string;
  name: string;
  hostId: string;
  pool: string;
  /** Null when the size is not known. */
  bytes: number | null;
  /** When a box last mounted the volume, or when it was created when no box ever did. */
  lastUsedAt: string;
  /** The box that last mounted the volume, or null when none did. */
  formerBox: string | null;
  status: PruneStatus;
  trash: TrashRef | null;
  error: OutcomeError | null;
}

export interface PrunedHost {
  hostId: string;
  name: string;
  status: "checked" | "offline" | "failed";
  error: OutcomeError | null;
}

export interface PruneResult {
  volumes: PrunedVolume[];
  hosts: PrunedHost[];
}

export interface PruneOptions {
  readonly dryRun: boolean;
  /** Only volumes unused for at least this long, in milliseconds. The grace period applies in any case. */
  readonly olderThanMs: number | null;
  /** The principal that removes the volumes. It is recorded on each recycle bin entry a removal keeps. */
  readonly principal: string;
  /** Whether the caller may delete one volume. A token may delete only the volumes it created. */
  readonly may: (volume: VolumeRecord) => Promise<boolean>;
  readonly tasks?: TaskReader;
  readonly record?: RecordNote;
  /** Called for each volume a removal was tried on, whatever its outcome, so the caller can add it to the activity feed. */
  readonly onRemoval?: (volume: PrunedVolume) => void;
  readonly now?: number;
}

/** When a volume was last used: the last time a box stopped mounting it, or its creation when none ever did. */
export function lastUsedAt(volume: Pick<VolumeRecord, "createdAt" | "lastMount">): string {
  return volume.lastMount?.at ?? volume.createdAt;
}

/**
 * Finds the volumes MiniBox made that nothing uses: no box spec, no container in any state, and no rollback that keeps
 * them. A dry run returns them. Otherwise each one is kept in the recycle bin, then removed once a second check under
 * the spec lock still finds it unused. Each host is pruned on its own, so an offline or failing host is reported and
 * skipped while the others are pruned.
 */
export async function pruneVolumes(hosts: readonly HostCtx[], opts: PruneOptions): Promise<PruneResult> {
  const result: PruneResult = { volumes: [], hosts: [] };
  for (const host of hosts) {
    const hostId = host.host.id;
    const name = host.host.name;
    if (hostOffline(host)) {
      const error = messageOutcome(msg("volume_host_offline", { host: name }));
      result.hosts.push({ hostId, name, status: "offline", error });
      continue;
    }
    let candidates: VolumeRecord[];
    try {
      candidates = await orphansOf(host, opts);
    } catch (e) {
      result.hosts.push({ hostId, name, status: "failed", error: hostFailure(e, name) });
      continue;
    }
    result.hosts.push({ hostId, name, status: "checked", error: null });
    for (const candidate of candidates) {
      const row = opts.dryRun ? await previewOf(host, candidate) : await removeOrphan(host, candidate, opts);
      result.volumes.push(row);
      if (row.status !== "candidate") opts.onRemoval?.(row);
    }
  }
  return result;
}

function hostFailure(error: unknown, host: string): OutcomeError {
  const outcome = errorOutcome(error);
  if (outcome.key === "volume_prune_busy") return outcome;
  return messageOutcome(msg("volume_host_failed", { host, detail: outcome.message }));
}

async function orphansOf(host: HostCtx, opts: PruneOptions): Promise<VolumeRecord[]> {
  if (fillingTaskOn(host, opts.tasks)) throw conflict(msg("volume_prune_busy"));
  await claimEngineVolumes(host);
  const inUse = await volumesInUse(host);
  const now = opts.now ?? Date.now();
  const minAgeMs = Math.max(PRUNE_GRACE_MS, opts.olderThanMs ?? 0);
  const found: VolumeRecord[] = [];
  for (const volume of host.volumes.list()) {
    if (volume.hostId !== host.host.id || volume.role === "tools" || inUse.has(volume.engineName)) continue;
    if (now - Date.parse(lastUsedAt(volume)) < minAgeMs) continue;
    if (await opts.may(volume)) found.push(volume);
  }
  return found.toSorted((a, b) => a.name.localeCompare(b.name));
}

function fillingTaskOn(host: HostCtx, tasks: TaskReader | undefined): boolean {
  const running = tasks?.list({ status: "running", limit: 1000 }) ?? [];
  return running.some((task) => task.hostId === host.host.id && FILLING_OPS.has(task.op));
}

async function previewOf(host: HostCtx, volume: VolumeRecord): Promise<PrunedVolume> {
  return rowOf(volume, { status: "candidate", bytes: await sizeOf(host, volume), trash: null, error: null });
}

type Settled = { status: "removed" } | { status: "refused" | "failed"; error: OutcomeError };

async function removeOrphan(host: HostCtx, volume: VolumeRecord, opts: PruneOptions): Promise<PrunedVolume> {
  const bytes = await sizeOf(host, volume);
  let trash: TrashRef | null = null;
  let settled: Settled;
  try {
    trash = keepsVolume(volume, false) ? await trashVolume(host, volume, opts.principal, opts.record) : null;
    settled = await host.specs.exclusive(() => removeIfUnused(host, volume));
  } catch (e) {
    settled = { status: "failed", error: errorOutcome(e) };
  }
  if (settled.status === "removed") {
    const row = rowOf(volume, { status: "removed", bytes, trash, error: null });
    auditRemoval(opts.record, row);
    return row;
  }
  await discardCopy(host, trash, opts.record);
  const row = rowOf(volume, { status: settled.status, bytes, trash: null, error: settled.error });
  auditRemoval(opts.record, row);
  return row;
}

/** Runs under the spec lock, where a box create or a rebuild that would mount the volume cannot be part way through. */
async function removeIfUnused(host: HostCtx, volume: VolumeRecord): Promise<Settled> {
  const current = host.volumes.read(volume.id);
  if (!current || !sameVolume(current, volume)) {
    return { status: "refused", error: messageOutcome(msg("volume_prune_changed", { volume: volume.name })) };
  }
  if ((await volumesInUse(host)).has(volume.engineName)) {
    return { status: "refused", error: messageOutcome(msg("volume_in_use_by_box", { volume: volume.name })) };
  }
  const removal = await removeEngine(host, volume.engineName);
  if (removal.status === "failed") {
    const error = msg("volume_delete_failed", { name: volume.name, detail: removal.detail });
    return { status: "failed", error: messageOutcome(error) };
  }
  host.volumes.remove(volume.id);
  return { status: "removed" };
}

/** Whether a volume still has the record it had when it was listed. Its data and sample may change; its owner may not. */
function sameVolume(current: VolumeRecord, listed: VolumeRecord): boolean {
  return (
    current.engineName === listed.engineName &&
    current.pool === listed.pool &&
    current.role === listed.role &&
    current.ownership === listed.ownership &&
    current.ownerBoxId === listed.ownerBoxId
  );
}

/**
 * The size a volume is listed with: its last sample, which the usage sampler keeps current. An NFS pool's sample is the
 * whole share, so that volume is measured instead.
 */
async function sizeOf(host: HostCtx, volume: VolumeRecord): Promise<number | null> {
  const pool = host.volumes.readPools().pools.find((item) => item.name === volume.pool);
  if (pool?.backend !== "nfs" && volume.bytes !== null) return volume.bytes;
  try {
    return await measureTree(host, volume.engineName);
  } catch {
    return null;
  }
}

function rowOf(volume: VolumeRecord, fields: Pick<PrunedVolume, "status" | "bytes" | "trash" | "error">): PrunedVolume {
  return {
    id: volume.id,
    name: volume.name,
    hostId: volume.hostId,
    pool: volume.pool,
    lastUsedAt: lastUsedAt(volume),
    formerBox: volume.lastMount?.boxName ?? null,
    ...fields,
  };
}

function auditRemoval(record: RecordNote | undefined, row: PrunedVolume): void {
  if (row.status === "candidate") return;
  const summary = {
    removed: `Orphaned volume removed: ${row.name}`,
    refused: `Orphaned volume kept: ${row.name}`,
    failed: `Orphaned volume could not be removed: ${row.name}`,
  }[row.status];
  const failed = row.status !== "removed";
  record?.({
    op: "volume.delete",
    kind: "destructive",
    status: failed ? "error" : "ok",
    summary,
    target: { kind: "volume", id: row.id, name: row.name },
    detail: { bytes: row.bytes, trash: row.trash?.id ?? null, lastUsedAt: row.lastUsedAt, formerBox: row.formerBox },
    ...(failed
      ? { error: row.status === "failed" ? { code: "docker_error", status: 502 } : { code: "conflict", status: 409 } }
      : {}),
  });
}
