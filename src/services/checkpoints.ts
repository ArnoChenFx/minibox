import type { BoxProfile } from "../box-profile";
import { legacyCheckpointId } from "../checkpoints/id";
import {
  CHECKPOINT_VERSION,
  type CheckpointRecord,
  type CheckpointSpec,
  type Consistency,
  type DataLayer,
  type SystemLayer,
} from "../checkpoints/types";
import type { HostCtx } from "../host/registry";
import { labelChange } from "../labels";
import { abortError } from "../lib/abort";
import { AppError, badRequest, conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { type ContainerChange, type ImageDetails, isRuntimeError } from "../runtime";
import { REBUILD_LOSES } from "../specs/plan";
import { newBoxId } from "../specs/revision";
import type { BoxMount, BoxSpec } from "../specs/types";
import { VolumeChanges } from "../volumes/changes";
import { createRestoredVolume, provisionDefaultMounts } from "../volumes/provision";
import { ROLE_MOUNT, type VolumeRecord, type VolumeRole } from "../volumes/types";
import { type Box, createBox, getBox, startBox, stopBox } from "./boxes";
import type { ImageItem } from "./images";
import { rebuildBox } from "./rebuild";
import { deleteSnapshot, listSnapshots } from "./snapshots";
import type { RecordNote } from "./volume-owner";

/** Progress lines and cancellation for a call that may run for a while. A task handle satisfies it. */
export interface Progress {
  readonly signal?: AbortSignal;
  log?(text: string): void;
}

/**
 * A checkpoint as the API shows it. A snapshot made before checkpoints appears too, with only a system layer and an id
 * derived from its image, so one listing covers both.
 */
export interface CheckpointView {
  id: string;
  legacy: boolean;
  hostId: string;
  boxId: string | null;
  boxName: string | null;
  label: string;
  reason: string;
  createdBy: string | null;
  pinned: boolean;
  auto: boolean;
  consistency: Consistency;
  specRevision: number | null;
  spec: CheckpointSpec;
  data: DataLayer[];
  system: SystemLayer | null;
  /** Bytes restic read from the volumes, summed over the data layers. */
  bytes: number;
  createdAt: string;
  updatedAt: string;
}

export interface TakeCheckpointInput {
  label?: string;
  reason?: string;
  pinned: boolean;
  /** Volumes to include beyond the default set, and whether to commit the writable layer. */
  include: { system: boolean; volumes: string[] };
  consistency: Consistency;
}

export interface ForkCheckpointInput {
  name: string;
  cpus: number;
  memoryMb: number;
  profile?: BoxProfile;
  copyHome: boolean;
  ttlSec?: number | null;
}

export interface CheckpointPatch {
  pinned?: boolean;
  label?: string;
}

const ROLLBACK_KEEPS = ["id", "name", "history", "shared volumes"] as const;

/** What a rollback would do, shown before anything changes. Its `restores` are the current volumes it replaces. */
export interface RollbackPreview {
  checkpoint: { id: string; label: string; createdAt: string };
  restores: { path: string; role: VolumeRole | null; volume: string }[];
  keeps: typeof ROLLBACK_KEEPS;
  loses: typeof REBUILD_LOSES;
  diff: ContainerChange[];
  revision: { current: number; next: number };
}

export interface RollbackResult {
  box: Box;
  /** The volumes the rollback replaced. They stay until the user confirms their removal or undoes the rollback. */
  replaced: { id: string; name: string }[];
}

export function viewOf(record: CheckpointRecord): CheckpointView {
  return {
    id: record.id,
    legacy: false,
    hostId: record.hostId,
    boxId: record.boxId,
    boxName: record.boxName,
    label: record.label,
    reason: record.reason,
    createdBy: record.createdBy,
    pinned: record.pinned,
    auto: record.auto,
    consistency: record.consistency,
    specRevision: record.specRevision,
    spec: record.spec,
    data: record.data,
    system: record.system,
    bytes: record.data.reduce((sum, layer) => sum + layer.bytes, 0),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** A snapshot from before checkpoints: a system layer only. It can be forked and deleted, not changed. */
function legacyView(host: HostCtx, image: ImageItem): CheckpointView {
  return {
    id: legacyCheckpointId(image.id),
    legacy: true,
    hostId: host.host.id,
    boxId: image.sourceId,
    boxName: image.source,
    label: image.name,
    reason: image.description ?? "",
    createdBy: image.createdBy,
    pinned: false,
    auto: false,
    consistency: "pause",
    specRevision: null,
    spec: {
      template: { ref: `snapshot:${image.ref}`, image: image.ref, digest: image.id },
      cpus: null,
      memoryBytes: null,
      profile: null,
    },
    data: [],
    system: { image: image.ref, imageId: image.id },
    bytes: 0,
    createdAt: image.createdAt,
    updatedAt: image.createdAt,
  };
}

function ownRecord(host: HostCtx, id: string): CheckpointRecord | null {
  const record = host.checkpoints.read(id);
  return record && record.hostId === host.host.id ? record : null;
}

export async function listCheckpoints(host: HostCtx): Promise<CheckpointView[]> {
  const own = host.checkpoints
    .list()
    .filter((record) => record.hostId === host.host.id)
    .map(viewOf);
  const legacy = (await listSnapshots(host)).map((image) => legacyView(host, image));
  return [...own, ...legacy].toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getCheckpoint(host: HostCtx, id: string): Promise<CheckpointView> {
  const record = ownRecord(host, id);
  if (record) return viewOf(record);
  const image = (await listSnapshots(host)).find((item) => legacyCheckpointId(item.id) === id);
  if (image) return legacyView(host, image);
  throw notFound(msg("checkpoint_not_found", { id }));
}

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
    let current = record;
    for (const layer of record.data) {
      await host.checkpointEngine.forget(host, layer.snapshotId);
      current = { ...current, data: current.data.filter((item) => item.snapshotId !== layer.snapshotId) };
      host.checkpoints.write(current);
    }
    if (current.system) await removeSystemImage(host, current.system, id);
    host.checkpoints.remove(id);
  });
  log.info("checkpoint.deleted", { id });
}

interface PlannedLayer {
  volume: VolumeRecord;
  mount: BoxMount;
}

/**
 * The volumes a checkpoint takes: the box's owned volumes (workspace and home, not cache), plus any volume the caller
 * names that the box mounts. Cache and tools are refused when named, because they are never part of a checkpoint.
 */
function planLayers(host: HostCtx, spec: BoxSpec, named: string[]): PlannedLayer[] {
  const mounted = spec.mounts.flatMap((mount) => {
    const volume = host.volumes.findByEngine(host.host.id, mount.volume);
    return volume ? [{ volume, mount }] : [];
  });
  const included = new Set<string>();
  for (const ref of named) {
    const volume = host.volumes.resolve(ref, host.host.id);
    if (!volume) throw notFound(msg("volume_not_found", { volume: ref }));
    if (!volume.checkpoint || volume.role === "tools") {
      throw badRequest(msg("checkpoint_volume_excluded", { volume: volume.name }), { field: "include" });
    }
    if (!mounted.some((item) => item.volume.id === volume.id)) {
      throw conflict(msg("checkpoint_volume_not_mounted", { volume: volume.name }));
    }
    included.add(volume.id);
  }
  return mounted.filter(({ volume }) => volume.checkpoint && (volume.ownership === "owned" || included.has(volume.id)));
}

function tagsFor(checkpointId: string, boxId: string, volume: VolumeRecord): string[] {
  return [`checkpoint:${checkpointId}`, `box:${boxId}`, `volume:${volume.id}`];
}

/**
 * Makes the box consistent for the backup, and returns what undoes it. `pause` freezes a running box. `stop` stops
 * it and starts it again afterwards, when it was running. `live` leaves it alone.
 */
async function quiesce(
  host: HostCtx,
  box: Box,
  consistency: Consistency,
  progress?: Progress,
): Promise<() => Promise<void>> {
  if (!box.running || consistency === "live") return async () => {};
  if (consistency === "pause") {
    progress?.log?.("Pausing the box…\n");
    await host.runtime.pauseContainer(box.id);
    return () => host.runtime.unpauseContainer(box.id);
  }
  progress?.log?.("Stopping the box…\n");
  await stopBox(host, box.boxId, "manual");
  return async () => {
    progress?.log?.("Starting the box again…\n");
    await startBox(host, box.boxId);
  };
}

async function commitSystemLayer(host: HostCtx, box: Box, id: string, signal?: AbortSignal): Promise<SystemLayer> {
  const repo = `${host.prefix}-checkpoint`;
  await host.runtime.commitContainer(box.id, {
    repo,
    tag: id,
    comment: `MiniBox checkpoint of ${box.name}`,
    author: "minibox",
    pause: true,
    signal,
    changes: [labelChange(host.keys.checkpoint, id), labelChange(host.keys.template, "false")],
  });
  const image = `${repo}:${id}`;
  const details = await host.runtime.inspectImage(image);
  return { image, imageId: details.id };
}

/** Removes a system image this checkpoint made. An image that carries another checkpoint's label is left alone. */
async function removeSystemImage(host: HostCtx, system: SystemLayer, id: string): Promise<void> {
  let details: ImageDetails;
  try {
    details = await host.runtime.inspectImage(system.imageId);
  } catch (e) {
    if (isRuntimeError(e, "not_found")) return;
    throw e;
  }
  if (details.labels[host.keys.checkpoint] !== id) return;
  await host.runtime.removeImage(system.imageId, { force: true });
}

/** Takes back what a failed checkpoint made. A step that fails is logged, and the original error still wins. */
async function discardTaken(host: HostCtx, id: string, snapshots: string[], system: SystemLayer | null): Promise<void> {
  for (const snapshotId of snapshots) {
    await host.checkpointEngine.forget(host, snapshotId).catch((e: unknown) => {
      log.warn("checkpoint.discard_failed", { id, snapshot: snapshotId, error: String(e) });
    });
  }
  if (system) {
    await removeSystemImage(host, system, id).catch((e: unknown) => {
      log.warn("checkpoint.discard_failed", { id, image: system.imageId, error: String(e) });
    });
  }
}

/**
 * Takes a checkpoint of a box. Every volume is backed up before the record is written. A failure takes back the
 * snapshots and the system image already made, so no half checkpoint is left behind, and the box is resumed either way.
 */
export async function takeCheckpoint(
  host: HostCtx,
  ref: string,
  input: TakeCheckpointInput,
  createdBy: string,
  progress?: Progress,
): Promise<CheckpointView> {
  const box = await getBox(host, ref);
  const spec = host.specs.read(box.boxId);
  if (!spec) throw notFound(msg("box_not_found"));
  const layers = planLayers(host, spec, input.include.volumes);
  const id = host.checkpoints.allocateId();
  const resume = await quiesce(host, box, input.consistency, progress);
  const snapshots: string[] = [];
  const data: DataLayer[] = [];
  let system: SystemLayer | null = null;
  try {
    if (input.include.system) {
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
      auto: false,
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

/** Writes one snapshot back into a volume that already exists, then sets its root to the owner the snapshot recorded. */
async function restoreLayer(host: HostCtx, layer: DataLayer, volume: VolumeRecord): Promise<void> {
  await host.checkpointEngine.restore(host, layer.snapshotId, volume.engineName);
  await host.runtime.setVolumeRootOwner(volume.engineName, layer.owner, host.baseTemplateTag);
}

const slug = (path: string): string => path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "volume";

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
  const image = checkpoint.system?.image ?? checkpoint.spec.template.image;
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
        profile: input.profile ?? checkpoint.spec.profile ?? undefined,
        createdBy,
        mounts,
        ttlSec: input.ttlSec,
        templateLabel: checkpoint.spec.template.ref,
      },
      record,
    );
  } catch (e) {
    await changes.rollback();
    throw e;
  }
}

interface RollbackPlan {
  box: Box;
  spec: BoxSpec;
  checkpoint: CheckpointView;
  restores: { layer: DataLayer; mount: BoxMount; volume: VolumeRecord }[];
}

/**
 * Matches each owned layer of the checkpoint to the box's current owned volume at the same path. Shared volumes are not
 * part of a rollback, so they are never matched. A checkpoint of another box, or one with no volume data, is refused.
 */
export async function planRollback(host: HostCtx, boxRef: string, checkpointRef: string): Promise<RollbackPlan> {
  const box = await getBox(host, boxRef);
  const spec = host.specs.read(box.boxId);
  if (!spec) throw notFound(msg("box_not_found"));
  const checkpoint = await getCheckpoint(host, checkpointRef);
  const owned = checkpoint.data.filter((layer) => layer.ownership === "owned");
  if (owned.length === 0) throw conflict(msg("checkpoint_no_data", { id: checkpoint.id }));
  if (checkpoint.boxId !== box.boxId) throw conflict(msg("checkpoint_other_box", { id: checkpoint.id }));
  const restores = owned.map((layer) => {
    const mount = spec.mounts.find((item) => item.path === layer.path);
    const volume = mount ? host.volumes.findByEngine(host.host.id, mount.volume) : null;
    if (!mount || !volume || volume.ownership !== "owned" || volume.ownerBoxId !== box.boxId) {
      throw conflict(msg("checkpoint_path_not_mounted", { path: layer.path }));
    }
    return { layer, mount, volume };
  });
  return { box, spec, checkpoint, restores };
}

export function rollbackPreview(plan: RollbackPlan, diff: ContainerChange[]): RollbackPreview {
  return {
    checkpoint: { id: plan.checkpoint.id, label: plan.checkpoint.label, createdAt: plan.checkpoint.createdAt },
    restores: plan.restores.map(({ mount, volume }) => ({ path: mount.path, role: volume.role, volume: volume.name })),
    keeps: ROLLBACK_KEEPS,
    loses: REBUILD_LOSES,
    diff,
    revision: { current: plan.spec.revision, next: plan.spec.revision + 1 },
  };
}

/**
 * Rolls a box back to one of its own checkpoints. Each owned volume's data is restored into a new volume, and the box is
 * rebuilt onto those volumes, which keeps the rebuild's checks. The replaced volumes are not deleted. Without `confirm`
 * nothing changes, and a 409 carries the preview.
 */
export async function rollbackBox(
  host: HostCtx,
  boxRef: string,
  input: { checkpoint: string; confirm: boolean },
  createdBy: string | null,
  progress?: Progress,
  record?: RecordNote,
): Promise<RollbackResult> {
  const plan = await planRollback(host, boxRef, input.checkpoint);
  if (!input.confirm) {
    const diff = await host.runtime.containerDiff(plan.spec.containerId);
    throw new AppError(409, "confirmation_required", msg("checkpoint_rollback_confirm"), {
      preview: rollbackPreview(plan, diff),
    });
  }
  const known = new Set<string>();
  const changes = new VolumeChanges();
  const replacement = new Map<string, VolumeRecord>();
  try {
    for (const { layer, mount, volume } of plan.restores) {
      progress?.log?.(`Restoring ${mount.path}…\n`);
      const fresh = await createRestoredVolume(
        host,
        {
          name: `${plan.spec.name}-${volume.role ?? slug(mount.path)}`,
          role: volume.role,
          owner: plan.spec.id,
          createdBy,
        },
        known,
        changes,
      );
      await restoreLayer(host, layer, fresh);
      replacement.set(mount.path, fresh);
    }
    const mounts = plan.spec.mounts.map((mount) => {
      const fresh = replacement.get(mount.path);
      return fresh ? { ...mount, volume: fresh.engineName } : mount;
    });
    const box = await rebuildBox(host, plan.spec.id, plan.spec.revision, { mounts }, true, record);
    log.info("checkpoint.rolled_back", { checkpoint: plan.checkpoint.id, box: plan.spec.name });
    return {
      box,
      replaced: plan.restores.map(({ volume }) => ({ id: volume.id, name: volume.name })),
    };
  } catch (e) {
    await changes.rollback();
    throw e;
  }
}
