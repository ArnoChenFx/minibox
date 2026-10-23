import type { CheckpointRecord } from "../checkpoints/types";
import type { HostCtx } from "../host/registry";
import { conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { removeSystemImage } from "./checkpoint-layers";
import type { CheckpointPatch, CheckpointView } from "./checkpoint-model";
import { ownRecord, getCheckpoint, viewOf } from "./checkpoint-view";
import { deleteSnapshot } from "./snapshots";

/** Pin and label. A snapshot from before checkpoints cannot change, so it is refused with a conflict. */
export async function updateCheckpoint(host: HostCtx, id: string, patch: CheckpointPatch): Promise<CheckpointView> {
  if (!ownRecord(host, id)) {
    await getCheckpoint(host, id);
    throw conflict(msg("checkpoint_legacy_read_only", { id }));
  }
  return host.checkpoints.exclusive(async () => {
    const record = ownRecord(host, id);
    if (!record) throw notFound(msg("checkpoint_not_found", { id }));
    const next: CheckpointRecord = {
      ...record,
      pinned: patch.pinned ?? record.pinned,
      label: patch.label ?? record.label,
      updatedAt: new Date().toISOString(),
    };
    host.checkpoints.write(next);
    return viewOf(next);
  });
}

/**
 * The safety checkpoints of rollbacks that wait for their confirm or undo. Each is the only copy of the data its rollback
 * replaced, so it is never deleted, by hand or by retention.
 */
export function heldCheckpointIds(host: HostCtx): Set<string> {
  return new Set(host.checkpoints.pendingRollbacks().map((pending) => pending.safetyCheckpointId));
}

/**
 * Refuses to delete the safety checkpoint of a rollback that waits for its confirm or undo. A confirm deletes the
 * replaced volumes, so that checkpoint is the last copy of their data.
 */
export function assertNotHeld(host: HostCtx, id: string): void {
  if (heldCheckpointIds(host).has(id)) throw conflict(msg("checkpoint_held_by_rollback", { id }));
}

/**
 * Deletes a checkpoint's snapshots and system image, then its record. A pinned checkpoint is kept until it is unpinned.
 * Each snapshot is forgotten and the record rewritten before the next, so a failure part way can be retried.
 */
export async function deleteCheckpoint(host: HostCtx, id: string): Promise<void> {
  if (!ownRecord(host, id)) {
    const legacy = await getCheckpoint(host, id);
    if (legacy.system) await deleteSnapshot(host, legacy.system.image);
    return;
  }
  await host.checkpoints.exclusive(async () => {
    const record = ownRecord(host, id);
    if (!record) throw notFound(msg("checkpoint_not_found", { id }));
    if (record.pinned) throw conflict(msg("checkpoint_pinned", { id }));
    if (host.checkpoints.exporting.has(id)) throw conflict(msg("checkpoint_exporting", { id }));
    assertNotHeld(host, id);
    await discardRecord(host, record);
  });
  log.info("checkpoint.deleted", { id });
}

/**
 * Forgets a record's snapshots and system image, then the record. The record is rewritten after each snapshot, so a
 * failure part way leaves what is still held and a retry finishes it. The caller holds `host.checkpoints.exclusive`.
 */
export async function discardRecord(host: HostCtx, record: CheckpointRecord): Promise<void> {
  let current = record;
  for (const layer of record.data) {
    await host.checkpointEngine.forget(host, layer.snapshotId);
    current = { ...current, data: current.data.filter((item) => item.snapshotId !== layer.snapshotId) };
    host.checkpoints.write(current);
  }
  if (current.system) await removeSystemImage(host, current.system, record.id);
  host.checkpoints.remove(record.id);
}
