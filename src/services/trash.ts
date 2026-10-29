import { expiredTrash, trashExpiresAt } from "../checkpoints/policy";
import type { CheckpointRecord, DataLayer, TrashKind, TrashMark, TrashRef } from "../checkpoints/types";
import type { HostCtx } from "../host/registry";
import { conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { VolumeChanges } from "../volumes/changes";
import { assertHostDiskRoom } from "../volumes/disk";
import { inspectVolumeOrNull } from "../volumes/engine";
import { createRestoredVolume, planIndependentVolume } from "../volumes/provision";
import type { VolumeRecord } from "../volumes/types";
import { measureTree } from "../volumes/usage";
import { type Box, deleteBox, type DeleteBoxResult } from "./boxes";
import { assertNewBox } from "./capacity";
import { usageOf } from "./checkpoint-capacity";
import {
  type BackupSource,
  backupLayers,
  boxLayers,
  type CheckpointView,
  discardRecord,
  forkFrom,
  type PlannedLayer,
  type Progress,
  restoreLayer,
  viewOf,
} from "./checkpoints";
import type { RecordNote } from "./volume-owner";

const MB = 1024 * 1024;
/** What a restored box gets when its entry recorded no resources. Matches the default a new box is created with. */
const FALLBACK_CPUS = 2;
const FALLBACK_MEMORY_MB = 4096;

/** A recycle bin entry as the API shows it. */
export interface TrashEntry {
  id: string;
  hostId: string;
  kind: TrashKind;
  sourceId: string;
  sourceName: string;
  deletedAt: string;
  expiresAt: string;
  bytes: number;
  createdBy: string | null;
}

/** What a restore may change. Unset values take the entry's own name and, for a box, its recorded resources. */
export interface TrashRestoreInput {
  name?: string;
  cpus?: number;
  memoryMb?: number;
}

export type TrashRecord = CheckpointRecord & { trash: TrashMark };

function isTrash(record: CheckpointRecord): record is TrashRecord {
  return record.trash !== null;
}

function entryOf(record: TrashRecord): TrashEntry {
  return {
    id: record.id,
    hostId: record.hostId,
    kind: record.trash.kind,
    sourceId: record.trash.sourceId,
    sourceName: record.trash.sourceName,
    deletedAt: record.trash.deletedAt,
    expiresAt: record.trash.expiresAt,
    bytes: record.data.reduce((sum, layer) => sum + layer.bytes, 0),
    createdBy: record.createdBy,
  };
}

/** The recycle bin entries of this host, newest deletion first. */
export async function listTrash(host: HostCtx): Promise<TrashEntry[]> {
  return host.checkpoints
    .list()
    .filter((record): record is TrashRecord => record.hostId === host.host.id && isTrash(record))
    .map(entryOf)
    .toSorted((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

/** The entry with this id on this host. Anything else, including an ordinary checkpoint, is not found. */
export function trashRecord(host: HostCtx, id: string): TrashRecord {
  const record = host.checkpoints.read(id);
  if (!record || record.hostId !== host.host.id || !isTrash(record)) {
    throw notFound(msg("trash_not_found", { id }));
  }
  return record;
}

export function trashEntryOf(host: HostCtx, id: string): TrashEntry {
  return entryOf(trashRecord(host, id));
}

/** Whether a volume's delete keeps a copy of its data in the recycle bin. Cache and tools are never kept. */
export function keepsVolume(volume: Pick<VolumeRecord, "checkpoint" | "role">, skipTrash: boolean): boolean {
  return !skipTrash && volume.checkpoint && volume.role !== "tools";
}

/** Purges the copy a volume removal kept, once that removal has not gone through. A purge that fails keeps the copy. */
export async function discardCopy(host: HostCtx, copy: TrashRef | null, record?: RecordNote): Promise<void> {
  if (copy === null) return;
  try {
    await purgeEntry(host, copy.id, "failed", record);
  } catch (e) {
    log.warn("volume.delete_copy_kept", { id: copy.id, error: String(e) });
  }
}

/**
 * Keeps a copy of a box's data in the recycle bin before the box is removed. The box's power lock is held by the caller,
 * and the box is left stopped for the removal that follows. A box with no spec has nothing to restore from and keeps
 * nothing.
 *
 * A volume a pending rollback replaced is kept only at a path the box no longer mounts. Two volumes at one path could not
 * be restored as one box, and the rollback's safety checkpoint holds the replaced data in any case.
 */
async function trashBox(
  host: HostCtx,
  box: Box,
  createdBy: string | null,
  record?: RecordNote,
): Promise<TrashRef | null> {
  const spec = host.specs.read(box.boxId);
  if (!spec) return null;
  const current = boxLayers(host, spec);
  const mounted = new Set(current.map((layer) => layer.path));
  const replaced = host.checkpoints.pendingRollback(box.boxId)?.replaced ?? [];
  const rolled = replaced.flatMap(({ volumeId, path }): PlannedLayer[] => {
    const volume = host.volumes.read(volumeId);
    return volume && !mounted.has(path) ? [{ volume, path, mode: "rw", inBox: false }] : [];
  });
  return keepInBin(
    host,
    {
      kind: "box",
      sourceId: box.boxId,
      sourceName: box.name,
      eventTarget: { kind: "box", id: box.id, name: box.name },
    },
    { box, spec },
    [...current, ...rolled],
    createdBy,
    record,
  );
}

/**
 * Keeps a volume's data in the recycle bin before the volume is removed. No box mounts a volume that is deleted. Returns
 * null when the engine has no data left to keep.
 */
export async function trashVolume(
  host: HostCtx,
  volume: VolumeRecord,
  createdBy: string | null,
  record?: RecordNote,
): Promise<TrashRef | null> {
  const layers: PlannedLayer[] = [{ volume, path: "", mode: "rw", inBox: false }];
  return keepInBin(
    host,
    {
      kind: "volume",
      sourceId: volume.id,
      sourceName: volume.name,
      eventTarget: { kind: "volume", id: volume.id, name: volume.name },
    },
    null,
    layers,
    createdBy,
    record,
  );
}

interface KeepMark {
  kind: TrashKind;
  sourceId: string;
  sourceName: string;
  eventTarget: { kind: string; id: string; name: string };
}

async function keepInBin(
  host: HostCtx,
  mark: KeepMark,
  source: BackupSource | null,
  candidates: PlannedLayer[],
  createdBy: string | null,
  record?: RecordNote,
): Promise<TrashRef | null> {
  const layers = await presentLayers(host, candidates);
  if (layers.length === 0 && mark.kind === "volume") return null;
  const now = Date.now();
  const trash: TrashMark = {
    kind: mark.kind,
    sourceId: mark.sourceId,
    sourceName: mark.sourceName,
    deletedAt: new Date(now).toISOString(),
    expiresAt: trashExpiresAt(now, host.checkpointPolicy.trashKeepDays),
  };
  await assertHostDiskRoom(host);
  await makeRoom(host, layers, record);
  const view = await backupLayers(
    host,
    source,
    layers,
    {
      label: mark.sourceName,
      reason: `Kept in the recycle bin when the ${mark.kind} was deleted`,
      pinned: false,
      include: { system: false, volumes: [] },
      consistency: mark.kind === "box" ? "stop" : "live",
    },
    createdBy,
    undefined,
    false,
    { trash, keepStopped: mark.kind === "box" },
  );
  const bytes = view.bytes;
  record?.({
    op: `${mark.kind}.trashed`,
    kind: "write",
    status: "ok",
    summary: `${mark.kind === "box" ? "Box" : "Volume"} kept in the recycle bin: ${mark.sourceName}`,
    target: mark.eventTarget,
    detail: { entry: view.id, bytes, expiresAt: trash.expiresAt },
  });
  return { id: view.id, expiresAt: trash.expiresAt };
}

/** The layers whose volume the engine still has. A missing one has nothing to keep, and a backup would create it empty. */
async function presentLayers(host: HostCtx, layers: PlannedLayer[]): Promise<PlannedLayer[]> {
  const present: PlannedLayer[] = [];
  for (const layer of layers) {
    if ((await inspectVolumeOrNull(host, layer.volume.engineName)) !== null) {
      present.push(layer);
    } else {
      log.warn("trash.layer_missing", { volume: layer.volume.name });
    }
  }
  return present;
}

async function layersBytes(host: HostCtx, layers: PlannedLayer[]): Promise<number> {
  let total = 0;
  for (const layer of layers) {
    total += await measureTree(host, layer.volume.engineName).catch((e) => {
      log.warn("trash.size_unmeasured", { volume: layer.volume.name, error: String(e) });
      return layer.volume.bytes ?? 0;
    });
  }
  return total;
}

/** The repository's bytes, or null when they cannot be measured. An unmeasurable repository is allowed, as elsewhere. */
async function measuredUsage(host: HostCtx): Promise<number | null> {
  try {
    return (await usageOf(host)).bytes;
  } catch (e) {
    log.warn("trash.capacity_unmeasured", { host: host.host.id, error: String(e) });
    return null;
  }
}

/**
 * Makes room in the repository for the layers about to be kept, when the host sets a limit. Usage is measured with the
 * new data counted in full, which is the most the backup can add. Recycle bin entries are purged oldest first until it
 * fits. If it still does not fit, the deletion is refused with the reason, and nothing has been stopped or removed.
 */
async function makeRoom(host: HostCtx, layers: PlannedLayer[], record?: RecordNote): Promise<void> {
  const { capacityBytes } = host.checkpointPolicy;
  if (capacityBytes === 0 || layers.length === 0) return;
  const need = await layersBytes(host, layers);
  if (need === 0) return;
  const fits = async (): Promise<boolean> => {
    const used = await measuredUsage(host);
    return used === null || used + need <= capacityBytes;
  };
  if (await fits()) return;
  const oldest = (await listTrash(host)).toReversed();
  for (const entry of oldest) {
    try {
      await purgeEntry(host, entry.id, "capacity", record);
    } catch (e) {
      log.error("trash.capacity_purge_failed", { id: entry.id, error: String(e) });
      continue;
    }
    if (await fits()) return;
  }
  const used = (await measuredUsage(host)) ?? 0;
  throw conflict(
    msg("trash_capacity_exceeded", {
      need: Math.ceil(need / MB),
      used: Math.round(used / MB),
      limit: Math.round(capacityBytes / MB),
    }),
  );
}

/**
 * Removes one recycle bin entry and what it holds. The record is rewritten after each snapshot, so a failure part way is
 * finished by the next attempt.
 */
export async function purgeEntry(
  host: HostCtx,
  id: string,
  reason: "requested" | "expired" | "capacity" | "failed" | "emptied",
  record?: RecordNote,
): Promise<void> {
  const found = await host.checkpoints.exclusive(async () => {
    const current = trashRecord(host, id);
    if (host.checkpoints.exporting.has(id)) throw conflict(msg("checkpoint_exporting", { id }));
    await discardRecord(host, current);
    return current;
  });
  const entry = entryOf(found);
  record?.({
    op: "trash.purged",
    kind: "destructive",
    status: "ok",
    summary: `Recycle bin entry purged: ${entry.sourceName}`,
    target: { kind: "trash", id: entry.id, name: entry.sourceName },
    detail: { reason, sourceKind: entry.kind, sourceId: entry.sourceId, bytes: entry.bytes },
  });
  log.info("trash.purged", { id, reason });
}

/** Purges the entries whose retention has ended by `now`, and returns their ids. One that fails is logged and kept. */
export async function purgeExpiredTrash(host: HostCtx, now = Date.now(), record?: RecordNote): Promise<string[]> {
  const records = host.checkpoints.list().filter((item) => item.hostId === host.host.id);
  const removed: string[] = [];
  for (const entry of expiredTrash(records, now)) {
    if (host.checkpoints.exporting.has(entry.id)) continue;
    try {
      await purgeEntry(host, entry.id, "expired", record);
      removed.push(entry.id);
    } catch (e) {
      log.error("trash.expiry_purge_failed", { id: entry.id, error: String(e) });
    }
  }
  return removed;
}

/**
 * Restores a recycle bin entry as a new box or a new volume, then removes the entry. A box is restored as a fork of its
 * entry, with its data and template, so a restore of a box needs a free name and room for a box of its size. The entry
 * is removed only after the restore has finished, so a failed restore leaves it in place.
 */
export async function restoreTrash(
  host: HostCtx,
  id: string,
  input: TrashRestoreInput,
  createdBy: string,
  progress?: Progress,
  record?: RecordNote,
): Promise<{ box: Box | null; volume: VolumeRecord | null }> {
  const found = trashRecord(host, id);
  const entry = entryOf(found);
  const name = input.name ?? entry.sourceName;
  if (found.trash.kind === "box") {
    if (host.specs.findByName(name)) throw conflict(msg("box_exists", { name }));
    const box = await restoreBox(host, found, name, input, createdBy, progress, record);
    await consumeEntry(host, id);
    emitRestored(record, entry, name, box.id);
    return { box, volume: null };
  }
  const volume = await restoreVolume(host, found, name, createdBy, progress);
  await consumeEntry(host, id);
  emitRestored(record, entry, name, volume.id);
  return { box: null, volume };
}

function emitRestored(record: RecordNote | undefined, entry: TrashEntry, name: string, resultId: string): void {
  record?.({
    op: "trash.restored",
    kind: "write",
    status: "ok",
    summary: `Recycle bin entry restored as ${name}`,
    target: { kind: "trash", id: entry.id, name: entry.sourceName },
    detail: { sourceKind: entry.kind, sourceId: entry.sourceId, restoredAs: name, resultId },
  });
}

/** The resources a restored box gets: the ones the restore names, else the entry's own, else a new box's default. */
export function restoreResources(found: TrashRecord, input: TrashRestoreInput): { cpus: number; memoryMb: number } {
  const spec = found.spec;
  return {
    cpus: input.cpus ?? spec?.cpus ?? FALLBACK_CPUS,
    memoryMb: input.memoryMb ?? (spec?.memoryBytes ? Math.round(spec.memoryBytes / MB) : FALLBACK_MEMORY_MB),
  };
}

async function restoreBox(
  host: HostCtx,
  found: TrashRecord,
  name: string,
  input: TrashRestoreInput,
  createdBy: string,
  progress: Progress | undefined,
  record: RecordNote | undefined,
): Promise<Box> {
  const view: CheckpointView = viewOf(found);
  return forkFrom(
    host,
    view,
    { name, ...restoreResources(found, input), copyHome: true, ttlSec: null },
    createdBy,
    progress,
    record,
  );
}

/**
 * Refuses a restore that could not succeed, before anything is created: a box name that is taken, a box the host has no
 * room for, or a volume name that is taken.
 */
export async function assertRestorable(host: HostCtx, found: TrashRecord, input: TrashRestoreInput): Promise<void> {
  const name = input.name ?? found.trash.sourceName;
  if (found.trash.kind === "box") {
    if (host.specs.findByName(name)) throw conflict(msg("box_exists", { name }));
    await assertNewBox(host, restoreResources(found, input));
    return;
  }
  planIndependentVolume(host, { name, role: volumeLayerOf(found).role });
}

/** The one layer a volume's recycle bin entry holds. An entry with any other count is not one a restore can read. */
function volumeLayerOf(found: TrashRecord): DataLayer {
  const layer = found.data[0];
  if (!layer || found.data.length !== 1) throw notFound(msg("trash_not_found", { id: found.id }));
  return layer;
}

async function restoreVolume(
  host: HostCtx,
  found: TrashRecord,
  name: string,
  createdBy: string,
  progress: Progress | undefined,
): Promise<VolumeRecord> {
  const layer = volumeLayerOf(found);
  planIndependentVolume(host, { name, role: layer.role });
  const changes = new VolumeChanges();
  try {
    progress?.log?.(`Restoring ${name}…\n`);
    const volume = await createRestoredVolume(
      host,
      { name, role: layer.role, owner: null, createdBy },
      new Set(),
      changes,
    );
    await restoreLayer(host, layer, volume);
    return volume;
  } catch (e) {
    await changes.rollback();
    throw e;
  }
}

/** Removes an entry once its restore has finished. Its data now lives in the restored box or volume. */
async function consumeEntry(host: HostCtx, id: string): Promise<void> {
  await host.checkpoints.exclusive(async () => {
    const found = host.checkpoints.read(id);
    if (found) await discardRecord(host, found);
  });
}

/**
 * Deletes a box, keeping a copy of its data in the recycle bin unless `skipTrash` is set. The copy is taken under the
 * box's power lock, before the container is removed, so a failed copy leaves the box as it was. A removal that fails
 * after the copy leaves the box in place, so the copy is dropped with it.
 */
export async function deleteBoxToTrash(
  host: HostCtx,
  ref: string,
  deleteVolume: boolean,
  opts: { skipTrash: boolean; createdBy: string | null; record?: RecordNote },
): Promise<DeleteBoxResult> {
  const copy: { ref: TrashRef | null } = { ref: null };
  try {
    return await deleteBox(host, ref, deleteVolume, {
      keep: opts.skipTrash
        ? undefined
        : async (box) => {
            copy.ref = await trashBox(host, box, opts.createdBy, opts.record);
            return copy.ref;
          },
    });
  } catch (e) {
    if (copy.ref !== null) await dropCopy(host, copy.ref, opts.record);
    throw e;
  }
}

async function dropCopy(host: HostCtx, copy: TrashRef, record?: RecordNote): Promise<void> {
  try {
    await purgeEntry(host, copy.id, "failed", record);
  } catch (e) {
    log.warn("box.delete_copy_kept", { id: copy.id, error: String(e) });
  }
}
