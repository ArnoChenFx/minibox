import type { HostCtx } from "../host/registry";
import { badRequest, conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { RuntimeError } from "../runtime";
import { revisionMismatch } from "../specs/revision";
import type { BoxMount, MountMode } from "../specs/types";
import { assertVolumesPresent, claimEngineVolumes } from "../volumes/engine";
import { probePools } from "../volumes/health";
import { validMountPath } from "../volumes/mounts";
import { normalizePools, type PoolDraft, type RoleDraft } from "../volumes/pools";
import { createIndependentVolume, removeEngine } from "../volumes/provision";
import type { PoolHealth, PoolsFile, VolumeRecord, VolumeRole } from "../volumes/types";
import { type Box, getBox, readSpec } from "./boxes";
import { rebuildBox } from "./rebuild";

export interface VolumeMountView {
  boxId: string;
  boxName: string;
  path: string;
  mode: MountMode;
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

function viewOf(host: HostCtx, volume: VolumeRecord): VolumeView {
  const mounts = mountsOf(host, volume);
  const pool = host.volumes.readPools().pools.find((item) => item.name === volume.pool);
  return {
    id: volume.id,
    name: volume.name,
    hostId: volume.hostId,
    pool: volume.pool,
    backend: pool?.backend ?? "local",
    role: volume.role,
    ownership: volume.ownership,
    ownerBoxId: volume.ownerBoxId,
    sensitive: volume.sensitive,
    checkpoint: volume.checkpoint,
    engineName: volume.engineName,
    bytes: volume.bytes,
    bytesAt: volume.bytesAt,
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

export async function deleteVolume(host: HostCtx, ref: string): Promise<{ name: string }> {
  const volume = requireVolume(host, ref);
  const mounts = mountsOf(host, volume);
  const user = mounts[0];
  if (user) throw conflict(msg("volume_mounted", { name: volume.name, box: user.boxName }));
  const result = await removeEngine(host, volume.engineName);
  if (result.status === "failed") {
    throw conflict(msg("volume_delete_failed", { name: volume.name, detail: result.detail }));
  }
  host.volumes.remove(volume.id);
  log.info("volume.deleted", { id: volume.id, name: volume.name });
  return { name: volume.name };
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
): Promise<{ box: Box; warning: "shared_rw" | null }> {
  const volume = requireVolume(host, ref);
  if (!validMountPath(input.path)) throw badRequest(msg("mount_path_invalid", { path: input.path }));
  const spec = await readSpec(host, input.box);
  const warning = warnShared(host, volume, input.mode, spec.id);
  const mount: BoxMount = { volume: volume.engineName, path: input.path, mode: input.mode };
  const mounts = nextMounts(spec.mounts, mount);
  return { box: await applyMounts(host, spec.id, input.revision, mounts, input.confirm, spec.mounts), warning };
}

export async function detachVolume(
  host: HostCtx,
  ref: string,
  input: { box: string; path: string; revision: number; confirm: boolean },
): Promise<{ box: Box }> {
  const volume = requireVolume(host, ref);
  const spec = await readSpec(host, input.box);
  const mounts = spec.mounts.filter((mount) => !(mount.volume === volume.engineName && mount.path === input.path));
  if (mounts.length === spec.mounts.length) throw notFound(msg("mount_not_found", { path: input.path }));
  return { box: await applyMounts(host, spec.id, input.revision, mounts, input.confirm, spec.mounts) };
}

async function applyMounts(
  host: HostCtx,
  boxId: string,
  revision: number,
  mounts: BoxMount[],
  confirm: boolean,
  current: BoxMount[],
): Promise<Box> {
  if (sameMountList(current, mounts)) {
    const spec = await readSpec(host, boxId);
    if (spec.revision !== revision) throw revisionMismatch(spec.revision, revision);
    return getBox(host, boxId);
  }
  return rebuildBox(host, boxId, revision, { mounts }, confirm);
}

export async function measureVolume(host: HostCtx, ref: string): Promise<VolumeView> {
  const volume = requireVolume(host, ref);
  await assertVolumesPresent(host, [volume.engineName]);
  let image: string;
  try {
    await host.runtime.inspectImage(host.baseTemplateTag);
    image = host.baseTemplateTag;
  } catch (e) {
    if (e instanceof RuntimeError && e.kind === "not_found") {
      throw badRequest(msg("helper_image_missing", { image: host.baseTemplateTag }));
    }
    throw e;
  }
  const result = await host.runtime.runHelper({
    image,
    user: "0:0",
    capAdd: ["DAC_READ_SEARCH"],
    cmd: ["du", "-sb", "/mnt"],
    mounts: [{ source: volume.engineName, target: "/mnt" }],
    timeoutSec: 120,
    labels: { [host.keys.internal]: "true" },
  });
  if (result.exitCode !== 0) {
    throw badRequest(
      msg("volume_prepare_failed", { detail: result.logs.trim().slice(0, 400) || String(result.exitCode) }),
    );
  }
  const bytes = Number(result.logs.trim().split(/\s+/)[0]);
  const now = new Date().toISOString();
  const next: VolumeRecord = {
    ...volume,
    bytes: Number.isFinite(bytes) ? bytes : null,
    bytesAt: now,
    updatedAt: now,
  };
  host.volumes.write(next);
  return viewOf(host, next);
}

export async function getPools(host: HostCtx, opts: { force?: boolean } = {}): Promise<PoolsView> {
  const file = host.volumes.readPools();
  const health = await probePools(host, opts);
  return { pools: file.pools, roles: file.roles, health };
}

export async function savePools(host: HostCtx, drafts: PoolDraft[], roles: RoleDraft | undefined): Promise<PoolsView> {
  const current = host.volumes.list();
  const previous = host.volumes.readPools();
  const file = normalizePools(drafts, roles, current);
  for (const volume of current) {
    const before = previous.pools.find((pool) => pool.name === volume.pool);
    const after = file.pools.find((pool) => pool.name === volume.pool);
    if (before && after && before.backend !== after.backend) failBackend(volume.pool);
  }
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
