import type { DataLayer } from "../checkpoints/types";
import type { HostCtx } from "../host/registry";
import { abortError } from "../lib/abort";
import { conflict } from "../lib/errors";
import { msg } from "../lib/messages";
import { newBoxId } from "../specs/revision";
import type { BoxMount } from "../specs/types";
import { VolumeChanges } from "../volumes/changes";
import { createRestoredVolume, provisionDefaultMounts } from "../volumes/provision";
import { type VolumeRole, ROLE_MOUNT, type VolumeRecord } from "../volumes/types";
import { type Box, createBox } from "./boxes";
import { restoreLayer, slug } from "./checkpoint-layers";
import type { CheckpointView, ForkCheckpointInput, Progress } from "./checkpoint-model";
import { getCheckpoint } from "./checkpoint-view";
import type { RecordNote } from "./volume-owner";

/**
 * Splits a checkpoint's layers for a fork. A layer at a role's own path restores into that role's volume. Workspace
 * always comes along, home only when asked for, and cache and tools never do. Any other layer becomes a copy mounted at
 * its path, and a copy may not sit on a path a default volume uses.
 */
function forkPlan(data: DataLayer[], copyHome: boolean): { roles: Map<VolumeRole, DataLayer>; copies: DataLayer[] } {
  const roles = new Map<VolumeRole, DataLayer>();
  const copies: DataLayer[] = [];
  const defaultPaths = new Set<string>(Object.values(ROLE_MOUNT).map((point) => point.path));
  for (const layer of data) {
    const atRolePath = layer.role !== null && ROLE_MOUNT[layer.role].path === layer.path;
    if (atRolePath && layer.role !== null) {
      if (layer.role === "workspace" || (layer.role === "home" && copyHome)) roles.set(layer.role, layer);
      continue;
    }
    if (layer.role === "cache" || layer.role === "tools") continue;
    if (defaultPaths.has(layer.path)) throw conflict(msg("checkpoint_path_taken", { path: layer.path }));
    copies.push(layer);
  }
  return { roles, copies };
}

/** Refuses a fork whose copies would take a default mount's path, so the request answers before any volume is made. */
export function assertForkable(checkpoint: CheckpointView, copyHome: boolean): void {
  forkPlan(checkpoint.data, copyHome);
}

/**
 * Creates a new box from a checkpoint. The restored volumes are new, so the source box and its volumes are never
 * touched. The new box takes the checkpoint's image (its system layer, when there is one) and reserves its own id up
 * front, so the volumes it restores can name it as their owner.
 */
export async function forkCheckpoint(
  host: HostCtx,
  ref: string,
  input: ForkCheckpointInput,
  createdBy: string,
  progress?: Progress,
  record?: RecordNote,
): Promise<Box> {
  const checkpoint = await getCheckpoint(host, ref);
  return underSourceBox(host, checkpoint.boxId, () => forkFrom(host, checkpoint, input, createdBy, progress, record));
}

/**
 * Runs a fork under the power lock of the box its checkpoint came from, and counts that box as active while it runs. A
 * fork reads only snapshots, so the source is neither started nor stopped. The lock keeps a delete or sleep from landing
 * mid-fork, and a checkpoint whose box is gone still forks.
 */
async function underSourceBox<T>(host: HostCtx, boxId: string | null, run: () => Promise<T>): Promise<T> {
  if (boxId === null) return run();
  const release = host.pulse.hold(boxId);
  try {
    return await host.power.run(boxId, run);
  } finally {
    release();
  }
}

/**
 * Creates a box from a checkpoint's data and settings. A recycle bin entry of a box is forked the same way, so its
 * restore is a fork. Only the checkpoint's template, resources and profile are taken; anything the box had outside
 * them is not in a checkpoint and is not restored.
 */
export async function forkFrom(
  host: HostCtx,
  checkpoint: CheckpointView,
  input: ForkCheckpointInput,
  createdBy: string,
  progress: Progress | undefined,
  record: RecordNote | undefined,
): Promise<Box> {
  const spec = checkpoint.spec;
  if (!spec) throw conflict(msg("checkpoint_no_spec", { id: checkpoint.id }));
  const image = checkpoint.system?.image ?? spec.template.image;
  const boxId = newBoxId();
  const known = new Set<string>();
  const changes = new VolumeChanges();
  const plan = forkPlan(checkpoint.data, input.copyHome);
  try {
    const restored = new Map<VolumeRole, VolumeRecord>();
    for (const [role, layer] of plan.roles) {
      progress?.log?.(`Restoring ${role}…\n`);
      const volume = await createRestoredVolume(
        host,
        { name: `${input.name}-${role}`, role, owner: boxId, createdBy },
        known,
        changes,
      );
      await restoreLayer(host, layer, volume);
      restored.set(role, volume);
    }
    const mounts: BoxMount[] = await provisionDefaultMounts(
      host,
      { id: boxId, name: input.name, createdBy },
      known,
      changes,
      restored,
    );
    for (const layer of plan.copies) {
      if (progress?.signal?.aborted) throw abortError();
      progress?.log?.(`Copying ${layer.path}…\n`);
      const volume = await createRestoredVolume(
        host,
        { name: `${input.name}-${slug(layer.path)}`, role: null, owner: null, createdBy },
        known,
        changes,
      );
      await restoreLayer(host, layer, volume);
      mounts.push({ volume: volume.engineName, path: layer.path, mode: layer.mode });
    }
    return await createBox(
      host,
      {
        id: boxId,
        name: input.name,
        image,
        cpus: input.cpus,
        memoryMb: input.memoryMb,
        profile: input.profile ?? spec.profile ?? undefined,
        createdBy,
        mounts,
        ttlSec: input.ttlSec,
        templateLabel: spec.template.ref,
      },
      record,
    );
  } catch (e) {
    await changes.rollback();
    throw e;
  }
}
