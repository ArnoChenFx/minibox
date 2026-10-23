/**
 * The notification channels as the settings card shapes them, kept apart from the DOM so they can be tested without a
 * browser. The server checks every value again; these only build the request and name the reason a send failed.
 */

/** The notices a channel can subscribe to, in the order the server lists them. */
export const NOTICE_KINDS = Object.freeze([
  "box.oom",
  "exec.failed",
  "checkpoint.failed",
  "box.ttl_soon",
  "box.idle_soon",
  "session.takeover",
  "agent.question",
  "host.offline",
  "volume.usage_high",
  "volume.usage_limit",
  "host.disk_low",
]);

export const CHANNEL_TYPES = Object.freeze(["webhook", "ntfy", "telegram"]);

/** The settings each channel type keeps. A form sends only the ones of its type, so a field left from another type is never sent. */
export const TYPE_FIELDS = Object.freeze({
  webhook: Object.freeze(["url"]),
  ntfy: Object.freeze(["server", "topic"]),
  telegram: Object.freeze(["chatId"]),
});

export const CHANNEL_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

const FAILURE_CODES = new Set([
  "timeout",
  "network",
  "dns_failed",
  "blocked_address",
  "bad_url",
  "queue_full",
  "unexpected",
]);
const HTTP_CODE = /^http_(\d{3})$/;

/** A box filter as typed: names or ids, one per line or separated by commas. Blanks and repeats are dropped. */
export function parseBoxes(text) {
  const boxes = [];
  for (const part of String(text ?? "").split(/[\n,]/)) {
    const box = part.trim();
    if (box && !boxes.includes(box)) boxes.push(box);
  }
  return boxes;
}

/**
 * The body that creates or changes a channel. An omitted secret keeps the stored one, `clearSecret` sends null to remove
 * it, and a typed value replaces it.
 */
export function channelBody(form) {
  const body = {
    type: form.type,
    name: String(form.name ?? "").trim(),
    enabled: form.enabled !== false,
    events: [...(form.events ?? [])],
    boxes: parseBoxes(form.boxes),
  };
  for (const field of TYPE_FIELDS[form.type] ?? []) {
    const value = String(form[field] ?? "").trim();
    if (value) body[field] = value;
  }
  if (form.clearSecret) body.secret = null;
  else if (form.secret) body.secret = String(form.secret);
  return body;
}

/** The message a failed send reads as, as a key and its parameters. Null when the send did not fail. */
export function failureOf(code) {
  if (!code) return null;
  const http = HTTP_CODE.exec(code);
  if (http) return { key: "st.notifyError.http", params: { status: Number(http[1]) } };
  return { key: `st.notifyError.${FAILURE_CODES.has(code) ? code : "other"}`, params: {} };
}
