import { describe, expect, test } from "bun:test";

import { hostAllowed, normalizeDomain, normalizeEgress, OPEN_EGRESS, presetDomains } from "../src/egress/policy";
import { AppError } from "../src/lib/errors";

function refusal(fn: () => unknown): AppError {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("normalizeDomain", () => {
  test("lowercases, drops a trailing dot and keeps a wildcard prefix", () => {
    expect(normalizeDomain(" Registry.NPMJS.org. ")).toBe("registry.npmjs.org");
    expect(normalizeDomain("*.Example.COM")).toBe("*.example.com");
  });

  test("refuses IP literals, single labels, bad characters and overlong names", () => {
    for (const bad of [
      "10.0.0.1",
      "localhost",
      "exa mple.com",
      "-bad.example.com",
      "a..b.com",
      "",
      "*",
      "*.",
      "x".repeat(254) + ".com",
    ]) {
      expect([bad, normalizeDomain(bad)]).toEqual([bad, null]);
    }
  });
});

describe("hostAllowed", () => {
  const allow = ["api.example.com", "*.example.org"];

  test("matches an exact name, ignoring case and a trailing dot", () => {
    expect(hostAllowed("API.example.com.", allow)).toBe(true);
    expect(hostAllowed("other.example.com", allow)).toBe(false);
  });

  test("a wildcard matches subdomains only, not the apex", () => {
    expect(hostAllowed("deep.sub.example.org", allow)).toBe(true);
    expect(hostAllowed("example.org", allow)).toBe(false);
    expect(hostAllowed("evilexample.org", allow)).toBe(false);
  });
});

describe("normalizeEgress", () => {
  test("open has no presets, domains or allowlist", () => {
    expect(normalizeEgress({ mode: "open" })).toEqual(OPEN_EGRESS);
  });

  test("none takes no options", () => {
    expect(normalizeEgress({ mode: "none" })).toEqual({ mode: "none", presets: [], domains: [], allow: [] });
    const error = refusal(() => normalizeEgress({ mode: "none", domains: ["example.com"] }));
    expect(error.status).toBe(400);
  });

  test("proxy-only expands presets, merges custom domains, and sorts and dedupes the allowlist", () => {
    const policy = normalizeEgress({
      mode: "proxy-only",
      presets: ["package-registries", "package-registries"],
      domains: ["Example.com", "registry.npmjs.org."],
    });
    expect(policy.presets).toEqual(["package-registries"]);
    expect(policy.domains).toEqual(["example.com", "registry.npmjs.org"]);
    expect(policy.allow).toEqual([...new Set([...presetDomains(["package-registries"]), "example.com"])].toSorted());
    expect(policy.allow.filter((host) => host === "registry.npmjs.org")).toHaveLength(1);
  });

  test("proxy-only with no hosts is allowed and allows nothing", () => {
    expect(normalizeEgress({ mode: "proxy-only" })).toEqual({
      mode: "proxy-only",
      presets: [],
      domains: [],
      allow: [],
    });
  });

  test("unknown modes, presets and domains are refused", () => {
    expect(refusal(() => normalizeEgress({ mode: "bridge" as never })).key).toBe("egress_mode_invalid");
    expect(refusal(() => normalizeEgress({ mode: "proxy-only", presets: ["everything"] })).key).toBe(
      "egress_preset_invalid",
    );
    expect(refusal(() => normalizeEgress({ mode: "proxy-only", domains: ["10.1.2.3"] })).key).toBe(
      "egress_domain_invalid",
    );
  });

  test("more than the allowed number of hosts is refused", () => {
    const domains = Array.from({ length: 101 }, (_, i) => `host${i}.example.com`);
    expect(refusal(() => normalizeEgress({ mode: "proxy-only", domains })).key).toBe("egress_domains_too_many");
  });
});
