import type { HostCtx } from "../host/registry";
import { conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { RuntimeError } from "../runtime";
import type { BoxMount } from "../specs/types";
import {
  adoptLegacyWorkspace,
  blankRecord,
  chownEngines,
  createEngineVolume,
  defaultRolePlans,
  mountFor,
  type NewVolume,
} from "./engine";
import { poolForRole } from "./pools";
import type { VolumeRecord, VolumeRole } from "./types";

async function materialize(
  host: HostCtx,
  input: NewVolume,
  known: Set<string>,
): Promise<{ record: VolumeRecord; chown: boolean }> {
  const file = host.volumes.readPools();
  const pool = file.pools.find((item) => item.name === input.pool);
  if (!pool) throw notFound(msg("pool_not_found", { pool: input.pool }));
  if (host.volumes.list().some((volume) => volume.name === input.name)) {
    throw conflict(msg("volume_exists", { name: input.name }));
  }
  const now = new Date().toISOString();
  const record = blankRecord(host, input, host.volumes.allocateId(), now);
  await createEngineVolume(host, pool, record, known);
  host.volumes.write(record);
  log.info("volume.created", { id: record.id, name: record.name, pool: record.pool, role: record.role });
  return { record, chown: pool.backend === "local" };
}

/**
 * The four role mounts for a new box. Workspace reuses a leftover `prefix-ws-<name>` volume when one exists.
 * Tools is one independent volume per pool, mounted read-only. Cache stays on the local pool unless a role override says otherwise.
 */
export async function provisionDefaultMounts(
  host: HostCtx,
  box: { id: string; name: string; createdBy: string | null },
  known: Set<string>,
): Promise<BoxMount[]> {
  return host.volumes.exclusive(() => provisionDefaultMountsLocked(host, box, known));
}

async function provisionDefaultMountsLocked(
  host: HostCtx,
  box: { id: string; name: string; createdBy: string | null },
  known: Set<string>,
): Promise<BoxMount[]> {
  const plans = defaultRolePlans(host, box);
  const mounts: BoxMount[] = [];
  const chown: string[] = [];
  for (const plan of plans) {
    if (plan.role === "workspace") {
      const legacy = await adoptLegacyWorkspace(host, box.name, box.id, box.createdBy);
      if (legacy) {
        mounts.push(mountFor("workspace", legacy.engineName));
        continue;
      }
    }
    if (plan.existing) {
      mounts.push(mountFor(plan.role, plan.existing.engineName));
      continue;
    }
    let name = plan.input.name;
    if (host.volumes.list().some((volume) => volume.name === name)) name = `${name}-${plan.input.pool}`;
    const created = await materialize(host, { ...plan.input, name }, known);
    if (created.chown) chown.push(created.record.engineName);
    mounts.push(mountFor(plan.role, created.record.engineName));
  }
  await chownEngines(host, chown, known);
  return mounts;
}

export async function createIndependentVolume(
  host: HostCtx,
  input: { name: string; pool?: string; role: VolumeRole | null; createdBy: string | null },
  known: Set<string>,
): Promise<VolumeRecord> {
  return host.volumes.exclusive(() => createIndependentLocked(host, input, known));
}

async function createIndependentLocked(
  host: HostCtx,
  input: { name: string; pool?: string; role: VolumeRole | null; createdBy: string | null },
  known: Set<string>,
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
