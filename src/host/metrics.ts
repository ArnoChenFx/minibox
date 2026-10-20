import { readFileSync, statfsSync } from "node:fs";
import os from "node:os";
import { listBoxes } from "../docker/boxes";
import type { DockerCtx } from "../docker/client";
import { log } from "../lib/logger";
import { type CpuTimes, cpuPercent, parseMeminfo, parseProcStat } from "./procfs";

export interface DiskUsage {
  mount: string;
  /** Stable id translated by the UI: "root" | "docker" | "root+docker". */
  label: string;
  total: number;
  used: number;
  free: number;
}

export interface HostSample {
  t: number;
  cpu: number;
  mem: number;
}

export interface HostMetrics {
  hostname: string;
  platform: string;
  kernel: string;
  arch: string;
  uptimeSec: number;
  cpu: { cores: number; model: string; usagePercent: number; load: [number, number, number] };
  memory: { total: number; used: number; available: number; swapTotal: number; swapUsed: number };
  disks: DiskUsage[];
  docker: {
    available: boolean;
    version: string | null;
    rootDir: string | null;
    containers: { running: number; total: number };
    images: number;
  };
  boxes: { running: number; total: number; allocatedCpus: number; allocatedMemory: number; unlimited: number };
  history: HostSample[];
  sampledAt: string;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function disk(mount: string, label: string): DiskUsage | null {
  try {
    const s = statfsSync(mount);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { mount, label, total, free, used: total - s.bfree * s.bsize };
  } catch {
    return null;
  }
}

/**
 * Samples host CPU/memory on a fixed interval into a ring buffer, and assembles a full
 * metrics snapshot (incl. Docker info, cached briefly) on demand.
 */
export class HostMonitor {
  private prev: CpuTimes | null = null;
  private lastCpu = 0;
  private history: HostSample[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private dockerCache: { at: number; value: HostMetrics["docker"] & { boxes: HostMetrics["boxes"] } } | null = null;

  constructor(
    private readonly ctx: DockerCtx,
    private readonly intervalMs: number,
    private readonly maxSamples: number,
  ) {}

  start(): void {
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private sample(): void {
    const stat = readText("/proc/stat");
    const next = stat ? parseProcStat(stat) : null;
    if (next && this.prev) this.lastCpu = cpuPercent(this.prev, next);
    if (next) this.prev = next;
    const mem = this.memory();
    this.history.push({
      t: Date.now(),
      cpu: this.lastCpu,
      mem: mem.total ? Math.round((mem.used / mem.total) * 1000) / 10 : 0,
    });
    if (this.history.length > this.maxSamples) this.history.splice(0, this.history.length - this.maxSamples);
  }

  private memory(): HostMetrics["memory"] {
    const text = readText("/proc/meminfo");
    const m = text ? parseMeminfo(text) : null;
    if (m)
      return { total: m.total, used: m.used, available: m.available, swapTotal: m.swapTotal, swapUsed: m.swapUsed };
    const total = os.totalmem();
    const free = os.freemem();
    return { total, used: total - free, available: free, swapTotal: 0, swapUsed: 0 };
  }

  private async dockerInfo(): Promise<HostMetrics["docker"] & { boxes: HostMetrics["boxes"] }> {
    const now = Date.now();
    if (this.dockerCache && now - this.dockerCache.at < 2500) return this.dockerCache.value;
    let value: HostMetrics["docker"] & { boxes: HostMetrics["boxes"] };
    try {
      const [info, version, boxes] = await Promise.all([
        this.ctx.docker.info() as Promise<Record<string, unknown>>,
        this.ctx.docker.version(),
        listBoxes(this.ctx),
      ]);
      value = {
        available: true,
        version: version.Version ?? null,
        rootDir: (info.DockerRootDir as string) ?? null,
        containers: { running: Number(info.ContainersRunning ?? 0), total: Number(info.Containers ?? 0) },
        images: Number(info.Images ?? 0),
        boxes: {
          total: boxes.length,
          running: boxes.filter((b) => b.running).length,
          allocatedCpus: Math.round(boxes.filter((b) => b.running).reduce((s, b) => s + (b.cpus ?? 0), 0) * 100) / 100,
          allocatedMemory: boxes.filter((b) => b.running).reduce((s, b) => s + (b.memory ?? 0), 0),
          unlimited: boxes.filter((b) => b.cpus === null || b.memory === null).length,
        },
      };
    } catch (e) {
      log.warn("host.docker_info_failed", { error: String(e) });
      value = {
        available: false,
        version: null,
        rootDir: null,
        containers: { running: 0, total: 0 },
        images: 0,
        boxes: { total: 0, running: 0, allocatedCpus: 0, allocatedMemory: 0, unlimited: 0 },
      };
    }
    this.dockerCache = { at: now, value };
    return value;
  }

  async snapshot(): Promise<HostMetrics> {
    const d = await this.dockerInfo();
    const { boxes, ...docker } = d;
    const cpus = os.cpus();
    const disks = [disk("/", "root")];
    if (docker.rootDir) {
      const dd = disk(docker.rootDir, "docker");
      // Only list separately when on a different filesystem.
      if (dd && disks[0] && dd.total !== disks[0].total) disks.push(dd);
      else if (dd && disks[0]) disks[0].label = "root+docker";
    }
    const load = os.loadavg();
    return {
      hostname: os.hostname(),
      platform: readText("/etc/os-release")?.match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1] ?? os.platform(),
      kernel: os.release(),
      arch: os.arch(),
      uptimeSec: Math.round(os.uptime()),
      cpu: {
        cores: cpus.length,
        model: cpus[0]?.model?.trim() ?? "Unknown",
        usagePercent: this.lastCpu,
        load: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0].map((n) => Math.round(n * 100) / 100) as [
          number,
          number,
          number,
        ],
      },
      memory: this.memory(),
      disks: disks.filter((x): x is DiskUsage => x !== null),
      docker,
      boxes,
      history: this.history,
      sampledAt: new Date().toISOString(),
    };
  }
}
