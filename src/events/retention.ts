import { log } from "../lib/logger";
import type { OutputStore } from "./outputs";
import type { EventStore } from "./store";

const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

export interface RetentionPolicy {
  readonly auditDays: number;
  readonly activityDays: number;
  readonly outputDays: number;
  readonly outputMaxBytes: number;
}

export interface PruneResult {
  readonly events: number;
  readonly outputs: number;
}

/**
 * Applies the retention policy now, and then on a timer. Each run is one `DELETE` per tier, which the `(tier, ts)` index
 * serves.
 */
export class RetentionJob {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly events: EventStore,
    private readonly outputs: OutputStore,
    private readonly policy: RetentionPolicy,
    private readonly everyMs = PRUNE_EVERY_MS,
  ) {}

  run(now = Date.now()): PruneResult {
    return {
      events: this.events.prune(now, {
        auditMs: this.policy.auditDays * DAY_MS,
        activityMs: this.policy.activityDays * DAY_MS,
      }),
      outputs: this.outputs.prune(now, this.policy.outputDays * DAY_MS, this.policy.outputMaxBytes),
    };
  }

  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private tick(): void {
    try {
      const pruned = this.run();
      if (pruned.events > 0 || pruned.outputs > 0) log.info("retention.pruned", { ...pruned });
    } catch (e) {
      log.error("retention.failed", { error: String(e) });
    }
  }
}
