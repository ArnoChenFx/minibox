/**
 * Idle-timeout and TTL helpers for the Lifecycle card. No DOM and no translation: the callers turn keys into text, so the
 * tests load this module directly.
 */

/** The most a lifetime may hold: 365 days. Mirrors `MAX_LIFETIME_SEC` in src/operations/validation.ts. */
export const MAX_LIFETIME_SEC = 31_536_000;

/** The units a lifetime is entered in, largest first, with the seconds each one holds. `id` ends a dictionary key. */
export const LIFETIME_UNITS = [
  { id: "days", seconds: 86_400 },
  { id: "hours", seconds: 3_600 },
  { id: "minutes", seconds: 60 },
  { id: "seconds", seconds: 1 },
];

const unitOf = (id) => LIFETIME_UNITS.find((unit) => unit.id === id) ?? LIFETIME_UNITS[3];

/**
 * The whole number of seconds a draft names, or null when it cannot be sent: an empty or fractional field, zero, or more
 * than the cap. The server refuses the same values, so a draft that passes here passes there.
 */
export function lifetimeSeconds(value, unitId) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const seconds = Number(text) * unitOf(unitId).seconds;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_LIFETIME_SEC) return null;
  return seconds;
}

/**
 * A stored lifetime as the form holds it: the largest unit that divides the seconds exactly, so 7200 reads as 2 hours and
 * 5400 as 90 minutes. A value that is missing, zero or not a whole number reads as `fallback`.
 */
export function lifetimeDraft(seconds, fallback = 3600) {
  const total = Number.isInteger(seconds) && seconds > 0 ? seconds : fallback;
  const unit = LIFETIME_UNITS.find((candidate) => total % candidate.seconds === 0) ?? LIFETIME_UNITS[3];
  return { value: total / unit.seconds, unit: unit.id };
}

/** The idle timeout's mode: `null` inherits the global default, `0` never sleeps, a positive number is the box's own. */
export function idleModeOf(seconds) {
  if (seconds === null || seconds === undefined) return "inherit";
  return seconds === 0 ? "never" : "custom";
}

/** The TTL's mode: `null` means no TTL, a positive number is a lifetime counted from the box's creation. */
export const ttlModeOf = (seconds) => (seconds === null || seconds === undefined ? "none" : "set");

/**
 * The PATCH body a form describes, holding only the fields whose value changed. `null` is a value here (inherit, no TTL),
 * so a field is compared by value and not by presence. Returns `{ problem }` when a custom number cannot be sent.
 */
export function lifetimePatch(box, { idleMode, idleValue, idleUnit, ttlMode, ttlValue, ttlUnit }) {
  const patch = {};
  const current = { idle: box.idleTimeoutSec ?? null, ttl: box.ttlSec ?? null };
  if (idleMode === "inherit") {
    if (current.idle !== null) patch.idleTimeoutSec = null;
  } else {
    const idle = idleMode === "never" ? 0 : lifetimeSeconds(idleValue, idleUnit);
    if (idle === null) return { problem: "idle" };
    if (idle !== current.idle) patch.idleTimeoutSec = idle;
  }
  if (ttlMode === "none") {
    if (current.ttl !== null) patch.ttlSec = null;
  } else {
    const ttl = lifetimeSeconds(ttlValue, ttlUnit);
    if (ttl === null) return { problem: "ttl" };
    if (ttl !== current.ttl) patch.ttlSec = ttl;
  }
  return { patch };
}
