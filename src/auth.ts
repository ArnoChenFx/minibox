import { timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "minibox_key";
const MAX_AGE = 60 * 60 * 24 * 30;

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/** Extract an access key from `Authorization: Bearer` or the session cookie. */
export function extractKey(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth && /^bearer\s+/i.test(auth)) {
    const key = auth.replace(/^bearer\s+/i, "").trim();
    return key || null;
  }
  return parseCookies(req.headers.get("cookie"))[COOKIE_NAME] || null;
}

export function isAuthorized(req: Request, accessKey: string): boolean {
  const key = extractKey(req);
  return key !== null && safeEqual(key, accessKey);
}

/**
 * Whether the browser reached us over HTTPS. Behind a TLS-terminating tunnel the request URL is
 * plain http, so also trust X-Forwarded-Proto and the browser-set Origin header.
 */
export function isSecureRequest(req: Request): boolean {
  return (
    new URL(req.url).protocol === "https:" ||
    req.headers.get("x-forwarded-proto") === "https" ||
    (req.headers.get("origin") ?? "").startsWith("https://")
  );
}

export function sessionCookie(key: string, secure: boolean): string {
  return `${COOKIE_NAME}=${encodeURIComponent(key)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Simple in-memory login throttle: max `limit` failures per IP per window. */
export class LoginThrottle {
  private failures = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly limit = 10,
    private readonly windowMs = 5 * 60_000,
  ) {}

  isBlocked(ip: string, now = Date.now()): boolean {
    const f = this.failures.get(ip);
    if (!f) return false;
    if (now > f.resetAt) {
      this.failures.delete(ip);
      return false;
    }
    return f.count >= this.limit;
  }

  fail(ip: string, now = Date.now()): void {
    const f = this.failures.get(ip);
    if (!f || now > f.resetAt) this.failures.set(ip, { count: 1, resetAt: now + this.windowMs });
    else f.count++;
  }

  reset(ip: string): void {
    this.failures.delete(ip);
  }
}
