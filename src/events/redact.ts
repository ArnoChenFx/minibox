import type { EventInput } from "./types";

export const REDACTED = "***";

/** Shorter known secrets are not matched: a three-letter key would blank out ordinary words. */
const MIN_KNOWN_SECRET = 8;

/** Field names that hold a credential, whatever their value looks like. */
const SECRET_KEY =
  /pass(word|wd)|passphrase|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key|access[-_]?key/i;

/** Common credential formats. Best effort: a format not listed here, or one split across fields, is not caught. */
const FORMATS: readonly (readonly [RegExp, string])[] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, REDACTED],
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}/g, REDACTED],
  // Agent API tokens. The stored prefix is shorter than this, so a prefix in a list is not mistaken for the secret.
  [/\bmbx_[A-Za-z0-9_-]{20,}\b/g, REDACTED],
];

export interface RedactOptions {
  /** Values that must never be persisted, such as the access key. Matched exactly wherever they appear. */
  readonly knownSecrets?: readonly string[];
}

export interface Redactor {
  /** The text with known secrets and credential formats replaced. */
  text(value: string): string;
  /**
   * A copy of a JSON-like value, with credential fields replaced and environment variables reduced to their names.
   * The value passed in is not modified.
   */
  value(value: unknown): unknown;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function createRedactor(options: RedactOptions = {}): Redactor {
  // Read the array on each call. Token creation appends secrets after the redactor already exists.
  const known = options.knownSecrets;

  const text = (value: string): string => {
    let out = value;
    for (const secret of known ?? []) {
      if (secret.length >= MIN_KNOWN_SECRET) out = out.replaceAll(secret, REDACTED);
    }
    for (const [pattern, replacement] of FORMATS) out = out.replace(pattern, replacement);
    return out;
  };

  const walk = (value: unknown, key: string | undefined): unknown => {
    if (key === "env" && isPlainObject(value)) return Object.keys(value);
    if (key === "env" && Array.isArray(value)) {
      return value.map((item) => {
        if (typeof item === "string") {
          const eq = item.indexOf("=");
          return eq === -1 ? item : item.slice(0, eq);
        }
        if (isPlainObject(item) && typeof item.name === "string") return item.name;
        return walk(item, undefined);
      });
    }
    if (key !== undefined && SECRET_KEY.test(key) && value !== undefined && value !== null) return REDACTED;
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map((item) => walk(item, undefined));
    if (isPlainObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, walk(item, name)]));
    }
    return value;
  };

  return { text, value: (value) => walk(value, undefined) };
}

/** The event with every free-text field and the detail redacted. Identifiers and timestamps are left as they are. */
export function redactEvent(event: EventInput, redactor: Redactor): EventInput {
  return {
    ...event,
    summary: redactor.text(event.summary),
    target: event.target && {
      kind: event.target.kind,
      id: event.target.id === undefined ? undefined : redactor.text(event.target.id),
      name: redactor.text(event.target.name),
    },
    principal: { ...event.principal, name: redactor.text(event.principal.name) },
    detail: event.detail === undefined ? undefined : redactor.value(event.detail),
    run: event.run === undefined ? undefined : redactor.text(event.run),
    ref: event.ref && (redactor.value(event.ref) as EventInput["ref"]),
  };
}
