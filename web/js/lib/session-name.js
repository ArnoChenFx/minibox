/**
 * The name a new terminal session starts with, and the checks the New session dialog runs before it sends one. No DOM
 * and no translation: the callers turn the keys into text, so the tests load this module directly.
 *
 * The rules mirror the server's (`SESSION_NAME_RE` in src/tmux/format.ts, and `isSessionName`): a letter or digit first,
 * then letters, digits, dashes and underscores, at most 32 characters. The server still checks every name, so a name that
 * passes here passes there, and a race with another client is refused with the server's own message.
 */

/** The longest session name, as the server takes it. */
export const SESSION_NAME_MAX = 32;

/** What a session name may hold, the same expression the server validates with. */
export const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/**
 * The name of the session a box opens with the first time its terminal is opened. It stays that name: it is what a
 * reader expects to find in a box that has never had another session, and the suggestion below only changes what the
 * New session dialog offers.
 */
export const DEFAULT_SESSION_NAME = "console";

/**
 * tmux keeps names case-sensitively, so `Console` and `console` are two sessions there. A person reads them as one, and
 * picking the second one by accident is the mistake this avoids, so every name is compared without its case.
 */
const fold = (name) => String(name ?? "").toLowerCase();

/**
 * The name to offer for a new session: `console` while it is free, then `console-2`, `console-3` and so on, skipping
 * every name in `used`. The style is the one the box's own session already uses, so the list reads as a series rather
 * than as noise, and two openings in a row never offer the same name.
 *
 * A base near the 32-character limit keeps the suffix: the stem is cut so that the whole name still fits, so a base of 32
 * characters yields `<30 characters>-2` and not a name the server would refuse.
 */
export function nextSessionName(used = [], base = DEFAULT_SESSION_NAME) {
  const stem = typeof base === "string" && SESSION_NAME_RE.test(base) ? base : DEFAULT_SESSION_NAME;
  const taken = new Set([...used].map(fold));
  if (!taken.has(fold(stem))) return stem;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${stem.slice(0, Math.max(1, SESSION_NAME_MAX - suffix.length))}${suffix}`;
    if (!taken.has(fold(candidate))) return candidate;
  }
}

/**
 * Why `value` cannot be a session name, as a dictionary key, or "" when it can. `used` holds the names already taken, so
 * a name the box already has is refused inside the dialog instead of after the request. An empty value is refused too:
 * the dialog is where a name is chosen, so a blank one is never sent to the server.
 */
export function sessionNameProblem(value, used = []) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "bd.sessionNameRequired";
  if (!SESSION_NAME_RE.test(text)) return "bd.sessionNameInvalid";
  if (new Set([...used].map(fold)).has(fold(text))) return "bd.sessionNameTaken";
  return "";
}
