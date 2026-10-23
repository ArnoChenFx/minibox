/**
 * The off-site targets as the settings card shapes them, kept apart from the DOM so they can be tested without a browser.
 * The server checks every value again; these only build the request body from the fields of the chosen kind.
 */

export const TARGET_KINDS = Object.freeze(["s3", "sftp"]);

/** The settings each kind keeps. A form sends only the ones of its kind, so a field left from the other kind is never sent. */
export const KIND_FIELDS = Object.freeze({
  s3: Object.freeze(["endpoint", "region", "bucket", "accessKeyId", "secretAccessKey"]),
  sftp: Object.freeze(["host", "port", "user", "privateKey"]),
});

/** A private key keeps its line breaks as typed. Every other value is trimmed, since the server would refuse the spaces. */
const AS_TYPED = new Set(["privateKey"]);

function portOf(text) {
  return /^\d+$/.test(text) ? Number(text) : text;
}

/**
 * The body a target request sends. Adding a target sends its name. A test sends none, so it stores nothing. The host key
 * is sent only for an SFTP target, and only once the operator has confirmed the key the server presented.
 */
export function targetBody(form, { named = true, fingerprint = "" } = {}) {
  const body = { kind: form.kind };
  if (named) body.name = String(form.name ?? "").trim();
  const path = String(form.path ?? "").trim();
  if (path) body.path = path;
  for (const field of KIND_FIELDS[form.kind] ?? []) {
    const raw = String(form[field] ?? "");
    const value = AS_TYPED.has(field) ? raw : raw.trim();
    if (value.trim() === "") continue;
    body[field] = field === "port" ? portOf(value) : value;
  }
  if (form.kind === "sftp" && fingerprint) body.hostKeyFingerprint = fingerprint;
  return body;
}
