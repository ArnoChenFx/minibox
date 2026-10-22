import { expiredAutomatic } from "../checkpoints/policy";
import type { HostCtx, HostRegistry } from "../host/registry";
import { log } from "../lib/logger";
import { usageOf } from "./checkpoint-capacity";
import { deleteCheckpoint, heldCheckpointIds } from "./checkpoints";

const SWEEP_EVERY_MS = 60 * 60 * 1000;

/**
 * Removes the automatic checkpoints the host's policy no longer keeps, and returns their ids. One that cannot be removed
 * is logged and left for the next pass, so one failure does not stop the others.
 */
export async function applyRetention(host: HostCtx, now = Date.now()): Promise<string[]> {
  const records = host.checkpoints.list().filter((record) => record.hostId === host.host.id);
  const expired = expiredAutomatic(records, host.checkpointPolicy, now, heldCheckpointIds(host));
  const removed: string[] = [];
  for (const record of expired) {
    if (host.checkpoints.exporting.has(record.id)) continue;
    try {
      await deleteCheckpoint(host, record.id);
      removed.push(record.id);
    } catch (e) {
      log.error("checkpoint.retention_failed", { id: record.id, error: String(e) });
    }
  }
  return removed;
}

/** Warns when a host's repository has reached the warning share of its limit. Hosts with no limit are not measured. */
async function warnIfNearLimit(host: HostCtx): Promise<void> {
  if (host.checkpointPolicy.capacityBytes === 0) return;
  const usage = await usageOf(host);
  if (usage.state === "warning" || usage.state === "exceeded") {
    log.warn("checkpoint.capacity_warning", {
      host: host.host.id,
      state: usage.state,
      bytes: usage.bytes,
      limitBytes: usage.limitBytes,
    });
  }
}

/** Removes expired packages. Hosts share one package store, so it is swept once. */
function sweepPackages(hosts: readonly HostCtx[], now: number): void {
  for (const store of new Set(hosts.map((host) => host.checkpoints.packages))) {
    try {
      const removed = store.sweep(now);
      if (removed.length > 0) log.info("checkpoint.packages_swept", { removed: removed.length });
    } catch (e) {
      log.error("checkpoint.package_sweep_failed", { error: String(e) });
    }
  }
}

/** Applies every host's retention policy now and then on a timer, and reports repositories that near their limit. */
export class CheckpointSweep {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly hosts: HostRegistry,
    private readonly everyMs = SWEEP_EVERY_MS,
  ) {}

  /** Returns how many checkpoints the pass removed. A host that cannot be swept is logged and skipped. */
  async run(now = Date.now()): Promise<number> {
    let removed = 0;
    for (const host of this.hosts.list()) {
      try {
        removed += (await applyRetention(host, now)).length;
        await warnIfNearLimit(host);
      } catch (e) {
        log.error("checkpoint.sweep_failed", { host: host.host.id, error: String(e) });
      }
    }
    sweepPackages(this.hosts.list(), now);
    return removed;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const removed = await this.run();
      if (removed > 0) log.info("checkpoint.retention_applied", { removed });
    } finally {
      this.running = false;
    }
  }
}
