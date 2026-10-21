import type { Config } from "../config";
import type { HostCtx, HostRegistry } from "../host/registry";
import { log } from "../lib/logger";
import { OWNER } from "../operations/types";
import type { BoxSpec } from "../specs/types";
import type { TaskManager } from "../tasks/manager";

export type { StopReason } from "../specs/types";
import type { ActivityPulse } from "./activity-pulse";
import { stopBox } from "./boxes";
import type { ExecManager } from "./exec";
import type { RecordNote, TerminalService } from "./terminals";

export interface LifecycleOptions {
  readonly hosts: HostRegistry;
  readonly pulse: ActivityPulse;
  readonly terminals: TerminalService;
  readonly execs: ExecManager;
  readonly tasks: TaskManager;
  readonly cfg: Config;
  readonly record: RecordNote;
  /** Override the tick interval in tests. */
  readonly everyMs?: number;
  /** Clock for tests. */
  readonly now?: () => number;
}

export interface LifecycleReport {
  readonly slept: string[];
  readonly expired: string[];
  readonly failed: { id: string; error: string }[];
}

/**
 * Idle auto-sleep and TTL expiry (#12). Sleep sets desired state to `stopped` with reason idle/ttl and runs
 * `docker stop`; the container is kept. Wake is on-demand via start/exec/session.
 */
export class LifecycleWatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private readonly everyMs: number;
  private readonly now: () => number;

  constructor(private readonly options: LifecycleOptions) {
    this.everyMs = options.everyMs ?? options.cfg.lifecycleIntervalMs;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass over every host. Safe to call from tests without starting the timer. */
  async tick(): Promise<LifecycleReport> {
    if (this.busy) return { slept: [], expired: [], failed: [] };
    this.busy = true;
    const report: LifecycleReport = { slept: [], expired: [], failed: [] };
    try {
      for (const host of this.options.hosts.list()) {
        await this.pass(host, report);
      }
    } finally {
      this.busy = false;
    }
    return report;
  }

  private async pass(host: HostCtx, report: LifecycleReport): Promise<void> {
    for (const spec of host.specs.list()) {
      if (spec.hostId !== host.host.id) continue;
      try {
        if (await this.expireTtl(host, spec, report)) continue;
        await this.maybeSleep(host, spec, report);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        report.failed.push({ id: spec.id, error });
        log.error("box.lifecycle_failed", { host: host.host.id, id: spec.id, error });
      }
    }
  }

  /** Stops a box whose absolute TTL has elapsed. Prefers stop over delete (overnight decision for #12). */
  private async expireTtl(host: HostCtx, spec: BoxSpec, report: LifecycleReport): Promise<boolean> {
    const ttl = spec.lifecycle.ttlSec;
    if (ttl === null || ttl <= 0) return false;
    const created = Date.parse(spec.createdAt);
    if (!Number.isFinite(created)) return false;
    if (this.now() - created < ttl * 1000) return false;
    if (spec.lifecycle.desired === "stopped" && spec.lifecycle.stopReason === "ttl") return true;
    await this.sleep(host, spec, "ttl");
    report.expired.push(spec.id);
    return true;
  }

  private async maybeSleep(host: HostCtx, spec: BoxSpec, report: LifecycleReport): Promise<void> {
    if (spec.lifecycle.desired !== "running") return;
    const idleSec = effectiveIdleSec(spec, this.options.cfg);
    if (idleSec === null) return;

    const info = await host.runtime.inspectContainer(spec.containerId).catch(() => null);
    if (!info?.running) return;

    if (this.options.terminals.hasOpenAttachment(spec.containerId)) return;
    if (this.options.execs.hasBackground(spec.containerId)) return;
    if (this.options.tasks.hasRunningForBox(spec.id, spec.containerId)) return;

    const last = this.options.pulse.lastAt(spec.id) ?? Date.parse(spec.createdAt);
    if (!Number.isFinite(last) || this.now() - last < idleSec * 1000) return;

    await host.sampler.sampleSoon();
    const cpu = host.sampler.statsOf(spec.id)?.cpuPercent;
    if (cpu == null) return;
    if (cpu >= this.options.cfg.boxIdleCpuPercent) return;

    await this.sleep(host, spec, "idle");
    report.slept.push(spec.id);
  }

  private async sleep(host: HostCtx, spec: BoxSpec, reason: "idle" | "ttl"): Promise<void> {
    await stopBox(host, spec.id, reason);
    this.options.record(host.host.id, "system", OWNER, {
      op: reason === "ttl" ? "box.ttl_expire" : "box.sleep",
      kind: "write",
      status: "ok",
      summary: reason === "ttl" ? `Box TTL expired: ${spec.name}` : `Box slept (idle): ${spec.name}`,
      target: { kind: "box", id: spec.containerId, name: spec.name },
      detail: { boxId: spec.id, reason },
    });
    log.info(reason === "ttl" ? "box.ttl_expired" : "box.slept", {
      id: spec.id,
      name: spec.name,
      host: host.host.id,
    });
  }
}

/** Per-box `0` disables sleep. `null` inherits the global default. Global `0` means off. */
export function effectiveIdleSec(spec: BoxSpec, cfg: Config): number | null {
  const per = spec.lifecycle.idleTimeoutSec;
  if (per === 0) return null;
  if (per !== null) return per;
  return cfg.boxIdleTimeoutSec > 0 ? cfg.boxIdleTimeoutSec : null;
}
