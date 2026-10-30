import { createHash } from "node:crypto";

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
 * described without dialling it. `digest` names exactly these records, so a confirmation can say which set it saw.
 */
export interface HostRecords {
  readonly host: { readonly id: string; readonly name: string };
  readonly boxes: DiscardedBox[];
  readonly volumes: DiscardedVolume[];
  readonly checkpoints: DiscardedCheckpoint[];
  readonly digest: string;
}

/** What a discard found and whether it went ahead. `changed` is set when a confirmation's digest no longer matched. */
export interface DiscardOutcome {
  readonly changed: boolean;
  readonly records: HostRecords;
}

/**
 * A short name for one host's records: the sorted ids of its boxes, volumes and checkpoints, with the host id. Sorted,
 * so two reads of the same set agree whatever order the store listed them in.
 */
function digestOf(
  hostId: string,
  boxes: readonly DiscardedBox[],
  volumes: readonly DiscardedVolume[],
  checkpoints: readonly DiscardedCheckpoint[],
): string {
  const ids = {
    host: hostId,
    boxes: boxes.map((box) => box.id).toSorted(),
    volumes: volumes.map((volume) => volume.id).toSorted(),
    checkpoints: checkpoints.map((checkpoint) => checkpoint.id).toSorted(),
  };
  return createHash("sha256").update(JSON.stringify(ids)).digest("hex").slice(0, 16);
}

function recordsOf(
  host: HostCtx,
  boxes: DiscardedBox[],
  volumes: DiscardedVolume[],
  checkpoints: DiscardedCheckpoint[],
): HostRecords {
  const id = host.host.id;
  return {
    host: { id, name: host.host.name },
    boxes,
    volumes,
    checkpoints,
    digest: digestOf(id, boxes, volumes, checkpoints),
  };
}

/** The records of one host, read from the stores alone. Nothing is changed and no engine is asked. */
export function hostRecords(host: HostCtx): HostRecords {
  const id = host.host.id;
  return recordsOf(
    host,
    host.specs
      .list()
      .filter((spec) => spec.hostId === id)
      .map((spec) => ({ id: spec.id, name: spec.name })),
    host.volumes
      .list()
      .filter((volume) => volume.hostId === id)
      .map((volume) => ({ id: volume.id, name: volume.name, engineName: volume.engineName })),
    host.checkpoints
      .list()
      .filter((checkpoint) => checkpoint.hostId === id)
      .map((checkpoint) => ({ id: checkpoint.id, label: checkpoint.label })),
  );
}

/** The preview a forced removal is refused with, and the one a changed digest is answered with. */
function previewOf(records: HostRecords) {
  return {
    host: records.host,
    counts: {
      boxes: records.boxes.length,
      volumes: records.volumes.length,
      checkpoints: records.checkpoints.length,
    },
    boxes: records.boxes,
    volumes: records.volumes.map(({ name, engineName }) => ({ name, engineName })),
    checkpoints: records.checkpoints,
    digest: records.digest,
  };
}

/**
 * The refusal a forced removal without `confirm` gets. Nothing has changed, and the preview lists every record a
 * confirmed call would discard, so the operator sees what the console and the API will then forget.
 */
export function forceRemoveConfirmation(records: HostRecords): AppError {
  return new AppError(409, "confirmation_required", msg("host_force_remove_confirm"), { preview: previewOf(records) });
}

/** The refusal a confirmation gets when the records are no longer the set its preview named. Nothing was discarded. */
export function recordsChanged(records: HostRecords): AppError {
  return new AppError(409, "conflict", msg("host_records_changed"), { preview: previewOf(records) });
}

/**
 * Drops MiniBox's records of one host, and nothing else. No engine is called: the containers, volumes and checkpoint
 * repository on the machine stay exactly where they are, so a machine that turns out to be alive keeps its containers
 * as orphans MiniBox no longer knows about. Box records are cleared as a box delete clears them without its engine, and
 * schedules and pending rollbacks that name the host are dropped with them.
 *
 * Each store is closed before anything is read, and the read-and-drop runs synchronously, so a write that arrives
 * afterwards is refused by the store (`host_gone`) and one already on disk is listed and removed. A store lock is
 * deliberately not taken: a create holds the volume lock across an engine helper, and a lost machine must not stay
 * listed until that call returns. The set is read here rather than taken from the preview, so a spec that has since
 * moved to another host is left alone.
 *
 * A confirmation may name the digest of the preview it saw. When the records are no longer that set, nothing is removed,
 * the host is put back into service and the caller answers with a fresh preview instead.
 *
 * The checkpoint records go, but the data they describe does not: each host's restic repository lives in a Docker volume
 * on that host (`<prefix>-checkpoints-<host>`), so it went with the machine. Exported packages under `DATA_DIR/packages`
 * are files of this control plane and are left for their own expiry, because they are a copy somebody may still import.
 */
export function discardHostRecords(host: HostCtx, expectedDigest?: string): DiscardOutcome {
  const id = host.host.id;
  // Everything here is synchronous, and the stores' writes are too. Closing each store first means a write that is
  // still under way when the host goes (a create inside a volume lock, a checkpoint backup finishing) is either
  // already on disk and listed below, or refused by the store when it reaches its write. The removal is not behind a
  // store lock on purpose: a create holds the volume lock across an engine helper, and a machine that is gone must not
  // keep its host listed until that call returns.
  host.specs.closeHost(id);
  host.checkpoints.closeHost(id);
  host.volumes.closeHost(id);
  const boxes = host.specs
    .list()
    .filter((spec) => spec.hostId === id)
    .map((spec) => ({ id: spec.id, name: spec.name }));
  const checkpoints = host.checkpoints
    .list()
    .filter((checkpoint) => checkpoint.hostId === id)
    .map((checkpoint) => ({ id: checkpoint.id, label: checkpoint.label }));
  const volumes = host.volumes
    .list()
    .filter((volume) => volume.hostId === id)
    .map((volume) => ({ id: volume.id, name: volume.name, engineName: volume.engineName }));
  const records = recordsOf(host, boxes, volumes, checkpoints);
  if (expectedDigest !== undefined && records.digest !== expectedDigest) {
    // Nothing has been removed yet. The host stays as it is, and the caller shows the fresh preview.
    host.specs.openHost(id);
    host.checkpoints.openHost(id);
    host.volumes.openHost(id);
    return { changed: true, records };
  }
  host.lifetime.retire();
  for (const box of records.boxes) {
    // Read again rather than trusting the list above: a move may have written this spec to another host meanwhile,
    // and another host's record must not go with this one.
    const current = host.specs.read(box.id);
    if (!current || current.hostId !== id) continue;
    // The container is retired too, so a read that began before this removal cannot write the spec back afterwards.
    forgetBoxRecords(host, box.id, current.containerId);
  }
  for (const schedule of host.checkpoints.schedules()) {
    if (schedule.hostId === id) host.checkpoints.removeSchedule(schedule.boxId);
  }
  for (const pending of host.checkpoints.pendingRollbacks()) {
    if (pending.hostId === id) host.checkpoints.removePendingRollback(pending.boxId);
  }
  for (const checkpoint of records.checkpoints) {
    if (host.checkpoints.read(checkpoint.id)?.hostId === id) host.checkpoints.remove(checkpoint.id);
  }
  for (const volume of records.volumes) {
    if (host.volumes.read(volume.id)?.hostId === id) host.volumes.remove(volume.id);
  }
  return { changed: false, records };
}
