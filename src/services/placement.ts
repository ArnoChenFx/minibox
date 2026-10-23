import type { HostCapacity, HostCtx } from "../host/registry";
import { untilAborted } from "../lib/abort";
import { AppError, badRequest } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { isRuntimeError } from "../runtime";
import { type Booking, bookedOn, bookingOf } from "./capacity";

const EPSILON = 1e-6;

export interface PlacementRequest {
  readonly cpus: number;
  readonly memoryMb: number;
  /** The template image the box runs. A host whose engine holds it is preferred. */
  readonly image: string;
  /**
   * Whether a host without the image may take the box, because that host builds the image on demand. Such a host is only
   * a fallback: a holder with room always wins.
   */
  readonly buildable?: boolean;
}

async function holdsImage(host: HostCtx, image: string): Promise<boolean> {
  try {
    await untilAborted(host.runtime.inspectImage(image), AbortSignal.timeout(host.readTimeoutMs));
    return true;
  } catch (e) {
    if (!isRuntimeError(e, "not_found")) {
      log.warn("placement.image_check_failed", { host: host.host.id, error: String(e) });
    }
    return false;
  }
}

/**
 * How much of the host's CPU and memory is still free once the box is placed on it: the tighter of the two shares, as a
 * fraction of the limit the overcommit ratio allows. Null when the box does not fit, either on its own or with what the
 * host already books.
 */
async function shareLeft(host: HostCtx, want: Booking): Promise<number | null> {
  let capacity: HostCapacity;
  let booked: Booking;
  try {
    [capacity, booked] = await Promise.all([host.capacity(), bookedOn(host)]);
  } catch (e) {
    log.warn("placement.capacity_failed", { host: host.host.id, error: String(e) });
    return null;
  }
  if (capacity.cpus !== null && want.cpus > capacity.cpus) return null;
  if (capacity.memoryBytes !== null && want.memoryBytes > capacity.memoryBytes) return null;
  const ratio = host.capacityPolicy.overcommit;
  const shares: number[] = [];
  if (capacity.cpus !== null) {
    const limit = capacity.cpus * ratio;
    const after = booked.cpus + want.cpus;
    if (after > limit + EPSILON) return null;
    shares.push(1 - after / limit);
  }
  if (capacity.memoryBytes !== null) {
    const limit = capacity.memoryBytes * ratio;
    const after = booked.memoryBytes + want.memoryBytes;
    if (after > limit) return null;
    shares.push(1 - after / limit);
  }
  return shares.length === 0 ? 0 : Math.min(...shares);
}

/**
 * The host with the most room left once the box is placed on it, or null when no host has room. The winner is the one left
 * with the most free CPU and memory, measured on its tighter resource. A tie keeps the earlier host, which is the local one.
 */
async function roomiest(hosts: readonly HostCtx[], want: Booking): Promise<HostCtx | null> {
  let best: { host: HostCtx; share: number } | null = null;
  for (const host of hosts) {
    const share = await shareLeft(host, want);
    if (share !== null && (best === null || share > best.share)) best = { host, share };
  }
  return best?.host ?? null;
}

/**
 * The host a box goes to when a create names `auto`. Only online hosts are considered. The hosts that hold the template
 * come first, and the roomiest of them with room for the box wins. Only when none of them has room, and the template is
 * buildable, the roomiest of the hosts that do not hold it yet is chosen, and that host builds the template. An agent
 * host builds nothing, so it is never chosen that way. Without a buildable template, a template that no online host
 * holds is refused.
 */
export async function placeBox(hosts: readonly HostCtx[], request: PlacementRequest): Promise<HostCtx> {
  const online = hosts.filter((host) => host.host.status === "online");
  if (online.length === 0) throw new AppError(503, "docker_unavailable", msg("host_auto_offline"));

  const holds = await Promise.all(online.map((host) => holdsImage(host, request.image)));
  const holding = online.filter((_, index) => holds[index]);
  const builders = request.buildable
    ? online.filter((host, index) => !holds[index] && host.host.transport !== "agent")
    : [];
  if (holding.length === 0 && builders.length === 0) {
    throw badRequest(msg("template_image_missing", { image: request.image }), { field: "template" });
  }

  const want = bookingOf(request.cpus, request.memoryMb);
  const winner = (await roomiest(holding, want)) ?? (await roomiest(builders, want));
  if (!winner) {
    throw new AppError(
      422,
      "insufficient_capacity",
      msg("host_auto_no_room", { cpus: request.cpus, memoryMb: request.memoryMb }),
    );
  }
  return winner;
}
