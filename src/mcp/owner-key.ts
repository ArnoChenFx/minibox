import type { EventReader } from "../events/store";
import type { EventStatus } from "../events/types";

/** The event op that records each use of the owner access key on `/mcp`. */
export const OWNER_KEY_OP = "mcp.owner_key";

/** Set on a successful `/mcp` response that the owner access key was accepted for. `minibox mcp` warns on it. */
export const OWNER_KEY_HEADER = "x-minibox-owner-key";

/** How long a use keeps the console banner up, and the startup warning, after the last one. */
export const OWNER_KEY_NOTICE_MS = 7 * 24 * 60 * 60 * 1000;

export type OwnerKeyOutcome = "accepted" | "refused";

/**
 * The status each outcome is recorded with. A refusal is an error, so it reads like a failed call. Both are recorded as
 * reads, which coalesce per minute, so an agent that retries does not write a row per request.
 */
export const OWNER_KEY_STATUS: Record<OwnerKeyOutcome, EventStatus> = { accepted: "ok", refused: "error" };

export interface OwnerKeyNotice {
  /** What `/mcp` does with the key under the current MCP_ALLOW_OWNER_KEY setting. */
  readonly outcome: OwnerKeyOutcome;
  /** When the key last reached `/mcp`, under any setting. Events are kept per minute, so this is to the minute. */
  readonly lastUsedAt: string;
}

/**
 * The latest use of the owner access key on `/mcp` within the notice window. A use recorded under an earlier setting
 * still counts: after MCP_ALLOW_OWNER_KEY turns off, the console and the startup warning still name the agents that
 * were using the key. The outcome is the one the current setting produces.
 */
export function latestOwnerKeyUse(events: EventReader, allowed: boolean, now: number): OwnerKeyNotice | null {
  const page = events.list({ op: OWNER_KEY_OP, since: now - OWNER_KEY_NOTICE_MS }, { limit: 1 });
  const latest = page.events[0];
  if (!latest) return null;
  return { outcome: allowed ? "accepted" : "refused", lastUsedAt: new Date(latest.ts).toISOString() };
}
