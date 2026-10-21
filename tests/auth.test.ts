import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  authenticate,
  clearLegacyKeyCookie,
  clearSessionCookie,
  clientAddress,
  COOKIE_NAME,
  isSecureRequest,
  isWeakAccessKey,
  LEGACY_KEY_COOKIE,
  LoginLimiter,
  LoginThrottle,
  parseCookies,
  proxyHeaderWarner,
  rateLimitKey,
  safeEqual,
  sessionCookie,
} from "../src/auth";
import { setLogLevel } from "../src/lib/logger";
import { SessionStore } from "../src/sessions";

setLogLevel("error");

const KEY = "k".repeat(64);
const req = (headers: Record<string, string>) => new Request("http://localhost/api/x", { headers });
const cookieOnly = (cookie: string) => req({ cookie });

describe("auth", () => {
  test("safeEqual", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  test("parseCookies reads and decodes name=value pairs", () => {
    expect(parseCookies(`a=1; ${COOKIE_NAME}=abc; b=2`)).toMatchObject({ [COOKIE_NAME]: "abc", b: "2" });
    expect(parseCookies("x=%E4%B8%AD; bad")).toEqual({ x: "中" });
  });

  test("the session cookie is named minibox_session, not minibox_key", () => {
    expect(COOKIE_NAME).toBe("minibox_session");
    expect(LEGACY_KEY_COOKIE).toBe("minibox_key");
  });

  test("session cookies are HttpOnly, SameSite=Strict and Secure only when asked", () => {
    const secure = sessionCookie("token", { secure: true, maxAgeSeconds: 2592000 });
    expect(secure).toStartWith("minibox_session=token; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000");
    expect(secure).toEndWith("; Secure");
    expect(sessionCookie("token", { secure: false, maxAgeSeconds: 60 })).not.toContain("Secure");
    expect(clearSessionCookie()).toBe("minibox_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    expect(clearLegacyKeyCookie()).toBe("minibox_key=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
  });

  test("an https request URL is secure", () => {
    expect(isSecureRequest(new Request("https://minibox.example.com/login"), false)).toBe(true);
  });

  test("an https Origin is secure behind a tunnel, without trustProxy", () => {
    expect(isSecureRequest(req({}), false)).toBe(false);
    expect(isSecureRequest(req({ origin: "https://minibox.example.com" }), false)).toBe(true);
    expect(isSecureRequest(req({ origin: "http://minibox.example.com" }), false)).toBe(false);
  });

  test("X-Forwarded-Proto is trusted only when trustProxy is enabled", () => {
    expect(isSecureRequest(req({ "x-forwarded-proto": "https" }), false)).toBe(false);
    expect(isSecureRequest(req({ "x-forwarded-proto": "https" }), true)).toBe(true);
    expect(isSecureRequest(req({ "x-forwarded-proto": "http" }), true)).toBe(false);
  });
});

describe("authenticate", () => {
  let dir: string;
  let sessions: SessionStore;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "minibox-auth-"));
    sessions = new SessionStore({ file: join(dir, "sessions.json"), accessKey: KEY, ttlMs: 60_000, idleMs: null });
  });

  afterAll(() => {
    sessions.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a bearer header with the access key is a bearer caller", () => {
    expect(authenticate(req({ authorization: `Bearer ${KEY}` }), KEY, sessions)).toEqual({ sessionId: null });
    expect(authenticate(req({ authorization: `bearer   ${KEY}` }), KEY, sessions)).toEqual({ sessionId: null });
  });

  test("a wrong, empty or non-bearer header is not a caller", () => {
    expect(authenticate(req({ authorization: "Bearer wrong" }), KEY, sessions)).toBeNull();
    expect(authenticate(req({ authorization: "Bearer " }), KEY, sessions)).toBeNull();
    expect(authenticate(req({ authorization: "Basic xyz" }), KEY, sessions)).toBeNull();
    expect(authenticate(req({}), KEY, sessions)).toBeNull();
  });

  test("a live session token in the cookie is a session caller", () => {
    const { token, session } = sessions.create({ userAgent: "test", ip: "127.0.0.1" });
    expect(authenticate(cookieOnly(`${COOKIE_NAME}=${token}`), KEY, sessions)).toEqual({ sessionId: session.id });
  });

  test("an unknown token is not a caller", () => {
    expect(authenticate(cookieOnly(`${COOKIE_NAME}=not-a-session`), KEY, sessions)).toBeNull();
  });

  test("the raw access key is not accepted from either cookie", () => {
    expect(authenticate(cookieOnly(`${COOKIE_NAME}=${KEY}`), KEY, sessions)).toBeNull();
    expect(authenticate(cookieOnly(`${LEGACY_KEY_COOKIE}=${KEY}`), KEY, sessions)).toBeNull();
  });

  test("a wrong bearer header does not fall back to a valid session cookie", () => {
    const { token } = sessions.create({ userAgent: "test", ip: "127.0.0.1" });
    const headers = { authorization: "Bearer wrong", cookie: `${COOKIE_NAME}=${token}` };
    expect(authenticate(req(headers), KEY, sessions)).toBeNull();
  });

  test("a revoked session stops authenticating at once", () => {
    const { token, session } = sessions.create({ userAgent: "test", ip: "127.0.0.1" });
    expect(sessions.revoke(session.id, "test")).toBe(true);
    expect(authenticate(cookieOnly(`${COOKIE_NAME}=${token}`), KEY, sessions)).toBeNull();
  });

  test("a session stops authenticating when its lifetime is over", () => {
    let clock = 1_000_000;
    const timed = new SessionStore({
      file: join(dir, "timed.json"),
      accessKey: KEY,
      ttlMs: 60_000,
      idleMs: null,
      now: () => clock,
    });
    try {
      const { token } = timed.create({ userAgent: "test", ip: "127.0.0.1" });
      clock += 59_999;
      expect(authenticate(cookieOnly(`${COOKIE_NAME}=${token}`), KEY, timed)).not.toBeNull();
      clock += 1;
      expect(authenticate(cookieOnly(`${COOKIE_NAME}=${token}`), KEY, timed)).toBeNull();
    } finally {
      timed.stop();
    }
  });
});

describe("client address for rate limiting", () => {
  const peer = "203.0.113.7";

  test("ignores X-Forwarded-For unless a trusted proxy is configured", () => {
    const forged = req({ "x-forwarded-for": "198.51.100.1" });
    expect(clientAddress(forged, peer, false)).toBe(peer);
    expect(clientAddress(req({}), undefined, false)).toBe("unknown");
  });

  test("with trustProxy, uses the right-most X-Forwarded-For entry added by the proxy", () => {
    expect(clientAddress(req({ "x-forwarded-for": "198.51.100.1" }), "10.0.0.2", true)).toBe("198.51.100.1");
    expect(clientAddress(req({ "x-forwarded-for": "6.6.6.6, 198.51.100.9" }), "10.0.0.2", true)).toBe("198.51.100.9");
  });

  test("with trustProxy, falls back to the socket peer when the header is missing or not an IP", () => {
    expect(clientAddress(req({}), peer, true)).toBe(peer);
    expect(clientAddress(req({ "x-forwarded-for": "not-an-ip" }), peer, true)).toBe(peer);
    expect(clientAddress(req({ "x-forwarded-for": "1.2.3.4:5678" }), peer, true)).toBe(peer);
  });

  test("IPv4 keys are used as-is", () => {
    expect(rateLimitKey("203.0.113.7")).toBe("203.0.113.7");
    expect(rateLimitKey("unknown")).toBe("unknown");
  });

  test("IPv6 keys are grouped per /64, whatever the notation", () => {
    const a = rateLimitKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    expect(a).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("2001:DB8:1:2::1")).toBe(a);
    expect(rateLimitKey("2001:db8:1:2:ffff::9")).toBe(a);
    expect(rateLimitKey("2001:db8:1:3::1")).not.toBe(a);
    expect(rateLimitKey("::1")).toBe("0:0:0:0::/64");
    expect(rateLimitKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  test("IPv4-mapped IPv6 addresses collapse to IPv4", () => {
    expect(rateLimitKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  test("malformed IPv6 is kept verbatim rather than mis-grouped", () => {
    expect(rateLimitKey("2001:db8::1::2")).toBe("2001:db8::1::2");
    expect(rateLimitKey("2001:db8:zz::1")).toBe("2001:db8:zz::1");
  });
});

describe("proxy header warning", () => {
  test("reports the first request with proxy headers while trustProxy is off, and only once", () => {
    const reports: string[][] = [];
    const warn = proxyHeaderWarner(false, (headers) => reports.push(headers));
    warn(req({}));
    warn(req({ "x-forwarded-for": "198.51.100.1" }));
    warn(req({ "x-forwarded-proto": "https", "x-forwarded-host": "minibox.example.com" }));
    expect(reports).toEqual([["x-forwarded-for"]]);
  });

  test("lists every proxy header that is being ignored", () => {
    const reports: string[][] = [];
    proxyHeaderWarner(false, (headers) => reports.push(headers))(
      req({ "x-forwarded-for": "198.51.100.1", "x-forwarded-proto": "https" }),
    );
    expect(reports).toEqual([["x-forwarded-for", "x-forwarded-proto"]]);
  });

  test("stays silent when trustProxy is on", () => {
    const reports: string[][] = [];
    proxyHeaderWarner(true, (headers) => reports.push(headers))(req({ "x-forwarded-for": "198.51.100.1" }));
    expect(reports).toEqual([]);
  });
});

describe("weak access key", () => {
  const STRONG = "Q9wZk3Lm7Xv2Bn5Tc8Rp";

  test("flags keys shorter than 20 characters", () => {
    expect(isWeakAccessKey("")).toBe(true);
    expect(isWeakAccessKey(STRONG.slice(0, 19))).toBe(true);
    expect(isWeakAccessKey(STRONG)).toBe(false);
  });

  test("flags a key of 20 to 23 characters drawn from one class", () => {
    expect(isWeakAccessKey("abcdefghijklmnopqrst")).toBe(true);
    expect(isWeakAccessKey("ABCDEFGHIJKLMNOPQRSTUVW")).toBe(true);
    expect(isWeakAccessKey("12345678901234567890123")).toBe(true);
    expect(isWeakAccessKey("abcdefghijklmnopqrstuvwx")).toBe(false);
  });

  test("accepts keys that mix classes, use symbols, or are passphrases", () => {
    expect(isWeakAccessKey("Q9w!k3L@7Xv2Bn5T#8Rp")).toBe(false);
    expect(isWeakAccessKey("correct horse battery staple")).toBe(false);
    expect(isWeakAccessKey("3f9a0c7e5b21d8a46e0f9c1b7d4a2e83c5f60b9d1a7e4c28f3b0d6e9a5c1f742")).toBe(false);
  });

  test("flags a key that repeats one character, at any length", () => {
    expect(isWeakAccessKey("a".repeat(40))).toBe(true);
    expect(isWeakAccessKey("0".repeat(64))).toBe(true);
  });
});

describe("login throttle", () => {
  test("blocks after limit and resets after window", () => {
    const t = new LoginThrottle(3, 1000, 100);
    try {
      for (let i = 0; i < 3; i++) t.fail("ip", 0);
      expect(t.isBlocked("ip", 10)).toBe(true);
      expect(t.isBlocked("ip", 2000)).toBe(false);
      t.fail("ip2", 0);
      t.reset("ip2");
      expect(t.isBlocked("ip2", 1)).toBe(false);
    } finally {
      t.stop();
    }
  });

  test("evicts the oldest entry when the table is full", () => {
    const t = new LoginThrottle(1, 60_000, 3);
    try {
      t.fail("ip1", 0);
      t.fail("ip2", 100);
      t.fail("ip3", 200);
      expect(t.size).toBe(3);
      expect(t.isBlocked("ip1", 300)).toBe(true);
      t.fail("ip4", 300);
      expect(t.size).toBe(3);
      expect(t.isBlocked("ip1", 300)).toBe(false);
      expect(t.isBlocked("ip4", 300)).toBe(true);
    } finally {
      t.stop();
    }
  });

  test("prune drops only expired windows", () => {
    const t = new LoginThrottle(5, 1000, 100);
    try {
      t.fail("old", 0);
      t.fail("new", 900);
      t.prune(1500);
      expect(t.size).toBe(1);
      expect(t.isBlocked("new", 1500)).toBe(false);
    } finally {
      t.stop();
    }
  });
});

describe("login limiter", () => {
  test("refuses an address after its own limit, and a success clears only that address", () => {
    const l = new LoginLimiter({ perAddress: 2, total: 100 });
    try {
      l.recordFailure("a", 0);
      l.recordFailure("a", 0);
      expect(l.refuses("a", 1)).toBe(true);
      expect(l.refuses("b", 1)).toBe(false);
      l.recordSuccess("a");
      expect(l.refuses("a", 1)).toBe(false);
    } finally {
      l.stop();
    }
  });

  test("the total applies to addresses that have never failed", () => {
    const l = new LoginLimiter({ perAddress: 100, total: 2 });
    try {
      l.recordFailure("a", 0);
      l.recordFailure("b", 0);
      expect(l.refuses("c", 1)).toBe(true);
    } finally {
      l.stop();
    }
  });

  test("a success does not clear the total", () => {
    const l = new LoginLimiter({ perAddress: 100, total: 2 });
    try {
      l.recordFailure("a", 0);
      l.recordFailure("b", 0);
      l.recordSuccess("b");
      expect(l.refuses("c", 1)).toBe(true);
    } finally {
      l.stop();
    }
  });

  test("address churn cannot evict the total", () => {
    const l = new LoginLimiter({ perAddress: 100, total: 2, maxEntries: 2 });
    try {
      l.recordFailure("a", 0);
      l.recordFailure("b", 0);
      for (let i = 0; i < 10; i++) l.recordFailure(`churn-${i}`, 1);
      expect(l.refuses("fresh", 2)).toBe(true);
    } finally {
      l.stop();
    }
  });

  test("a refused key is not held when there is no penalty or no waiting slot", async () => {
    const none = new LoginLimiter({ penaltyMs: 0 });
    const full = new LoginLimiter({ penaltyMs: 60_000, maxPenalties: 0 });
    try {
      const started = performance.now();
      await none.delayRefusal();
      await full.delayRefusal();
      expect(performance.now() - started).toBeLessThan(1000);
    } finally {
      none.stop();
      full.stop();
    }
  });
});
