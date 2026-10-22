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

/** The error object of every error answer, REST and the terminal socket alike, so a client reads one shape. */
export interface ErrorBody {
  code: string;
  message: string;
  hint?: string;
  retryable: boolean;
  key?: string;
  params?: unknown;
  hintKey?: string;
  hintParams?: unknown;
  details?: unknown;
}

export function errorBody(e: unknown): { status: number; error: ErrorBody } {
  const err = toAppError(e);
  const error: ErrorBody = { code: err.code, message: err.message, retryable: err.retryable };
  if (err.hint) error.hint = err.hint;
  if (err.key) error.key = err.key;
  if (err.params) error.params = err.params;
  if (err.hintKey) error.hintKey = err.hintKey;
  if (err.hintParams) error.hintParams = err.hintParams;
  if (err.details !== undefined) error.details = err.details;
  return { status: err.status, error };
}

export function errorResponse(e: unknown): Response {
  const { status, error } = errorBody(e);
  return json({ error }, status);
}

/**
 * The largest JSON body the API reads. Archive uploads travel as base64 inside JSON, so this keeps the ceiling every
 * request had before the server's body limit grew for packages. Only package uploads may be larger.
 */
export const JSON_BODY_MAX_BYTES = 128 * 1024 * 1024;

/** Reads a request body as UTF-8 text, refusing one longer than `limit` bytes before it is held in memory. */
export async function readBodyText(req: Request, limit: number): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > limit) throw payloadTooLarge(limit);
  if (!req.body) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of req.body) {
    total += chunk.byteLength;
    if (total > limit) throw payloadTooLarge(limit);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function payloadTooLarge(limit: number): AppError {
  return new AppError(413, "payload_too_large", msg("payload_too_large", { limit: Math.round(limit / (1024 * 1024)) }));
}

/**
 * The server's body limit is sized for checkpoint packages, which only `POST /api/packages` accepts. Every other request
 * keeps the old ceiling: one that declares a larger body is refused before any route runs.
 */
export function assertBodyAllowed(req: Request, pathname: string): void {
  if (req.method === "POST" && pathname === "/api/packages") return;
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > JSON_BODY_MAX_BYTES) throw payloadTooLarge(JSON_BODY_MAX_BYTES);
}

/** A body stream that fails once more than `limit` bytes have passed, for a body that is forwarded rather than read. */
export function limitedBody(body: ReadableStream<Uint8Array>, limit: number): ReadableStream<Uint8Array> {
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > limit) controller.error(payloadTooLarge(limit));
        else controller.enqueue(chunk);
      },
    }),
  );
}

/** Parse a JSON request body. Empty body → `{}`; malformed JSON → 400; a body over `JSON_BODY_MAX_BYTES` → 413. */
export async function readJson(req: Request): Promise<unknown> {
  const text = await readBodyText(req, JSON_BODY_MAX_BYTES);
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
