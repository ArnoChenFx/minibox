import type { HostCtx } from "../host/registry";
import { AppError } from "../lib/errors";
import { msg } from "../lib/messages";

/** Reject a single box that asks for more than the host physically has. */
export async function assertCapacity(host: HostCtx, res: { cpus?: number; memoryMb?: number }): Promise<void> {
  const metrics = await host.monitor.snapshot();
  if (res.cpus !== undefined && res.cpus > metrics.cpu.cores) {
    throw new AppError(422, "insufficient_capacity", msg("cpu_over_host", { cores: metrics.cpu.cores }), {
      field: "cpus",
    });
  }
  if (res.memoryMb !== undefined && res.memoryMb * 1024 * 1024 > metrics.memory.total) {
    const gb = (metrics.memory.total / 1024 ** 3).toFixed(1);
    throw new AppError(422, "insufficient_capacity", msg("memory_over_host", { gb }), { field: "memoryMb" });
  }
}
