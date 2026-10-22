import type { HostCtx } from "../host/registry";
import { badRequest, conflict } from "../lib/errors";
import { msg } from "../lib/messages";
import type { BoxMount } from "../specs/types";
import { type LimitAction, UNLIMITED, type UsageLevel, type VolumeLimits, type VolumeRecord } from "./types";

const MB = 1024 * 1024;

/** A byte count in MiB to one decimal, so a 2.5 MB limit is not reported as 2 MB. */
export function mebibytes(bytes: number): number {
  return Math.round((bytes / MB) * 10) / 10;
}

export interface LimitPatch {
  softBytes?: number | null;
  hardBytes?: number | null;
  action?: LimitAction;
}

/** Limits as stored. A record written before limits existed has none, so it reads as unlimited. */
export function normalizeLimits(value: unknown): VolumeLimits {
  if (typeof value !== "object" || value === null) return { ...UNLIMITED };
  const raw = value as Partial<VolumeLimits>;
  return {
    softBytes: positiveBytes(raw.softBytes),
    hardBytes: positiveBytes(raw.hardBytes),
    action: raw.action === "stop" ? "stop" : "warn",
  };
}

function positiveBytes(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** The level a figure is at. A volume that has never been sampled is unknown, and a figure with no limit set is ok. */
export function usageLevel(bytes: number | null, limits: VolumeLimits): UsageLevel {
  if (bytes === null) return "unknown";
  if (limits.hardBytes !== null && bytes >= limits.hardBytes) return "hard";
  if (limits.softBytes !== null && bytes >= limits.softBytes) return "soft";
  return "ok";
}

/** The limits a partial update leaves a volume with. A field left out keeps its value; null clears a limit. */
export function mergeLimits(current: VolumeLimits, patch: LimitPatch): VolumeLimits {
  const next: VolumeLimits = {
    softBytes: patch.softBytes === undefined ? current.softBytes : patch.softBytes,
    hardBytes: patch.hardBytes === undefined ? current.hardBytes : patch.hardBytes,
    action: patch.action ?? current.action,
  };
  if (next.softBytes !== null && next.hardBytes !== null && next.softBytes > next.hardBytes) {
    throw badRequest(msg("volume_limit_order"));
  }
  return next;
}

/** A volume whose action is `stop` and whose last sample is at or over its hard limit. Boxes that mount it stay stopped. */
export function overHardStop(volume: VolumeRecord): boolean {
  return volume.limits.action === "stop" && usageLevel(volume.bytes, volume.limits) === "hard";
}

/**
 * Refuses a start, restart, create or rebuild that would run a box with a volume over its hard stop limit. It reads the
 * last sample and does not measure again, so the check is quick; the hint tells the operator how to clear it.
 */
export function assertMountsWithinLimits(host: HostCtx, mounts: readonly BoxMount[]): void {
  for (const mount of mounts) {
    const volume = host.volumes.findByEngine(host.host.id, mount.volume);
    if (!volume || !overHardStop(volume)) continue;
    throw conflict(
      msg("volume_over_limit", {
        volume: volume.name,
        used: mebibytes(volume.bytes ?? 0),
        limit: mebibytes(volume.limits.hardBytes ?? 0),
      }),
      { hint: msg("volume_over_limit_hint") },
    );
  }
}
