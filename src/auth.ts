import { randomBytes, timingSafeEqual } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const ENV_PATH = join(ROOT, ".env");
const COOKIE = "minibox_key";

export function loadOrCreateAccessKey(): string {
  if (existsSync(ENV_PATH)) {
    const text = readFileSync(ENV_PATH, "utf8");
    const m = text.match(/^ACCESS_KEY=(.+)$/m);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  const key = randomBytes(32).toString("hex");
  writeFileSync(ENV_PATH, `ACCESS_KEY=${key}\nPORT=3920\nHOST=127.0.0.1\n`, { mode: 0o600 });
  return key;
}

export function loadPortHost(): { port: number; host: string } {
  let port = 3920;
  let host = "127.0.0.1";
  if (existsSync(ENV_PATH)) {
    const text = readFileSync(ENV_PATH, "utf8");
    const p = text.match(/^PORT=(\d+)$/m);
    const h = text.match(/^HOST=(.+)$/m);
    if (p) port = Number(p[1]);
    if (h) host = h[1].trim();
  }
  return { port, host };
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function extractKey(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim() || null;
  }
  const cookie = req.headers.get("cookie") || "";
  for (const part of cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function isAuthorized(req: Request, accessKey: string): boolean {
  const key = extractKey(req);
  if (!key) return false;
  return safeEqual(key, accessKey);
}

export function loginSetCookie(key: string): string {
  return `${COOKIE}=${encodeURIComponent(key)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`;
}

export function logoutClearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export { COOKIE, ENV_PATH, ROOT };
