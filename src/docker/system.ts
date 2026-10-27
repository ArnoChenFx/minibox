import { statfsSync } from "node:fs";

import { type DiskBreakdown, type DiskBreakdownEntry, type DiskUsage, RuntimeError, type Runtime } from "../runtime";
import { call, type Engine, withSignal } from "./engine";

type SystemMethods = Pick<Runtime, "ping" | "info" | "diskUsage" | "diskBreakdown">;

/**
 * `docker.df()` takes an options object that dockerode's typings do not describe, as the other calls' `withSignal`
 * shows. The signal never reaches the query string: docker-modem reads it from the options alone.
 */
function df(docker: Engine["docker"], signal: AbortSignal | undefined): Promise<unknown> {
  const request = docker.df as unknown as (opts: { abortSignal?: AbortSignal }) => Promise<unknown>;
  return request.call(docker, withSignal({}, signal));
}

/** A finite, non-negative integer, or null when the engine did not report the field. */
function amount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function fieldsOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * One class from an engine that answers API 1.52 and later: `ImageUsage`, `ContainerUsage`, `VolumeUsage` and
 * `BuildCacheUsage`, each with its own `TotalCount`, `ActiveCount`, `TotalSize` and `Reclaimable`.
 */
function totalsOf(value: unknown): DiskBreakdownEntry | null {
  const fields = fieldsOf(value);
  if (!fields) return null;
  return {
    count: amount(fields.TotalCount),
    activeCount: amount(fields.ActiveCount),
    totalBytes: amount(fields.TotalSize),
    reclaimableBytes: amount(fields.Reclaimable),
  };
}

/** How one entry of a class an older engine reports as a plain array is read. */
interface LegacyFields {
  /** Bytes the entry takes, or null when the engine did not measure it (it reports -1). */
  size(item: Record<string, unknown>): number | null;
  /** Whether removing the entry would free its bytes. */
  unused(item: Record<string, unknown>): boolean;
  /** Whether a container, volume or image still uses the entry. */
  active(item: Record<string, unknown>): boolean;
}

/**
 * One class from an engine older than API 1.52, which lists what it holds and gives no totals: the sizes are summed,
 * `unused` decides which of them a removal would free, and an entry the engine never measured is left out of both
 * sums rather than counted as nothing.
 */
function sumOf(value: unknown, how: LegacyFields): DiskBreakdownEntry | null {
  if (!Array.isArray(value)) return null;
  let totalBytes = 0;
  let reclaimableBytes = 0;
  let activeCount = 0;
  for (const item of value) {
    const fields = fieldsOf(item);
    if (!fields) continue;
    const size = how.size(fields);
    if (size !== null) {
      totalBytes += size;
      if (how.unused(fields)) reclaimableBytes += size;
    }
    if (how.active(fields)) activeCount += 1;
  }
  return { count: value.length, activeCount, totalBytes, reclaimableBytes };
}

/** The states an engine counts a container as active in, as `docker system df` counts them. */
const ACTIVE_CONTAINER_STATES = ["running", "paused", "restarting"];

const CONTAINERS: LegacyFields = {
  size: (item) => amount(item.SizeRw),
  unused: (item) => !ACTIVE_CONTAINER_STATES.includes(String(item.State ?? "")),
  active: (item) => ACTIVE_CONTAINER_STATES.includes(String(item.State ?? "")),
};

/** Legacy image sizes overlap. Docker CLI uses LayersSize and subtracts the unique bytes of images in use. */
function imageTotals(value: unknown, layersSize: unknown): DiskBreakdownEntry | null {
  if (!Array.isArray(value)) return null;
  const totalBytes = amount(layersSize);
  let activeCount = 0;
  let usedBytes = 0;
  for (const item of value) {
    const fields = fieldsOf(item);
    if (!fields || (amount(fields.Containers) ?? 0) === 0) continue;
    activeCount += 1;
    const size = amount(fields.Size) ?? amount(fields.VirtualSize);
    const shared = amount(fields.SharedSize);
    if (size !== null && shared !== null) usedBytes += Math.max(0, size - shared);
  }
  return {
    count: value.length,
    activeCount,
    totalBytes,
    reclaimableBytes: totalBytes === null ? null : Math.max(0, totalBytes - usedBytes),
  };
}

const VOLUMES: LegacyFields = {
  // A volume's size is in its usage data, and is -1 when the engine never measured it.
  size: (item) => amount(fieldsOf(item.UsageData)?.Size),
  unused: (item) => (amount(fieldsOf(item.UsageData)?.RefCount) ?? 0) === 0,
  active: (item) => (amount(fieldsOf(item.UsageData)?.RefCount) ?? 0) > 0,
};

const BUILD_CACHE: LegacyFields = {
  // An older engine's summary counts only the cache no build shares, as `docker system df` does.
  size: (item) => (item.Shared === true ? 0 : amount(item.Size)),
  unused: (item) => item.InUse !== true && item.Shared !== true,
  active: (item) => item.InUse === true,
};

/**
 * `/system/df` as `docker system df` reads it. An engine of API 1.52 or later reports each class with its own totals
 * (`ImageUsage` and the rest). An older one reports plain arrays: image totals use `LayersSize`, which counts shared
 * layers once, and the other classes are summed here. A class or figure the engine does not report is null, so an
 * engine that answers less yields less instead of an error.
 */
export function toDiskBreakdown(raw: unknown): DiskBreakdown {
  const body = fieldsOf(raw) ?? {};
  const entry = (totals: string, items: string, how: LegacyFields) => totalsOf(body[totals]) ?? sumOf(body[items], how);
  return {
    images: totalsOf(body.ImageUsage) ?? imageTotals(body.Images, body.LayersSize),
    containers: entry("ContainerUsage", "Containers", CONTAINERS),
    volumes: entry("VolumeUsage", "Volumes", VOLUMES),
    buildCache: entry("BuildCacheUsage", "BuildCache", BUILD_CACHE),
  };
}

export function systemMethods(engine: Engine): SystemMethods {
  const { docker } = engine;

  return {
    async ping() {
      await call(() => docker.ping());
    },

    async info() {
      const [info, version] = await call(() =>
        Promise.all([docker.info() as Promise<Record<string, unknown>>, docker.version()]),
      );
      return {
        version: version.Version ?? null,
        rootDir: (info.DockerRootDir as string) ?? null,
        containers: { running: Number(info.ContainersRunning ?? 0), total: Number(info.Containers ?? 0) },
        images: Number(info.Images ?? 0),
        cpus: typeof info.NCPU === "number" ? info.NCPU : null,
        memoryBytes: typeof info.MemTotal === "number" ? info.MemTotal : null,
      };
    },

    async diskUsage(path): Promise<DiskUsage> {
      try {
        const stat = statfsSync(path);
        return { totalBytes: stat.blocks * stat.bsize, freeBytes: stat.bavail * stat.bsize };
      } catch (e) {
        const code = typeof e === "object" && e !== null && "code" in e ? String(e.code) : "";
        if (code === "ENOENT") throw new RuntimeError("not_found", `path not found: ${path}`);
        throw new RuntimeError("engine", e instanceof Error ? e.message : String(e));
      }
    },

    async diskBreakdown(opts): Promise<DiskBreakdown> {
      const raw = await call(() => df(docker, opts?.signal));
      return toDiskBreakdown(raw);
    },
  };
}
