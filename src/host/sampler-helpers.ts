import type { ContainerInfo } from "../runtime";
import type { BoxTotals } from "./sampler-types";

/** The allocation of the boxes in `infos`. A box without a CPU or memory limit counts as unlimited. */
export function summarizeBoxes(infos: Iterable<ContainerInfo>): BoxTotals {
  const totals: BoxTotals = { total: 0, running: 0, allocatedCpus: 0, allocatedMemory: 0, unlimited: 0 };
  for (const info of infos) {
    totals.total += 1;
    if (info.cpus === null || info.memoryBytes === null) totals.unlimited += 1;
    if (!info.running) continue;
    totals.running += 1;
    totals.allocatedCpus += info.cpus ?? 0;
    totals.allocatedMemory += info.memoryBytes ?? 0;
  }
  return { ...totals, allocatedCpus: Math.round(totals.allocatedCpus * 100) / 100 };
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Resolves once `promise` settles, or after `ms`, whichever comes first. The promise itself is left to finish. */
export function waitUpTo(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      resolve();
    }
    promise.then(done, done);
  });
}

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
