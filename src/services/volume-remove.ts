import type { TrashRef } from "../checkpoints/types";
import type { HostCtx } from "../host/registry";
import { msg } from "../lib/messages";
import { volumeSnapshotting } from "../volumes/activity";
import { inspectVolumeOrNull } from "../volumes/engine";
import { removeEngine } from "../volumes/provision";
import type { VolumeRecord } from "../volumes/types";
import { discardCopy, keepsVolume, trashVolume } from "./trash";
import type { RecordNote } from "./volume-owner";
import { errorOutcome, messageOutcome, type OutcomeError, volumesInUse } from "./volume-refs";

/**
 * Why MiniBox never deletes a volume in a batch or a prune, whatever the request says: the shared tools volume (by role
 * or by its `<prefix>-tools-<host>` name), or null — unless `teardown` clears a host's tools volume as part of removing
 * that host. A system volume is caught by its engine label, under the spec lock, whatever the flags say.
 */
export function protectedReason(
  host: HostCtx,
  volume: Pick<VolumeRecord, "name" | "role" | "engineName" | "ownership">,
  teardown = false,
): OutcomeError | null {
  if (teardown && volume.role === "tools" && volume.ownership === "independent") return null;
  if (volume.role === "tools" || volume.engineName.startsWith(`${host.prefix}-tools-`)) {
    return messageOutcome(msg("volume_shared_tools", { volume: volume.name }));
  }
  return null;
}

export type GuardedOutcome =
  | { status: "removed"; trash: TrashRef | null }
  | { status: "refused" | "failed"; trash: null; error: OutcomeError };

export interface GuardedRemoval {
  readonly skipTrash: boolean;
  readonly principal: string | null;
  readonly record?: RecordNote;
  /** A further reason to keep the volume, checked under the spec lock with what the engine uses now. */
  readonly keep?: (current: VolumeRecord, inUse: Set<string>) => OutcomeError | null;
  /** A host teardown: the tools volume may go, so removing the host is not blocked by the volume it cannot lose. */
  readonly teardown?: boolean;
}

/**
 * Removes one volume a batch delete or a prune named. A copy of its data is kept in the recycle bin first where a delete
 * keeps one. Then, under the spec lock, where no create or rebuild can be part way through mounting it, the volume is
 * checked again: it must still have the record it had, not be the tools volume or a system volume, and no box spec,
 * container or pending rollback may use it. Anything else keeps the volume and discards the copy.
 */
export async function removeGuarded(
  host: HostCtx,
  volume: VolumeRecord,
  opts: GuardedRemoval,
): Promise<GuardedOutcome> {
  const early = protectedReason(host, volume, opts.teardown === true) ?? snapshotReason(host, volume);
  if (early) return { status: "refused", trash: null, error: early };
  let trash: TrashRef | null = null;
  let settled: GuardedOutcome;
  try {
    trash = keepsVolume(volume, opts.skipTrash) ? await trashVolume(host, volume, opts.principal, opts.record) : null;
    settled = await host.specs.exclusive(() => removeIfAllowed(host, volume, opts));
  } catch (e) {
    settled = { status: "failed", trash: null, error: errorOutcome(e) };
  }
  if (settled.status === "removed") return { status: "removed", trash };
  await discardCopy(host, trash, opts.record);
  return settled;
}

async function removeIfAllowed(host: HostCtx, volume: VolumeRecord, opts: GuardedRemoval): Promise<GuardedOutcome> {
  const current = host.volumes.read(volume.id);
  if (!current || !sameVolume(current, volume)) {
    return refuse(messageOutcome(msg("volume_prune_changed", { volume: volume.name })));
  }
  const shielded = protectedReason(host, current, opts.teardown === true) ?? snapshotReason(host, current);
  if (shielded) return refuse(shielded);
  const info = await inspectVolumeOrNull(host, current.engineName);
  if (info && info.labels[host.keys.internal] === "true") {
    return refuse(messageOutcome(msg("volume_system", { volume: current.name })));
  }
  const inUse = await volumesInUse(host);
  if (inUse.has(current.engineName)) {
    return refuse(messageOutcome(msg("volume_in_use_by_box", { volume: current.name })));
  }
  const kept = opts.keep?.(current, inUse);
  if (kept) return refuse(kept);
  const removal = await removeEngine(host, current.engineName);
  if (removal.status === "failed") {
    const error = msg("volume_delete_failed", { name: current.name, detail: removal.detail });
    return { status: "failed", trash: null, error: messageOutcome(error) };
  }
  host.volumes.remove(current.id);
  return { status: "removed", trash: null };
}

function refuse(error: OutcomeError): GuardedOutcome {
  return { status: "refused", trash: null, error };
}

function snapshotReason(host: HostCtx, volume: VolumeRecord): OutcomeError | null {
  return volumeSnapshotting(host, volume.engineName)
    ? messageOutcome(msg("volume_busy", { volume: volume.name }))
    : null;
}

/** Whether a volume still has the record it had when it was listed. Its data and sample may change; its owner may not. */
function sameVolume(current: VolumeRecord, listed: VolumeRecord): boolean {
  return (
    current.hostId === listed.hostId &&
    current.engineName === listed.engineName &&
    current.pool === listed.pool &&
    current.role === listed.role &&
    current.ownership === listed.ownership &&
    current.ownerBoxId === listed.ownerBoxId
  );
}
