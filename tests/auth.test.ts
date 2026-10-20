import { describe, expect, test } from "bun:test";

import {
  clientAddress,
  COOKIE_NAME,
  clearSessionCookie,
  extractKey,
  isAuthorized,
  isSecureRequest,
  LoginThrottle,
  parseCookies,
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

  test("cookies are HttpOnly and Secure only on https", () => {
    expect(sessionCookie(KEY, true)).toContain("HttpOnly");
    expect(sessionCookie(KEY, true)).toContain("Secure");
    expect(sessionCookie(KEY, false)).not.toContain("Secure");
    expect(clearSessionCookie()).toContain("Max-Age=0");
  });

  test("detects https behind tunnels only when trustProxy is enabled", () => {
    expect(isSecureRequest(req({}), false)).toBe(false);
    expect(isSecureRequest(req({ "x-forwarded-proto": "https" }), false)).toBe(false);
    expect(isSecureRequest(req({ "x-forwarded-proto": "https" }), true)).toBe(true);
    expect(isSecureRequest(req({ origin: "https://minibox.example.com" }), true)).toBe(true);
    expect(isSecureRequest(req({ origin: "https://minibox.example.com" }), false)).toBe(false);
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
