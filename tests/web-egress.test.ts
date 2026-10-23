import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { ROOT } from "../src/config";
import { EGRESS_MODES, EGRESS_PRESETS as SERVER_PRESETS } from "../src/egress/policy";
import { PROXY_PROGRAM } from "../src/egress/proxy";
import en from "../web/js/i18n/en.js";
import zh from "../web/js/i18n/zh-CN.js";
import {
  DENIAL_REASONS,
  denialReasonKey,
  domainsOf,
  EGRESS_PRESETS,
  EGRESS_TIERS,
  egressRequestOf,
  presetHintKey,
  presetKey,
  tierHintKey,
  tierKey,
} from "../web/js/lib/egress.js";

const CARD = join(ROOT, "web", "js", "components", "egress-card.js");

const stubs = [
  `const stub = { documentElement: {}, body: {}, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };`,
  `Object.defineProperty(globalThis, "document", { configurable: true, value: stub });`,
  `Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {} } });`,
  `Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"], language: "en-US" } });`,
];

interface CardCase {
  box: Record<string, unknown>;
  denials?: unknown[] | null;
  denialsError?: string;
}

/** Renders the network card for each case, in a fresh process with the browser globals the card's modules read at import. */
function renderCards<K extends string>(cases: Record<K, CardCase>): Record<K, string> {
  const script = [
    ...stubs,
    `const { egressCardHtml } = await import(${JSON.stringify(CARD)});`,
    `const cases = ${JSON.stringify(cases)};`,
    `console.log(JSON.stringify(Object.fromEntries(Object.entries(cases).map(([k, c]) => [k, egressCardHtml(c)]))));`,
  ].join("\n");
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000 });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout) as Record<K, string>;
}

const denial = (host: string, port: number, reason: string) => ({
  seq: 1,
  ts: Date.UTC(2026, 9, 23, 12, 0, 0),
  op: "egress.denied",
  status: "denied",
  target: { kind: "box", id: "c_1", name: "dev" },
  detail: { host, port, reason },
});

describe("egress choices", () => {
  test("the console offers the tiers and presets the server accepts", () => {
    expect(EGRESS_TIERS).toEqual([...EGRESS_MODES]);
    expect(EGRESS_PRESETS).toEqual([...SERVER_PRESETS]);
  });

  test("the console names every reason the proxy can deny a connection for", () => {
    const emitted = new Set([...PROXY_PROGRAM.matchAll(/deny: '(\w+)'/g)].map((match) => match[1] ?? ""));
    expect([...emitted].toSorted()).toEqual([...DENIAL_REASONS].toSorted());
  });

  test("every tier, preset and denial reason has a label and a hint in both languages", () => {
    const keys = [
      ...EGRESS_TIERS.flatMap((mode) => [tierKey(mode), tierHintKey(mode)]),
      ...EGRESS_PRESETS.flatMap((preset) => [presetKey(preset), presetHintKey(preset)]),
      ...DENIAL_REASONS.map(denialReasonKey),
    ];
    for (const key of keys) expect([key, key in en && key in zh]).toEqual([key, true]);
  });

  test("keys take the camel-case form of their ids", () => {
    expect(tierKey("proxy-only")).toBe("egress.tier.proxyOnly");
    expect(presetHintKey("package-registries")).toBe("egress.presetHint.packageRegistries");
  });
});

describe("domainsOf", () => {
  test("splits on commas, spaces and line breaks, and drops repeats", () => {
    expect(domainsOf("pypi.org,  crates.io\n*.example.com\tpypi.org")).toEqual([
      "pypi.org",
      "crates.io",
      "*.example.com",
    ]);
  });

  test("text with no hosts names none", () => {
    expect(domainsOf("")).toEqual([]);
    expect(domainsOf(undefined)).toEqual([]);
    expect(domainsOf(" , \n ")).toEqual([]);
  });
});

describe("egressRequestOf", () => {
  test("an open create sends no egress, so its body is what it was before", () => {
    expect(egressRequestOf({ mode: "open", presets: ["agent-default"], domains: "a.com" })).toBeUndefined();
  });

  test("none sends the mode alone, since presets and hosts apply to proxy-only only", () => {
    expect(egressRequestOf({ mode: "none", presets: ["agent-default"], domains: "a.com" })).toEqual({ mode: "none" });
  });

  test("proxy-only sends the presets it names and the hosts it lists", () => {
    expect(
      egressRequestOf({ mode: "proxy-only", presets: ["package-registries"], domains: "example.org, *.example.com" }),
    ).toEqual({ mode: "proxy-only", presets: ["package-registries"], domains: ["example.org", "*.example.com"] });
  });

  test("proxy-only with no presets or hosts sends the mode alone", () => {
    expect(egressRequestOf({ mode: "proxy-only", presets: [], domains: "  " })).toEqual({ mode: "proxy-only" });
  });
});

describe("network card", () => {
  const proxyBox = {
    id: "c_1",
    egress: {
      mode: "proxy-only",
      presets: ["agent-default"],
      domains: ["example.org"],
      allow: ["api.anthropic.com", "example.org"],
    },
  };

  const html = renderCards({
    open: { box: { id: "c_1" } },
    none: { box: { id: "c_1", egress: { mode: "none", presets: [], domains: [], allow: [], subnet: "240.0.1.0/28" } } },
    proxied: { box: proxyBox, denials: [denial("evil.test", 443, "not_allowed"), denial("pypi.org", 80, "port")] },
    pending: { box: proxyBox, denials: null },
    quiet: { box: proxyBox, denials: [] },
    failed: { box: proxyBox, denials: null, denialsError: "the event store is busy" },
    unlisted: { box: { id: "c_1", egress: { ...proxyBox.egress, presets: [], domains: [], allow: [] } }, denials: [] },
    escaped: { box: proxyBox, denials: [denial("<img src=x onerror=alert(1)>", 443, "dns_failed")] },
    unknown: { box: proxyBox, denials: [denial("evil.test", 443, "something_new")] },
  });

  test("an open box shows its tier and no allowlist or denials", () => {
    expect(html.open).toContain("Reaches the internet like any container.");
    expect(html.open).not.toContain("Recent denials");
  });

  test("a box with no route out says so and has no denials to show", () => {
    expect(html.none).toContain("No route out. Exec, SSH and preview still work.");
    expect(html.none).not.toContain("Recent denials");
  });

  test("a proxy-only box lists its presets, its allowlist and its recent denials", () => {
    expect(html.proxied).toContain("Proxy only");
    expect(html.proxied).toContain("Agent defaults");
    expect(html.proxied).toContain("api.anthropic.com");
    expect(html.proxied).toContain("evil.test:443");
    expect(html.proxied).toContain("Host not on the allowlist");
    expect(html.proxied).toContain("Port not allowed");
  });

  test("the denials show a loading row until they are read, and a note when there are none", () => {
    expect(html.pending).toContain('class="skeleton sk-line"');
    expect(html.quiet).toContain("No connection has been refused.");
  });

  test("a failed read says so and keeps the tier on the card", () => {
    expect(html.failed).toContain("load recent denials.");
    expect(html.failed).toContain("the event store is busy");
    expect(html.failed).toContain("Proxy only");
  });

  test("a proxy-only box with no hosts says that it reaches nothing", () => {
    expect(html.unlisted).toContain("No host is allowed, so the box reaches nothing.");
  });

  test("a destination the proxy logged is escaped, so it never runs as markup", () => {
    expect(html.escaped).not.toContain("<img");
    expect(html.escaped).toContain("&lt;img src=x onerror=alert(1)&gt;:443");
  });

  test("a reason the console does not know is shown as the proxy wrote it", () => {
    expect(html.unknown).toContain("something_new");
  });
});
