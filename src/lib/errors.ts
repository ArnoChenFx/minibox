import { RuntimeError } from "../runtime";
import { type Msg, msg } from "./messages";

export type ErrorCode =
  | "bad_request"
  | "validation_failed"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "method_not_allowed"
  | "unsupported_media_type"
  | "too_many_requests"
  | "conflict"
  | "precondition_failed"
  | "precondition_required"
  | "insufficient_capacity"
  | "docker_unavailable"
  | "docker_error"
  | "internal";

/**
 * An error that maps to a JSON response `{ error: { code, message, key?, params?, details? } }`.
 * Pass a `Msg` (from `msg()`) to include a translatable key; a plain string is sent as-is.
 */
export class AppError extends Error {
  readonly key?: string;
  readonly params?: Record<string, string | number>;
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string | Msg,
    readonly details?: unknown,
  ) {
    super(typeof message === "string" ? message : message.text);
    this.name = "AppError";
    if (typeof message !== "string") {
      this.key = message.key;
      this.params = message.params;
    }
  }
}

export const badRequest = (message: string | Msg, details?: unknown) =>
  new AppError(400, "validation_failed", message, details);
export const notFound = (message: string | Msg) => new AppError(404, "not_found", message);
export const conflict = (message: string | Msg) => new AppError(409, "conflict", message);

function fromRuntimeError(e: RuntimeError): AppError {
  switch (e.kind) {
    case "not_found":
      return new AppError(404, "not_found", msg("docker_not_found", { detail: e.detail }));
    case "conflict":
      return new AppError(409, "conflict", msg("docker_conflict", { detail: e.detail }));
    case "invalid":
      return new AppError(400, "docker_error", e.detail);
    case "unavailable":
      return new AppError(503, "docker_unavailable", msg("docker_unavailable"));
    case "engine":
      return new AppError(502, "docker_error", msg("docker_error", { detail: e.detail }));
  }
}

/** Normalise anything thrown (AppError, RuntimeError, unexpected Error) into an AppError. */
export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof RuntimeError) return fromRuntimeError(e);
  const message = e instanceof Error && e.message ? e.message : msg("unknown_error").text;
  return new AppError(500, "internal", message);
}
