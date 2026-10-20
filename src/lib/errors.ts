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

interface DockerLikeError {
  statusCode?: number;
  code?: string;
  json?: { message?: string } | null;
  message?: string;
}

/** Normalise anything thrown (AppError, dockerode error, generic Error) into an AppError. */
export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  const d = (e ?? {}) as DockerLikeError;
  if (d.code === "ENOENT" || d.code === "ECONNREFUSED" || d.code === "EACCES") {
    return new AppError(503, "docker_unavailable", msg("docker_unavailable"));
  }
  const message = d.json?.message || d.message || msg("unknown_error").text;
  if (typeof d.statusCode === "number") {
    if (d.statusCode === 404) return new AppError(404, "not_found", msg("docker_not_found", { detail: message }));
    if (d.statusCode === 409) return new AppError(409, "conflict", msg("docker_conflict", { detail: message }));
    if (d.statusCode >= 400 && d.statusCode < 500) return new AppError(400, "docker_error", message);
    return new AppError(502, "docker_error", msg("docker_error", { detail: message }));
  }
  return new AppError(500, "internal", message);
}
