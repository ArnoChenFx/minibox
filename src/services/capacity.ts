import type { HostCtx } from "../host/registry";
import { summarizeBoxes } from "../host/sampler";
import { untilAborted } from "../lib/abort";
import { AppError } from "../lib/errors";
import { msg } from "../lib/messages";
import { RuntimeError } from "../runtime";

const MB = 1024 * 1024;
const GB = 1024 ** 3;
/** Float sums of fractional CPU shares can land a hair above a limit they equal. */
const EPSILON = 1e-6;

/** What a running box books on its host: the CPU and memory limits it holds. Memory is in bytes. */
export interface Booking {
  readonly cpus: number;
  readonly memoryBytes: number;
}

const NO_BOOKING: Booking = { cpus: 0, memoryBytes: 0 };

export const bookingOf = (cpus: number, memoryMb: number): Booking => ({ cpus, memoryBytes: memoryMb * MB });

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
    const gb = (capacity.memoryBytes / GB).toFixed(1);
    throw new AppError(422, "insufficient_capacity", msg("memory_over_host", { gb }), { field: "memoryMb" });
  }
}

/**
 * What the running boxes of a host book, as limits. The sampler's cache answers when it is current. Otherwise one listing
 * of the engine does, bounded by the host's read timeout.
 */
export async function bookedOn(host: HostCtx): Promise<Booking> {
  const cached = host.sampler.summary();
  const totals = cached ?? summarizeBoxes(await listBoxContainers(host));
  return { cpus: totals.allocatedCpus, memoryBytes: totals.allocatedMemory };
}

async function listBoxContainers(host: HostCtx) {
  const deadline = AbortSignal.timeout(host.readTimeoutMs);
  try {
    return await untilAborted(
      host.runtime.listContainers({ labels: { [host.keys.box]: "true" } }, { signal: deadline }),
      deadline,
    );
  } catch (e) {
    if (deadline.aborted) throw new RuntimeError("unavailable", `no answer within ${host.readTimeoutMs} ms`);
    throw e;
  }
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * Refuses a booking that would take the running boxes of `host` past its capacity times the overcommit ratio. `replacing`
 * is what the same box already books there, which the change gives back. Only a dimension the change grows is checked, so
 * a resize that shrinks a box is never refused. A control plane with one host is not checked at all.
 */
export async function assertRoom(host: HostCtx, want: Booking, replacing: Booking = NO_BOOKING): Promise<void> {
  if (!host.multiHost()) return;
  const growsCpus = want.cpus > replacing.cpus + EPSILON;
  const growsMemory = want.memoryBytes > replacing.memoryBytes;
  if (!growsCpus && !growsMemory) return;
  const [capacity, booked] = await Promise.all([host.capacity(), bookedOn(host)]);
  const ratio = host.capacityPolicy.overcommit;
  const cpusAfter = booked.cpus - replacing.cpus + want.cpus;
  const memoryAfter = booked.memoryBytes - replacing.memoryBytes + want.memoryBytes;
  if (growsCpus && capacity.cpus !== null && cpusAfter > capacity.cpus * ratio + EPSILON) {
    throw new AppError(
      422,
      "insufficient_capacity",
      msg("cpu_booked_over_host", { booked: round1(cpusAfter), limit: round1(capacity.cpus * ratio) }),
      { field: "cpus" },
    );
  }
  if (growsMemory && capacity.memoryBytes !== null && memoryAfter > capacity.memoryBytes * ratio) {
    throw new AppError(
      422,
      "insufficient_capacity",
      msg("memory_booked_over_host", {
        booked: round1(memoryAfter / GB),
        limit: round1((capacity.memoryBytes * ratio) / GB),
      }),
      { field: "memoryMb" },
    );
  }
}

/** The checks a new running box meets on the host it goes to: the box fits the host, and the host has room for it. */
export async function assertNewBox(host: HostCtx, res: { cpus: number; memoryMb: number }): Promise<void> {
  await assertCapacity(host, res);
  await assertRoom(host, bookingOf(res.cpus, res.memoryMb));
}

/**
 * The checks a resize meets. A stopped box books nothing, so resizing it is not checked here: the next start is not
 * checked either, which is a known limit.
 */
export async function assertResizeRoom(
  host: HostCtx,
  box: { running: boolean; cpus: number | null; memory: number | null },
  res: { cpus?: number; memoryMb?: number },
): Promise<void> {
  if (!box.running) return;
  const current: Booking = { cpus: box.cpus ?? 0, memoryBytes: box.memory ?? 0 };
  const want: Booking = {
    cpus: res.cpus ?? current.cpus,
    memoryBytes: res.memoryMb === undefined ? current.memoryBytes : res.memoryMb * MB,
  };
  await assertRoom(host, want, current);
}
