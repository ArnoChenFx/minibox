import type { EventReader } from "../events/store";
import type { EventStatus } from "../events/types";

/** The event op that records each use of the owner access key on `/mcp`. */
export const OWNER_KEY_OP = "mcp.owner_key";

/** Set on a successful `/mcp` response that the owner access key was accepted for. `minibox mcp` warns on it. */
export const OWNER_KEY_HEADER = "x-minibox-owner-key";

/** How long a use keeps the console banner up after the last one. */
export const OWNER_KEY_NOTICE_MS = 7 * 24 * 60 * 60 * 1000;

export type OwnerKeyOutcome = "accepted" | "refused";

/**
 * The status each outcome is recorded with. A refusal is an error, so it reads like a failed call. Both are recorded as
 * reads, which coalesce per minute, so an agent that retries does not write a row per request.
 */
export const OWNER_KEY_STATUS: Record<OwnerKeyOutcome, EventStatus> = { accepted: "ok", refused: "error" };

export interface OwnerKeyNotice {
  readonly outcome: OwnerKeyOutcome;
  /** When the key last reached `/mcp` with this outcome. Events are kept per minute, so this is to the minute. */
  readonly lastUsedAt: string;
}

/**
 * The latest use of the owner access key on `/mcp` within the notice window, for the console banner. The outcome is the
 * one the current `MCP_ALLOW_OWNER_KEY` setting produces, so a use under the old setting does not show after a flip.
 */
export function latestOwnerKeyUse(events: EventReader, allowed: boolean, now: number): OwnerKeyNotice | null {
  const outcome: OwnerKeyOutcome = allowed ? "accepted" : "refused";
  const page = events.list(
    { op: OWNER_KEY_OP, status: OWNER_KEY_STATUS[outcome], since: now - OWNER_KEY_NOTICE_MS },
    { limit: 1 },
  );
  const latest = page.events[0];
  return latest ? { outcome, lastUsedAt: new Date(latest.ts).toISOString() } : null;
}
