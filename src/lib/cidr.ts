/** An IPv4 network: the integer form of its base address and its prefix length. Host bits of the base are cleared. */
export interface Ipv4Network {
  readonly base: number;
  readonly prefix: number;
}

const DOTTED = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4ToInt(address: string): number | null {
  const match = DOTTED.exec(address);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  return (
    ((octets[0] ?? 0) * 0x1000000 + (octets[1] ?? 0) * 0x10000 + (octets[2] ?? 0) * 0x100 + (octets[3] ?? 0)) >>> 0
  );
}

function intToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".");
}

const maskOf = (prefix: number): number => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);

/** Parses `a.b.c.d/len`. Returns null for anything that is not an IPv4 network with a prefix from 0 to 32. */
export function parseIpv4Cidr(text: string): Ipv4Network | null {
  const slash = text.indexOf("/");
  if (slash < 0) return null;
  const address = ipv4ToInt(text.slice(0, slash));
  const length = text.slice(slash + 1);
  if (address === null || !/^\d{1,2}$/.test(length)) return null;
  const prefix = Number(length);
  if (prefix > 32) return null;
  return { base: (address & maskOf(prefix)) >>> 0, prefix };
}

export function formatIpv4Cidr(network: Ipv4Network): string {
  return `${intToIpv4(network.base)}/${network.prefix}`;
}

/** Two networks overlap when one contains the other, which for CIDR blocks means they share an address. */
export function ipv4Overlaps(a: Ipv4Network, b: Ipv4Network): boolean {
  const shared = maskOf(Math.min(a.prefix, b.prefix));
  return (a.base & shared) >>> 0 === (b.base & shared) >>> 0;
}

/** The address at `offset` from the network's base. The caller keeps `offset` inside the network. */
export function ipv4At(network: Ipv4Network, offset: number): string {
  return intToIpv4((network.base + offset) >>> 0);
}
