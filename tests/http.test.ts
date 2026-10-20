import { describe, expect, test } from "bun:test";

import { json, withSecurityHeaders } from "../src/lib/http";

function parseCsp(policy: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out[name] = sources;
  }
  return out;
}

const policyOf = (res: Response) => parseCsp(res.headers.get("content-security-policy") ?? "");

describe("security headers", () => {
  test("every response carries the console's Content-Security-Policy", () => {
    const policy = policyOf(withSecurityHeaders(new Response("ok"), false));
    expect(policy["default-src"]).toEqual(["'self'"]);
    expect(policy["frame-ancestors"]).toEqual(["'none'"]);
    expect(policy["base-uri"]).toEqual(["'none'"]);
    expect(policy["object-src"]).toEqual(["'none'"]);
  });

  test("scripts come from MiniBox only: no inline code, eval or third-party hosts", () => {
    expect(policyOf(withSecurityHeaders(new Response("ok"), true))["script-src"]).toEqual(["'self'"]);
  });

  test("websocket terminals stay allowed", () => {
    expect(policyOf(withSecurityHeaders(new Response("ok"), false))["connect-src"]).toEqual(["'self'", "ws:", "wss:"]);
  });

  test("HSTS is sent only for HTTPS requests, without includeSubDomains", () => {
    expect(withSecurityHeaders(new Response("ok"), false).headers.get("strict-transport-security")).toBeNull();
    expect(withSecurityHeaders(new Response("ok"), true).headers.get("strict-transport-security")).toBe(
      "max-age=31536000",
    );
  });

  test("keeps the hardening headers and sets cross-origin isolation headers", () => {
    const res = withSecurityHeaders(json({ ok: true }), false);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  test("headers set by a handler are kept", () => {
    const res = withSecurityHeaders(json({ ok: true }, 200, { "set-cookie": "a=b" }), false);
    expect(res.headers.get("set-cookie")).toBe("a=b");
  });
});
