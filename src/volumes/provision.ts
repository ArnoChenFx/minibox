import type { HostCtx } from "../host/registry";
import { conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { RuntimeError } from "../runtime";
import type { BoxMount } from "../specs/types";
import { reserveVolumeRemoval } from "./activity";
import { VolumeChanges } from "./changes";
import { assertHostDiskRoom } from "./disk";
import {
  adoptLegacyWorkspace,
  assertVolumesPresent,
  blankRecord,
  chownEngines,
  createEngineVolume,
  defaultRolePlans,
  inspectVolumeOrNull,
  mountFor,
  type NewVolume,
  restoreSharedTools,
} from "./engine";
import { poolForRole } from "./pools";
import type { StoragePool, VolumeRecord, VolumeRole } from "./types";

/** Display names are unique per host: each host has its own engine and its own tools volume. */
function nameTaken(host: HostCtx, name: string): boolean {
  return host.volumes.list().some((volume) => volume.hostId === host.host.id && volume.name === name);
}

/** Most numbered names tried for a role volume before a create gives up with `volume_exists`. */
const NAME_ATTEMPTS = 100;

/**
 * A free display name for a box's role volume: `<box>-<role>`, then `<box>-<role>-<pool>`, then numbered. Deleting a box
 * keeps its volumes by default, so recreating a box of the same name several times must not run out of names.
 */
export function freeName(host: HostCtx, base: string, pool: string): string {
  const candidates = [base, `${base}-${pool}`];
  for (let n = 2; n <= NAME_ATTEMPTS; n++) candidates.push(`${base}-${n}`);
  return candidates.find((name) => !nameTaken(host, name)) ?? base;
}

export async function materialize(
  host: HostCtx,
  input: NewVolume,
  known: Set<string>,
  changes: VolumeChanges,
): Promise<{ record: VolumeRecord; chown: boolean }> {
  const file = host.volumes.readPools();
  const pool = file.pools.find((item) => item.name === input.pool);
  if (!pool) throw notFound(msg("pool_not_found", { pool: input.pool }));
  if (nameTaken(host, input.name)) throw conflict(msg("volume_exists", { name: input.name }));
  await assertHostDiskRoom(host);
  const now = new Date().toISOString();
  const record = blankRecord(host, input, host.volumes.allocateId(), now);
  if ((await inspectVolumeOrNull(host, record.engineName)) !== null) {
    throw conflict(msg("volume_engine_exists", { volume: record.engineName }));
  }
  await createEngineVolume(host, pool, record, known, changes);
  changes.add(`volume ${record.engineName}`, () => undoCreated(host, record));
  host.volumes.write(record);
  log.info("volume.created", { id: record.id, name: record.name, pool: record.pool, role: record.role });
  return { record, chown: pool.backend === "local" };
}

/**
 * Removes what `materialize` created. Only called for an engine volume this attempt created, never for one it found.
 * The record stays when the engine refuses, so MiniBox still knows the volume.
 */
async function undoCreated(host: HostCtx, record: VolumeRecord): Promise<void> {
  const outcome = await removeEngine(host, record.engineName);
  if (outcome.status === "failed") throw new Error(outcome.detail);
  host.volumes.remove(record.id);
}

/**
 * The four role mounts for a new box. Workspace reuses a leftover `prefix-ws-<name>` volume when one exists.
 * Tools is one independent volume per pool, mounted read-only. Cache stays on the local pool unless a role override says otherwise.
 * A role in `restored` mounts the volume that already holds its data, so a fork keeps what the checkpoint captured.
 * Without `changes`, a failure removes what this call created before it is thrown.
 */
export async function provisionDefaultMounts(
  host: HostCtx,
  box: { id: string; name: string; createdBy: string | null },
  known: Set<string>,
  changes?: VolumeChanges,
  restored: ReadonlyMap<VolumeRole, VolumeRecord> = new Map(),
): Promise<BoxMount[]> {
  return provisionRoleMounts(host, box, ["workspace", "home", "tools", "cache"], known, changes, restored);
}

/**
 * The mounts for the role volumes a create named, in the order it named them. A role the list omits is not created.
 * `pools` names the storage pool a role's new volume goes to; a role left out of it follows its own rule. A role in
 * `restored` mounts the volume that already holds its data, as a fork does. Without `changes`, a failure removes what
 * this call created before it is thrown.
 */
export async function provisionRoleMounts(
  host: HostCtx,
  box: { id: string; name: string; createdBy: string | null },
  roles: readonly VolumeRole[],
  known: Set<string>,
  changes?: VolumeChanges,
  restored: ReadonlyMap<VolumeRole, VolumeRecord> = new Map(),
  pools: ReadonlyMap<VolumeRole, string> = new Map(),
): Promise<BoxMount[]> {
  const own = changes ?? new VolumeChanges();
  try {
    return await host.volumes.exclusive(() => provisionRoleMountsLocked(host, box, roles, known, own, restored, pools));
  } catch (e) {
    if (!changes) await own.rollback();
    throw e;
  }
}

async function provisionRoleMountsLocked(
  host: HostCtx,
  box: { id: string; name: string; createdBy: string | null },
  roles: readonly VolumeRole[],
  known: Set<string>,
  changes: VolumeChanges,
  restored: ReadonlyMap<VolumeRole, VolumeRecord>,
  pools: ReadonlyMap<VolumeRole, string>,
): Promise<BoxMount[]> {
  const wanted = new Set(roles);
  const plans = defaultRolePlans(host, box, pools).filter((plan) => wanted.has(plan.role));
  const mounts: BoxMount[] = [];
  const chown: string[] = [];
  for (const plan of plans) {
    const kept = restored.get(plan.role);
    if (kept) {
      await assertVolumesPresent(host, [kept.engineName]);
      mounts.push(mountFor(plan.role, kept.engineName));
      continue;
    }
    // A leftover volume sits on whatever pool it was made on, so adopting one would put the workspace somewhere other
    // than the pool this create picked. A create that names no pool for the workspace still adopts it.
    if (plan.role === "workspace" && !pools.has("workspace")) {
      const legacy = await adoptLegacyWorkspace(host, box.name, box.id, box.createdBy, changes);
      if (legacy) {
        mounts.push(mountFor("workspace", legacy.engineName));
        continue;
      }
    }
    if (plan.existing) {
      await restoreSharedTools(host, plan.existing, known);
      await assertVolumesPresent(host, [plan.existing.engineName]);
      mounts.push(mountFor(plan.role, plan.existing.engineName));
      continue;
    }
    const name = freeName(host, plan.input.name, plan.input.pool);
    const created = await materialize(host, { ...plan.input, name }, known, changes);
    if (created.chown) chown.push(created.record.engineName);
    mounts.push(mountFor(plan.role, created.record.engineName));
  }
  await chownEngines(host, chown, known);
  return mounts;
}

/**
 * A standalone volume, as `volume.create` and a rebuild that names a new volume make it. Without `changes`, a failure
 * removes what this call created before it is thrown.
 */
export async function createIndependentVolume(
  host: HostCtx,
  input: { name: string; pool?: string; role: VolumeRole | null; createdBy: string | null },
  known: Set<string>,
  changes?: VolumeChanges,
): Promise<VolumeRecord> {
  const own = changes ?? new VolumeChanges();
  try {
    return await host.volumes.exclusive(() => createIndependentLocked(host, input, known, own));
  } catch (e) {
    if (!changes) await own.rollback();
    throw e;
  }
}

/**
 * An empty volume for data a checkpoint restores into: owned by `owner` when one is given, else independent. Its name
 * is made free the way a box's role volume is. It is not chowned, because the restore writes the owners the snapshot
 * recorded. Without `changes`, a failure removes what this call created before it is thrown.
 */
export async function createRestoredVolume(
  host: HostCtx,
  input: { name: string; role: VolumeRole | null; owner: string | null; createdBy: string | null },
  known: Set<string>,
  changes?: VolumeChanges,
): Promise<VolumeRecord> {
  const own = changes ?? new VolumeChanges();
  try {
    return await host.volumes.exclusive(async () => {
      const pool = resolvePool(host, { role: input.role });
      const created = await materialize(
        host,
        {
          name: freeName(host, input.name, pool.name),
          pool: pool.name,
          role: input.role,
          ownership: input.owner === null ? "independent" : "owned",
          ownerBoxId: input.owner,
          createdBy: input.createdBy,
        },
        known,
        own,
      );
      return created.record;
    });
  } catch (e) {
    if (!changes) await own.rollback();
    throw e;
  }
}

/** The pool a standalone volume goes to: the one named, else the role's pool, else the default. */
function resolvePool(host: HostCtx, input: { pool?: string; role: VolumeRole | null }): StoragePool {
  const file = host.volumes.readPools();
  const pool = input.pool
    ? file.pools.find((item) => item.name === input.pool)
    : input.role
      ? poolForRole(file, input.role)
      : file.pools.find((item) => item.default);
  if (!pool) throw notFound(msg("pool_not_found", { pool: input.pool ?? "default" }));
  return pool;
}

/**
 * What `createIndependentVolume` would create: the pool and the name. It refuses what that call would refuse and writes
 * nothing, so a confirmation can show the change before the engine is touched.
 */
export function planIndependentVolume(
  host: HostCtx,
  input: { name: string; pool?: string; role: VolumeRole | null },
): { name: string; pool: StoragePool } {
  const pool = resolvePool(host, input);
  if (nameTaken(host, input.name)) throw conflict(msg("volume_exists", { name: input.name }));
  return { name: input.name, pool };
}

async function createIndependentLocked(
  host: HostCtx,
  input: { name: string; pool?: string; role: VolumeRole | null; createdBy: string | null },
  known: Set<string>,
  changes: VolumeChanges,
): Promise<VolumeRecord> {
  const pool = resolvePool(host, input);
  const created = await materialize(
    host,
    {
      name: input.name,
      pool: pool.name,
      role: input.role,
      ownership: "independent",
      ownerBoxId: null,
      createdBy: input.createdBy,
    },
    known,
    changes,
  );
  if (created.chown) await chownEngines(host, [created.record.engineName], known);
  return created.record;
}

export type EngineRemoval = { status: "removed" | "missing" } | { status: "failed"; detail: string };

/** Removes an engine volume. `not_found` counts as already gone. A failure is returned with the engine's own message. */
export async function removeEngine(host: HostCtx, engineName: string): Promise<EngineRemoval> {
  const release = reserveVolumeRemoval(host, engineName);
  if (!release) return { status: "failed", detail: msg("volume_busy", { volume: engineName }).text };
  try {
    await host.runtime.removeVolume(engineName);
    return { status: "removed" };
  } catch (e) {
    if (e instanceof RuntimeError && e.kind === "not_found") return { status: "missing" };
    log.warn("volume.remove_failed", { volume: engineName, error: String(e) });
    return { status: "failed", detail: e instanceof RuntimeError ? e.detail : String(e) };
  } finally {
    release();
  }
}
