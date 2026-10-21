import type { Config } from "../config";
import type { HostCtx, HostRegistry } from "../host/registry";
import { log } from "../lib/logger";
import { OWNER } from "../operations/types";
import { ttlExpired } from "../specs/lifetime";
import type { BoxSpec } from "../specs/types";
import type { TaskManager } from "../tasks/manager";

export type { StopReason } from "../specs/types";
import type { ActivityPulse } from "./activity-pulse";
import { type Box, sleepBox } from "./boxes";
import type { ExecManager } from "./exec";
import type { RecordNote, TerminalService } from "./terminals";

/** The SSH gateway's open connections. An open one keeps its box awake, as an attached terminal does. */
export interface SshConnections {
  hasOpenConnection(boxId: string): boolean;
}

export interface LifecycleOptions {
  readonly hosts: HostRegistry;
  readonly pulse: ActivityPulse;
  readonly terminals: TerminalService;
  readonly execs: ExecManager;
  readonly tasks: TaskManager;
  readonly cfg: Config;
  readonly record: RecordNote;
  readonly ssh?: SshConnections;
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
 * `docker stop`; the container is kept. Wake happens on demand, see `wakeIfSleeping` and `ensureRunning`.
 */
export class LifecycleWatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private readonly everyMs: number;
  private readonly now: () => number;
  /**
   * When this process started watching. A box with no heartbeat counts idle from here, not from its creation, so a
   * restart does not put every box to sleep at the first pass.
   */
  private readonly watchedSince: number;

  constructor(private readonly options: LifecycleOptions) {
    this.everyMs = options.everyMs ?? options.cfg.lifecycleIntervalMs;
    this.now = options.now ?? Date.now;
    this.watchedSince = this.now();
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

  /** Stops a box whose absolute TTL has elapsed. It stops rather than deletes, so the container and its volumes remain. */
  private async expireTtl(host: HostCtx, spec: BoxSpec, report: LifecycleReport): Promise<boolean> {
    if (!ttlExpired(spec, this.now())) return false;
    if (spec.lifecycle.desired === "stopped" && spec.lifecycle.stopReason === "ttl") return true;
    if (await sleepBox(host, spec.id, "ttl")) {
      report.expired.push(spec.id);
      this.options.record(host.host.id, "system", OWNER, {
        op: "box.ttl_expire",
        kind: "write",
        status: "ok",
        summary: `Box TTL expired: ${spec.name}`,
        target: { kind: "box", id: spec.containerId, name: spec.name },
        detail: { boxId: spec.id, reason: "ttl" },
      });
      log.info("box.ttl_expired", { id: spec.id, name: spec.name, host: host.host.id });
    }
    return true;
  }

  private async maybeSleep(host: HostCtx, spec: BoxSpec, report: LifecycleReport): Promise<void> {
    if (spec.lifecycle.desired !== "running") return;
    const idleSec = effectiveIdleSec(spec, this.options.cfg);
    if (idleSec === null) return;

    const info = await host.runtime.inspectContainer(spec.containerId).catch(() => null);
    if (!info?.running) return;
    if (!this.isIdle(info.id, spec.id, spec.createdAt, idleSec)) return;

    await host.sampler.sampleSoon();
    const cpu = host.sampler.statsOf(spec.id)?.cpuPercent;
    if (cpu == null) return;
    if (cpu >= this.options.cfg.boxIdleCpuPercent) return;

    const slept = await sleepBox(host, spec.id, "idle", (box) => this.stillIdleBox(box, idleSec));
    if (!slept) return;
    report.slept.push(spec.id);
    this.options.record(host.host.id, "system", OWNER, {
      op: "box.sleep",
      kind: "write",
      status: "ok",
      summary: `Box slept (idle): ${spec.name}`,
      target: { kind: "box", id: spec.containerId, name: spec.name },
      detail: { boxId: spec.id, reason: "idle" },
    });
    log.info("box.slept", { id: spec.id, name: spec.name, host: host.host.id });
  }

  /**
   * Checked under the box's lock. A box a person stopped in the meantime is not put to sleep as idle, because that would
   * turn a manual stop into a sleep that wakes on the next terminal or preview request.
   */
  private stillIdleBox(box: Box, idleSec: number): boolean {
    if (!box.running || box.desired !== "running") return false;
    return this.isIdle(box.id, box.boxId, box.createdAt, idleSec);
  }

  /** No hold, attachment, SSH connection, exec or task is using the box, and its last heartbeat is at least `idleSec` old. */
  private isIdle(containerId: string, boxId: string, createdAt: string, idleSec: number): boolean {
    if (this.options.pulse.isHeld(boxId)) return false;
    if (this.options.terminals.hasOpenAttachment(containerId)) return false;
    if (this.options.ssh?.hasOpenConnection(boxId)) return false;
    if (this.options.execs.hasRunning(containerId)) return false;
    if (this.options.tasks.hasRunningForBox(boxId, containerId)) return false;
    const last = this.options.pulse.lastAt(boxId) ?? Math.max(Date.parse(createdAt), this.watchedSince);
    return Number.isFinite(last) && this.now() - last >= idleSec * 1000;
  }
}

/** Per-box `0` disables sleep. `null` inherits the global default. Global `0` means off. */
export function effectiveIdleSec(spec: BoxSpec, cfg: Config): number | null {
  const per = spec.lifecycle.idleTimeoutSec;
  if (per === 0) return null;
  if (per !== null) return per;
  return cfg.boxIdleTimeoutSec > 0 ? cfg.boxIdleTimeoutSec : null;
}
