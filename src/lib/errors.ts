export type ErrorCode =
  | "bad_request"
  | "validation_failed"
  | "unauthorized"
  | "not_found"
  | "method_not_allowed"
  | "too_many_requests"
  | "conflict"
  | "insufficient_capacity"
  | "docker_unavailable"
  | "docker_error"
  | "internal";

/** An error that maps to a JSON response `{ error: { code, message } }`. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, "validation_failed", message, details);
export const notFound = (message: string) => new AppError(404, "not_found", message);
export const conflict = (message: string) => new AppError(409, "conflict", message);

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
    return new AppError(
      503,
      "docker_unavailable",
      "无法连接 Docker 守护进程，请确认 Docker 已启动且当前用户有权限访问。",
    );
  }
  const message = d.json?.message || d.message || "未知错误";
  if (typeof d.statusCode === "number") {
    if (d.statusCode === 404) return new AppError(404, "not_found", `资源不存在：${message}`);
    if (d.statusCode === 409) return new AppError(409, "conflict", `操作冲突：${message}`);
    if (d.statusCode >= 400 && d.statusCode < 500) return new AppError(400, "docker_error", message);
    return new AppError(502, "docker_error", `Docker 返回错误：${message}`);
  }
  return new AppError(500, "internal", message);
}
