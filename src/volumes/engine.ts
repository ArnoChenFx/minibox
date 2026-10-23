import { randomBytes } from "node:crypto";

import type { HostCtx } from "../host/registry";
import { volumeName } from "../labels";
import { AppError, badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { type Msg, msg } from "../lib/messages";
import { isRuntimeError, RuntimeError, type VolumeInfo, type VolumeOwner } from "../runtime";
import { ensureBaseImage } from "../services/base-template";
import type { BoxSpec } from "../specs/types";
import { VolumeChanges } from "./changes";
import { assertPoolsReachable, poolRootVolume } from "./health";
import { nfsDriverOpts, pathDriverOpts, poolForRole } from "./pools";
import type { StoragePool, VolumeOwnership, VolumeRecord, VolumeRole } from "./types";
import { DEV_OWNER, LOCAL_POOL, ROLE_MOUNT, UNLIMITED } from "./types";

export interface NewVolume {
  name: string;
  pool: string;
  role: VolumeRole | null;
  ownership: VolumeOwnership;
  ownerBoxId: string | null;
  createdBy: string | null;
}

export function labelsFor(
  host: HostCtx,
  volume: Pick<VolumeRecord, "name" | "role" | "pool" | "ownership">,
): Record<string, string> {
  const keys = host.keys;
  const labels: Record<string, string> = {
    [keys.volume]: "true",
    [keys.box]: "true",
    [keys.name]: volume.name,
    [keys.pool]: volume.pool,
    [`${host.prefix}.ownership`]: volume.ownership,
  };
  if (volume.role) labels[keys.role] = volume.role;
  return labels;
}

/** Makes sure the base template is on the host, building it on first need. `known` saves the check within one call. */
async function requireHelper(host: HostCtx, known: Set<string>): Promise<void> {
  if (known.has(host.baseTemplateTag)) return;
  known.add(await ensureBaseImage(host));
}

/** The owner a new volume's root takes on an agent host, where no helper container runs to chown it recursively. */
const AGENT_VOLUME_OWNER = { uid: 1000, gid: 1000 };

/**
 * Hands a new local volume to uid 1000. NFS and path pools chown inside the directory helper instead:
 * a squashed root cannot chown, and the mkdir helper already tried.
 */
export async function chownEngines(host: HostCtx, engines: string[], known: Set<string>): Promise<void> {
  if (engines.length === 0) return;
  try {
    await requireHelper(host, known);
  } catch (e) {
    // An agent host that lacks the image, or a build that failed: the volume still works, owned by root.
    log.warn("volume.chown_skipped", { image: host.baseTemplateTag, count: engines.length, error: String(e) });
    return;
  }
  if (host.host.transport === "agent") {
    for (const engine of engines) {
      await host.runtime.setVolumeRootOwner(engine, AGENT_VOLUME_OWNER, host.baseTemplateTag);
    }
    return;
  }
  const mounts = engines.map((source, index) => ({ source, target: `/mnt/${index}` }));
  const args = engines.map((_, index) => `/mnt/${index}`);
  const result = await host.runtime.runHelper({
    image: host.baseTemplateTag,
    user: "0:0",
    capAdd: ["CHOWN"],
    // $1 is the owner; shift drops it so "$@" is only the mount points.
    cmd: ["sh", "-c", 'owner=$1; shift; chown -R "$owner" -- "$@"', "minibox", DEV_OWNER, ...args],
    mounts,
    timeoutSec: 120,
    labels: { [host.keys.internal]: "true" },
  });
  if (result.exitCode !== 0) {
    const detail = result.logs.trim().slice(0, 400) || String(result.exitCode);
    throw badRequest(msg("volume_chown_failed", { detail }));
  }
}

/** Permission errors from the storage server while a volume directory is prepared. A squashed root is the usual cause. */
const PERMISSION_DENIED = /permission denied|operation not permitted/i;

/** The storage server refused the box. A retry changes nothing until the export or the path changes. */
function storageRefusal(message: Msg): AppError {
  return new AppError(502, "bad_gateway", message, undefined, { hint: msg("storage_squash_hint"), retryable: false });
}

async function prepareSubdir(host: HostCtx, pool: StoragePool, subpath: string, known: Set<string>): Promise<void> {
  await requireHelper(host, known);
  const source = pool.backend === "nfs" ? poolRootVolume(host.prefix, pool.name) : (pool.root ?? "/");
  const kind = pool.backend === "path" ? "bind" : "volume";
  const script = [
    'if ! mkdir -p -- "$1"; then exit 1; fi',
    'if ! chown -R "$2" -- "$1"; then echo MINIBOX_CHOWN_SKIPPED; fi',
  ].join("\n");
  const result = await host.runtime.runHelper({
    image: host.baseTemplateTag,
    user: "0:0",
    capAdd: ["CHOWN", "DAC_OVERRIDE"],
    cmd: ["sh", "-c", script, "minibox", `/mnt/${subpath}`, DEV_OWNER],
    mounts: [{ source, target: "/mnt", kind, mode: "rw" }],
    timeoutSec: 120,
    labels: { [host.keys.internal]: "true" },
  });
  if (result.exitCode !== 0) {
    const detail = result.logs.trim().slice(0, 400) || String(result.exitCode);
    if (PERMISSION_DENIED.test(result.logs)) {
      throw storageRefusal(msg("storage_permission_denied", { pool: pool.name, detail }));
    }
    throw badRequest(msg("volume_prepare_failed", { detail }));
  }
  if (result.logs.includes("MINIBOX_CHOWN_SKIPPED")) {
    log.warn("volume.chown_skipped", { pool: pool.name, subpath, reason: "chown failed, often root_squash" });
  }
}

/** Creates and removes a file in the directory `$1`. It runs as the box user, so it fails where the box would. */
export const WRITE_CHECK = 'touch -- "$1/.minibox-write-check" && rm -f -- "$1/.minibox-write-check"';

/** The directory of one volume as an operator finds it on the NAS or the host. */
function storagePath(pool: StoragePool, subpath: string): string {
  return pool.backend === "nfs" ? `${pool.server}:${pool.export}/${subpath}` : `${pool.root ?? "/"}/${subpath}`;
}

/**
 * Proves the box user can write the directory `prepareSubdir` just made. A squashed root cannot chown, so the
 * directory can stay with the squashed user, and the box would start with a volume it cannot write.
 */
async function assertWritable(host: HostCtx, pool: StoragePool, subpath: string): Promise<void> {
  const source = pool.backend === "nfs" ? poolRootVolume(host.prefix, pool.name) : (pool.root ?? "/");
  const kind = pool.backend === "path" ? "bind" : "volume";
  const result = await host.runtime.runHelper({
    image: host.baseTemplateTag,
    user: DEV_OWNER,
    cmd: ["sh", "-c", WRITE_CHECK, "minibox", `/mnt/${subpath}`],
    mounts: [{ source, target: "/mnt", kind, mode: "rw" }],
    timeoutSec: 120,
    labels: { [host.keys.internal]: "true" },
  });
  if (result.exitCode === 0) return;
  const detail = result.logs.trim().slice(0, 400) || String(result.exitCode);
  throw storageRefusal(msg("storage_unwritable", { path: storagePath(pool, subpath), detail }));
}

/** The engine's volume of this name, or null. Other errors are the caller's to handle. */
export async function inspectVolumeOrNull(host: HostCtx, name: string): Promise<VolumeInfo | null> {
  try {
    return await host.runtime.inspectVolume(name);
  } catch (e) {
    if (e instanceof RuntimeError && e.kind === "not_found") return null;
    throw e;
  }
}

/**
 * Refuses an engine volume that no longer exists. Docker creates a missing named volume when a container is created or
 * started and when a helper runs, so a check here is the only thing that keeps a lost volume from coming back empty.
 */
export async function assertVolumesPresent(host: HostCtx, engineNames: Iterable<string>): Promise<void> {
  for (const engineName of new Set(engineNames)) {
    if ((await inspectVolumeOrNull(host, engineName)) !== null) continue;
    const record = host.volumes.findByEngine(host.host.id, engineName);
    throw conflict(msg("volume_missing", { volume: record?.name ?? engineName }));
  }
}

/**
 * Records the removal of each NFS pool root that does not exist yet. The reachability probe creates a missing root, so
 * this runs before the probe, and a failed create then removes the root it caused.
 */
export async function trackPoolRoots(
  host: HostCtx,
  poolNames: Iterable<string>,
  changes: VolumeChanges,
): Promise<void> {
  const file = host.volumes.readPools();
  for (const name of new Set(poolNames)) {
    const pool = file.pools.find((item) => item.name === name);
    if (pool?.backend !== "nfs") continue;
    const root = poolRootVolume(host.prefix, pool.name);
    if ((await inspectVolumeOrNull(host, root)) === null) {
      changes.add(`pool root ${root}`, () => removeEngineVolume(host, root));
    }
  }
}

/**
 * Creates the engine volume for a record. Local volumes still need `chownEngines`; nfs and path are prepared here.
 * Every step that creates something registers its undo in `changes`, so a later failure removes it again.
 */
export async function createEngineVolume(
  host: HostCtx,
  pool: StoragePool,
  volume: VolumeRecord,
  known: Set<string>,
  changes: VolumeChanges,
): Promise<void> {
  await trackPoolRoots(host, [pool.name], changes);
  await assertPoolsReachable(host, [pool.name]);
  const labels = labelsFor(host, volume);
  if (pool.backend === "local") {
    await host.runtime.createVolume(volume.engineName, labels);
    return;
  }
  const subpath = volume.subpath;
  if (!subpath) throw badRequest(msg("volume_prepare_failed", { detail: "missing subpath" }));
  if (pool.backend === "nfs") {
    const keys = host.keys;
    await host.runtime.createVolume(
      poolRootVolume(host.prefix, pool.name),
      { [keys.volume]: "true", [keys.internal]: "true", [keys.pool]: pool.name },
      { driver: "local", driverOpts: nfsDriverOpts(pool, null, true) },
    );
  }
  await prepareSubdir(host, pool, subpath, known);
  changes.add(`directory ${subpath}`, () => removeEmptyDirectory(host, pool, subpath));
  await assertWritable(host, pool, subpath);
  const driverOpts = pool.backend === "nfs" ? nfsDriverOpts(pool, subpath, false) : pathDriverOpts(pool, subpath);
  await host.runtime.createVolume(volume.engineName, labels, { driver: "local", driverOpts });
}

/** Removes an engine volume that MiniBox just created. A volume that is already gone counts as removed. */
async function removeEngineVolume(host: HostCtx, name: string): Promise<void> {
  try {
    await host.runtime.removeVolume(name);
  } catch (e) {
    if (!(e instanceof RuntimeError && e.kind === "not_found")) throw e;
  }
}

/** `rmdir` only: a directory that still holds anything is kept, so this never deletes data. */
async function removeEmptyDirectory(host: HostCtx, pool: StoragePool, subpath: string): Promise<void> {
  const source = pool.backend === "nfs" ? poolRootVolume(host.prefix, pool.name) : (pool.root ?? "/");
  const kind = pool.backend === "path" ? "bind" : "volume";
  const result = await host.runtime.runHelper({
    image: host.baseTemplateTag,
    user: "0:0",
    capAdd: ["DAC_OVERRIDE"],
    cmd: ["sh", "-c", 'rmdir -- "$1"', "minibox", `/mnt/${subpath}`],
    mounts: [{ source, target: "/mnt", kind, mode: "rw" }],
    timeoutSec: 120,
    labels: { [host.keys.internal]: "true" },
  });
  if (result.exitCode !== 0) throw new Error(`rmdir ${subpath}: ${result.logs.trim() || result.exitCode}`);
}

export function blankRecord(host: HostCtx, input: NewVolume, id: string, now: string): VolumeRecord {
  const file = host.volumes.readPools();
  const pool = file.pools.find((item) => item.name === input.pool);
  if (!pool) throw badRequest(msg("pool_not_found", { pool: input.pool }));
  const remote = pool.backend !== "local";
  return {
    version: 1,
    id,
    name: input.name,
    hostId: host.host.id,
    pool: pool.name,
    role: input.role,
    ownership: input.ownership,
    ownerBoxId: input.ownership === "owned" ? input.ownerBoxId : null,
    sensitive: input.role === "home",
    checkpoint: input.role !== "cache",
    engineName: id,
    subpath: remote ? id : null,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
    bytes: null,
    bytesAt: null,
    limits: { ...UNLIMITED },
    lastMount: null,
  };
}

/**
 * An existing `prefix-ws-*` volume becomes a Volume record. Docker cannot add a label after creation,
 * so recognition is the record plus the name; volumes MiniBox creates carry `prefix.volume=true`.
 */
export function claimInfo(host: HostCtx, info: VolumeInfo, specs: BoxSpec[], now: string): VolumeRecord | null {
  if (info.labels[host.keys.internal] === "true") return null;
  const legacy = new RegExp(`^${host.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-ws-.+$`).test(info.name);
  const labeled = info.labels[host.keys.box] === "true" || info.labels[host.keys.volume] === "true";
  if (!legacy && !labeled) return null;
  if (host.volumes.findByEngineName(info.name)) return null;

  const users = specs.filter(
    (spec) => spec.hostId === host.host.id && spec.mounts.some((mount) => mount.volume === info.name),
  );
  const roleLabel = info.labels[host.keys.role];
  const role =
    roleLabel === "workspace" || roleLabel === "home" || roleLabel === "tools" || roleLabel === "cache"
      ? roleLabel
      : legacy
        ? "workspace"
        : null;
  const owned = users.length === 1 && (role === "workspace" || role === "home" || role === "cache");
  const poolName = info.labels[host.keys.pool];
  const pools = host.volumes.readPools();
  const pool = poolName && pools.pools.some((item) => item.name === poolName) ? poolName : LOCAL_POOL;
  const id = host.volumes.allocateId();
  return {
    version: 1,
    id,
    name: info.name,
    hostId: host.host.id,
    pool,
    role,
    ownership: owned ? "owned" : "independent",
    ownerBoxId: owned ? (users[0]?.id ?? null) : null,
    sensitive: role === "home",
    checkpoint: role !== "cache",
    engineName: info.name,
    subpath: null,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
    bytes: null,
    bytesAt: null,
    limits: { ...UNLIMITED },
    lastMount: null,
  };
}

/** Records one engine volume that has no record yet. Null when `claimInfo` does not recognise it. */
export async function claimOne(host: HostCtx, info: VolumeInfo): Promise<VolumeRecord | null> {
  return host.volumes.exclusive(async () => {
    const known = host.volumes.findByEngine(host.host.id, info.name);
    if (known) return known;
    const record = claimInfo(host, info, host.specs.list(), new Date().toISOString());
    if (record) host.volumes.write(record);
    return record;
  });
}

export async function claimEngineVolumes(host: HostCtx): Promise<number> {
  return claimListed(host, await host.runtime.listVolumes());
}

/** Records the listed engine volumes that MiniBox recognises and has no record for. Returns how many it recorded. */
export async function claimListed(host: HostCtx, listed: VolumeInfo[]): Promise<number> {
  const specs = host.specs.list();
  const now = new Date().toISOString();
  let claimed = 0;
  await host.volumes.exclusive(async () => {
    for (const info of listed) {
      const record = claimInfo(host, info, specs, now);
      if (!record) continue;
      host.volumes.write(record);
      claimed += 1;
    }
  });
  return claimed;
}

/** True when a live box other than `boxId` mounts the engine volume, whatever its ownership. */
export function mountedByAnotherBox(host: HostCtx, boxId: string | null, engineName: string): boolean {
  return host.specs
    .list()
    .some(
      (spec) => spec.hostId === host.host.id && spec.id !== boxId && spec.mounts.some((m) => m.volume === engineName),
    );
}

/** True when the engine volume is owned by a live box other than `boxId`. An owner that no longer exists owns nothing. */
export function ownedByAnotherBox(host: HostCtx, boxId: string | null, engineName: string): boolean {
  const record = host.volumes.findByEngine(host.host.id, engineName);
  if (!record || record.ownership !== "owned" || record.ownerBoxId === null || record.ownerBoxId === boxId)
    return false;
  return host.specs.read(record.ownerBoxId) !== null;
}

/**
 * Notes on each volume record a box has stopped mounting, so a volume left without a box shows where it was last used.
 * The unmount has already happened when this runs, so a write that fails is logged rather than thrown.
 */
export function noteUnmounted(
  host: HostCtx,
  box: { boxId: string; name: string },
  engineNames: Iterable<string>,
): void {
  const now = new Date().toISOString();
  for (const engineName of new Set(engineNames)) {
    const record = host.volumes.findByEngine(host.host.id, engineName);
    if (!record) continue;
    try {
      host.volumes.write({ ...record, lastMount: { at: now, boxId: box.boxId, boxName: box.name }, updatedAt: now });
    } catch (e) {
      log.warn("volume.last_mount_failed", { volume: record.name, error: String(e) });
    }
  }
}

/**
 * Uses a leftover `prefix-ws-<box>` volume as the workspace instead of creating a second one. MiniBox must have
 * created it (the box label), and no other live box may mount or own it. `changes` puts the previous record back,
 * or drops the new one, when the create that adopted the volume fails.
 */
export async function adoptLegacyWorkspace(
  host: HostCtx,
  boxName: string,
  boxId: string,
  createdBy: string | null,
  changes: VolumeChanges,
): Promise<VolumeRecord | null> {
  const engineName = volumeName(host.prefix, boxName);
  const existing = host.volumes.findByEngine(host.host.id, engineName);
  let info: VolumeInfo;
  try {
    info = await host.runtime.inspectVolume(engineName);
  } catch (e) {
    if (!(e instanceof RuntimeError && e.kind === "not_found")) throw e;
    if (existing) throw conflict(msg("volume_missing", { volume: existing.name }));
    return null;
  }
  if (info.labels[host.keys.box] !== "true") throw forbidden(msg("volume_unmanaged", { volume: engineName }));
  if (mountedByAnotherBox(host, boxId, engineName) || ownedByAnotherBox(host, boxId, engineName)) {
    throw forbidden(msg("volume_in_use", { volume: engineName }));
  }
  const now = new Date().toISOString();
  if (existing) {
    if (existing.ownership === "owned" && existing.ownerBoxId === boxId) return existing;
    const adopted: VolumeRecord = {
      ...existing,
      ownership: "owned",
      ownerBoxId: boxId,
      role: existing.role ?? "workspace",
      updatedAt: now,
    };
    host.volumes.write(adopted);
    changes.add(`restore record ${existing.name}`, async () => host.volumes.write(existing));
    return adopted;
  }
  const claimed = claimInfo(host, info, host.specs.list(), now);
  if (!claimed) return null;
  const record: VolumeRecord = {
    ...claimed,
    ownership: "owned",
    ownerBoxId: boxId,
    role: "workspace",
    createdBy,
    sensitive: false,
    checkpoint: true,
  };
  host.volumes.write(record);
  changes.add(`unrecord ${record.name}`, async () => host.volumes.remove(record.id));
  return record;
}

/**
 * The leftover `prefix-ws-<name>` volume a new box of this name adopts as its workspace, with its record when it has
 * one. Null when the engine has no such volume. Nothing is written.
 */
export async function leftoverWorkspace(
  host: HostCtx,
  boxName: string,
): Promise<{ engineName: string; record: VolumeRecord | null } | null> {
  const engineName = volumeName(host.prefix, boxName);
  if ((await inspectVolumeOrNull(host, engineName)) === null) return null;
  return { engineName, record: host.volumes.findByEngine(host.host.id, engineName) };
}

/** True for a host's shared tools record: an independent `tools` volume, one for each pool. */
export function isSharedTools(host: HostCtx, volume: VolumeRecord): boolean {
  return volume.role === "tools" && volume.ownership === "independent" && volume.hostId === host.host.id;
}

/** The independent tools volume for one pool on this host, if one already exists. */
export function findSharedTools(host: HostCtx, poolName: string): VolumeRecord | null {
  return host.volumes.list().find((volume) => isSharedTools(host, volume) && volume.pool === poolName) ?? null;
}

/**
 * Recreates the engine volume of a shared tools record that the engine no longer has. The record and its engine name stay,
 * so the boxes that mount the volume find it again. On a local pool the volume comes back empty, so the tools installed
 * in it are gone until a box installs them again. An NFS or path volume reuses its directory, so its tools remain.
 * Nothing is undone afterwards, because the record still puts the volume on this host, and removing the volume again
 * would only restore the state this repairs. The caller holds the volume lock, or uses `healSharedTools`.
 * Returns false when the engine already has the volume.
 */
export async function restoreSharedTools(host: HostCtx, volume: VolumeRecord, known: Set<string>): Promise<boolean> {
  // Only the shared tools volume holds no user data. Workspace, home and cache volumes are never recreated.
  if (!isSharedTools(host, volume)) return false;
  if ((await inspectVolumeOrNull(host, volume.engineName)) !== null) return false;
  const pool = host.volumes.readPools().pools.find((item) => item.name === volume.pool);
  if (!pool) throw notFound(msg("pool_not_found", { pool: volume.pool }));
  await createEngineVolume(host, pool, volume, known, new VolumeChanges());
  if (pool.backend === "local") await chownEngines(host, [volume.engineName], known);
  log.warn("volume.tools_recreated", { host: host.host.id, volume: volume.name, engine: volume.engineName });
  host.activity.add({
    action: "volume.recreate",
    target: volume.name,
    ok: true,
    message: msg("volume_tools_recreated", { volume: volume.name }).text,
  });
  return true;
}

/** Recreates a shared tools volume the engine lost, under the volume lock. Returns false when nothing was missing. */
export async function healSharedTools(host: HostCtx, volume: VolumeRecord, known: Set<string>): Promise<boolean> {
  return host.volumes.exclusive(async () => {
    const current = host.volumes.read(volume.id);
    if (!current || !isSharedTools(host, current)) return false;
    return restoreSharedTools(host, current, known);
  });
}

/** Recreates each shared tools volume among the engine volumes named that the engine lost. Other volumes are left to the caller. */
export async function healSharedToolsMounts(
  host: HostCtx,
  engineNames: Iterable<string>,
  known: Set<string>,
): Promise<void> {
  for (const engineName of new Set(engineNames)) {
    const record = host.volumes.findByEngine(host.host.id, engineName);
    if (record && isSharedTools(host, record)) await healSharedTools(host, record, known);
  }
}

/**
 * Recreates every shared tools volume of this host that the engine lost, at startup and when a remote host comes back.
 * A volume that cannot be recreated is logged and skipped, so one broken pool does not hold back the others. Returns the
 * engine names it recreated.
 */
export async function healAllSharedTools(host: HostCtx): Promise<string[]> {
  const recreated: string[] = [];
  for (const volume of host.volumes.list().filter((item) => isSharedTools(host, item))) {
    try {
      if (await healSharedTools(host, volume, new Set())) recreated.push(volume.engineName);
    } catch (e) {
      log.error("volume.tools_recreate_failed", { host: host.host.id, volume: volume.name, error: String(e) });
    }
  }
  return recreated;
}

export function defaultRolePlans(
  host: HostCtx,
  box: { id: string; name: string; createdBy: string | null },
): { role: VolumeRole; input: NewVolume; existing: VolumeRecord | null }[] {
  const file = host.volumes.readPools();
  const roles: VolumeRole[] = ["workspace", "home", "tools", "cache"];
  return roles.map((role) => {
    const pool = poolForRole(file, role);
    const shared = role === "tools";
    const existing = shared ? findSharedTools(host, pool.name) : null;
    return {
      role,
      existing,
      input: {
        name: shared ? `${host.prefix}-tools-${host.host.id}` : `${box.name}-${role}`,
        pool: pool.name,
        role,
        ownership: shared ? "independent" : "owned",
        ownerBoxId: shared ? null : box.id,
        createdBy: box.createdBy,
      },
    };
  });
}

export function poolsUsed(host: HostCtx, mounts: { volume: string }[]): string[] {
  const names = mounts.map((mount) => host.volumes.findByEngine(host.host.id, mount.volume)?.pool ?? LOCAL_POOL);
  return [...new Set(names)];
}

export function mountFor(role: VolumeRole, engineName: string): { volume: string; path: string; mode: "rw" | "ro" } {
  const point = ROLE_MOUNT[role];
  return { volume: engineName, path: point.path, mode: point.mode };
}

const HELPER_PATH = "/mnt";

/**
 * The owner of a volume's root, read through a helper that mounts it. A volume that no box mounts has no container of
 * its own to read it from, so a checkpoint of one needs this.
 */
export async function rootOwnerOf(host: HostCtx, engineName: string): Promise<VolumeOwner> {
  const image = await ensureBaseImage(host);
  const created = await host.runtime.createContainer({
    image,
    name: `${host.prefix}-owner-${randomBytes(4).toString("hex")}`,
    cmd: ["true"],
    mounts: [{ source: engineName, target: HELPER_PATH, mode: "ro", noCopy: true }],
    network: "none",
    labels: { [host.keys.internal]: "true" },
    readonlyRootfs: true,
    tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=16m" },
    hardening: { capDrop: ["ALL"], noNewPrivileges: true, pidsLimit: 64 },
  });
  try {
    return await host.runtime.volumeRootOwner(created.id, HELPER_PATH);
  } finally {
    try {
      await host.runtime.removeContainer(created.id, { force: true });
    } catch (e) {
      if (!isRuntimeError(e, "not_found")) log.warn("volume.owner_helper_remove_failed", { error: String(e) });
    }
  }
}
