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
      if (host.volumes.read(volume.volumeId)) {
        progress?.log?.(`Deleting ${volume.name}…\n`);
        await deleteVolume(host, volume.volumeId);
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
        await deleteVolume(host, volume.volumeId);
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
