import type { HostCtx } from "../host/registry";
import { AppError } from "../lib/errors";
import { msg } from "../lib/messages";
import { forgetBoxRecords } from "./box-lifecycle";

/** One box whose record a forced removal discards. */
export interface DiscardedBox {
  readonly id: string;
  readonly name: string;
}

/** One volume whose record a forced removal discards, with the name its engine knows. */
export interface DiscardedVolume {
  readonly id: string;
  readonly name: string;
  readonly engineName: string;
}

/** One checkpoint whose record a forced removal discards. */
export interface DiscardedCheckpoint {
  readonly id: string;
  readonly label: string;
}

/**
 * Everything MiniBox still records about one host: the boxes on it, every volume record that names it (the shared tools
 * volume too) and every checkpoint record it holds. Reading this touches no engine, so a machine that is gone can be
 * described without dialling it.
 */
export interface HostRecords {
  readonly host: { readonly id: string; readonly name: string };
  readonly boxes: DiscardedBox[];
  readonly volumes: DiscardedVolume[];
  readonly checkpoints: DiscardedCheckpoint[];
}

/** The records of one host, read from the stores alone. Nothing is changed and no engine is asked. */
export function hostRecords(host: HostCtx): HostRecords {
  const id = host.host.id;
  return {
    host: { id, name: host.host.name },
    boxes: host.specs
      .list()
      .filter((spec) => spec.hostId === id)
      .map((spec) => ({ id: spec.id, name: spec.name })),
    volumes: host.volumes
      .list()
      .filter((volume) => volume.hostId === id)
      .map((volume) => ({ id: volume.id, name: volume.name, engineName: volume.engineName })),
    checkpoints: host.checkpoints
      .list()
      .filter((checkpoint) => checkpoint.hostId === id)
      .map((checkpoint) => ({ id: checkpoint.id, label: checkpoint.label })),
  };
}

/**
 * The refusal a forced removal without `confirm` gets. Nothing has changed, and the preview lists every record a
 * confirmed call would discard, so the operator sees what the console and the API will then forget.
 */
export function forceRemoveConfirmation(records: HostRecords): AppError {
  return new AppError(409, "confirmation_required", msg("host_force_remove_confirm"), {
    preview: {
      host: records.host,
      counts: {
        boxes: records.boxes.length,
        volumes: records.volumes.length,
        checkpoints: records.checkpoints.length,
      },
      boxes: records.boxes,
      volumes: records.volumes.map(({ name, engineName }) => ({ name, engineName })),
      checkpoints: records.checkpoints,
    },
  });
}

/**
 * Drops MiniBox's records of one host, and nothing else. No engine is called: the containers, volumes and checkpoint
 * repository on the machine stay exactly where they are, so a machine that turns out to be alive keeps its containers
 * as orphans MiniBox no longer knows about. Box records are cleared as a box delete clears them without its engine, and
 * schedules and pending rollbacks that name the host are dropped with them.
 *
 * The checkpoint records go, but the data they describe does not: each host's restic repository lives in a Docker volume
 * on that host (`<prefix>-checkpoints-<host>`), so it went with the machine. Exported packages under `DATA_DIR/packages`
 * are files of this control plane and are left for their own expiry, because they are a copy somebody may still import.
 */
export async function discardHostRecords(host: HostCtx): Promise<HostRecords> {
  const records = hostRecords(host);
  await host.specs.exclusive(async () => {
    for (const box of records.boxes) {
      // The container is retired too, so a read that began before this removal cannot write the spec back afterwards.
      forgetBoxRecords(host, box.id, host.specs.read(box.id)?.containerId);
    }
  });
  await host.checkpoints.exclusive(async () => {
    for (const schedule of host.checkpoints.schedules()) {
      if (schedule.hostId === host.host.id) host.checkpoints.removeSchedule(schedule.boxId);
    }
    for (const pending of host.checkpoints.pendingRollbacks()) {
      if (pending.hostId === host.host.id) host.checkpoints.removePendingRollback(pending.boxId);
    }
    for (const checkpoint of records.checkpoints) host.checkpoints.remove(checkpoint.id);
  });
  for (const volume of records.volumes) host.volumes.remove(volume.id);
  return records;
}
