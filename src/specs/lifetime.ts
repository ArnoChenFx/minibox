import type { BoxSpec } from "./types";

/**
 * Epoch ms when a box's TTL elapses, or `null` when it has no TTL or its creation time cannot be read. The TTL is an
 * absolute lifetime from creation, so it counts whether or not the box is running.
 */
export function ttlEndsAt(spec: Pick<BoxSpec, "createdAt" | "lifecycle">): number | null {
  const ttl = spec.lifecycle.ttlSec;
  if (ttl === null || ttl <= 0) return null;
  const created = Date.parse(spec.createdAt);
  return Number.isFinite(created) ? created + ttl * 1000 : null;
}

export function ttlExpired(spec: Pick<BoxSpec, "createdAt" | "lifecycle">, now: number): boolean {
  const ends = ttlEndsAt(spec);
  return ends !== null && now >= ends;
}
