import type { AuthorizeRequest } from "../operations/executor";
import type { BoxSelfPrincipal } from "../operations/types";
import { SELF_SCOPE } from "./self-policy";

/**
 * Whether a box's own agent may run one operation. Only the self operations are open to it, and each one may act only
 * on the box the token belongs to: the box a self operation resolved, or the task it started. No other box, host,
 * secret or token is reachable, so a self operation with no resolved target is refused.
 */
export function selfAllowed(request: AuthorizeRequest, principal: BoxSelfPrincipal): boolean {
  if (request.operation.scope !== SELF_SCOPE) return false;
  const phase = request.phase ?? "scope";
  if (phase === "scope") return true;
  if (phase === "resource") return false;
  return ownsResolved(request.resolved, principal.id);
}

/**
 * Whether a resolved box or task belongs to the box with this id. A box is matched by its stable id, a task by the
 * principal that started it. Anything else is not the box's.
 */
function ownsResolved(resolved: unknown, boxId: string): boolean {
  if (typeof resolved !== "object" || resolved === null) return false;
  if ("boxId" in resolved && typeof resolved.boxId === "string") return resolved.boxId === boxId;
  if ("principalId" in resolved && typeof resolved.principalId === "string") return resolved.principalId === boxId;
  return false;
}
