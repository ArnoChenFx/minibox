import type { HostCtx } from "../host/registry";
import { conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { RuntimeError } from "../runtime";
import type { BoxMount } from "../specs/types";
import { VolumeChanges } from "./changes";
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
} from "./engine";
import { poolForRole } from "./pools";
import type { VolumeRecord, VolumeRole } from "./types";

/** Display names are unique per host: each host has its own engine and its own tools volume. */
function nameTaken(host: HostCtx, name: string): boolean {
  return host.volumes.list().some((volume) => volume.hostId === host.host.id && volume.name === name);
}

async function materialize(
  host: HostCtx,
  input: NewVolume,
  known: Set<string>,
  changes: VolumeChanges,
): Promise<{ record: VolumeRecord; chown: boolean }> {
  const file = host.volumes.readPools();
  const pool = file.pools.find((item) => item.name === input.pool);
  if (!pool) throw notFound(msg("pool_not_found", { pool: input.pool }));
  if (nameTaken(host, input.name)) throw conflict(msg("volume_exists", { name: input.name }));
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
 * Without `changes`, a failure removes what this call created before it is thrown.
 */
export async function provisionDefaultMounts(
  host: HostCtx,
  box: { id: string; name: string; createdBy: string | null },
  known: Set<string>,
  changes?: VolumeChanges,
): Promise<BoxMount[]> {
  const own = changes ?? new VolumeChanges();
  try {
    return await host.volumes.exclusive(() => provisionDefaultMountsLocked(host, box, known, own));
  } catch (e) {
    if (!changes) await own.rollback();
    throw e;
  }
}

async function provisionDefaultMountsLocked(
  host: HostCtx,
  box: { id: string; name: string; createdBy: string | null },
  known: Set<string>,
  changes: VolumeChanges,
): Promise<BoxMount[]> {
  const plans = defaultRolePlans(host, box);
  const mounts: BoxMount[] = [];
  const chown: string[] = [];
  for (const plan of plans) {
    if (plan.role === "workspace") {
      const legacy = await adoptLegacyWorkspace(host, box.name, box.id, box.createdBy, changes);
      if (legacy) {
        mounts.push(mountFor("workspace", legacy.engineName));
        continue;
      }
    }
    if (plan.existing) {
      await assertVolumesPresent(host, [plan.existing.engineName]);
      mounts.push(mountFor(plan.role, plan.existing.engineName));
      continue;
    }
    let name = plan.input.name;
    if (nameTaken(host, name)) name = `${name}-${plan.input.pool}`;
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

async function createIndependentLocked(
  host: HostCtx,
  input: { name: string; pool?: string; role: VolumeRole | null; createdBy: string | null },
  known: Set<string>,
  changes: VolumeChanges,
): Promise<VolumeRecord> {
  const file = host.volumes.readPools();
  const pool = input.pool
    ? file.pools.find((item) => item.name === input.pool)
    : input.role
      ? poolForRole(file, input.role)
      : file.pools.find((item) => item.default);
  if (!pool) throw notFound(msg("pool_not_found", { pool: input.pool ?? "default" }));
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
  try {
    await host.runtime.removeVolume(engineName);
    return { status: "removed" };
  } catch (e) {
    if (e instanceof RuntimeError && e.kind === "not_found") return { status: "missing" };
    log.warn("volume.remove_failed", { volume: engineName, error: String(e) });
    return { status: "failed", detail: e instanceof RuntimeError ? e.detail : String(e) };
  }
}
