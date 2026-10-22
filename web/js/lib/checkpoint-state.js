/**
 * The rules the checkpoint list shows, kept apart from the DOM so they can be tested without a browser. The server
 * enforces each rule as well: these only say, before a press, why a control is off.
 */

export const KINDS = ["manual", "automatic", "pinned", "legacy"];
export const HOLD_MODES = ["live", "pause", "stop"];
export const REASON_KEYS = [
  "ck.reasonLegacy",
  "ck.reasonPending",
  "ck.reasonNoData",
  "ck.reasonHeld",
  "ck.reasonPinned",
];

/** The kinds a row carries. A legacy snapshot is read-only, so it carries only that kind. */
export function kindsOf(checkpoint) {
  if (checkpoint.legacy) return ["legacy"];
  const kinds = [checkpoint.auto ? "automatic" : "manual"];
  if (checkpoint.pinned) kinds.push("pinned");
  return kinds;
}

/** The roles of the workspace and home a checkpoint holds, the count of other volumes, and whether it has a system layer. */
export function contentsOf(checkpoint) {
  const roles = [];
  let others = 0;
  for (const layer of checkpoint.data) {
    if (layer.role === "workspace" || layer.role === "home") roles.push(layer.role);
    else others += 1;
  }
  return { roles, others, system: checkpoint.system !== null };
}

const ALLOWED = Object.freeze({ allowed: true, reason: "" });
const refused = (reason) => Object.freeze({ allowed: false, reason });

/**
 * Each row action, whether it is allowed and, when it is not, the key of the reason. `held` marks the safety point of a
 * rollback that waits for its confirm or undo, and `pending` says whether any rollback waits on the box.
 */
export function rowActions(checkpoint, { held = false, pending = false } = {}) {
  if (checkpoint.legacy) {
    return {
      fork: ALLOWED,
      rollback: refused("ck.reasonLegacy"),
      pin: refused("ck.reasonLegacy"),
      delete: ALLOWED,
    };
  }
  const owned = checkpoint.data.some((layer) => layer.ownership === "owned");
  let rollback = ALLOWED;
  if (pending) rollback = refused("ck.reasonPending");
  else if (!owned) rollback = refused("ck.reasonNoData");
  let remove = ALLOWED;
  if (held) remove = refused("ck.reasonHeld");
  else if (checkpoint.pinned) remove = refused("ck.reasonPinned");
  return { fork: ALLOWED, rollback, pin: ALLOWED, delete: remove };
}

/** Newest first, by the time each was taken. */
export function newestFirst(checkpoints) {
  return checkpoints.toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** The share of the repository limit in use, rounded, or null when no limit is set. */
export function usedPercent(usage) {
  if (usage.limitBytes === null || usage.limitBytes <= 0) return null;
  return Math.round((usage.bytes / usage.limitBytes) * 100);
}
