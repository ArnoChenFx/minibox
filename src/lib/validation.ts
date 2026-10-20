import { badRequest } from "./errors";
import { type LabelKey, type Msg, msg } from "./messages";

/** Docker-safe resource name: starts alphanumeric, then [A-Za-z0-9_.-], max 63 chars. */
export const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

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
}

export type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: Failure };

export const accept = <T>(value: T): Checked<T> => ({ ok: true, value });
export const reject = (message: Msg, field?: string): Checked<never> => ({ ok: false, failure: { message, field } });

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

export function validateName(value: unknown, field = "name", label: LabelKey = "name"): string {
  const checked = checkName(value, label);
  if (!checked.ok) throw badRequest(checked.failure.message, { field });
  return checked.value;
}
