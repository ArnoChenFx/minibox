import type { HostCtx } from "../host/registry";
import { badRequest, conflict } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { inspectVolumeOrNull } from "../volumes/engine";
import type { VolumeRecord } from "../volumes/types";
import type { PlannedLayer } from "./checkpoint-layers";
import type { CheckpointView, Progress, TakeCheckpointInput } from "./checkpoint-model";
import { backupLayers } from "./checkpoint-take";
import { hostOffline } from "./volume-refs";

/**
 * The layer a snapshot of one volume reads. A volume snapshotted on its own need not be mounted anywhere, so its path
 * is empty and it is read with its owner taken from a helper, as the recycle bin reads a deleted volume's data.
 */
function volumeLayer(volume: VolumeRecord): PlannedLayer {
  return { volume, path: "", mode: "rw", inBox: false };
}

/**
 * Refuses a volume that can never be part of a checkpoint: cache and tools volumes are left out of every checkpoint, so
 * naming one as the whole snapshot gets the same error a box's checkpoint gives. The check runs before a task starts, so
 * the caller is answered at once.
 */
export function assertVolumeSnapshotable(volume: VolumeRecord): void {
  if (!volume.checkpoint || volume.role === "tools") {
    throw badRequest(msg("checkpoint_volume_excluded", { volume: volume.name }), { field: "id" });
  }
}

/**
 * Refuses a snapshot whose volume cannot be read now: an offline host, or a volume the engine has lost, which a backup
 * would only create again empty. A host whose agent cannot run the helper a backup needs is refused by the operation's
 * own precondition, with `unsupported`.
 */
export async function assertVolumeReadable(host: HostCtx, volume: VolumeRecord): Promise<void> {
  assertVolumeSnapshotable(volume);
  if (hostOffline(host)) {
    throw conflict(msg("volume_snapshot_host_offline", { host: host.host.name, volume: volume.name }));
  }
  if ((await inspectVolumeOrNull(host, volume.engineName)) === null) {
    throw conflict(msg("volume_missing", { volume: volume.name }));
  }
}

/**
 * The label a snapshot without one gets: the volume's own name. It is also what the record's box name holds, so a list
 * that groups a record with no box shows the volume the record belongs to.
 */
function labelOf(volume: VolumeRecord, label: string | undefined): string {
  return label?.trim() || volume.name;
}

/**
 * Takes a snapshot of one volume, without a box. The record has no box (`boxId`, `boxName`, `specRevision` and `spec`
 * are null) and holds that one volume as its only layer, read live. Its recorded box name is the volume's name, so a
 * list that groups a record with no box shows the volume it holds instead of a dash.
 *
 * Nothing is stopped or paused: no box has to be, and a volume a box mounts is read as it runs, crash-consistent, the
 * way a `live` checkpoint reads it. The boxes that mount the volume still count as active while the backup runs, so the
 * idle watcher cannot sleep one in the middle.
 */
export async function takeVolumeCheckpoint(
  host: HostCtx,
  volume: VolumeRecord,
  input: TakeCheckpointInput,
  createdBy: string | null,
  progress?: Progress,
): Promise<CheckpointView> {
  const view = await backupLayers(
    host,
    null,
    [volumeLayer(volume)],
    {
      ...input,
      label: labelOf(volume, input.label),
      // A snapshot of one volume has no box to commit, so the system layer is never taken, and no other volume is read.
      include: { system: false, volumes: [] },
      consistency: "live",
    },
    createdBy,
    progress,
    false,
    { sourceName: volume.name },
  );
  log.info("checkpoint.volume_snapshot", { id: view.id, volume: volume.name, host: host.host.id });
  return view;
}
