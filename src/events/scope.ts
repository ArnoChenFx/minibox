import type { EventFilter } from "./store";
import type { PrincipalRef } from "./types";

/**
 * The limits on what a principal may read from the event log. Every read applies them over the filters the caller
 * asks for, so a caller can narrow what it sees but never widen it. Only the owner exists until scoped tokens (#13)
 * add other principals, so any other type is refused until its limits are written here.
 */
export function visibilityOf(principal: PrincipalRef): EventFilter {
  if (principal.type === "owner") return {};
  throw new Error(`no event visibility is defined for principal type ${principal.type}`);
}

/** The filter for one read: the caller's filters, with the principal's limits applied over them. */
export function scopedFilter(caller: EventFilter, principal: PrincipalRef): EventFilter {
  return { ...caller, ...visibilityOf(principal) };
}

/**
 * Whether a stream may carry the live state: the boxes, samples, host metrics, link state and task status. That state
 * has no filter of its own, so only a stream with no filter at all carries it. A principal whose limits narrow its
 * scope therefore gets the stored events alone, until the live frames are limited too.
 */
export function carriesLiveState(scope: EventFilter): boolean {
  return Object.values(scope).every((value) => value === undefined);
}
