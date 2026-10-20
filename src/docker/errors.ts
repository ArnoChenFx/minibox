import { RuntimeError, type RuntimeErrorKind } from "../runtime";

const UNAVAILABLE_CODES = new Set(["ENOENT", "ECONNREFUSED", "EACCES"]);
const UNKNOWN = "Unknown error";

function kindForStatus(status: number): RuntimeErrorKind {
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status >= 400 && status < 500) return "invalid";
  return "engine";
}

/**
 * Translate an error from dockerode / docker-modem. Anything that is neither an engine response nor a connection
 * failure is returned unchanged and surfaces as an unexpected error.
 */
export function toRuntimeError(e: unknown): unknown {
  if (e === null || typeof e !== "object" || e instanceof RuntimeError) return e;
  const { code, statusCode, message, json } = e as {
    code?: unknown;
    statusCode?: unknown;
    message?: unknown;
    json?: unknown;
  };
  const text = typeof message === "string" && message ? message : UNKNOWN;
  const engineMessage = json !== null && typeof json === "object" ? (json as { message?: unknown }).message : undefined;
  const detail = typeof engineMessage === "string" && engineMessage ? engineMessage : text;

  if (typeof code === "string" && UNAVAILABLE_CODES.has(code)) return new RuntimeError("unavailable", text, detail);
  if (typeof statusCode !== "number") return e;
  return new RuntimeError(kindForStatus(statusCode), text, detail);
}
