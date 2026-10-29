import type { HostCtx } from "../host/registry";
import { abortError } from "../lib/abort";
import { AppError, conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { type ImageDetails, isRuntimeError } from "../runtime";
import { assertSecretsSet, containerEnv } from "../secrets/env";
import { type PlannedRebuild, REBUILD_LOSES } from "../specs/plan";
import type { BoxMount, BoxSpec } from "../specs/types";
import { VolumeChanges } from "../volumes/changes";
import { assertVolumesPresent, mountedByAnotherBox } from "../volumes/engine";
import { createRestoredVolume, removeEngine } from "../volumes/provision";
import { type Box, ensureBoxNetwork, getBox, refuseExpired } from "./boxes";
import { restoreLayer, type PlannedLayer } from "./checkpoint-layers";
import { deleteCheckpoint } from "./checkpoint-manage";
import type { CheckpointView, Progress } from "./checkpoint-model";
import { underBox } from "./checkpoint-quiesce";
import { backupBox } from "./checkpoint-take";
import { copyCheckpoint } from "./checkpoint-transfer";
import { needsImage, sendImage } from "./image-transfer";
import {
  assertMovable,
  assertReachable,
  assertRoomFor,
  checkpointsOn,
  commitMove,
  type Leftover,
  MOVE_KEEPS,
  type MovePreview,
  type MoveResult,
  type MoveVolume,
  sharedToolsOn,
  sourceImage,
  targetContainerName,
} from "./move";
import { beginMove } from "./moving";
import { assertFresh, containerSpec, movedTag } from "./rebuild";
import { provisionSelfToken } from "./self-token";
import { startupNow } from "./startup";
import { copyRecipe } from "./template-builds";
import { findTemplateSource } from "./template-sync";

/** The volumes a checkpoint move may carry, and what happens to each of the box's mounts on the target. */
interface CheckpointVolume extends MoveVolume {
  readonly action: "checkpoint" | "tools" | "empty";
}

interface CheckpointMovePlan {
  readonly spec: BoxSpec;
  readonly running: boolean;
  readonly starts: boolean;
  readonly image: ImageDetails;
  /** True when the target lacks the template and it is sent there with the checkpoint. */
  readonly transfer: boolean;
  readonly volumes: readonly CheckpointVolume[];
  /** The volumes the checkpoint reads, one layer per mount, in the order the box mounts them. */
  readonly layers: readonly PlannedLayer[];
  readonly checkpoints: number;
}

/**
 * What a run has changed so far, on the target and on the source (it pauses the source box), so a failure can put both
 * back.
 */
interface CheckpointRunState {
  created: string | null;
  tokenIssued: boolean;
  paused: boolean;
}

/** The 409 a checkpoint move answers without `confirm`. It carries the same preview the direct move carries. */
export function checkpointMoveConfirmation(preview: MovePreview): AppError {
  return new AppError(
    409,
    "confirmation_required",
    msg("move_confirm_checkpoint", { box: preview.box.name, to: preview.to, from: preview.from }),
    { preview },
  );
}

/**
 * The checkpoint move a request would make, read without changing anything. Every refusal the move would give is
 * raised here, so a preview answers with the same reason.
 *
 * The box is read as a checkpoint would read it: the volumes a checkpoint can hold (workspace, home and any recorded
 * volume the box mounts) travel in the checkpoint, the shared tools volume is replaced by the target's own, and a cache
 * volume is made again empty. A mount whose data a checkpoint cannot hold refuses the move, because the alternative is
 * a box on the target without the data it had.
 */
export async function previewCheckpointMove(
  from: HostCtx,
  to: HostCtx,
  ref: string,
  revision: number,
  holders: readonly HostCtx[],
): Promise<MovePreview> {
  const box = await getBox(from, ref);
  const spec = from.specs.read(box.boxId);
  if (!spec) throw notFound(msg("box_not_found"));
  const plan = await planCheckpointMove(from, to, box, spec, revision, holders);
  return checkpointPreviewOf(from, to, plan);
}

/**
 * Moves a box through a checkpoint: the box is checkpointed where it runs, the checkpoint is copied to the target, the
 * box is made there from that copy, and only then is it removed from the source. The box's power lock is held for the
 * whole move. A running source box is paused when its checkpoint is taken and stays paused until the move commits.
 * Nothing is written to the source's spec until the new container has been created and checked, so every failure
 * before that resumes the box and leaves it running where it was.
 *
 * A box whose checkpoint holds no data (a box with no volumes of its own) is moved without copying a package: there is
 * nothing to carry, and `copyCheckpoint` refuses a checkpoint with no layers.
 */
export async function moveBoxByCheckpoint(
  from: HostCtx,
  to: HostCtx,
  ref: string,
  revision: number,
  holders: readonly HostCtx[],
  progress?: Progress,
): Promise<MoveResult> {
  const { boxId } = await getBox(from, ref);
  return underBox(from, boxId, async (box) => {
    const spec = from.specs.read(box.boxId);
    if (!spec) throw notFound(msg("box_not_found"));
    const release = beginMove(box.boxId);
    try {
      const plan = await planCheckpointMove(from, to, box, spec, revision, holders);
      return await runCheckpointMove(from, to, plan, revision, holders, progress);
    } finally {
      release();
    }
  });
}

async function planCheckpointMove(
  from: HostCtx,
  to: HostCtx,
  box: Box,
  spec: BoxSpec,
  revision: number,
  holders: readonly HostCtx[],
): Promise<CheckpointMovePlan> {
  assertMovable(from, to, box, spec, revision);
  await assertReachable(to);
  refuseExpired(from, spec.id);
  if (from.checkpoints.pendingRollback(spec.id)) throw conflict(msg("rollback_pending", { box: box.name }));
  if (await movedTag(from, spec)) throw conflict(msg("move_template_moved", { tag: spec.template.image }));

  const image = await sourceImage(from, spec.template.image);
  const transfer = await templateOnTarget(to, holders, spec.template.image, image);
  assertSecretsSet(to.secrets, spec.env);

  const layers = carriedLayers(from, spec);
  await assertVolumesPresent(
    from,
    layers.map((layer) => layer.volume.engineName),
  );
  const volumes = volumePlanOf(from, to, spec, layers);

  const starts = spec.lifecycle.desired === "running";
  if (starts) await assertRoomFor(to, spec);

  return {
    spec,
    running: box.running,
    starts,
    image,
    transfer,
    volumes,
    layers,
    checkpoints: checkpointsOn(from, spec.id),
  };
}

/**
 * The volumes a checkpoint of this box reads: every mount whose volume is a checkpointed volume, at the path the box
 * mounts it. Cache and the shared tools volume are left out, because a checkpoint never reads them. A volume another box
 * also mounts is refused: a move copies data for this box alone, and a checkpoint would carry the other box's data too.
 */
function carriedLayers(from: HostCtx, spec: BoxSpec): PlannedLayer[] {
  const layers: PlannedLayer[] = [];
  const seen = new Set<string>();
  for (const mount of spec.mounts) {
    const record = from.volumes.findByEngine(from.host.id, mount.volume);
    if (!record) throw conflict(msg("volume_unmanaged", { volume: mount.volume }));
    if (!record.checkpoint || record.role === "tools") continue;
    if (mountedByAnotherBox(from, spec.id, record.engineName)) {
      throw conflict(msg("move_shared_volume", { volume: record.name }));
    }
    // A package holds one snapshot per volume, so a volume mounted twice cannot be carried: the copy would find two
    // snapshots for it and refuse the package half way through.
    if (seen.has(record.id)) {
      throw conflict(
        msg("move_checkpoint_volume_unrepresentable", { volume: record.name, path: mount.path, host: from.host.id }),
      );
    }
    seen.add(record.id);
    layers.push({ volume: record, path: mount.path, mode: mount.mode, inBox: true });
  }
  return layers;
}

/**
 * The template the target needs. A checkpoint carries the box's data, not the image it runs, so the template must be
 * on the target or in a package a host there can send. When no host can send it, the move is refused before a
 * checkpoint is taken: a copy would otherwise land on the target and only then fail to make a box from it.
 */
async function templateOnTarget(
  to: HostCtx,
  holders: readonly HostCtx[],
  image: string,
  details: ImageDetails,
): Promise<boolean> {
  // A tag the target holds for another image is refused here, by needsImage, before anything is taken.
  if (!(await needsImage(to, image, details))) return false;
  if (await firstHolder(holders, image)) return true;
  throw conflict(msg("move_checkpoint_template_missing", { host: to.host.id, image }));
}

/** Whether a host among `holders` holds the image as a template, so a copy can be sent from it. */
async function firstHolder(holders: readonly HostCtx[], image: string): Promise<boolean> {
  return (await findTemplateSource(holders, image)) !== null;
}

function volumePlanOf(from: HostCtx, to: HostCtx, spec: BoxSpec, layers: readonly PlannedLayer[]): CheckpointVolume[] {
  const atPath = new Map(layers.map((layer) => [layer.path, layer]));
  const pools = from.volumes.readPools().pools;
  return spec.mounts.map((mount) => {
    const source = from.volumes.findByEngine(from.host.id, mount.volume);
    if (!source) throw conflict(msg("volume_unmanaged", { volume: mount.volume }));
    if (source.role === "tools") return { mount, source, action: "tools", target: null };
    // The volume is made again in the pool it is in, so a pool that is gone refuses the move here, with the same reason a
    // direct move gives, and not half way through the restore.
    if (!pools.some((pool) => pool.name === source.pool)) throw notFound(msg("pool_not_found", { pool: source.pool }));
    const layer = atPath.get(mount.path);
    if (layer) return { mount, source, action: "checkpoint", target: source.name };
    // A cache volume is the one volume a checkpoint never reads, and its contents are only a cache: it is made again
    // empty on the target. Any other volume a checkpoint cannot read refuses the move rather than arriving without the
    // data the box had.
    if (source.role === "cache") return { mount, source, action: "empty", target: source.name };
    throw conflict(
      msg("move_checkpoint_volume_unrepresentable", {
        volume: source.name,
        path: mount.path,
        host: to.host.id,
      }),
    );
  });
}

function checkpointPreviewOf(from: HostCtx, to: HostCtx, plan: CheckpointMovePlan): MovePreview {
  return {
    box: { id: plan.spec.id, name: plan.spec.name },
    via: "checkpoint",
    from: from.host.id,
    to: to.host.id,
    running: plan.running,
    starts: plan.starts,
    image: { ref: plan.spec.template.image, transfer: plan.transfer },
    volumes: plan.volumes.map((volume) => ({
      path: volume.mount.path,
      role: volume.source.role,
      name: volume.source.name,
      action: volume.action,
      target: volume.target,
    })),
    network: plan.spec.network,
    checkpoints: plan.checkpoints,
    keeps: MOVE_KEEPS,
    loses: REBUILD_LOSES,
    revision: { current: plan.spec.revision, next: plan.spec.revision + 1 },
  };
}

async function runCheckpointMove(
  from: HostCtx,
  to: HostCtx,
  plan: CheckpointMovePlan,
  revision: number,
  holders: readonly HostCtx[],
  progress: Progress | undefined,
): Promise<MoveResult> {
  const { spec } = plan;
  const oldId = spec.containerId;
  const changes = new VolumeChanges();
  const state: CheckpointRunState = { created: null, tokenIssued: false, paused: false };
  const say = (text: string): void => progress?.log?.(`${text}\n`);
  let sourceCheckpoint: CheckpointView | null = null;
  let copy: CheckpointView | null = null;
  try {
    throwIfCancelled(progress);
    say(`Taking a checkpoint of ${spec.name} for the move.`);
    sourceCheckpoint = await backupBox(
      from,
      await getBox(from, spec.id),
      {
        pinned: false,
        reason: "Taken for a move to another host",
        include: { system: false, volumes: plan.layers.map((layer) => layer.volume.id) },
        consistency: "pause",
      },
      null,
      progress,
      false,
      { keepStopped: true },
    );
    state.paused = plan.running;
    throwIfCancelled(progress);
    if (sourceCheckpoint.data.length > 0) {
      say(`Copying the checkpoint to ${to.host.id}.`);
      copy = await copyCheckpoint(from, to, sourceCheckpoint.id, null, holders, progress);
    } else {
      say("The checkpoint holds no volume data, so only the box's settings travel.");
    }
    throwIfCancelled(progress);
    // The copy carries the template when it can, so the transfer is decided again here rather than from the preview.
    if (await needsImage(to, spec.template.image, plan.image)) {
      say(`Sending image ${spec.template.image} to ${to.host.id}.`);
      await sendImage(from, to, spec.template.image, plan.image.id, progress?.signal);
    }
    copyRecipe(from, to, spec.template.image, plan.image.id);
    const mounts = await restoreMounts(to, plan, copy, changes, say, progress);
    throwIfCancelled(progress);
    if (spec.network === to.security.network) await ensureBoxNetwork(to);
    const name = await targetContainerName(to, spec.id);
    const template = { ref: spec.template.ref, image: spec.template.image, digest: plan.image.id };
    const planned: PlannedRebuild = {
      changes: [],
      templateRef: spec.template.image,
      mounts,
      env: spec.env,
      network: spec.network,
      egress: null,
      profile: spec.profile,
      containerName: name,
    };
    say(`Creating the box on ${to.host.id}.`);
    const created = await to.runtime.createContainer(
      containerSpec(to, spec, planned, template, name, containerEnv(to.secrets, spec.env)),
    );
    state.created = created.id;
    await assertFresh(to, created.id, template, planned);
    if (plan.starts) {
      say(`Starting the box on ${to.host.id}.`);
      await to.runtime.startContainer(created.id);
      const started = await to.runtime.inspectContainer(created.id);
      if (!started.running) throw new AppError(502, "docker_error", msg("move_start_failed", { host: to.host.id }));
      if (spec.selfToken) {
        state.tokenIssued = true;
        await provisionSelfToken(to, { boxId: spec.id, name: spec.name }, created.id);
      }
    }
    throwIfCancelled(progress);
    await commitMove(from, to, spec.id, revision, { containerId: created.id, containerName: name, mounts, template });
    if (!plan.starts) to.selfTokens.revoke(spec.id);
    if (plan.starts) await startupNow(to, spec.id);
    say(`The box now runs on ${to.host.id}.`);
  } catch (e) {
    await undoCheckpointMove(from, to, spec, state, changes, sourceCheckpoint, copy);
    throw e;
  }
  return finishCheckpointMove(from, to, spec, oldId, plan, state.created, sourceCheckpoint, copy, say);
}

/**
 * Restores the checkpoint into the volumes the box mounts on the target, in the order the box mounts them. A mount the
 * checkpoint holds is restored into a new volume owned by the box. The shared tools volume is the target's own, and a
 * cache volume is made again empty. A volume keeps the storage pool it was in, and the names the volumes had are kept
 * where the target has them free.
 */
async function restoreMounts(
  to: HostCtx,
  plan: CheckpointMovePlan,
  copy: CheckpointView | null,
  changes: VolumeChanges,
  say: (text: string) => void,
  progress: Progress | undefined,
): Promise<BoxMount[]> {
  const known = new Set<string>();
  const layers = new Map((copy?.data ?? []).map((layer) => [layer.path, layer]));
  const mounts: BoxMount[] = [];
  for (const volume of plan.volumes) {
    throwIfCancelled(progress);
    if (volume.action === "tools") {
      const shared = await sharedToolsOn(to, volume.source, changes, known);
      mounts.push({ volume: shared.engineName, path: volume.mount.path, mode: volume.mount.mode });
      continue;
    }
    const layer = layers.get(volume.mount.path);
    if (volume.action === "checkpoint" && !layer) {
      throw conflict(
        msg("move_checkpoint_volume_unrepresentable", {
          volume: volume.source.name,
          path: volume.mount.path,
          host: to.host.id,
        }),
      );
    }
    say(
      layer
        ? `Restoring ${volume.mount.path} on ${to.host.id}.`
        : `Making ${volume.mount.path} again on ${to.host.id}, without its old contents.`,
    );
    const record = await createRestoredVolume(
      to,
      {
        name: volume.source.name,
        role: volume.source.role,
        owner: volume.source.ownership === "owned" ? plan.spec.id : null,
        createdBy: volume.source.createdBy,
        pool: volume.source.pool,
      },
      known,
      changes,
    );
    if (layer) await restoreLayer(to, layer, record);
    mounts.push({ volume: record.engineName, path: volume.mount.path, mode: volume.mount.mode });
  }
  return mounts;
}

/**
 * Takes back a move that failed before the commit: the target container, the volumes and records the move made there,
 * and the checkpoint it left on either host. Each step is logged if it fails, and the original error is still the one
 * thrown. The source's spec was never written, so what is put back is its running state: a box the move paused is
 * resumed, its self token, which the target took over, is issued to it again, and its checkpoint is removed.
 */
async function undoCheckpointMove(
  from: HostCtx,
  to: HostCtx,
  spec: BoxSpec,
  state: CheckpointRunState,
  changes: VolumeChanges,
  sourceCheckpoint: CheckpointView | null,
  copy: CheckpointView | null,
): Promise<void> {
  if (state.created) {
    try {
      await to.runtime.removeContainer(state.created, { force: true });
    } catch (e) {
      if (!isRuntimeError(e, "not_found")) {
        log.warn("box.move_rollback_failed", { id: spec.id, container: state.created, error: String(e) });
      }
    }
  }
  if (state.tokenIssued) to.selfTokens.revoke(spec.id);
  if (state.paused) {
    try {
      await from.runtime.unpauseContainer(spec.containerId);
      if (state.tokenIssued) {
        await provisionSelfToken(from, { boxId: spec.id, name: spec.name }, spec.containerId);
      }
    } catch (e) {
      log.warn("box.move_rollback_failed", { id: spec.id, container: spec.containerId, error: String(e) });
    }
  }
  if (copy) {
    await deleteCheckpoint(to, copy.id).catch((e: unknown) => {
      log.warn("box.move_rollback_failed", { id: spec.id, checkpoint: copy.id, error: String(e) });
    });
  }
  await changes.rollback();
  if (sourceCheckpoint) {
    await deleteCheckpoint(from, sourceCheckpoint.id).catch((e: unknown) => {
      log.warn("box.move_rollback_failed", { id: spec.id, checkpoint: sourceCheckpoint.id, error: String(e) });
    });
  }
}

/**
 * Removes what the box left on the source, once it runs on the target, and the two checkpoints the move made. A failure
 * here is not undone, because the box has already moved: it is reported as a leftover. A volume that could not be
 * removed is kept as an independent volume, so it can be seen and removed by hand.
 */
async function finishCheckpointMove(
  from: HostCtx,
  to: HostCtx,
  spec: BoxSpec,
  oldId: string,
  plan: CheckpointMovePlan,
  createdId: string | null,
  sourceCheckpoint: CheckpointView | null,
  copy: CheckpointView | null,
  say: (text: string) => void,
): Promise<MoveResult> {
  const leftovers: Leftover[] = [];
  const oldName = spec.containerName;
  say(`Removing the box from ${from.host.id}.`);
  let removed = true;
  try {
    await from.runtime.removeContainer(oldId, { force: true });
  } catch (e) {
    if (!isRuntimeError(e, "not_found")) {
      removed = false;
      leftovers.push({ kind: "container", name: oldName });
      log.warn("box.move_source_remove_failed", { id: spec.id, container: oldId, error: String(e) });
    }
  }
  from.specs.retire(oldId);
  const pools = from.volumes.readPools().pools;
  for (const volume of plan.volumes) {
    if (volume.action === "tools") continue;
    // A volume on shared storage is never removed by a move: the same export may hold data another host still reads.
    const local = pools.find((pool) => pool.name === volume.source.pool)?.backend === "local";
    const keep = (): void => {
      const now = new Date().toISOString();
      from.volumes.write({
        ...volume.source,
        ownership: "independent",
        ownerBoxId: null,
        updatedAt: now,
        lastMount: { at: now, boxId: spec.id, boxName: spec.name },
      });
      leftovers.push({ kind: "volume", name: volume.source.name });
    };
    if (!removed || !local) {
      keep();
      continue;
    }
    const outcome = await removeEngine(from, volume.source.engineName);
    if (outcome.status === "failed") {
      keep();
      continue;
    }
    from.volumes.remove(volume.source.id);
  }
  if (copy) {
    await deleteCheckpoint(to, copy.id).catch((e: unknown) => {
      leftovers.push({ kind: "checkpoint", name: copy.label });
      log.warn("box.move_checkpoint_remove_failed", {
        id: spec.id,
        host: to.host.id,
        checkpoint: copy.id,
        error: String(e),
      });
    });
  }
  if (sourceCheckpoint) {
    await deleteCheckpoint(from, sourceCheckpoint.id).catch((e: unknown) => {
      leftovers.push({ kind: "checkpoint", name: sourceCheckpoint.label });
      log.warn("box.move_checkpoint_remove_failed", {
        id: spec.id,
        host: from.host.id,
        checkpoint: sourceCheckpoint.id,
        error: String(e),
      });
    });
  }

  await from.sampler.observe(oldId);
  if (createdId) await to.sampler.observe(createdId);
  to.pulse.touch(spec.id, "wake");
  log.info("box.moved", { id: spec.id, name: spec.name, from: from.host.id, to: to.host.id, via: "checkpoint" });
  const box = await getBox(to, spec.id);
  return {
    box,
    from: from.host.id,
    to: to.host.id,
    via: "checkpoint",
    checkpoints: checkpointsOn(from, spec.id),
    leftovers,
  };
}

function throwIfCancelled(progress: Progress | undefined): void {
  if (progress?.signal?.aborted) throw abortError();
}
