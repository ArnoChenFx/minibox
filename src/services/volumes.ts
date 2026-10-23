import type { TrashRef } from "../checkpoints/types";
import type { HostCtx } from "../host/registry";
import { AppError, badRequest, conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { revisionMismatch } from "../specs/revision";
import type { BoxMount, MountMode } from "../specs/types";
import { claimEngineVolumes } from "../volumes/engine";
import { probePools } from "../volumes/health";
import { type LimitPatch, mergeLimits, usageLevel } from "../volumes/limits";
import { validMountPath } from "../volumes/mounts";
import { normalizePools, type PoolDraft, type RoleDraft } from "../volumes/pools";
import { createIndependentVolume, planIndependentVolume, removeEngine } from "../volumes/provision";
import type {
  PoolBackend,
  PoolHealth,
  PoolsFile,
  RolePools,
  UsageLevel,
  UsagePoint,
  UsageScope,
  VolumeLimits,
  VolumeRecord,
  VolumeRole,
} from "../volumes/types";
import { recordSample, sampleWithin } from "../volumes/usage";
import { type Box, getBox, readSpec } from "./boxes";
import { type RebuildResult, rebuildWithSafety, type SafetyHook } from "./rebuild";
import { discardCopy, keepsVolume, trashVolume } from "./trash";
import type { RecordNote } from "./volume-owner";
import { errorOutcome, hostOffline, messageOutcome, type OutcomeError, volumesInUse } from "./volume-refs";

export interface VolumeMountView {
  boxId: string;
  boxName: string;
  path: string;
  mode: MountMode;
}

/** The usage a volume view shows. The trend is what this process has sampled, so it starts empty after a restart. */
export interface VolumeUsageView {
  /** `share` for an NFS volume, whose figure is the usage of the whole share rather than of the volume. */
  scope: UsageScope;
  level: UsageLevel;
  history: UsagePoint[];
  /** Why the last sample failed, or null when it worked or none has run yet. */
  lastError: string | null;
}

export interface VolumeView {
  id: string;
  name: string;
  hostId: string;
  pool: string;
  backend: string;
  role: VolumeRole | null;
  ownership: VolumeRecord["ownership"];
  ownerBoxId: string | null;
  sensitive: boolean;
  checkpoint: boolean;
  engineName: string;
  bytes: number | null;
  bytesAt: string | null;
  limits: VolumeLimits;
  usage: VolumeUsageView;
  createdAt: string;
  mounts: VolumeMountView[];
  unattached: boolean;
  /** How many boxes currently mount this volume read-write. A second read-write mount is the operator's risk. */
  rwMounts: number;
}

export interface PoolsView {
  pools: PoolsFile["pools"];
  roles: PoolsFile["roles"];
  health: PoolHealth[];
}

function requireVolume(host: HostCtx, ref: string): VolumeRecord {
  const volume = host.volumes.resolve(ref, host.host.id);
  if (!volume || volume.hostId !== host.host.id) throw notFound(msg("volume_not_found", { volume: ref }));
  return volume;
}

function mountsOf(host: HostCtx, volume: VolumeRecord): VolumeMountView[] {
  const mounts: VolumeMountView[] = [];
  for (const spec of host.specs.list()) {
    if (spec.hostId !== host.host.id) continue;
    for (const mount of spec.mounts) {
      if (mount.volume !== volume.engineName) continue;
      mounts.push({ boxId: spec.id, boxName: spec.name, path: mount.path, mode: mount.mode });
    }
  }
  return mounts;
}

function usageOf(host: HostCtx, volume: VolumeRecord, backend: PoolBackend): VolumeUsageView {
  const memory = host.volumes.usageMemory(volume.id);
  const lastKnown: UsagePoint[] =
    volume.bytes !== null && volume.bytesAt ? [{ at: volume.bytesAt, bytes: volume.bytes }] : [];
  return {
    scope: backend === "nfs" ? "share" : "volume",
    level: usageLevel(volume.bytes, volume.limits),
    history: memory.points.length > 0 ? [...memory.points] : lastKnown,
    lastError: memory.lastError,
  };
}

function viewOf(host: HostCtx, volume: VolumeRecord): VolumeView {
  const mounts = mountsOf(host, volume);
  const pool = host.volumes.readPools().pools.find((item) => item.name === volume.pool);
  const backend = pool?.backend ?? "local";
  return {
    id: volume.id,
    name: volume.name,
    hostId: volume.hostId,
    pool: volume.pool,
    backend,
    role: volume.role,
    ownership: volume.ownership,
    ownerBoxId: volume.ownerBoxId,
    sensitive: volume.sensitive,
    checkpoint: volume.checkpoint,
    engineName: volume.engineName,
    bytes: volume.bytes,
    bytesAt: volume.bytesAt,
    limits: volume.limits,
    usage: usageOf(host, volume, backend),
    createdAt: volume.createdAt,
    mounts,
    unattached: mounts.length === 0,
    rwMounts: mounts.filter((mount) => mount.mode === "rw").length,
  };
}

export async function listVolumes(host: HostCtx): Promise<VolumeView[]> {
  await claimEngineVolumes(host);
  return host.volumes
    .list()
    .filter((volume) => volume.hostId === host.host.id)
    .map((volume) => viewOf(host, volume))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

export async function getVolume(host: HostCtx, ref: string): Promise<VolumeView> {
  await claimEngineVolumes(host);
  return viewOf(host, requireVolume(host, ref));
}

export async function createVolume(
  host: HostCtx,
  input: { name: string; pool?: string; role: VolumeRole | null; createdBy: string | null },
): Promise<VolumeView> {
  const record = await createIndependentVolume(host, input, new Set());
  return viewOf(host, record);
}

function refuseIfMounted(name: string, mounts: VolumeMountView[]): void {
  const user = mounts[0];
  if (user) throw conflict(msg("volume_mounted", { name, box: user.boxName }));
}

/** The change a storage write would make. A caller sees it in `details.preview` before it sends confirm. */
export type StoragePreview =
  | {
      action: "create_volume";
      name: string;
      pool: string;
      backend: PoolBackend;
      role: VolumeRole | null;
      ownership: "independent";
    }
  | {
      action: "delete_volume";
      id: string;
      name: string;
      pool: string;
      role: VolumeRole | null;
      engineName: string;
      bytes: number | null;
      /** Whether the delete keeps a copy of the data in the recycle bin. */
      trash: boolean;
    }
  | {
      action: "delete_volumes";
      volumes: {
        id: string;
        name: string;
        hostId: string | null;
        pool: string | null;
        role: VolumeRole | null;
        bytes: number | null;
        /** Whether the delete keeps a copy of the data in the recycle bin. */
        trash: boolean;
        /** Why the volume is not deleted, or null when it will be. */
        blocked: DeleteBlock | null;
      }[];
    }
  | {
      action: "replace_pools";
      pools: { name: string; backend: PoolBackend; default: boolean }[];
      roles: RolePools;
      added: string[];
      removed: string[];
    };

/** Refuses a storage write that did not send confirm. Nothing has changed when this is thrown. */
export function confirmationRequired(preview: StoragePreview): AppError {
  return new AppError(409, "confirmation_required", msg("storage_confirm_required"), { preview });
}

export function previewCreateVolume(
  host: HostCtx,
  input: { name: string; pool?: string; role: VolumeRole | null },
): StoragePreview {
  const { name, pool } = planIndependentVolume(host, input);
  return {
    action: "create_volume",
    name,
    pool: pool.name,
    backend: pool.backend,
    role: input.role,
    ownership: "independent",
  };
}

export function previewDeleteVolume(volume: VolumeView, skipTrash: boolean): StoragePreview {
  refuseIfMounted(volume.name, volume.mounts);
  return {
    action: "delete_volume",
    id: volume.id,
    name: volume.name,
    pool: volume.pool,
    role: volume.role,
    engineName: volume.engineName,
    bytes: volume.bytes,
    trash: keepsVolume(volume, skipTrash),
  };
}

export function previewPools(host: HostCtx, drafts: PoolDraft[], roles: RoleDraft | undefined): StoragePreview {
  const { previous, file } = planPools(host, drafts, roles);
  const before = new Set(previous.pools.map((pool) => pool.name));
  const after = new Set(file.pools.map((pool) => pool.name));
  return {
    action: "replace_pools",
    pools: file.pools.map((pool) => ({ name: pool.name, backend: pool.backend, default: pool.default })),
    roles: file.roles,
    added: [...after].filter((name) => !before.has(name)),
    removed: [...before].filter((name) => !after.has(name)),
  };
}

/**
 * Deletes a volume and its engine data. Its data is first kept in the recycle bin, unless `skipTrash` is set or its role
 * keeps nothing. When the engine delete then fails, that copy is purged, so a refused delete leaves no entry behind.
 */
export async function deleteVolume(
  host: HostCtx,
  ref: string,
  opts: { skipTrash?: boolean; createdBy?: string | null; record?: RecordNote } = {},
): Promise<{ name: string; trash: TrashRef | null }> {
  const volume = requireVolume(host, ref);
  refuseIfMounted(volume.name, mountsOf(host, volume));
  const trash = keepsVolume(volume, opts.skipTrash ?? false)
    ? await trashVolume(host, volume, opts.createdBy ?? null, opts.record)
    : null;
  const result = await removeEngine(host, volume.engineName);
  if (result.status === "failed") {
    await discardCopy(host, trash, opts.record);
    throw conflict(msg("volume_delete_failed", { name: volume.name, detail: result.detail }));
  }
  host.volumes.remove(volume.id);
  log.info("volume.deleted", { id: volume.id, name: volume.name, trash: trash !== null });
  return { name: volume.name, trash };
}

/** Why a batch delete does not remove a volume. `in_use` and `forbidden` are refusals; the rest are failures. */
export type DeleteBlock = "in_use" | "forbidden" | "not_found" | "offline" | "unavailable";

/** One id of a batch delete, resolved and judged before anything is removed. */
export interface DeletePlan {
  /** The id or name the request named. */
  ref: string;
  volume: VolumeRecord | null;
  host: HostCtx | null;
  blocked: DeleteBlock | null;
  /** The engine's reason when its containers could not be listed. */
  detail: string | null;
}

/**
 * Resolves each id or name a batch delete names and decides what happens to it, without changing anything. A volume is
 * blocked when the caller may not delete it or a box or container still uses it. A host that is offline, or cannot list
 * its containers, blocks only its own volumes, so one bad host does not stop the others.
 */
export async function planDeletes(
  request: HostCtx,
  hosts: readonly HostCtx[],
  refs: readonly string[],
  may: (volume: VolumeRecord) => Promise<boolean>,
): Promise<DeletePlan[]> {
  const usage = new Map<string, Promise<Set<string>>>();
  const usageOf = (host: HostCtx): Promise<Set<string>> => {
    const known = usage.get(host.host.id);
    if (known) return known;
    const pending = volumesInUse(host);
    usage.set(host.host.id, pending);
    return pending;
  };
  const seen = new Set<string>();
  const plans: DeletePlan[] = [];
  for (const ref of new Set(refs)) {
    const volume = request.volumes.resolve(ref);
    if (volume && seen.has(volume.id)) continue;
    if (volume) seen.add(volume.id);
    plans.push(await planOne(ref, volume, hosts, may, usageOf));
  }
  return plans;
}

async function planOne(
  ref: string,
  volume: VolumeRecord | null,
  hosts: readonly HostCtx[],
  may: (volume: VolumeRecord) => Promise<boolean>,
  usageOf: (host: HostCtx) => Promise<Set<string>>,
): Promise<DeletePlan> {
  if (!volume) return { ref, volume, host: null, blocked: "not_found", detail: null };
  if (!(await may(volume))) return { ref, volume, host: null, blocked: "forbidden", detail: null };
  const host = hosts.find((item) => item.host.id === volume.hostId) ?? null;
  if (!host) return { ref, volume, host, blocked: "not_found", detail: null };
  if (hostOffline(host)) return { ref, volume, host, blocked: "offline", detail: null };
  try {
    const inUse = (await usageOf(host)).has(volume.engineName);
    return { ref, volume, host, blocked: inUse ? "in_use" : null, detail: null };
  } catch (e) {
    return { ref, volume, host, blocked: "unavailable", detail: errorOutcome(e).message };
  }
}

/** What a batch delete did with one of its volumes. */
export interface DeletedVolume {
  id: string;
  name: string;
  hostId: string | null;
  status: "removed" | "refused" | "failed";
  trash: TrashRef | null;
  error: OutcomeError | null;
}

/**
 * Deletes the planned volumes one after another, each the way `deleteVolume` deletes one. A blocked volume is left alone,
 * and a delete that fails is reported with its reason, so one failure does not stop the rest.
 */
export async function deleteVolumes(
  plans: readonly DeletePlan[],
  opts: { skipTrash: boolean; createdBy: string; record?: RecordNote },
): Promise<DeletedVolume[]> {
  const deleted: DeletedVolume[] = [];
  for (const plan of plans) deleted.push(await deleteOne(plan, opts));
  return deleted;
}

async function deleteOne(
  plan: DeletePlan,
  opts: { skipTrash: boolean; createdBy: string; record?: RecordNote },
): Promise<DeletedVolume> {
  const { volume, host, blocked } = plan;
  const id = volume?.id ?? plan.ref;
  const name = volume?.name ?? plan.ref;
  const hostId = volume?.hostId ?? null;
  if (blocked !== null || volume === null || host === null) {
    const status = blocked === "in_use" || blocked === "forbidden" ? "refused" : "failed";
    return { id, name, hostId, status, trash: null, error: blockOf(plan, blocked ?? "not_found") };
  }
  try {
    const removed = await deleteVolume(host, volume.id, opts);
    return { id, name, hostId, status: "removed", trash: removed.trash, error: null };
  } catch (e) {
    const error = errorOutcome(e);
    return { id, name, hostId, status: error.key === "volume_mounted" ? "refused" : "failed", trash: null, error };
  }
}

function blockOf(plan: DeletePlan, block: DeleteBlock): OutcomeError {
  const name = plan.volume?.name ?? plan.ref;
  const hostName = plan.host?.host.name ?? plan.volume?.hostId ?? "";
  switch (block) {
    case "in_use":
      return messageOutcome(msg("volume_in_use_by_box", { volume: name }));
    case "forbidden":
      return messageOutcome(msg("volume_delete_forbidden", { volume: name }));
    case "not_found":
      return messageOutcome(msg("volume_not_found", { volume: plan.ref }));
    case "offline":
      return messageOutcome(msg("volume_host_offline", { host: hostName }));
    case "unavailable":
      return messageOutcome(msg("volume_host_failed", { host: hostName, detail: plan.detail ?? "" }));
  }
}

export function previewDeleteVolumes(plans: readonly DeletePlan[], skipTrash: boolean): StoragePreview {
  return {
    action: "delete_volumes",
    volumes: plans.map((plan) => ({
      id: plan.volume?.id ?? plan.ref,
      name: plan.volume?.name ?? plan.ref,
      hostId: plan.volume?.hostId ?? null,
      pool: plan.volume?.pool ?? null,
      role: plan.volume?.role ?? null,
      bytes: plan.volume?.bytes ?? null,
      trash: plan.volume !== null && keepsVolume(plan.volume, skipTrash),
      blocked: plan.blocked,
    })),
  };
}

function nextMounts(current: BoxMount[], mount: BoxMount): BoxMount[] {
  const without = current.filter((item) => item.path !== mount.path);
  return [...without, mount].toSorted((a, b) => a.path.localeCompare(b.path));
}

function mountKey(mounts: BoxMount[]): string {
  return mounts
    .map((mount) => `${mount.path}\0${mount.volume}\0${mount.mode}`)
    .toSorted()
    .join("\n");
}

function sameMountList(left: BoxMount[], right: BoxMount[]): boolean {
  return mountKey(left) === mountKey(right);
}

/**
 * Mounts are changed by a rebuild, so the same If-Match and confirm rules apply as for `box.rebuild`. Without
 * `confirm` the call returns the rebuild preview and changes nothing.
 */
export async function attachVolume(
  host: HostCtx,
  ref: string,
  input: { box: string; path: string; mode: MountMode; revision: number; confirm: boolean },
  safety: SafetyHook | null,
  record?: RecordNote,
): Promise<{ box: Box; warning: "shared_rw" | null; safety: RebuildResult["safety"] }> {
  const volume = requireVolume(host, ref);
  if (!validMountPath(input.path)) throw badRequest(msg("mount_path_invalid", { path: input.path }));
  const spec = await readSpec(host, input.box);
  const warning = warnShared(host, volume, input.mode, spec.id);
  const mount: BoxMount = { volume: volume.engineName, path: input.path, mode: input.mode };
  const mounts = nextMounts(spec.mounts, mount);
  const applied = await applyMounts(host, spec.id, input.revision, mounts, input.confirm, spec.mounts, safety, record);
  return { ...applied, warning };
}

export async function detachVolume(
  host: HostCtx,
  ref: string,
  input: { box: string; path: string; revision: number; confirm: boolean },
  safety: SafetyHook | null,
  record?: RecordNote,
): Promise<RebuildResult> {
  const volume = requireVolume(host, ref);
  const spec = await readSpec(host, input.box);
  const mounts = spec.mounts.filter((mount) => !(mount.volume === volume.engineName && mount.path === input.path));
  if (mounts.length === spec.mounts.length) throw notFound(msg("mount_not_found", { path: input.path }));
  return applyMounts(host, spec.id, input.revision, mounts, input.confirm, spec.mounts, safety, record);
}

async function applyMounts(
  host: HostCtx,
  boxId: string,
  revision: number,
  mounts: BoxMount[],
  confirm: boolean,
  current: BoxMount[],
  safety: SafetyHook | null,
  record?: RecordNote,
): Promise<RebuildResult> {
  if (sameMountList(current, mounts)) {
    const spec = await readSpec(host, boxId);
    if (spec.revision !== revision) throw revisionMismatch(spec.revision, revision);
    return { box: await getBox(host, boxId), safety: null };
  }
  return rebuildWithSafety(host, boxId, revision, { mounts }, confirm, record, safety);
}

/** Measures a volume now, the same sample the periodic sampler takes. A failed measurement is thrown after it is recorded. */
export async function measureVolume(host: HostCtx, ref: string): Promise<VolumeView> {
  const volume = requireVolume(host, ref);
  const sample = await sampleWithin(host, volume);
  const next = recordSample(host, volume.id, sample);
  if (!sample.ok) throw sample.error instanceof Error ? sample.error : new Error(sample.message);
  if (!next) throw notFound(msg("volume_not_found", { volume: ref }));
  return viewOf(host, next);
}

/**
 * Sets a volume's usage limits. A field left out keeps its value and null clears one. An NFS volume is refused, since
 * its usage is the whole share's: a quota belongs on the NAS export.
 */
export function setVolumeLimits(host: HostCtx, ref: string, patch: LimitPatch): VolumeView {
  const volume = requireVolume(host, ref);
  const pool = host.volumes.readPools().pools.find((item) => item.name === volume.pool);
  if (pool?.backend === "nfs") throw badRequest(msg("volume_limit_nfs", { volume: volume.name }));
  const next: VolumeRecord = {
    ...volume,
    limits: mergeLimits(volume.limits, patch),
    updatedAt: new Date().toISOString(),
  };
  host.volumes.write(next);
  return viewOf(host, next);
}

export async function getPools(host: HostCtx, opts: { force?: boolean } = {}): Promise<PoolsView> {
  const file = host.volumes.readPools();
  const health = await probePools(host, opts);
  return { pools: file.pools, roles: file.roles, health };
}

/** Validates a pool replacement against the volumes that exist. Nothing is written. */
function planPools(
  host: HostCtx,
  drafts: PoolDraft[],
  roles: RoleDraft | undefined,
): { previous: PoolsFile; file: PoolsFile } {
  const current = host.volumes.list();
  const previous = host.volumes.readPools();
  const file = normalizePools(drafts, roles, current);
  for (const volume of current) {
    const before = previous.pools.find((pool) => pool.name === volume.pool);
    const after = file.pools.find((pool) => pool.name === volume.pool);
    if (before && after && before.backend !== after.backend) failBackend(volume.pool);
  }
  return { previous, file };
}

export async function savePools(host: HostCtx, drafts: PoolDraft[], roles: RoleDraft | undefined): Promise<PoolsView> {
  const { file } = planPools(host, drafts, roles);
  await host.volumes.exclusive(async () => {
    host.volumes.writePools(file);
  });
  log.info("pools.saved", { pools: file.pools.map((pool) => pool.name).join(",") });
  return getPools(host, { force: true });
}

function failBackend(pool: string): never {
  throw conflict(msg("pool_in_use", { pool }));
}

function warnShared(host: HostCtx, volume: VolumeRecord, mode: MountMode, boxId: string): "shared_rw" | null {
  if (mode !== "rw") return null;
  const others = mountsOf(host, volume).filter((mount) => mount.boxId !== boxId && mount.mode === "rw");
  return others.length > 0 ? "shared_rw" : null;
}
