import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

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

export const MIN_ACCESS_KEY_LENGTH = 20;
const SINGLE_CLASS_MIN_LENGTH = 24;

function characterClasses(key: string): Set<string> {
  const classes = new Set<string>();
  for (const ch of key) {
    if (/[a-z]/.test(ch)) classes.add("lower");
    else if (/[A-Z]/.test(ch)) classes.add("upper");
    else if (/[0-9]/.test(ch)) classes.add("digit");
    else classes.add("other");
  }
  return classes;
}

/**
 * Whether an access key is too weak to rely on. The login limiter does not stop guessing, so the key's strength is
 * what resists brute force. The check is deliberately coarse: it flags keys shorter than MIN_ACCESS_KEY_LENGTH, keys
 * from one class (lowercase, uppercase, digits, or everything else) shorter than SINGLE_CLASS_MIN_LENGTH, and keys
 * that repeat a single character.
 */
export function isWeakAccessKey(key: string): boolean {
  const chars = [...key];
  if (chars.length < MIN_ACCESS_KEY_LENGTH) return true;
  if (new Set(chars).size === 1) return true;
  return chars.length < SINGLE_CLASS_MIN_LENGTH && characterClasses(key).size === 1;
}

/** The right-most entry of a comma-separated proxy header: the one appended by the proxy closest to MiniBox. */
export function lastListValue(value: string | null): string | null {
  return value?.split(",").at(-1)?.trim() || null;
}

/**
 * Whether the browser reached us over HTTPS. Behind a TLS-terminating tunnel the request URL is plain http, so the
 * browser's Origin is checked without trustProxy: same-host tunnels leave it intact, and a forged value can only turn
 * on Secure and HSTS. X-Forwarded-Proto is read only when trustProxy is enabled.
 */
export function isSecureRequest(req: Request, trustProxy: boolean): boolean {
  if (new URL(req.url).protocol === "https:") return true;
  if ((req.headers.get("origin") ?? "").startsWith("https://")) return true;
  return trustProxy && lastListValue(req.headers.get("x-forwarded-proto")) === "https";
}

/**
 * Client address for rate limiting. X-Forwarded-For is read only when a trusted proxy sits in front of
 * MiniBox, and then only its right-most entry; a client can otherwise pick any value per request.
 */
export function clientAddress(req: Request, peer: string | undefined, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = lastListValue(req.headers.get("x-forwarded-for"));
    if (forwarded && isIP(forwarded)) return forwarded;
  }
  return peer ?? "unknown";
}

const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host"] as const;

/**
 * Reports, once per process, the first request that carries proxy headers while trustProxy is off. Those
 * headers are ignored, so a tunnel or reverse proxy in front of MiniBox is most likely missing TRUST_PROXY.
 */
export function proxyHeaderWarner(trustProxy: boolean, report: (headers: string[]) => void): (req: Request) => void {
  let reported = false;
  return (req) => {
    if (trustProxy || reported) return;
    const ignored = PROXY_HEADERS.filter((name) => req.headers.has(name));
    if (ignored.length === 0) return;
    reported = true;
    report(ignored);
  };
}

/**
 * Throttle bucket for an address. A single IPv6 host usually owns a whole /64, so addresses are grouped
 * by that prefix; IPv4-mapped IPv6 addresses collapse to their IPv4 form.
 */
export function rateLimitKey(address: string): string {
  const ip = (address.trim().toLowerCase().split("%")[0] ?? "").trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip)?.[1];
  if (mapped) return mapped;
  if (!ip.includes(":")) return ip;
  const groups = expandIPv6(ip);
  if (!groups) return ip;
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

const splitGroups = (s: string | undefined) => (s ? s.split(":") : []);
const toHextets = (parts: string[]) => parts.map((g) => Number.parseInt(g, 16));

/** Expand an IPv6 literal (with `::` and optional trailing dotted IPv4) to its eight 16-bit groups. */
function expandIPv6(ip: string): number[] | null {
  let text = ip;
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const octets = v4.slice(1, 5).map(Number);
    if (octets.some((o) => o > 255)) return null;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = splitGroups(halves[0]);
  const tail = halves.length === 2 ? splitGroups(halves[1]) : [];
  const groups = [...head, ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const missing = 8 - groups.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  return [...toHextets(head), ...Array.from({ length: missing }, () => 0), ...toHextets(tail)];
}

export function sessionCookie(key: string, secure: boolean): string {
  return `${COOKIE_NAME}=${encodeURIComponent(key)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/**
 * In-memory login throttle: at most `limit` failures per key per window. The table is bounded
 * (`maxEntries`, oldest evicted first) and expired entries are pruned periodically, so spraying
 * requests from many addresses cannot grow memory without limit.
 */
export class LoginThrottle {
  private readonly failures = new Map<string, { count: number; resetAt: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly limit = 10,
    private readonly windowMs = 5 * 60_000,
    private readonly maxEntries = 10_000,
  ) {
    this.timer = setInterval(() => this.prune(), windowMs);
    this.timer.unref?.();
  }

  get size(): number {
    return this.failures.size;
  }

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
    if (f && now <= f.resetAt) {
      f.count++;
      return;
    }
    this.failures.delete(ip);
    this.failures.set(ip, { count: 1, resetAt: now + this.windowMs });
    while (this.failures.size > this.maxEntries) {
      const oldest = this.failures.keys().next().value;
      if (oldest === undefined) break;
      this.failures.delete(oldest);
    }
  }

  reset(ip: string): void {
    this.failures.delete(ip);
  }

  prune(now = Date.now()): void {
    for (const [ip, f] of this.failures) {
      if (now > f.resetAt) this.failures.delete(ip);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export interface LoginLimits {
  /** Wrong keys one client address may send per window before its wrong keys are refused. */
  perAddress: number;
  /** Wrong keys from all addresses together per window before every further wrong key is refused. */
  total: number;
  windowMs: number;
  /** How long a refused wrong key is held before its 429 is sent. */
  penaltyMs: number;
  /** Refused wrong keys held at once; past this, they are answered without waiting. */
  maxPenalties: number;
  maxEntries: number;
}

const DEFAULT_LIMITS: LoginLimits = {
  perAddress: 10,
  total: 50,
  windowMs: 5 * 60_000,
  penaltyMs: 1000,
  maxPenalties: 16,
  maxEntries: 10_000,
};

const ALL_ADDRESSES = "*";

/**
 * Limits wrong access keys only. The caller checks the key before asking whether to refuse, so a correct key always
 * signs in, even while its address or every address is blocked. Refusals do not stop guesses from being checked, so
 * the key's strength is what resists brute force. The total has its own table, so address churn cannot evict it.
 */
export class LoginLimiter {
  private readonly limits: LoginLimits;
  private readonly byAddress: LoginThrottle;
  private readonly overall: LoginThrottle;
  private waiting = 0;

  constructor(overrides: Partial<LoginLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...overrides };
    this.byAddress = new LoginThrottle(this.limits.perAddress, this.limits.windowMs, this.limits.maxEntries);
    this.overall = new LoginThrottle(this.limits.total, this.limits.windowMs, 1);
  }

  refuses(address: string, now = Date.now()): boolean {
    return this.byAddress.isBlocked(address, now) || this.overall.isBlocked(ALL_ADDRESSES, now);
  }

  recordFailure(address: string, now = Date.now()): void {
    this.byAddress.fail(address, now);
    this.overall.fail(ALL_ADDRESSES, now);
  }

  recordSuccess(address: string): void {
    this.byAddress.reset(address);
  }

  /** Holds a refused wrong key before its 429 is sent. Past maxPenalties waiting, it is sent at once. */
  async delayRefusal(): Promise<void> {
    if (this.limits.penaltyMs <= 0 || this.waiting >= this.limits.maxPenalties) return;
    this.waiting++;
    try {
      await new Promise((resolve) => setTimeout(resolve, this.limits.penaltyMs));
    } finally {
      this.waiting--;
    }
  }

  stop(): void {
    this.byAddress.stop();
    this.overall.stop();
  }
}
