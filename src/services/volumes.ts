import type { TrashKind, TrashRef } from "../checkpoints/types";
import type { HostCtx } from "../host/registry";
import { AppError, badRequest, conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { type MessageKey, msg } from "../lib/messages";
import { revisionMismatch } from "../specs/revision";
import type { BoxMount, MountMode } from "../specs/types";
import { claimListed } from "../volumes/engine";
import { probePools } from "../volumes/health";
import { type LimitPatch, mergeLimits, usageLevel } from "../volumes/limits";
import { validMountPath } from "../volumes/mounts";
import { normalizePools, type PoolDraft, type RoleDraft } from "../volumes/pools";
import { createIndependentVolume, planIndependentVolume } from "../volumes/provision";
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
import { keepsVolume } from "./trash";
import type { RecordNote } from "./volume-owner";
import { errorOutcome, hostOffline, messageOutcome, type OutcomeError, volumesInUse } from "./volume-refs";
import { protectedReason, removeGuarded } from "./volume-remove";

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
  /** The engine no longer has this volume, so no box can mount it. Only a shared tools volume is recreated on its own. */
  engineMissing: boolean;
  /** The box that owned this volume was deleted and kept it. Deleting the volume frees its space once no box mounts it. */
  ownerMissing: boolean;
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

/** An owned volume whose owner box is gone. Deleting a box keeps its volumes unless the caller asks for them to go. */
function ownerGone(host: HostCtx, volume: VolumeRecord): boolean {
  return volume.ownership === "owned" && volume.ownerBoxId !== null && host.specs.read(volume.ownerBoxId) === null;
}

/** Records the engine volumes MiniBox does not know yet, and returns the engine names as they are now. */
async function claimedEngines(host: HostCtx): Promise<Set<string>> {
  const listed = await host.runtime.listVolumes();
  await claimListed(host, listed);
  return new Set(listed.map((info) => info.name));
}

function viewOf(host: HostCtx, volume: VolumeRecord, engineMissing: boolean): VolumeView {
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
    engineMissing,
    ownerMissing: ownerGone(host, volume),
  };
}

export async function listVolumes(host: HostCtx): Promise<VolumeView[]> {
  const engines = await claimedEngines(host);
  return host.volumes
    .list()
    .filter((volume) => volume.hostId === host.host.id)
    .map((volume) => viewOf(host, volume, !engines.has(volume.engineName)))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

export async function getVolume(host: HostCtx, ref: string): Promise<VolumeView> {
  const engines = await claimedEngines(host);
  const volume = requireVolume(host, ref);
  return viewOf(host, volume, !engines.has(volume.engineName));
}

export async function createVolume(
  host: HostCtx,
  input: { name: string; pool?: string; role: VolumeRole | null; createdBy: string | null },
): Promise<VolumeView> {
  const record = await createIndependentVolume(host, input, new Set());
  return viewOf(host, record, false);
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
      action: "empty_trash";
      /** How many entries the empty would purge. */
      count: number;
      /** The size of the data those entries keep. */
      bytes: number;
      entries: {
        id: string;
        hostId: string;
        kind: TrashKind;
        sourceName: string;
        bytes: number;
        /** Why the entry stays, or null when it will be purged. */
        blocked: "exporting" | "busy" | "offline" | null;
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

/** Throws the refusal or failure a single delete received, with the key and params a translated client shows. */
function raiseOutcome(error: OutcomeError): never {
  throw new AppError(409, "conflict", {
    key: (error.key ?? "unknown_error") as MessageKey,
    params: error.params ?? {},
    text: error.message,
  });
}

/**
 * Deletes one volume the way a batch delete deletes each of its volumes: the same checks, the same recycle bin copy and
 * the same second look under the spec lock. The shared tools volume is refused, and so is a volume a box spec mounts, a
 * container in any state mounts, or a pending rollback keeps. Under the spec lock, where no create or rebuild can be
 * part way through mounting it, the volume is checked again: it must still have the record it had, not be the tools
 * volume or a system volume, and nothing may have begun to use it. Its data is first kept in the recycle bin, unless
 * `skipTrash` is set or its role keeps nothing; a refusal purges that copy, so it leaves no entry behind.
 */
export async function deleteVolume(
  host: HostCtx,
  ref: string,
  opts: { skipTrash?: boolean; createdBy?: string | null; record?: RecordNote } = {},
): Promise<{ name: string; trash: TrashRef | null }> {
  const volume = requireVolume(host, ref);
  const outcome = await removeGuarded(host, volume, {
    skipTrash: opts.skipTrash ?? false,
    principal: opts.createdBy ?? null,
    record: opts.record,
  });
  if (outcome.status !== "removed") raiseOutcome(outcome.error);
  log.info("volume.deleted", { id: volume.id, name: volume.name, trash: outcome.trash !== null });
  return { name: volume.name, trash: outcome.trash };
}

/** Why a batch delete does not remove a volume. `in_use`, `forbidden` and `tools` are refusals; the rest are failures. */
export type DeleteBlock = "in_use" | "forbidden" | "tools" | "not_found" | "offline" | "unavailable";

const REFUSED_BLOCKS: ReadonlySet<DeleteBlock> = new Set(["in_use", "forbidden", "tools"]);

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
  if (protectedReason(host, volume)) return { ref, volume, host: null, blocked: "tools", detail: null };
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
    const status = blocked !== null && REFUSED_BLOCKS.has(blocked) ? "refused" : "failed";
    return { id, name, hostId, status, trash: null, error: blockOf(plan, blocked ?? "not_found") };
  }
  const outcome = await removeGuarded(host, volume, {
    skipTrash: opts.skipTrash,
    principal: opts.createdBy,
    record: opts.record,
  });
  if (outcome.status === "removed") {
    log.info("volume.deleted", { id: volume.id, name: volume.name, trash: outcome.trash !== null });
    return { id, name, hostId, status: "removed", trash: outcome.trash, error: null };
  }
  return { id, name, hostId, status: outcome.status, trash: null, error: outcome.error };
}

function blockOf(plan: DeletePlan, block: DeleteBlock): OutcomeError {
  const name = plan.volume?.name ?? plan.ref;
  const hostName = plan.host?.host.name ?? plan.volume?.hostId ?? "";
  switch (block) {
    case "in_use":
      return messageOutcome(msg("volume_in_use_by_box", { volume: name }));
    case "forbidden":
      return messageOutcome(msg("volume_delete_forbidden", { volume: name }));
    case "tools":
      return messageOutcome(msg("volume_shared_tools", { volume: name }));
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
  return viewOf(host, next, false);
}

/**
 * Sets a volume's usage limits. A field left out keeps its value and null clears one. An NFS volume is refused, since
 * its usage is the whole share's: a quota belongs on the NAS export.
 */
export function setVolumeLimits(host: HostCtx, ref: string, patch: LimitPatch): void {
  const volume = requireVolume(host, ref);
  const pool = host.volumes.readPools().pools.find((item) => item.name === volume.pool);
  if (pool?.backend === "nfs") throw badRequest(msg("volume_limit_nfs", { volume: volume.name }));
  const next: VolumeRecord = {
    ...volume,
    limits: mergeLimits(volume.limits, patch),
    updatedAt: new Date().toISOString(),
  };
  host.volumes.write(next);
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
