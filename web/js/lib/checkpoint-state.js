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
  "ck.reasonEmpty",
  "ck.reasonHeld",
  "ck.reasonPinned",
  "ck.reasonSystem",
  "ck.reasonOtherHost",
  "ck.reasonCopyLegacy",
  "ck.reasonCopyEmpty",
  "ck.reasonCopySystem",
];

/** The translation of each reason a scheduled run can be skipped for, as the server names it. */
export const SKIP_REASON_KEYS = Object.freeze({
  sleeping: "ck.skip.sleeping",
  stopped: "ck.skip.stopped",
  capacity: "ck.skip.capacity",
  disk: "ck.skip.disk",
  gone: "ck.skip.gone",
});

/** The limits of a package passphrase, counted in characters as the server counts them. */
export const PASSPHRASE_MIN = 12;
export const PASSPHRASE_MAX = 1024;

/** The limits of an every-N-hours schedule. A daily time is `HH:MM` in the schedule's time zone. */
export const SCHEDULE_HOURS = Object.freeze({ min: 1, max: 720 });
const SCHEDULE_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

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
 * rollback that waits for its confirm or undo, `pending` says whether any rollback waits on the box, and `elsewhere` says
 * the checkpoint is kept on a host other than the one the box runs on.
 */
export function rowActions(checkpoint, { held = false, pending = false, elsewhere = false } = {}) {
  if (checkpoint.legacy) {
    return {
      fork: ALLOWED,
      export: refused("ck.reasonLegacy"),
      copy: refused("ck.reasonCopyLegacy"),
      rollback: refused("ck.reasonLegacy"),
      pin: refused("ck.reasonLegacy"),
      delete: ALLOWED,
    };
  }
  const owned = checkpoint.data.some((layer) => layer.ownership === "owned");
  let rollback = ALLOWED;
  if (pending) rollback = refused("ck.reasonPending");
  else if (elsewhere) rollback = refused("ck.reasonOtherHost");
  else if (!owned) rollback = refused("ck.reasonNoData");
  let remove = ALLOWED;
  if (held) remove = refused("ck.reasonHeld");
  else if (checkpoint.pinned) remove = refused("ck.reasonPinned");
  let exportable = ALLOWED;
  if (checkpoint.data.length === 0) exportable = refused("ck.reasonEmpty");
  else if (checkpoint.system !== null) exportable = refused("ck.reasonSystem");
  let copyable = ALLOWED;
  if (checkpoint.data.length === 0) copyable = refused("ck.reasonCopyEmpty");
  else if (checkpoint.system !== null) copyable = refused("ck.reasonCopySystem");
  return { fork: ALLOWED, export: exportable, copy: copyable, rollback, pin: ALLOWED, delete: remove };
}

/** Whether a passphrase is one the server will seal a package with: its length, and no edge spaces or line breaks. */
export function passphraseOk(value) {
  const length = [...value].length;
  if (length < PASSPHRASE_MIN || length > PASSPHRASE_MAX) return false;
  return value === value.trim() && !/[\r\n\0]/.test(value);
}

/**
 * The zone a daily schedule runs in. One saved before zones has none, and one whose saved zone the server does not know
 * (`timezoneUnknown`) falls back; both run in UTC.
 */
export const scheduleZone = (schedule) => (schedule?.timezoneUnknown ? "UTC" : (schedule?.timezone ?? "UTC"));

/** The browser's IANA time zone, such as `Asia/Shanghai`, or UTC when the browser does not say. */
export function browserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * The request body a schedule form sends for its mode: `everyHours` for an interval, `at` with its time zone for a daily
 * time. Null when the form does not describe a rule the server accepts.
 */
export function scheduleBody(mode, { hours, at, timezone = browserTimezone() }) {
  if (mode === "daily") return SCHEDULE_TIME.test(at ?? "") ? { at, timezone } : null;
  const every = Number(hours);
  const inRange = Number.isInteger(every) && every >= SCHEDULE_HOURS.min && every <= SCHEDULE_HOURS.max;
  return inRange ? { everyHours: every } : null;
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
