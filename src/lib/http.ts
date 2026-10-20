import { AppError, toAppError } from "./errors";
import { msg } from "./messages";

/**
 * Everything the console loads comes from MiniBox itself (xterm.js is vendored), so scripts are limited to
 * 'self'. Styles keep 'unsafe-inline' because the UI renders inline style attributes.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

/** Sent only for HTTPS requests. No includeSubDomains, so other hosts under the same domain are not affected. */
const HSTS = "max-age=31536000";

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export function errorResponse(e: unknown): Response {
  const err = toAppError(e);
  const body: {
    error: { code: string; message: string; key?: string; params?: unknown; details?: unknown };
  } = {
    error: { code: err.code, message: err.message },
  };
  if (err.key) body.error.key = err.key;
  if (err.params) body.error.params = err.params;
  if (err.details !== undefined) body.error.details = err.details;
  return json(body, err.status);
}

/** Parse a JSON request body. Empty body → `{}`; malformed JSON → 400. */
export async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(400, "bad_request", msg("invalid_json"));
  }
}

export function withSecurityHeaders(res: Response, secure: boolean): Response {
  const headers = secure ? { ...SECURITY_HEADERS, "strict-transport-security": HSTS } : SECURITY_HEADERS;
  for (const [k, v] of Object.entries(headers)) {
    if (!res.headers.has(k)) res.headers.set(k, v);
  }
  return res;
}
