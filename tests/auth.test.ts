import { describe, expect, test } from "bun:test";

import {
  clientAddress,
  COOKIE_NAME,
  clearSessionCookie,
  extractKey,
  isAuthorized,
  isSecureRequest,
  isWeakAccessKey,
  LoginLimiter,
  LoginThrottle,
  parseCookies,
  proxyHeaderWarner,
  rateLimitKey,
  safeEqual,
  sessionCookie,
} from "../src/auth";

const KEY = "k".repeat(64);
const req = (headers: Record<string, string>) => new Request("http://localhost/api/x", { headers });

describe("auth", () => {
  test("safeEqual", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  test("extracts key from bearer header (case-insensitive)", () => {
    expect(extractKey(req({ authorization: `Bearer ${KEY}` }))).toBe(KEY);
    expect(extractKey(req({ authorization: `bearer   ${KEY}` }))).toBe(KEY);
    expect(extractKey(req({ authorization: "Basic xyz" }))).toBeNull();
  });

  test("extracts key from cookie", () => {
    expect(extractKey(req({ cookie: `a=1; ${COOKIE_NAME}=${KEY}; b=2` }))).toBe(KEY);
    expect(parseCookies("x=%E4%B8%AD; bad")).toEqual({ x: "中" });
  });

  test("isAuthorized", () => {
    expect(isAuthorized(req({ authorization: `Bearer ${KEY}` }), KEY)).toBe(true);
    expect(isAuthorized(req({ authorization: "Bearer wrong" }), KEY)).toBe(false);
    expect(isAuthorized(req({}), KEY)).toBe(false);
  });

  test("cookies are HttpOnly, SameSite=Strict and Secure only on https", () => {
    expect(sessionCookie(KEY, true)).toContain("HttpOnly");
    expect(sessionCookie(KEY, true)).toContain("SameSite=Strict");
    expect(sessionCookie(KEY, true)).toContain("Secure");
    expect(sessionCookie(KEY, false)).not.toContain("Secure");
    expect(clearSessionCookie()).toContain("Max-Age=0");
    expect(clearSessionCookie()).toContain("SameSite=Strict");
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
