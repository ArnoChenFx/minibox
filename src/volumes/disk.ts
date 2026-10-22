import type { HostCtx } from "../host/registry";
import { AppError } from "../lib/errors";
import { msg } from "../lib/messages";
import { within } from "../lib/within";
import { helperImage, parseDf } from "./health";
import { DEV_OWNER, type HostDisk } from "./types";

/** A reading this old is measured again before a create or a checkpoint trusts it. */
export const HOST_DISK_MAX_AGE_MS = 30_000;
/** A measurement that has not answered by then counts as unknown, which lets the create or checkpoint go ahead. */
export const MEASURE_DEADLINE_MS = 15_000;

export function freePercent(disk: HostDisk): number {
  return disk.totalBytes > 0 ? (disk.freeBytes / disk.totalBytes) * 100 : 100;
}

/**
 * The disk the engine's data lives on. The local engine is read in process, which is right when MiniBox runs on the
 * machine itself. Anywhere else, and where that read fails, a helper reports the filesystem of the engine's root
 * directory, because that is where the engine's host has the disk.
 */
async function measureHostDisk(host: HostCtx): Promise<HostDisk | null> {
  const info = await host.runtime.info();
  const rootDir = info.rootDir || "/";
  if (host.host.transport === "local") {
    try {
      const disk = await host.runtime.diskUsage(rootDir);
      return { totalBytes: disk.totalBytes, freeBytes: disk.freeBytes, at: Date.now() };
    } catch {
      // Not visible from this process, such as MiniBox in a container without the engine's root: ask the engine's host.
    }
  }
  const image = await helperImage(host);
  if (!image) return null;
  const result = await host.runtime.runHelper({
    image,
    user: DEV_OWNER,
    cmd: ["sh", "-c", "df -B1 -P /mnt"],
    mounts: [{ source: rootDir, target: "/mnt", kind: "bind", mode: "ro" }],
    timeoutSec: 20,
    labels: { [host.keys.internal]: "true" },
  });
  if (result.exitCode !== 0) return null;
  const space = parseDf(result.logs);
  return space ? { totalBytes: space.totalBytes, freeBytes: space.freeBytes, at: Date.now() } : null;
}

/** Measures the host disk now and keeps the reading. Null when it cannot be measured in time. */
export async function remeasureHostDisk(host: HostCtx): Promise<HostDisk | null> {
  const disk = await within(
    measureHostDisk(host).catch(() => null),
    MEASURE_DEADLINE_MS,
    () => null,
  );
  if (disk) host.volumes.rememberDisk(host.host.id, disk);
  return disk;
}

/** The last reading if it is recent, else a fresh one. Null when the disk cannot be measured. */
export async function currentHostDisk(host: HostCtx): Promise<HostDisk | null> {
  const cached = host.volumes.diskOf(host.host.id);
  if (cached && Date.now() - cached.at < HOST_DISK_MAX_AGE_MS) return cached;
  return remeasureHostDisk(host);
}

/**
 * Refuses a new volume or checkpoint while the host's disk is below its minimum free share. An unmeasured disk is
 * allowed through, the same way the checkpoint repository's capacity check allows an unmeasured repository.
 */
export async function assertHostDiskRoom(host: HostCtx): Promise<void> {
  const minFree = host.diskPolicy.minFreePercent;
  if (minFree <= 0) return;
  const disk = await currentHostDisk(host);
  if (!disk) return;
  const free = freePercent(disk);
  if (free >= minFree) return;
  throw new AppError(
    507,
    "insufficient_storage",
    msg("host_disk_low", { free: Math.floor(free), min: minFree }),
    undefined,
    { hint: msg("host_disk_low_hint") },
  );
}
