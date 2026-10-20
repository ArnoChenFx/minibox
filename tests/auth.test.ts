import { describe, expect, test } from "bun:test";
import {
  COOKIE_NAME,
  clearSessionCookie,
  extractKey,
  isAuthorized,
  LoginThrottle,
  parseCookies,
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

  test("login throttle blocks after limit and resets after window", () => {
    const t = new LoginThrottle(3, 1000);
    for (let i = 0; i < 3; i++) t.fail("ip", 0);
    expect(t.isBlocked("ip", 10)).toBe(true);
    expect(t.isBlocked("ip", 2000)).toBe(false);
    t.fail("ip2", 0);
    t.reset("ip2");
    expect(t.isBlocked("ip2", 1)).toBe(false);
  });
});
