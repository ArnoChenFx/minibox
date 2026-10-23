import { formatIpv4Cidr, type Ipv4Network, ipv4Overlaps, parseIpv4Cidr } from "../lib/cidr";
import { conflict } from "../lib/errors";
import { msg } from "../lib/messages";

/**
 * The addresses egress networks use. They sit outside the ranges Docker hands out by default, and a remote agent only
 * blocks sources inside them, or the subnets of its engine's own networks (see `setHostIngressBlock`).
 */
export const EGRESS_POOL = requireCidr("240.0.0.0/12");

/** The shared network every proxy reaches the internet through. Boxes are never attached to it. */
export const UPLINK_SUBNET = "240.0.0.0/24";

const BOX_PREFIX = 28;

function requireCidr(text: string): Ipv4Network {
  const parsed = parseIpv4Cidr(text);
  if (parsed === null) throw new Error(`invalid built-in CIDR ${text}`);
  return parsed;
}

export function inEgressPool(network: Ipv4Network): boolean {
  return ipv4Overlaps(network, EGRESS_POOL);
}

/**
 * The first /28 in the pool that overlaps none of `used`. A box's internal network needs room for the box, its proxy
 * and the gateway, which a /28 holds. The uplink's /24 is skipped.
 */
export function allocateBoxSubnet(used: readonly Ipv4Network[]): string {
  const uplink = requireCidr(UPLINK_SUBNET);
  const size = 2 ** (32 - BOX_PREFIX);
  const end = EGRESS_POOL.base + 2 ** (32 - EGRESS_POOL.prefix);
  for (let base = uplink.base + 2 ** (32 - uplink.prefix); base + size <= end; base += size) {
    const candidate: Ipv4Network = { base, prefix: BOX_PREFIX };
    if (used.some((network) => ipv4Overlaps(network, candidate))) continue;
    return formatIpv4Cidr(candidate);
  }
  throw conflict(msg("egress_pool_full"));
}
