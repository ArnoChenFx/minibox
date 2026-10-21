import { boxVisible, type BoxView, type TokenGrants } from "../tokens/model";
import type { EventFilter, EventVisibility } from "./store";

/** A principal the event log can see. `grants` is set on agent tokens and absent on the owner. */
export interface VisibilityPrincipal {
  readonly type: string;
  readonly id: string;
  readonly name: string;
  readonly grants?: TokenGrants;
}

/**
 * The limits on what a principal may read from the event log. Every read applies them over the filters the caller
 * asks for, so a caller can narrow what it sees but never widen it. A token without `grants` and any principal type
 * that has no rule here are refused: failing closed, rather than showing the whole log.
 * `boxes` is the current spec list, used to turn `created-by-me` and tags into ids. The owner ignores it.
 */
export function visibilityOf(principal: VisibilityPrincipal, boxes: readonly BoxView[] = []): EventFilter {
  if (principal.type === "owner") return {};
  if (principal.type === "token") {
    if (!principal.grants) throw new Error(`no event visibility is defined for principal type ${principal.type}`);
    if (principal.grants.audit === "all") return {};
    return { visible: visibilityFor(principal.id, principal.grants, boxes) };
  }
  // Reserved. Nothing issues this principal. It sees events about its own box id, and events it caused.
  if (principal.type === "box-self") {
    return { visible: { principalId: principal.id, boxes: { ids: [principal.id], names: [] }, hosts: null } };
  }
  throw new Error(`no event visibility is defined for principal type ${principal.type}`);
}

function visibilityFor(id: string, grants: TokenGrants, boxes: readonly BoxView[]): EventVisibility {
  const hosts = grants.hosts.type === "all" ? null : [...grants.hosts.ids];
  if (grants.boxes.type === "all") return { principalId: id, boxes: null, hosts };
  const ids = new Set<string>();
  const names = new Set<string>();
  // A grant by id still matches events after the box is gone, when it is no longer in the spec list.
  if (grants.boxes.type === "ids") {
    for (const item of grants.boxes.ids) ids.add(item);
  }
  for (const box of boxes) {
    if (!boxVisible({ type: "token", id, grants }, box)) continue;
    ids.add(box.boxId);
    names.add(box.name);
    if (box.containerId !== undefined) ids.add(box.containerId);
  }
  return { principalId: id, boxes: { ids: [...ids], names: [...names] }, hosts };
}

/** The filter for one read: the caller's filters, with the principal's limits applied over them. */
export function scopedFilter(
  caller: EventFilter,
  principal: VisibilityPrincipal,
  boxes: readonly BoxView[] = [],
): EventFilter {
  return { ...caller, ...visibilityOf(principal, boxes) };
}
