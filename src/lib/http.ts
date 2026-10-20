import { AppError, toAppError } from "./errors";
import { msg } from "./messages";

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
};

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...SECURITY_HEADERS,
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

export function withSecurityHeaders(res: Response): Response {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!res.headers.has(k)) res.headers.set(k, v);
  }
  return res;
}
