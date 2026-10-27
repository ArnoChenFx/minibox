import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BOX_PROFILES } from "../src/box-profile";
import { ROOT } from "../src/config";
import { EGRESS_MODES, EGRESS_PRESETS as SERVER_PRESETS } from "../src/egress/policy";
import { STAGED_FIELDS } from "../src/specs/staged";
import en from "../web/js/i18n/en.js";
import zh from "../web/js/i18n/zh-CN.js";
import {
  egressDraftOf,
  egressFieldOf,
  profileFieldOf,
  sameEgressDraft,
  sameTemplate,
  SECURITY_PROFILES,
  templateFieldOf,
} from "../web/js/lib/box-rebuild-fields.js";

const LIB = join(ROOT, "web", "js", "lib");
const COMPONENTS = join(ROOT, "web", "js", "components");

/**
 * Evaluates `body` in a fresh process whose globals stand in for a browser set to `language`. The i18n module reads the
 * language when it loads, so each language needs its own process. `modules` maps a name to the module it imports.
 */
function inBrowser<T>(language: "en-US" | "zh-CN", modules: Record<string, string>, body: string): T {
  const script = [
    `Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {} } });`,
    `Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: [${JSON.stringify(language)}], language: ${JSON.stringify(language)} } });`,
    `const stub = { documentElement: {}, body: {}, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };`,
    `Object.defineProperty(globalThis, "document", { configurable: true, value: stub });`,
    `Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) } });`,
    `Object.defineProperty(globalThis, "location", { configurable: true, value: { hash: "", search: "", pathname: "/", origin: "http://localhost" } });`,
    ...Object.entries(modules).map(([name, path]) => `const ${name} = await import(${JSON.stringify(path)});`),
    `const result = await (async () => {\n${body}\n})();`,
    `console.log(JSON.stringify(result));`,
  ].join("\n");
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000 });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout) as T;
}

const FIELDS = {
  fields: join(LIB, "box-rebuild-fields.js"),
  egress: join(LIB, "egress.js"),
};
const read = (path: string) => readFileSync(path, "utf8");

describe("the staged rebuild settings the console offers", () => {
  test("the template, the egress policy and the profile are fields the server stages", () => {
    for (const field of ["template", "egress", "profile"]) {
      expect([field, (STAGED_FIELDS as readonly string[]).includes(field)]).toEqual([field, true]);
    }
  });

  test("the console offers the profiles the server accepts", () => {
    expect([...SECURITY_PROFILES]).toEqual([...BOX_PROFILES]);
  });

  test("the console offers the egress tiers and presets the server accepts", () => {
    const offered = inBrowser<{ tiers: string[]; presets: string[] }>(
      "en-US",
      FIELDS,
      `return {
      tiers: egress.EGRESS_TIERS,
      presets: egress.EGRESS_PRESETS,
    };`,
    );
    expect(offered.tiers).toEqual([...EGRESS_MODES]);
    expect(offered.presets).toEqual([...SERVER_PRESETS]);
  });
});

describe("the egress field a staged change names", () => {
  test("open and none name the tier alone, since presets and hosts apply to proxy-only", () => {
    expect(egressFieldOf({ mode: "open", presets: ["agent-default"], domains: "a.com" })).toEqual({ mode: "open" });
    expect(egressFieldOf({ mode: "none", presets: [], domains: "" })).toEqual({ mode: "none" });
  });

  test("proxy-only names its presets and the hosts typed, split and deduplicated", () => {
    expect(
      egressFieldOf({ mode: "proxy-only", presets: ["package-registries"], domains: "example.org, *.example.com" }),
    ).toEqual({ mode: "proxy-only", presets: ["package-registries"], domains: ["example.org", "*.example.com"] });
    expect(egressFieldOf({ mode: "proxy-only", presets: [], domains: "pypi.org pypi.org" })).toEqual({
      mode: "proxy-only",
      domains: ["pypi.org"],
    });
  });

  test("a box's policy reads back as the draft its editor starts from", () => {
    expect(
      egressDraftOf({
        mode: "proxy-only",
        presets: ["agent-default"],
        domains: ["example.org", "*.example.com"],
        allow: ["api.anthropic.com", "example.org"],
      }),
    ).toEqual({ mode: "proxy-only", presets: ["agent-default"], domains: "example.org, *.example.com" });
    expect(egressDraftOf(undefined)).toEqual({ mode: "open", presets: [], domains: "" });
  });

  test("two drafts holding the same policy compare equal, and a host typed differently does not", () => {
    const base = { mode: "proxy-only", presets: ["agent-default"], domains: "example.org" };
    expect(sameEgressDraft(base, { ...base, domains: " example.org " })).toBe(true);
    expect(sameEgressDraft(base, { ...base, domains: "example.com" })).toBe(false);
    expect(
      sameEgressDraft(
        { mode: "none", presets: [], domains: "" },
        { mode: "none", presets: ["agent-default"], domains: "" },
      ),
    ).toBe(true);
    expect(sameEgressDraft({ mode: "open", presets: [], domains: "" }, base)).toBe(false);
  });
});

describe("the profile field a staged change names", () => {
  test("a profile the console offers is staged as it is", () => {
    expect(profileFieldOf("strict")).toEqual({ profile: "strict" });
    expect(profileFieldOf("relaxed")).toEqual({ profile: "relaxed" });
  });

  test("a name the console does not offer is refused rather than staged", () => {
    expect(profileFieldOf("")).toBeNull();
    expect(profileFieldOf("root")).toBeNull();
  });
});

describe("the template field a staged change names", () => {
  test("a reference the server accepts is staged trimmed", () => {
    expect(templateFieldOf("  node:24-bookworm-slim ")).toEqual({ template: "node:24-bookworm-slim" });
    expect(templateFieldOf("mbtest-template:base")).toEqual({ template: "mbtest-template:base" });
  });

  test("an empty or malformed reference names the dictionary key of its refusal", () => {
    expect(templateFieldOf("")).toEqual({ problem: "tp.errImageRef" });
    expect(templateFieldOf("  ")).toEqual({ problem: "tp.errImageRef" });
    expect(templateFieldOf("node 24")).toEqual({ problem: "tp.errImageRef" });
  });

  test("a reference the box already runs compares the same, so a save that changes nothing stages nothing", () => {
    expect(sameTemplate({ template: "node:24" }, " node:24 ")).toBe(true);
    expect(sameTemplate({ template: "node:24" }, "node:22")).toBe(false);
    expect(sameTemplate({}, "")).toBe(true);
  });
});

describe("the staged settings are named in both languages", () => {
  test("every staged field has its own name in English and in Chinese", () => {
    for (const field of STAGED_FIELDS) {
      const key = `rebuild.field.${field}`;
      expect([key, key in en && key in zh && en[key] !== zh[key]]).toEqual([key, true]);
    }
  });

  test("the three cards name their own state, help and pending note in both languages", () => {
    const keys = [
      "bd.templateCard",
      "bd.templateHelp",
      "bd.templatePendingHelp",
      "bd.templateEditHelp",
      "bd.securityHelp",
      "bd.profilePendingHelp",
      "bd.profileEditHelp",
      "bd.profileSaveNote",
      "bd.profileInvalid",
      "egress.edit",
      "egress.editHelp",
      "egress.pendingHelp",
      "egress.saveNote",
    ];
    for (const key of keys) expect([key, key in en && key in zh && en[key] !== zh[key]]).toEqual([key, true]);
  });
});

describe("the cards stage instead of rebuilding", () => {
  const cards = {
    template: join(COMPONENTS, "box-template-card.js"),
    security: join(COMPONENTS, "box-security-card.js"),
    egress: join(COMPONENTS, "egress-card.js"),
  };
  const settings = join(COMPONENTS, "box-settings.js");

  test("each card stages through the shared helper and posts no rebuild of its own", () => {
    for (const [name, path] of Object.entries(cards)) {
      const source = read(path);
      expect([name, source.includes("stageFields(")]).toEqual([name, true]);
      expect([name, /\/rebuild`/.test(source)]).toEqual([name, false]);
    }
  });

  test("each card reads the staged changes and follows every announcement, so it and the banner draw one state", () => {
    for (const [name, path] of Object.entries(cards)) {
      const source = read(path);
      expect([name, source.includes("onStaged(")]).toEqual([name, true]);
      expect([name, source.includes("fetchStaged(")]).toEqual([name, true]);
    }
  });

  test("the security section mounts the template, egress and profile cards under the staged banner", () => {
    const source = read(settings);
    for (const id of ["bsTemplate", "bsEgress", "bsSecurity"]) expect([id, source.includes(id)]).toEqual([id, true]);
    for (const mount of ["mountTemplateCard", "mountEgressCard", "mountSecurityCard", "mountStagedBanner"]) {
      expect([mount, source.includes(mount)]).toEqual([mount, true]);
    }
    // The section no longer draws a read-only card of its own.
    expect(source.includes("securityRows")).toBe(false);
    expect(source.includes("kvCard")).toBe(false);
  });

  test("a card marks what it staged as pending, so the page says the box has not changed yet", () => {
    expect(read(cards.template)).toContain("data-template-pending");
    expect(read(cards.security)).toContain("data-profile-pending");
    expect(read(cards.egress)).toContain("data-egress-pending");
    for (const path of Object.values(cards)) expect(read(path)).toContain("stg.pendingBadge");
  });
});
