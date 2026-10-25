import type { PendingRollback } from "../checkpoints/types";
import type { HostCtx } from "../host/registry";
import { AppError, conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { revisionMismatch } from "../specs/revision";
import type { BoxMount, BoxSpec } from "../specs/types";
import { type Box, getBox, refuseExpired } from "./boxes";
import { type Progress, underBox } from "./checkpoints";
import { rebuildBox } from "./rebuild";
import { deleteVolume } from "./volumes";

/** A rollback that waits for its confirm or undo, as the box page shows it. */
export interface PendingRollbackView {
  boxId: string;
  checkpoint: { id: string; label: string };
  safetyCheckpointId: string;
  createdBy: string | null;
  createdAt: string;
  /** The volumes the rollback replaced. They stay until the rollback is confirmed (deleted) or undone (mounted again). */
  replaced: { id: string; name: string; path: string }[];
  /** The volumes the rollback restored, which the box mounts now. An undo deletes them. */
  restored: { id: string; name: string; path: string }[];
}

interface VolumeItem {
  id: string;
  name: string;
  path: string;
  bytes: number | null;
}

/** What a confirm deletes, shown before anything changes. */
export interface RollbackCleanupPreview {
  action: "confirm_rollback";
  box: string;
  safetyCheckpointId: string;
  delete: VolumeItem[];
}

/** What an undo does, shown before anything changes. */
export interface RollbackUndoPreview {
  action: "undo_rollback";
  box: string;
  remount: { path: string; volume: string }[];
  delete: VolumeItem[];
  revision: { current: number; next: number };
}

export function pendingRollbackView(host: HostCtx, boxId: string): PendingRollbackView | null {
  const pending = host.checkpoints.pendingRollback(boxId);
  if (!pending) return null;
  return pendingRollbackOf(pending);
}

/** The view of a rollback record the store already holds, for a list that reads them all. */
export function pendingRollbackOf(pending: PendingRollback): PendingRollbackView {
  return {
    boxId: pending.boxId,
    checkpoint: { id: pending.checkpointId, label: pending.checkpointLabel },
    safetyCheckpointId: pending.safetyCheckpointId,
    createdBy: pending.createdBy,
    createdAt: pending.createdAt,
    replaced: pending.replaced.map(({ volumeId, name, path }) => ({ id: volumeId, name, path })),
    restored: pending.restored.map(({ volumeId, name, path }) => ({ id: volumeId, name, path })),
  };
}

function requirePending(host: HostCtx, box: Box): PendingRollback {
  const pending = host.checkpoints.pendingRollback(box.boxId);
  if (!pending) throw conflict(msg("rollback_none", { box: box.name }));
  return pending;
}

function itemOf(host: HostCtx, volume: { volumeId: string; name: string; path: string }): VolumeItem {
  return {
    id: volume.volumeId,
    name: volume.name,
    path: volume.path,
    bytes: host.volumes.read(volume.volumeId)?.bytes ?? null,
  };
}

function mountedByAnyBox(host: HostCtx, engineName: string): boolean {
  return host.specs
    .list()
    .some((spec) => spec.hostId === host.host.id && spec.mounts.some((mount) => mount.volume === engineName));
}

function mountsAt(spec: BoxSpec, volume: { engineName: string; path: string }): boolean {
  return spec.mounts.some((mount) => mount.volume === volume.engineName && mount.path === volume.path);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function cleanupPreview(host: HostCtx, box: Box): RollbackCleanupPreview {
  const pending = requirePending(host, box);
  return {
    action: "confirm_rollback",
    box: box.name,
    safetyCheckpointId: pending.safetyCheckpointId,
    delete: pending.replaced.map((volume) => itemOf(host, volume)),
  };
}

export function cleanupConfirmation(preview: RollbackCleanupPreview): AppError {
  return new AppError(409, "confirmation_required", msg("rollback_confirm_required"), { preview });
}

/**
 * Deletes the volumes a rollback replaced. The record is rewritten after each deletion, so a failure part way leaves the
 * rest listed, and a retry finishes them. A volume that is already gone is skipped. Nothing is deleted before the
 * rollback's restored volumes are mounted, because the record exists only after that.
 */
export async function confirmRollback(
  host: HostCtx,
  ref: string,
  progress?: Progress,
): Promise<{ removed: { id: string; name: string }[] }> {
  const { boxId } = await getBox(host, ref);
  return underBox(host, boxId, async (box) => {
    const pending = requirePending(host, box);
    const removed: { id: string; name: string }[] = [];
    let left = pending.replaced;
    for (const volume of pending.replaced) {
      if (mountedByAnyBox(host, volume.engineName)) {
        // A rebuild since the rollback, or an undo a crash cut short, mounts it again. It is in use, so it stays.
        progress?.log?.(`Keeping ${volume.name}: a box mounts it.\n`);
        log.warn("checkpoint.rollback_confirm_kept", { box: box.name, volume: volume.name });
      } else if (host.volumes.read(volume.volumeId)) {
        progress?.log?.(`Deleting ${volume.name}…\n`);
        // The single delete refuses a volume a pending rollback keeps, and this record keeps these, so it is lifted
        // for the removal. A failure puts it back as it was, so a retry finishes the rest; success drops the volume.
        host.checkpoints.removePendingRollback(box.boxId);
        try {
          await deleteVolume(host, volume.volumeId, { skipTrash: true });
        } catch (e) {
          // `left` still names this volume, so the record comes back listing it and every volume after it.
          host.checkpoints.writePendingRollback({ ...pending, replaced: left });
          throw e;
        }
        removed.push({ id: volume.volumeId, name: volume.name });
      }
      left = left.filter((item) => item.volumeId !== volume.volumeId);
      if (left.length > 0) host.checkpoints.writePendingRollback({ ...pending, replaced: left });
    }
    host.checkpoints.removePendingRollback(box.boxId);
    log.info("checkpoint.rollback_confirmed", { box: box.name, removed: removed.length });
    return { removed };
  });
}

interface UndoPlan {
  box: Box;
  spec: BoxSpec;
  pending: PendingRollback;
  mounts: BoxMount[];
}

/**
 * The mounts an undo would set. Each restored volume is replaced at its path by the volume the rollback replaced. A
 * revision other than the box's current one is refused, and so is a rollback whose volumes no longer fit: a replaced
 * volume that is gone, or a restored volume the box no longer mounts where the rollback put it.
 */
function planUndo(host: HostCtx, box: Box, revision: number): UndoPlan {
  const spec = host.specs.read(box.boxId);
  if (!spec) throw notFound(msg("box_not_found"));
  if (spec.revision !== revision) throw revisionMismatch(spec.revision, revision);
  const pending = requirePending(host, box);
  for (const volume of pending.replaced) {
    if (!host.volumes.read(volume.volumeId)) {
      throw conflict(msg("rollback_undo_gone", { box: box.name, volume: volume.name }));
    }
  }
  for (const volume of pending.restored) {
    if (!spec.mounts.some((mount) => mount.volume === volume.engineName && mount.path === volume.path)) {
      throw conflict(msg("rollback_undo_unmounted", { box: box.name, volume: volume.name }));
    }
  }
  const mounts = spec.mounts.map((mount) => {
    const back = pending.replaced.find((item) => item.path === mount.path);
    const restored = pending.restored.some((item) => item.path === mount.path && item.engineName === mount.volume);
    return restored && back ? { ...mount, volume: back.engineName } : mount;
  });
  return { box, spec, pending, mounts };
}

/** Refuses an undo that could not run, so the request answers before a task starts. */
export function assertUndoable(host: HostCtx, box: Box, revision: number): void {
  planUndo(host, box, revision);
}

export function undoPreview(host: HostCtx, box: Box, revision: number): RollbackUndoPreview {
  const plan = planUndo(host, box, revision);
  return {
    action: "undo_rollback",
    box: box.name,
    remount: plan.pending.replaced.map((volume) => ({ path: volume.path, volume: volume.name })),
    delete: plan.pending.restored.map((volume) => itemOf(host, volume)),
    revision: { current: plan.spec.revision, next: plan.spec.revision + 1 },
  };
}

export function undoConfirmation(preview: RollbackUndoPreview): AppError {
  return new AppError(409, "confirmation_required", msg("rollback_undo_confirm"), { preview });
}

/**
 * Undoes a rollback. The box is rebuilt onto the volumes the rollback replaced, and only then are the restored volumes
 * deleted. Data written since the rollback is lost, which the confirmation says. A failed rebuild leaves the rollback as
 * it was, with its record, so the undo can be tried again.
 */
export async function undoRollback(
  host: HostCtx,
  ref: string,
  input: { revision: number },
  progress?: Progress,
): Promise<Box> {
  const { boxId } = await getBox(host, ref);
  return underBox(host, boxId, async (box) => {
    refuseExpired(host, boxId);
    const plan = planUndo(host, box, input.revision);
    progress?.log?.("Mounting the replaced volumes again…\n");
    const rebuilt = await rebuildBox(host, plan.spec.id, plan.spec.revision, { mounts: plan.mounts }, true);
    host.checkpoints.removePendingRollback(box.boxId);
    for (const volume of plan.pending.restored) {
      progress?.log?.(`Deleting ${volume.name}…\n`);
      try {
        await deleteVolume(host, volume.volumeId, { skipTrash: true });
      } catch (e) {
        progress?.log?.(`${volume.name} could not be deleted: ${errorText(e)}\n`);
        log.warn("checkpoint.rollback_undo_cleanup_failed", {
          box: box.name,
          volume: volume.name,
          error: errorText(e),
        });
      }
    }
    log.info("checkpoint.rollback_undone", { box: box.name });
    return rebuilt;
  });
}

/**
 * Startup repair of rollback records a crash left behind. A record whose box is gone is dropped (its volumes went, or
 * stayed, with the box). A record whose box mounts every replaced volume again and none of the restored ones is an undo
 * cut short after its rebuild: the record is dropped and the restored volumes, which nothing mounts, are deleted, as the
 * undo would have done. Any other record is left as it is, for its confirm or undo. Returns the box ids settled.
 */
export async function settlePendingRollbacks(host: HostCtx): Promise<string[]> {
  const settled: string[] = [];
  for (const pending of host.checkpoints.pendingRollbacks()) {
    if (pending.hostId !== host.host.id) continue;
    const spec = host.specs.read(pending.boxId);
    if (!spec) {
      host.checkpoints.removePendingRollback(pending.boxId);
      settled.push(pending.boxId);
      continue;
    }
    const undone = pending.replaced.every((volume) => mountsAt(spec, volume));
    const restoredMounted = pending.restored.some((volume) => mountsAt(spec, volume));
    if (!undone || restoredMounted) continue;
    host.checkpoints.removePendingRollback(pending.boxId);
    settled.push(pending.boxId);
    for (const volume of pending.restored) {
      if (!host.volumes.read(volume.volumeId) || mountedByAnyBox(host, volume.engineName)) continue;
      try {
        await deleteVolume(host, volume.volumeId, { skipTrash: true });
      } catch (e) {
        log.warn("checkpoint.rollback_undo_cleanup_failed", {
          box: pending.boxName,
          volume: volume.name,
          error: errorText(e),
        });
      }
    }
    log.info("checkpoint.rollback_undo_finished", { box: pending.boxName });
  }
  return settled;
}
