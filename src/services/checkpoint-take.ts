import {
  type DataLayer,
  type SystemLayer,
  type CheckpointRecord,
  type TrashMark,
  CHECKPOINT_VERSION,
} from "../checkpoints/types";
import type { HostCtx } from "../host/registry";
import { abortError } from "../lib/abort";
import { notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { assertNoSecretInImage } from "../secrets/env";
import type { BoxSpec } from "../specs/types";
import { assertHostDiskRoom } from "../volumes/disk";
import { rootOwnerOf } from "../volumes/measure";
import { type Box, getBox } from "./boxes";
import { planLayers, type PlannedLayer, commitSystemLayer, tagsFor, discardTaken } from "./checkpoint-layers";
import type { TakeCheckpointInput, Progress, CheckpointView } from "./checkpoint-model";
import { underBox, quiesce } from "./checkpoint-quiesce";
import { viewOf } from "./checkpoint-view";
import { holdVolumeBoxes } from "./files";

/** Refuses a take that names a volume the box cannot include, so the request answers before any backup starts. */
export function assertTakeable(host: HostCtx, box: Box, input: TakeCheckpointInput): void {
  const spec = host.specs.read(box.boxId);
  if (!spec) throw notFound(msg("box_not_found"));
  planLayers(host, spec, input.include.volumes);
  if (input.include.system) assertNoSecretInImage(spec.env);
}

/**
 * Takes a checkpoint of a box. The box's power lock is held for the whole backup, so a start, stop, sleep or delete of
 * the box waits for it. Every volume is backed up before the record is written. A failure takes back the snapshots and
 * the system image already made, so no half checkpoint is left behind, and the box is resumed either way.
 */
export async function takeCheckpoint(
  host: HostCtx,
  ref: string,
  input: TakeCheckpointInput,
  createdBy: string,
  progress?: Progress,
): Promise<CheckpointView> {
  const { boxId } = await getBox(host, ref);
  return underBox(host, boxId, (box) => backupBox(host, box, input, createdBy, progress));
}

/** What a backup does beyond taking the layers. The defaults are an ordinary checkpoint of a box. */
export interface BackupOptions {
  /** Keeps the activity hold without counting its end as activity, for work the scheduler starts on its own. */
  quiet?: boolean;
  /** Makes the record a recycle bin entry, which keeps the data until the mark's `expiresAt`. */
  trash?: TrashMark;
  /**
   * Leaves a stopped box stopped once the backup has completed. A caller that removes the box next needs this, since a
   * restart would only make that removal wait on it.
   */
  keepStopped?: boolean;
}

/** The box a backup reads from, and its spec. A backup of a volume no box mounts has none. */
export interface BackupSource {
  box: Box;
  spec: BoxSpec;
}

/**
 * Holds every box that mounts a volume the backup reads, so the backup counts as activity for each of them (decision 56).
 * `auto` marks a checkpoint an automatic trigger took, such as the safety point of a rollback.
 */
export async function backupBox(
  host: HostCtx,
  box: Box,
  input: TakeCheckpointInput,
  createdBy: string | null,
  progress?: Progress,
  auto = false,
  opts: BackupOptions = {},
): Promise<CheckpointView> {
  const spec = host.specs.read(box.boxId);
  if (!spec) throw notFound(msg("box_not_found"));
  await assertHostDiskRoom(host);
  const layers = planLayers(host, spec, input.include.volumes);
  return backupLayers(host, { box, spec }, layers, input, createdBy, progress, auto, opts);
}

/**
 * Backs up the given layers into one record. `source` is the box they belong to, or null for a volume kept without a
 * box, which is then read with its owner taken from a helper. Each layer is held as a backup of its volume.
 */
export async function backupLayers(
  host: HostCtx,
  source: BackupSource | null,
  layers: PlannedLayer[],
  input: TakeCheckpointInput,
  createdBy: string | null,
  progress: Progress | undefined,
  auto: boolean,
  opts: BackupOptions,
): Promise<CheckpointView> {
  const releases = layers.map(({ volume }) => holdVolumeBoxes(host, volume, { quiet: opts.quiet }));
  try {
    return await writeCheckpoint(host, source, layers, input, createdBy, auto, opts, progress);
  } finally {
    for (const release of releases) release();
  }
}

async function writeCheckpoint(
  host: HostCtx,
  source: BackupSource | null,
  layers: PlannedLayer[],
  input: TakeCheckpointInput,
  createdBy: string | null,
  auto: boolean,
  opts: BackupOptions,
  progress?: Progress,
): Promise<CheckpointView> {
  const id = host.checkpoints.allocateId();
  const box = source?.box ?? null;
  const resume = await quiesce(host, box, input.consistency, progress);
  const snapshots: string[] = [];
  const data: DataLayer[] = [];
  let system: SystemLayer | null = null;
  let completed = false;
  try {
    if (input.include.system && source) {
      assertNoSecretInImage(source.spec.env);
      progress?.log?.(`Committing ${source.box.name}…\n`);
      system = await commitSystemLayer(host, source.box, id, progress?.signal);
    }
    for (const layer of layers) {
      if (progress?.signal?.aborted) throw abortError();
      progress?.log?.(`Backing up ${layer.path || layer.volume.name}…\n`);
      const owner =
        layer.inBox && box
          ? await host.runtime.volumeRootOwner(box.id, layer.path)
          : await rootOwnerOf(host, layer.volume.engineName);
      const result = await host.checkpointEngine.backup(
        host,
        layer.volume.engineName,
        tagsFor(id, box?.boxId ?? null, layer.volume),
      );
      snapshots.push(result.snapshotId);
      data.push({
        volumeId: layer.volume.id,
        path: layer.path,
        mode: layer.mode,
        role: layer.volume.role,
        ownership: layer.volume.ownership,
        owner,
        snapshotId: result.snapshotId,
        bytes: result.bytes,
      });
    }
    const now = new Date().toISOString();
    const spec = source?.spec ?? null;
    const record: CheckpointRecord = {
      version: CHECKPOINT_VERSION,
      id,
      hostId: host.host.id,
      boxId: box?.boxId ?? null,
      boxName: box?.name ?? null,
      label: input.label?.trim() || box?.name || "",
      reason: input.reason?.trim() ?? "",
      createdBy,
      pinned: input.pinned,
      auto,
      consistency: input.consistency,
      specRevision: spec?.revision ?? null,
      spec: spec
        ? {
            template: spec.template,
            cpus: spec.resources.cpus,
            memoryBytes: spec.resources.memoryBytes,
            profile: spec.profile,
          }
        : null,
      data,
      system,
      trash: opts.trash ?? null,
      createdAt: now,
      updatedAt: now,
    };
    host.checkpoints.write(record);
    completed = true;
    log.info("checkpoint.created", {
      id,
      box: box?.name ?? null,
      layers: data.length,
      system: system !== null,
      trash: record.trash !== null,
    });
    return viewOf(record);
  } catch (e) {
    await discardTaken(host, id, snapshots, system);
    throw e;
  } finally {
    if (!(completed && opts.keepStopped)) await resume();
  }
}
