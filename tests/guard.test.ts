import { describe, expect, test } from "bun:test";

import { type GuardPolicy, guardRequest, isSameOriginRequest, requireJsonBody } from "../src/guard";
import { AppError } from "../src/lib/errors";

const APP = "https://minibox.example.com";
const direct: GuardPolicy = { allowedOrigins: [], trustProxy: false };
const evil = { origin: "https://evil.example" };

const req = (method: string, path: string, headers: Record<string, string> = {}) =>
  new Request(`${APP}${path}`, { method, headers });

function statusOf(fn: () => void): number | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof AppError) return e.status;
    throw e;
  }
}

const guard = (request: Request, policy: GuardPolicy = direct) => statusOf(() => guardRequest(request, policy));

describe("same-origin check", () => {
  test("accepts the MiniBox origin and rejects other sites, including sibling subdomains", () => {
    expect(isSameOriginRequest(req("POST", "/api/x", { origin: APP }), direct)).toBe(true);
    expect(isSameOriginRequest(req("POST", "/api/x", evil), direct)).toBe(false);
    expect(isSameOriginRequest(req("POST", "/api/x", { origin: "https://other.minibox.example.com" }), direct)).toBe(
      false,
    );
    expect(isSameOriginRequest(req("POST", "/api/x", { origin: "null" }), direct)).toBe(false);
    expect(isSameOriginRequest(req("POST", "/api/x", { origin: "not a url" }), direct)).toBe(false);
  });

  test("ignores the scheme so TLS-terminating proxies keep working", () => {
    const plain = new Request("http://minibox.example.com/api/x", { method: "POST", headers: { origin: APP } });
    expect(isSameOriginRequest(plain, direct)).toBe(true);
  });

  test("without an Origin header, only Fetch Metadata can reject", () => {
    expect(isSameOriginRequest(req("POST", "/api/x"), direct)).toBe(true);
    expect(isSameOriginRequest(req("POST", "/api/x", { "sec-fetch-site": "same-origin" }), direct)).toBe(true);
    expect(isSameOriginRequest(req("POST", "/api/x", { "sec-fetch-site": "none" }), direct)).toBe(true);
    expect(isSameOriginRequest(req("POST", "/api/x", { "sec-fetch-site": "same-site" }), direct)).toBe(false);
    expect(isSameOriginRequest(req("POST", "/api/x", { "sec-fetch-site": "cross-site" }), direct)).toBe(false);
  });

  test("ALLOWED_ORIGINS admits explicitly listed origins", () => {
    const policy = { allowedOrigins: ["https://panel.example.net"], trustProxy: false };
    expect(isSameOriginRequest(req("POST", "/api/x", { origin: "https://panel.example.net" }), policy)).toBe(true);
    expect(isSameOriginRequest(req("POST", "/api/x", { origin: "https://panel.example.org" }), policy)).toBe(false);
  });

  test("X-Forwarded-Host counts only when a proxy is trusted", () => {
    const headers = { origin: "https://public.example.net", "x-forwarded-host": "public.example.net" };
    expect(isSameOriginRequest(req("POST", "/api/x", headers), direct)).toBe(false);
    expect(isSameOriginRequest(req("POST", "/api/x", headers), { allowedOrigins: [], trustProxy: true })).toBe(true);
  });
});

describe("guardRequest", () => {
  test("cross-site writes and WebSocket upgrades are refused with 403", () => {
    expect(guard(req("POST", "/api/auth/login", evil))).toBe(403);
    expect(guard(req("PATCH", "/api/boxes/a/resources", evil))).toBe(403);
    expect(guard(req("DELETE", "/api/boxes/a", evil))).toBe(403);
    expect(guard(req("GET", "/api/boxes/a/terminal", { ...evil, upgrade: "websocket" }))).toBe(403);
  });

  test("cross-site JSON writes are refused by the Origin check before the body rule applies", () => {
    const json = { ...evil, "content-type": "application/json", "content-length": "2" };
    expect(guard(req("POST", "/api/boxes", json))).toBe(403);
  });

  test("cross-site reads are left to the browser's same-origin policy", () => {
    expect(guard(req("GET", "/api/boxes", evil))).toBeNull();
  });

  test("same-origin writes with a JSON body pass; other bodies are 415", () => {
    const json = { origin: APP, "content-type": "application/json; charset=utf-8", "content-length": "2" };
    expect(guard(req("POST", "/api/boxes", json))).toBeNull();
    const form = { origin: APP, "content-type": "application/x-www-form-urlencoded", "content-length": "3" };
    expect(guard(req("POST", "/api/boxes", form))).toBe(415);
    const text = { origin: APP, "content-type": "text/plain", "content-length": "3" };
    expect(guard(req("POST", "/api/boxes", text))).toBe(415);
  });

  test("bodyless writes and empty bodies need no content type", () => {
    expect(guard(req("POST", "/api/boxes/a/start"))).toBeNull();
    const emptyForm = { origin: APP, "content-type": "application/x-www-form-urlencoded", "content-length": "0" };
    expect(guard(req("POST", "/api/boxes/a/start", emptyForm))).toBeNull();
  });

  test("Bearer-token CLIs without an Origin header are not refused", () => {
    const cli = { authorization: "Bearer key", "content-type": "application/json", "content-length": "2" };
    expect(guard(req("POST", "/api/boxes", cli))).toBeNull();
  });

  test("WebSocket upgrades from the same origin pass", () => {
    expect(guard(req("GET", "/api/boxes/a/terminal", { origin: APP, upgrade: "websocket" }))).toBeNull();
  });

  test("non-API writes are not subject to the JSON rule", () => {
    const form = { origin: APP, "content-type": "text/plain", "content-length": "1" };
    expect(guard(req("POST", "/login", form))).toBeNull();
  });
});

describe("requireJsonBody", () => {
  test("treats chunked bodies as present", () => {
    const chunked = new Request(`${APP}/api/x`, {
      method: "POST",
      headers: { "transfer-encoding": "chunked", "content-type": "text/plain" },
    });
    expect(statusOf(() => requireJsonBody(chunked))).toBe(415);
  });
});
