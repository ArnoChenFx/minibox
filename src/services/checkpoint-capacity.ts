import { type CapacityState, capacityStateOf } from "../checkpoints/policy";
import type { HostCtx } from "../host/registry";
import { conflict } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";

const MB = 1024 * 1024;

export interface CheckpointUsage {
  bytes: number;
  /** The limit in bytes, or null when none is set. */
  limitBytes: number | null;
  state: CapacityState;
  policy: { keepLast: number; keepDays: number };
}

/** The repository's stored size against its limit, with the policy that decides what it keeps. */
export async function usageOf(host: HostCtx): Promise<CheckpointUsage> {
  const { bytes } = await host.checkpointEngine.usage(host);
  const { capacityBytes, keepLast, keepDays } = host.checkpointPolicy;
  return {
    bytes,
    limitBytes: capacityBytes === 0 ? null : capacityBytes,
    state: capacityStateOf(bytes, capacityBytes),
    policy: { keepLast, keepDays },
  };
}

/**
 * Refuses an automatic checkpoint while the repository is at its limit. A rollback takes one before it replaces any
 * volume, so a full repository stops the rollback rather than replacing data with no copy of it. When usage cannot be
 * measured the checkpoint is allowed: an unreachable engine fails the safety checkpoint itself, before any volume changes.
 */
export async function assertAutomaticAllowed(host: HostCtx): Promise<void> {
  const { capacityBytes } = host.checkpointPolicy;
  if (capacityBytes === 0) return;
  let usage: CheckpointUsage;
  try {
    usage = await usageOf(host);
  } catch (e) {
    log.warn("checkpoint.capacity_unmeasured", { host: host.host.id, error: String(e) });
    return;
  }
  if (usage.state !== "exceeded") return;
  throw conflict(
    msg("checkpoint_capacity_exceeded", {
      used: Math.round(usage.bytes / MB),
      limit: Math.round(capacityBytes / MB),
    }),
  );
}
