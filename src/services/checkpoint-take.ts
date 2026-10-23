import { type DataLayer, type SystemLayer, type CheckpointRecord, CHECKPOINT_VERSION } from "../checkpoints/types";
import type { HostCtx } from "../host/registry";
import { abortError } from "../lib/abort";
import { notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { assertNoSecretInImage } from "../secrets/env";
import type { BoxSpec } from "../specs/types";
import { assertHostDiskRoom } from "../volumes/disk";
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
  opts: { quiet?: boolean } = {},
): Promise<CheckpointView> {
  const spec = host.specs.read(box.boxId);
  if (!spec) throw notFound(msg("box_not_found"));
  await assertHostDiskRoom(host);
  const layers = planLayers(host, spec, input.include.volumes);
  const releases = layers.map(({ volume }) => holdVolumeBoxes(host, volume, opts));
  try {
    return await writeCheckpoint(host, box, spec, layers, input, createdBy, auto, progress);
  } finally {
    for (const release of releases) release();
  }
}

async function writeCheckpoint(
  host: HostCtx,
  box: Box,
  spec: BoxSpec,
  layers: PlannedLayer[],
  input: TakeCheckpointInput,
  createdBy: string | null,
  auto: boolean,
  progress?: Progress,
): Promise<CheckpointView> {
  const id = host.checkpoints.allocateId();
  const resume = await quiesce(host, box, input.consistency, progress);
  const snapshots: string[] = [];
  const data: DataLayer[] = [];
  let system: SystemLayer | null = null;
  try {
    if (input.include.system) {
      assertNoSecretInImage(spec.env);
      progress?.log?.(`Committing ${box.name}…\n`);
      system = await commitSystemLayer(host, box, id, progress?.signal);
    }
    for (const { volume, mount } of layers) {
      if (progress?.signal?.aborted) throw abortError();
      progress?.log?.(`Backing up ${mount.path}…\n`);
      const owner = await host.runtime.volumeRootOwner(box.id, mount.path);
      const result = await host.checkpointEngine.backup(host, volume.engineName, tagsFor(id, box.boxId, volume));
      snapshots.push(result.snapshotId);
      data.push({
        volumeId: volume.id,
        path: mount.path,
        mode: mount.mode,
        role: volume.role,
        ownership: volume.ownership,
        owner,
        snapshotId: result.snapshotId,
        bytes: result.bytes,
      });
    }
    const now = new Date().toISOString();
    const record: CheckpointRecord = {
      version: CHECKPOINT_VERSION,
      id,
      hostId: host.host.id,
      boxId: box.boxId,
      boxName: box.name,
      label: input.label?.trim() || box.name,
      reason: input.reason?.trim() ?? "",
      createdBy,
      pinned: input.pinned,
      auto,
      consistency: input.consistency,
      specRevision: spec.revision,
      spec: {
        template: spec.template,
        cpus: spec.resources.cpus,
        memoryBytes: spec.resources.memoryBytes,
        profile: spec.profile,
      },
      data,
      system,
      createdAt: now,
      updatedAt: now,
    };
    host.checkpoints.write(record);
    log.info("checkpoint.created", { id, box: box.name, layers: data.length, system: system !== null });
    return viewOf(record);
  } catch (e) {
    await discardTaken(host, id, snapshots, system);
    throw e;
  } finally {
    await resume();
  }
}
