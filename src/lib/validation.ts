import { badRequest } from "./errors";
import { type LabelKey, type Msg, msg } from "./messages";

/** Docker-safe resource name: starts alphanumeric, then [A-Za-z0-9_.-], max 63 chars. */
export const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

/** A reference name that is also a file name: starts alphanumeric, then [A-Za-z0-9_.-], max 128 chars. */
export const IDENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export const LIMITS = {
  minCpus: 0.1,
  maxCpus: 64,
  minMemoryMb: 128,
  maxMemoryMb: 262144,
  maxLogTail: 5000,
} as const;

/** A rejected input: its translatable message and the input field it is about, when there is one. */
export interface Failure {
  readonly message: Msg;
  readonly field?: string;
  readonly hint?: Msg;
}

export type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: Failure };

export const accept = <T>(value: T): Checked<T> => ({ ok: true, value });
export const reject = (message: Msg, field?: string, hint?: Msg): Checked<never> => ({
  ok: false,
  failure: { message, field, hint },
});

export function asObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest(msg("invalid_json_object"));
  }
  return body as Record<string, unknown>;
}

export function checkName(value: unknown, label: LabelKey): Checked<string> {
  if (typeof value !== "string" || !value.trim()) return reject(msg("field_required", { label }), "name");
  const v = value.trim();
  if (!NAME_RE.test(v)) return reject(msg("name_invalid", { label }), "name");
  return accept(v);
}

export const DESCRIPTION_MAX = 200;

/** Optional one-line description. Control characters are refused, newlines above all: they would start a new Dockerfile instruction. */
export function checkDescription(value: unknown): Checked<string | undefined> {
  if (typeof value !== "string") return accept(undefined);
  if (/\p{Cc}/u.test(value)) return reject(msg("description_invalid"), "description");
  const v = value.trim();
  return accept(v ? [...v].slice(0, DESCRIPTION_MAX).join("") : undefined);
}
