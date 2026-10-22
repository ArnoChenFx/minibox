import type { HostCtx } from "../host/registry";
import { AppError } from "../lib/errors";
import { msg } from "../lib/messages";

const MB = 1024 * 1024;

/**
 * Reject a single box that asks for more than the host it will run on has. A figure the host does not report is not
 * checked, rather than refused.
 */
export async function assertCapacity(host: HostCtx, res: { cpus?: number; memoryMb?: number }): Promise<void> {
  const capacity = await host.capacity();
  if (res.cpus !== undefined && capacity.cpus !== null && res.cpus > capacity.cpus) {
    throw new AppError(422, "insufficient_capacity", msg("cpu_over_host", { cores: capacity.cpus }), {
      field: "cpus",
    });
  }
  if (res.memoryMb !== undefined && capacity.memoryBytes !== null && res.memoryMb * MB > capacity.memoryBytes) {
    const gb = (capacity.memoryBytes / 1024 ** 3).toFixed(1);
    throw new AppError(422, "insufficient_capacity", msg("memory_over_host", { gb }), { field: "memoryMb" });
  }
}
