import type Docker from "dockerode";

export interface BoxStats {
  cpuPercent: number;
  memUsage: number;
  memLimit: number;
  memPercent: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Convert a one-shot Docker stats payload into percentages (same formula as `docker stats`). */
export function computeStats(raw: Docker.ContainerStats): BoxStats {
  const cpuDelta = raw.cpu_stats.cpu_usage.total_usage - raw.precpu_stats.cpu_usage.total_usage;
  const sysDelta = (raw.cpu_stats.system_cpu_usage ?? 0) - (raw.precpu_stats.system_cpu_usage ?? 0);
  const online = raw.cpu_stats.online_cpus || raw.cpu_stats.cpu_usage.percpu_usage?.length || 1;
  const cpuPercent = sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * online * 100 : 0;
  // cgroup v2 reports page cache under stats.inactive_file; subtract it like the docker CLI.
  const ms = raw.memory_stats as Docker.ContainerStats["memory_stats"] & { stats?: Record<string, number> };
  const cache = ms.stats?.inactive_file ?? ms.stats?.total_inactive_file ?? 0;
  const memUsage = Math.max(0, (ms.usage ?? 0) - cache);
  const memLimit = ms.limit ?? 0;
  return {
    cpuPercent: round2(cpuPercent),
    memUsage,
    memLimit,
    memPercent: memLimit ? round2((memUsage / memLimit) * 100) : 0,
  };
}

export async function getContainerStats(docker: Docker, id: string): Promise<BoxStats> {
  const raw = (await docker.getContainer(id).stats({ stream: false })) as Docker.ContainerStats;
  return computeStats(raw);
}
