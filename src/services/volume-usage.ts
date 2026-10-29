import type { Config } from "../config";
import type { HostCtx, HostRegistry } from "../host/registry";
import { log } from "../lib/logger";
import { OWNER } from "../operations/types";
import { freePercent, remeasureHostDisk } from "../volumes/disk";
import { usageLevel } from "../volumes/limits";
import type { UsageLevel, VolumeRecord } from "../volumes/types";
import { recordSample, sampleWithin } from "../volumes/usage";
import { stopBox } from "./boxes";
import type { RecordNote } from "./terminals";

/** The first pass runs this soon after start, so a volume over a limit at boot is found without waiting a full interval. */
const FIRST_PASS_MS = 30_000;
/**
 * Samples one host runs at once. Each is a helper container walking a tree, so a host with many volumes takes them a few
 * at a time instead of starting a helper for every volume on the same tick. A late sample frees its slot at its deadline.
 */
export const SAMPLES_PER_HOST = 4;

export interface VolumeUsageOptions {
  readonly hosts: HostRegistry;
  readonly record: RecordNote;
  readonly cfg: Config;
  /** Overrides `VOLUME_USAGE_INTERVAL_SEC`. Tests set it. */
  readonly everyMs?: number;
}

interface StoppedBox {
  id: string;
  name: string;
}

/**
 * Samples every volume's usage on an interval and raises the events the limits call for. Each volume's level is kept in
 * memory, so an event is written as a volume crosses a limit, not on every pass. Over a hard limit with the `stop`
 * action, every pass stops the running boxes that mount the volume, so a box started by a path that did not check the
 * limit is stopped too.
 */
export class VolumeUsageWatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private firstPass: ReturnType<typeof setTimeout> | undefined;
  /** Volumes whose sample or judgement is still running. A pass leaves them to finish, and samples the rest. */
  private readonly sampling = new Set<string>();
  private readonly everyMs: number;
  /** The level each volume was last seen at. A volume not seen yet counts as ok, so one over its limit at start alerts once. */
  private readonly levels = new Map<string, UsageLevel>();
  /** Hosts whose disk is below the free-space floor, so a low disk is announced once and not on every pass. */
  private readonly diskLow = new Set<string>();
  /** Per host, the samples running now and the ones waiting for a slot. */
  private readonly slots = new Map<string, { active: number; waiting: Array<() => void> }>();

  constructor(private readonly options: VolumeUsageOptions) {
    this.everyMs = options.everyMs ?? options.cfg.volumeUsageIntervalSec * 1000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.everyMs);
    this.timer.unref();
    this.firstPass = setTimeout(() => void this.tick(), Math.min(this.everyMs, FIRST_PASS_MS));
    this.firstPass.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    clearTimeout(this.firstPass);
    this.timer = undefined;
    this.firstPass = undefined;
  }

  /** One pass over every host. Safe to call from tests without starting the timer. A failure is logged, never thrown. */
  async tick(): Promise<void> {
    const current = new Set(
      this.options.hosts.list().flatMap((host) => host.volumes.list().map((volume) => volume.id)),
    );
    for (const id of this.levels.keys()) if (!current.has(id)) this.levels.delete(id);
    await Promise.all(
      this.options.hosts
        .list()
        .map((host) =>
          this.hostPass(host).catch((e) =>
            log.error("volume.usage_pass_failed", { host: host.host.id, error: String(e) }),
          ),
        ),
    );
  }

  private async hostPass(host: HostCtx): Promise<void> {
    if (host.host.transport !== "local" && host.host.status !== "online") return;
    const volumes = host.volumes.list().filter((volume) => volume.hostId === host.host.id);
    await Promise.all([this.checkDisk(host), ...volumes.map((volume) => this.sampleVolume(host, volume))]);
  }

  /**
   * Each volume is sampled on its own clock. A volume that is still waiting on a sample is not asked again by a later
   * pass, so a frozen mount holds back only itself, and the next pass samples the rest.
   */
  private async sampleVolume(host: HostCtx, volume: VolumeRecord): Promise<void> {
    if (this.sampling.has(volume.id)) return;
    this.sampling.add(volume.id);
    const release = await this.slot(host.host.id);
    try {
      const sample = await sampleWithin(host, volume);
      const next = recordSample(host, volume.id, sample);
      if (!next || !sample.ok || sample.scope === "share") return;
      await this.judge(host, next);
    } catch (e) {
      log.error("volume.usage_failed", { host: host.host.id, id: volume.id, error: String(e) });
    } finally {
      release();
      this.sampling.delete(volume.id);
    }
  }

  /** Waits for one of the host's sample slots, and returns the function that gives it back. */
  private async slot(hostId: string): Promise<() => void> {
    let slots = this.slots.get(hostId);
    if (!slots) {
      slots = { active: 0, waiting: [] };
      this.slots.set(hostId, slots);
    }
    const held = slots;
    if (held.active >= SAMPLES_PER_HOST) await new Promise<void>((resolve) => held.waiting.push(resolve));
    else held.active += 1;
    return () => {
      const next = held.waiting.shift();
      if (next) next();
      else held.active -= 1;
    };
  }

  private async judge(host: HostCtx, volume: VolumeRecord): Promise<void> {
    const level = usageLevel(volume.bytes, volume.limits);
    const before = this.levels.get(volume.id) ?? "ok";
    this.levels.set(volume.id, level);
    if ((level === "soft" || level === "hard") && before === "ok") this.raiseHigh(host, volume);
    if (level !== "hard") return;
    const stopped = volume.limits.action === "stop" ? await this.stopMounting(host, volume) : [];
    if (before !== "hard" || stopped.length > 0) this.raiseLimit(host, volume, stopped);
  }

  private raiseHigh(host: HostCtx, volume: VolumeRecord): void {
    log.warn("volume.usage_high", { id: volume.id, name: volume.name, bytes: volume.bytes });
    this.options.record(host.host.id, "system", OWNER, {
      op: "volume.usage_high",
      kind: "write",
      status: "ok",
      summary: `Volume over its soft limit: ${volume.name}`,
      target: { kind: "volume", id: volume.id, name: volume.name },
      detail: {
        volumeId: volume.id,
        bytes: volume.bytes,
        softBytes: volume.limits.softBytes,
        hardBytes: volume.limits.hardBytes,
      },
    });
  }

  private raiseLimit(host: HostCtx, volume: VolumeRecord, stopped: StoppedBox[]): void {
    log.warn("volume.usage_limit", { id: volume.id, name: volume.name, action: volume.limits.action });
    this.options.record(host.host.id, "system", OWNER, {
      op: "volume.usage_limit",
      kind: "write",
      status: "error",
      summary: `Volume over its hard limit: ${volume.name}`,
      target: { kind: "volume", id: volume.id, name: volume.name },
      error: { code: "volume_over_limit", status: 409 },
      detail: {
        volumeId: volume.id,
        bytes: volume.bytes,
        hardBytes: volume.limits.hardBytes,
        action: volume.limits.action,
        reason: "volume_limit",
        boxes: stopped,
      },
    });
  }

  /** Stops each running box that mounts the volume. A box stopped by a person is left as it is. */
  private async stopMounting(host: HostCtx, volume: VolumeRecord): Promise<StoppedBox[]> {
    const stopped: StoppedBox[] = [];
    for (const spec of host.specs.list()) {
      if (spec.hostId !== host.host.id || spec.lifecycle.desired !== "running") continue;
      if (!spec.mounts.some((mount) => mount.volume === volume.engineName)) continue;
      try {
        await stopBox(host, spec.id, "volume_limit");
        stopped.push({ id: spec.id, name: spec.name });
      } catch (e) {
        log.error("volume.stop_failed", { id: spec.id, volume: volume.id, error: String(e) });
      }
    }
    return stopped;
  }

  private async checkDisk(host: HostCtx): Promise<void> {
    const minFree = host.diskPolicy.minFreePercent;
    if (minFree <= 0) return;
    const disk = await remeasureHostDisk(host);
    if (!disk) return;
    const free = freePercent(disk);
    if (free >= minFree) {
      this.diskLow.delete(host.host.id);
      return;
    }
    if (this.diskLow.has(host.host.id)) return;
    this.diskLow.add(host.host.id);
    log.warn("host.disk_low", { host: host.host.id, freePercent: Math.floor(free), minFreePercent: minFree });
    this.options.record(host.host.id, "system", OWNER, {
      op: "host.disk_low",
      kind: "write",
      status: "error",
      summary: `Host disk is low: ${host.host.name}`,
      target: { kind: "host", id: host.host.id, name: host.host.name },
      error: { code: "insufficient_storage", status: 507 },
      detail: {
        hostId: host.host.id,
        freePercent: Math.floor(free),
        minFreePercent: minFree,
        freeBytes: disk.freeBytes,
        totalBytes: disk.totalBytes,
      },
    });
  }
}
