import type { TrashRef } from "../checkpoints/types";
import type { HostCtx } from "../host/registry";
import { badRequest, conflict } from "../lib/errors";
import { msg } from "../lib/messages";
import type { TaskReader } from "../tasks/types";
import { claimEngineVolumes } from "../volumes/engine";
import type { VolumeRecord, VolumeRole } from "../volumes/types";
import { measureTree } from "../volumes/usage";
import { keepsVolume } from "./trash";
import type { RecordNote } from "./volume-owner";
import { errorOutcome, hostOffline, messageOutcome, type OutcomeError, volumesInUse } from "./volume-refs";
import { protectedReason, removeGuarded } from "./volume-remove";

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

type PruneStatus = "candidate" | "removed" | "refused" | "failed";

interface PrunedVolume {
  id: string;
  name: string;
  /** Null only for an id the request named that matches no volume. */
  hostId: string | null;
  pool: string | null;
  role: VolumeRole | null;
  /** Null when the size is not known. */
  bytes: number | null;
  /** When a box last mounted the volume, or when it was created when no box ever did. Null for an unknown id. */
  lastUsedAt: string | null;
  /** The box that last mounted the volume, or null when none did. */
  formerBox: string | null;
  /** Whether removing it keeps a copy of its data in the recycle bin. A cache volume keeps none: it cannot be restored. */
  keepsCopy: boolean;
  status: PruneStatus;
  trash: TrashRef | null;
  error: OutcomeError | null;
}

interface PrunedHost {
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
  /**
   * The volumes to consider, by id or name. A removal must name them, normally the ids its dry run listed, and nothing
   * outside the list is ever removed. Null lists every orphan, which only a dry run may do.
   */
  readonly ids: readonly string[] | null;
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
function lastUsedAt(volume: Pick<VolumeRecord, "createdAt" | "lastMount">): string {
  return volume.lastMount?.at ?? volume.createdAt;
}

/**
 * Finds the volumes MiniBox made that nothing uses: no box spec mounts or owns them, no container in any state mounts
 * them, and no rollback keeps them. A dry run returns them. A removal takes only the volumes `ids` names: each one that
 * is still an orphan is kept in the recycle bin, then removed once a second check under the spec lock still finds it
 * unused; each one that no longer qualifies is refused with its reason. Each host is pruned on its own, so an offline or
 * failing host is reported and skipped while the others are pruned.
 */
export async function pruneVolumes(hosts: readonly HostCtx[], opts: PruneOptions): Promise<PruneResult> {
  if (!opts.dryRun && opts.ids === null) throw badRequest(msg("volume_prune_ids_required"));
  const result: PruneResult = { volumes: [], hosts: [] };
  const named = opts.ids === null ? null : resolveNamed(hosts, opts.ids);
  const report = (row: PrunedVolume) => {
    result.volumes.push(row);
    if (row.status !== "candidate") {
      auditRemoval(opts.record, row);
      opts.onRemoval?.(row);
    }
  };
  for (const host of hosts) {
    const hostId = host.host.id;
    const name = host.host.name;
    const wanted = named?.volumes.filter((volume) => volume.hostId === hostId) ?? null;
    if (hostOffline(host)) {
      const error = messageOutcome(msg("volume_host_offline", { host: name }));
      result.hosts.push({ hostId, name, status: "offline", error });
      if (!opts.dryRun) for (const volume of wanted ?? []) report(rowOf(volume, { status: "refused", error }));
      continue;
    }
    let scan: OrphanScan;
    try {
      scan = await scanOrphans(host, opts);
    } catch (e) {
      const error = hostFailure(e, name);
      result.hosts.push({ hostId, name, status: "failed", error });
      if (!opts.dryRun) for (const volume of wanted ?? []) report(rowOf(volume, { status: "refused", error }));
      continue;
    }
    result.hosts.push({ hostId, name, status: "checked", error: null });
    const orphanIds = new Set(scan.orphans.map((volume) => volume.id));
    if (opts.dryRun) {
      const listed =
        wanted === null ? scan.orphans : scan.orphans.filter((volume) => wanted.some((w) => w.id === volume.id));
      for (const volume of listed) report(rowOf(volume, { status: "candidate", bytes: await sizeOf(host, volume) }));
      continue;
    }
    for (const volume of wanted ?? []) {
      if (!orphanIds.has(volume.id)) {
        report(rowOf(volume, { status: "refused", error: await whyKept(host, volume, scan, opts) }));
        continue;
      }
      report(await removeOrphan(host, volume, scan, opts));
    }
  }
  if (!opts.dryRun && named) {
    const checked = new Set(hosts.map((host) => host.host.id));
    for (const volume of named.volumes) {
      if (checked.has(volume.hostId)) continue;
      report(
        rowOf(volume, { status: "refused", error: messageOutcome(msg("volume_not_found", { volume: volume.name })) }),
      );
    }
    for (const ref of named.unknown) report(unknownRow(ref));
  }
  return result;
}

/** The volumes the request named, each once, in the order named, and the names that match no volume. */
function resolveNamed(
  hosts: readonly HostCtx[],
  ids: readonly string[],
): { volumes: VolumeRecord[]; unknown: string[] } {
  const store = hosts[0]?.volumes;
  const volumes: VolumeRecord[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const ref of new Set(ids)) {
    const volume = store?.resolve(ref) ?? null;
    if (!volume) {
      unknown.push(ref);
      continue;
    }
    if (seen.has(volume.id)) continue;
    seen.add(volume.id);
    volumes.push(volume);
  }
  return { volumes, unknown };
}

function hostFailure(error: unknown, host: string): OutcomeError {
  const outcome = errorOutcome(error);
  if (outcome.key === "volume_prune_busy") return outcome;
  return messageOutcome(msg("volume_host_failed", { host, detail: outcome.message }));
}

interface OrphanScan {
  orphans: VolumeRecord[];
  inUse: Set<string>;
  now: number;
  minAgeMs: number;
}

/** A volume a live box owns is that box's, even while no spec mounts it, so it is never an orphan. */
function ownedByLiveBox(host: HostCtx, volume: VolumeRecord): boolean {
  return volume.ownership === "owned" && volume.ownerBoxId !== null && host.specs.read(volume.ownerBoxId) !== null;
}

function tooRecent(volume: VolumeRecord, now: number, minAgeMs: number): boolean {
  return now - Date.parse(lastUsedAt(volume)) < minAgeMs;
}

async function scanOrphans(host: HostCtx, opts: PruneOptions): Promise<OrphanScan> {
  if (fillingTaskOn(host, opts.tasks)) throw conflict(msg("volume_prune_busy"));
  await claimEngineVolumes(host);
  const inUse = await volumesInUse(host);
  const now = opts.now ?? Date.now();
  const minAgeMs = Math.max(PRUNE_GRACE_MS, opts.olderThanMs ?? 0);
  const orphans: VolumeRecord[] = [];
  for (const volume of host.volumes.list()) {
    if (volume.hostId !== host.host.id || protectedReason(host, volume) || inUse.has(volume.engineName)) continue;
    if (ownedByLiveBox(host, volume) || tooRecent(volume, now, minAgeMs)) continue;
    if (await opts.may(volume)) orphans.push(volume);
  }
  return { orphans: orphans.toSorted((a, b) => a.name.localeCompare(b.name)), inUse, now, minAgeMs };
}

/** Why a volume a removal named is not an orphan now, so it is kept. */
async function whyKept(
  host: HostCtx,
  volume: VolumeRecord,
  scan: OrphanScan,
  opts: PruneOptions,
): Promise<OutcomeError> {
  if (!(await opts.may(volume))) return messageOutcome(msg("volume_delete_forbidden", { volume: volume.name }));
  const shielded = protectedReason(host, volume);
  if (shielded) return shielded;
  if (scan.inUse.has(volume.engineName)) return messageOutcome(msg("volume_in_use_by_box", { volume: volume.name }));
  return messageOutcome(msg("volume_not_orphan", { volume: volume.name }));
}

function fillingTaskOn(host: HostCtx, tasks: TaskReader | undefined): boolean {
  const running = tasks?.list({ status: "running", limit: 1000 }) ?? [];
  return running.some((task) => task.hostId === host.host.id && FILLING_OPS.has(task.op));
}

async function removeOrphan(
  host: HostCtx,
  volume: VolumeRecord,
  scan: OrphanScan,
  opts: PruneOptions,
): Promise<PrunedVolume> {
  const bytes = await sizeOf(host, volume);
  const outcome = await removeGuarded(host, volume, {
    skipTrash: false,
    principal: opts.principal,
    record: opts.record,
    keep: (current) =>
      ownedByLiveBox(host, current) || tooRecent(current, opts.now ?? Date.now(), scan.minAgeMs)
        ? messageOutcome(msg("volume_not_orphan", { volume: current.name }))
        : null,
  });
  if (outcome.status === "removed") return rowOf(volume, { status: "removed", bytes, trash: outcome.trash });
  return rowOf(volume, { status: outcome.status, bytes, error: outcome.error });
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

function rowOf(
  volume: VolumeRecord,
  fields: Pick<PrunedVolume, "status"> & Partial<Pick<PrunedVolume, "bytes" | "trash" | "error">>,
): PrunedVolume {
  return {
    id: volume.id,
    name: volume.name,
    hostId: volume.hostId,
    pool: volume.pool,
    role: volume.role,
    bytes: fields.bytes ?? volume.bytes,
    lastUsedAt: lastUsedAt(volume),
    formerBox: volume.lastMount?.boxName ?? null,
    keepsCopy: keepsVolume(volume, false),
    status: fields.status,
    trash: fields.trash ?? null,
    error: fields.error ?? null,
  };
}

function unknownRow(ref: string): PrunedVolume {
  return {
    id: ref,
    name: ref,
    hostId: null,
    pool: null,
    role: null,
    bytes: null,
    lastUsedAt: null,
    formerBox: null,
    keepsCopy: false,
    status: "refused",
    trash: null,
    error: messageOutcome(msg("volume_not_found", { volume: ref })),
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
