import { existsSync, readFileSync, statfsSync } from "node:fs";
import os from "node:os";

import { log } from "../lib/logger";
import { type LiveSink, NO_LIVE } from "./live";
import { type CpuTimes, cpuPercent, parseMeminfo, parseProcStat } from "./procfs";
import type { HostCtx } from "./registry";
import { type BoxTotals, summarizeBoxes } from "./sampler";

export interface DiskUsage {
  mount: string;
  /** Stable id translated by the UI: "root" | "root+docker" | "docker" | "container" | "container+docker". */
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

type Usage = Omit<DiskUsage, "label">;

function disk(mount: string): Usage | null {
  try {
    const s = statfsSync(mount);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { mount, total, free, used: total - s.bfree * s.bsize };
  } catch {
    return null;
  }
}

/** Docker and Podman each create one of these files in the containers they start. */
const CONTAINER_MARKERS = ["/.dockerenv", "/run/.containerenv"];

export function runsInContainer(exists: (path: string) => boolean = existsSync): boolean {
  return CONTAINER_MARKERS.some((path) => exists(path));
}

/**
 * Labels the disks to show. Inside a container, "/" is the container's own filesystem rather than the host's, so it
 * is labelled "container". The Docker data root is listed on its own only when its total size differs from the root's,
 * since statfs gives no device id to compare.
 */
export function assembleDisks(root: Usage | null, docker: Usage | null, inContainer: boolean): DiskUsage[] {
  const rootLabel = inContainer ? "container" : "root";
  if (!root) return docker ? [{ ...docker, label: "docker" }] : [];
  if (!docker) return [{ ...root, label: rootLabel }];
  if (docker.total === root.total) return [{ ...root, label: `${rootLabel}+docker` }];
  return [
    { ...root, label: rootLabel },
    { ...docker, label: "docker" },
  ];
}

/**
 * Samples host CPU/memory on a fixed interval into a ring buffer, and assembles a full
 * metrics snapshot (incl. Docker info, cached briefly) on demand. Each tick also publishes the
 * metrics on the live sink, so an open page needs no request of its own to stay current.
 */
export class HostMonitor {
  private prev: CpuTimes | null = null;
  private lastCpu = 0;
  private history: HostSample[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private dockerCache: { at: number; value: HostMetrics["docker"] & { boxes: HostMetrics["boxes"] } } | null = null;
  private readonly inContainer = runsInContainer();

  constructor(
    private readonly currentHost: () => HostCtx,
    private readonly intervalMs: number,
    private readonly maxSamples: number,
    private readonly live: LiveSink = NO_LIVE,
  ) {}

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The local reading is kept every tick. The Docker reads, and the publish, happen only while a subscriber watches. */
  private tick(): void {
    this.sample();
    if (!this.currentHost().sampler.watched()) return;
    this.snapshot()
      .then(({ history, ...metrics }) => {
        this.live.publish("host", {
          hostId: this.currentHost().host.id,
          metrics,
          sample: history.at(-1) ?? null,
        });
      })
      .catch((e: unknown) => log.warn("host.metrics_failed", { error: String(e) }));
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

  /** The totals the sampler keeps. One listing of the engine stands in while the sampler's cache is not current. */
  private async boxTotals(host: HostCtx): Promise<BoxTotals> {
    const cached = host.sampler.summary();
    if (cached) return cached;
    return summarizeBoxes(await host.runtime.listContainers({ labels: { [host.keys.box]: "true" } }));
  }

  private async dockerInfo(): Promise<HostMetrics["docker"] & { boxes: HostMetrics["boxes"] }> {
    const now = Date.now();
    if (this.dockerCache && now - this.dockerCache.at < 2500) return this.dockerCache.value;
    let value: HostMetrics["docker"] & { boxes: HostMetrics["boxes"] };
    try {
      const host = this.currentHost();
      const [info, totals] = await Promise.all([host.runtime.info(), this.boxTotals(host)]);
      value = {
        available: true,
        version: info.version,
        rootDir: info.rootDir,
        containers: info.containers,
        images: info.images,
        boxes: totals,
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
    const disks = assembleDisks(disk("/"), docker.rootDir ? disk(docker.rootDir) : null, this.inContainer);
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
      disks,
      docker,
      boxes,
      history: this.history,
      sampledAt: new Date().toISOString(),
    };
  }
}
