/** Pure parsers for Linux /proc files (unit-testable). */

export interface CpuTimes {
  idle: number;
  total: number;
}

/** Parse the aggregate `cpu` line of /proc/stat. */
export function parseProcStat(text: string): CpuTimes | null {
  const line = text.split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return null;
  const nums = line.trim().split(/\s+/).slice(1).map(Number);
  if (nums.length < 4 || nums.some((n) => !Number.isFinite(n))) return null;
  // user nice system idle iowait irq softirq steal (guest fields are already included in user/nice)
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = nums;
  return { idle: idle + iowait, total: user + nice + system + idle + iowait + irq + softirq + steal };
}

/** CPU busy percentage between two samples, clamped to [0, 100]. */
export function cpuPercent(prev: CpuTimes, next: CpuTimes): number {
  const total = next.total - prev.total;
  const idle = next.idle - prev.idle;
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round(((total - idle) / total) * 1000) / 10));
}

export interface MemInfo {
  total: number;
  available: number;
  used: number;
  swapTotal: number;
  swapUsed: number;
}

/** Parse /proc/meminfo (values in kB) into bytes. `used = MemTotal - MemAvailable`. */
export function parseMeminfo(text: string): MemInfo | null {
  const kv: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m?.[1] && m[2]) kv[m[1]] = Number(m[2]) * 1024;
  }
  const total = kv.MemTotal;
  if (!total) return null;
  const available = kv.MemAvailable ?? (kv.MemFree ?? 0) + (kv.Cached ?? 0) + (kv.Buffers ?? 0);
  const swapTotal = kv.SwapTotal ?? 0;
  return { total, available, used: total - available, swapTotal, swapUsed: swapTotal - (kv.SwapFree ?? 0) };
}
