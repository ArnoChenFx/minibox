import type { HostCtx } from "../host/registry";
import { AppError } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { RuntimeError, type VolumeInfo } from "../runtime";
import { nfsDriverOpts, sameOptions } from "./pools";
import type { VolumeStore } from "./store";
import { DEV_OWNER, type PoolHealth, type StoragePool } from "./types";

const PROBE_TTL_MS = 15_000;
const LOW_FREE_BYTES = 5 * 1024 * 1024 * 1024;
const LOW_FREE_RATIO = 0.1;

export function poolRootVolume(prefix: string, pool: string): string {
  return `${prefix}-pool-${pool}`;
}

function lowSpace(total: number | null, free: number | null): boolean {
  if (total === null || free === null || total <= 0) return false;
  return free < LOW_FREE_BYTES || free / total < LOW_FREE_RATIO;
}

/** The size line of `df -B1 -P`: total, used and available bytes of the filesystem the path is on. */
export function parseDf(logs: string): { totalBytes: number; usedBytes: number; freeBytes: number } | null {
  const line = logs
    .trim()
    .split("\n")
    .map((row) => row.trim())
    .filter((row) => row && !row.startsWith("Filesystem"))
    .at(-1);
  if (!line) return null;
  const parts = line.split(/\s+/);
  const total = Number(parts[1]);
  const used = Number(parts[2]);
  const free = Number(parts[3]);
  if (!Number.isFinite(total) || !Number.isFinite(used) || !Number.isFinite(free)) return null;
  return { totalBytes: total, usedBytes: used, freeBytes: free };
}

type Space = { totalBytes: number | null; usedBytes: number | null; freeBytes: number | null };

function health(
  host: HostCtx,
  pool: StoragePool,
  status: PoolHealth["status"],
  message: string | null,
  space: Space = { totalBytes: null, usedBytes: null, freeBytes: null },
): PoolHealth {
  return {
    pool: pool.name,
    hostId: host.host.id,
    status,
    message,
    checkedAt: new Date().toISOString(),
    totalBytes: space.totalBytes,
    usedBytes: space.usedBytes,
    freeBytes: space.freeBytes,
    lowSpace: lowSpace(space.totalBytes, space.freeBytes),
  };
}

/** The base template, which holds the helper tools, or null when it has not been built yet. */
export async function helperImage(host: HostCtx): Promise<string | null> {
  try {
    await host.runtime.inspectImage(host.baseTemplateTag);
    return host.baseTemplateTag;
  } catch (e) {
    if (e instanceof RuntimeError && e.kind === "not_found") return null;
    throw e;
  }
}

async function ensureDriverVolume(
  host: HostCtx,
  name: string,
  labels: Record<string, string>,
  driverOpts: Record<string, string>,
): Promise<void> {
  let existing: VolumeInfo | null = null;
  try {
    existing = await host.runtime.inspectVolume(name);
  } catch (e) {
    if (!(e instanceof RuntimeError && e.kind === "not_found")) throw e;
  }
  if (existing && !sameOptions(existing.options, driverOpts)) {
    try {
      await host.runtime.removeVolume(name);
    } catch (e) {
      if (!(e instanceof RuntimeError && e.kind === "not_found")) throw e;
    }
    existing = null;
  }
  if (!existing) await host.runtime.createVolume(name, labels, { driver: "local", driverOpts });
}

async function probeLocal(host: HostCtx, pool: StoragePool): Promise<PoolHealth> {
  try {
    const info = await host.runtime.info();
    const disk = await host.runtime.diskUsage(info.rootDir || "/").catch(() => null);
    return health(host, pool, "reachable", null, {
      totalBytes: disk?.totalBytes ?? null,
      usedBytes: disk ? disk.totalBytes - disk.freeBytes : null,
      freeBytes: disk?.freeBytes ?? null,
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return health(host, pool, "unreachable", detail);
  }
}

async function probeRemote(host: HostCtx, pool: StoragePool): Promise<PoolHealth> {
  const image = await helperImage(host);
  if (!image) {
    return health(host, pool, "unknown", `base template image ${host.baseTemplateTag} is missing`);
  }
  try {
    if (pool.backend === "nfs") {
      const keys = host.keys;
      await ensureDriverVolume(
        host,
        poolRootVolume(host.prefix, pool.name),
        { [keys.volume]: "true", [keys.internal]: "true", [keys.pool]: pool.name },
        nfsDriverOpts(pool, null, true),
      );
      const result = await host.runtime.runHelper({
        image,
        user: DEV_OWNER,
        cmd: ["sh", "-c", "df -B1 -P /mnt"],
        mounts: [{ source: poolRootVolume(host.prefix, pool.name), target: "/mnt" }],
        timeoutSec: 20,
        labels: { [keys.internal]: "true" },
      });
      if (result.exitCode !== 0) return health(host, pool, "unreachable", result.logs.trim() || "mount failed");
      const space = parseDf(result.logs);
      return health(host, pool, "reachable", null, {
        totalBytes: space?.totalBytes ?? null,
        usedBytes: space?.usedBytes ?? null,
        freeBytes: space?.freeBytes ?? null,
      });
    }

    const marker = pool.marker ?? ".minibox-mounted";
    const keys = host.keys;
    const result = await host.runtime.runHelper({
      image,
      user: DEV_OWNER,
      cmd: ["sh", "-c", 'test -f "$1" && df -B1 -P /mnt', "minibox", `/mnt/${marker}`],
      mounts: [{ source: pool.root ?? "/", target: "/mnt", kind: "bind", mode: "ro" }],
      timeoutSec: 20,
      labels: { [keys.internal]: "true" },
    });
    if (result.exitCode !== 0) {
      return health(
        host,
        pool,
        "unreachable",
        `mount guard: ${marker} is not present under ${pool.root}. Refusing to write in case the storage is not mounted.`,
      );
    }
    const space = parseDf(result.logs);
    return health(host, pool, "reachable", null, {
      totalBytes: space?.totalBytes ?? null,
      usedBytes: space?.usedBytes ?? null,
      freeBytes: space?.freeBytes ?? null,
    });
  } catch (e) {
    const detail = e instanceof RuntimeError ? e.detail : e instanceof Error ? e.message : String(e);
    log.warn("pool.probe_failed", { pool: pool.name, host: host.host.id, error: detail });
    return health(host, pool, "unreachable", detail);
  }
}

/** A probe that has not answered by then reports the pool unreachable. The probe itself keeps running until it ends. */
const PROBE_DEADLINE_MS = 5_000;

/**
 * Probes still running, per store and pool. A hung mount keeps its helper busy, so a later probe of the same pool
 * joins the one already running instead of starting another.
 */
const running = new WeakMap<VolumeStore, Map<string, Promise<PoolHealth>>>();

function runningProbes(store: VolumeStore): Map<string, Promise<PoolHealth>> {
  const existing = running.get(store);
  if (existing) return existing;
  const probes = new Map<string, Promise<PoolHealth>>();
  running.set(store, probes);
  return probes;
}

function startProbe(host: HostCtx, pool: StoragePool): Promise<PoolHealth> {
  const probes = runningProbes(host.volumes);
  const key = `${host.host.id}\0${pool.name}`;
  const existing = probes.get(key);
  if (existing) return existing;
  const probe = (pool.backend === "local" ? probeLocal(host, pool) : probeRemote(host, pool))
    .then((next) => {
      host.volumes.rememberHealth(next);
      return next;
    })
    .finally(() => probes.delete(key));
  probes.set(key, probe);
  return probe;
}

async function probeWithin(host: HostCtx, pool: StoragePool, deadlineMs: number): Promise<PoolHealth> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<PoolHealth>((resolve) => {
    timer = setTimeout(() => {
      const timedOut = health(host, pool, "unreachable", `no answer within ${deadlineMs / 1000} s`);
      host.volumes.rememberHealth(timedOut);
      resolve(timedOut);
    }, deadlineMs);
  });
  try {
    return await Promise.race([startProbe(host, pool), late]);
  } finally {
    clearTimeout(timer);
  }
}

interface ProbeOptions {
  force?: boolean;
  /** Tests shorten the deadline. Production uses the default. */
  deadlineMs?: number;
}

/** Cached for a few seconds. A forced probe is what the pools page asks for when the operator hits refresh. */
export async function probePool(host: HostCtx, pool: StoragePool, opts: ProbeOptions = {}): Promise<PoolHealth> {
  const cached = host.volumes.healthOf(host.host.id, pool.name);
  const fresh = cached?.checkedAt && Date.now() - Date.parse(cached.checkedAt) < PROBE_TTL_MS;
  if (!opts.force && cached && fresh) return cached;
  return probeWithin(host, pool, opts.deadlineMs ?? PROBE_DEADLINE_MS);
}

/** Every pool is probed at once, so one dead server cannot delay the others. */
export async function probePools(host: HostCtx, opts: ProbeOptions = {}): Promise<PoolHealth[]> {
  const file = host.volumes.readPools();
  return Promise.all(file.pools.map((pool) => probePool(host, pool, opts)));
}

/**
 * Refuses to start a box whose pool we cannot prove is mounted. A `hard` NFS mount would otherwise block
 * the container, and `docker stop`, until the server comes back.
 */
export async function assertPoolsReachable(host: HostCtx, poolNames: Iterable<string>): Promise<void> {
  const file = host.volumes.readPools();
  for (const name of new Set(poolNames)) {
    const pool = file.pools.find((item) => item.name === name) ?? file.pools.find((item) => item.backend === "local");
    if (!pool) {
      throw new AppError(503, "docker_unavailable", msg("storage_unreachable", { pool: name, detail: "unknown pool" }));
    }
    const result = await probePool(host, pool);
    if (pool.backend !== "local" && result.status !== "reachable") {
      throw new AppError(
        503,
        "docker_unavailable",
        msg("storage_unreachable", { pool: pool.name, detail: result.message ?? result.status }),
      );
    }
    if (pool.backend === "local" && result.status === "unreachable") {
      throw new AppError(
        503,
        "docker_unavailable",
        msg("storage_unreachable", { pool: pool.name, detail: result.message ?? "engine unreachable" }),
      );
    }
  }
}
