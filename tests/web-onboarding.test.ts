import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "../src/config";
import en from "../web/js/i18n/en.js";
import zh from "../web/js/i18n/zh-CN.js";
import {
  baseTemplateState,
  defaultPreset,
  isBaseBuilt,
  loadOnboardingState,
  mcpSnippet,
  onboardingShown,
  ONBOARDING_STEPS,
  onboardingSteps,
  saveOnboardingState,
  tokenName,
  tokenRequest,
} from "../web/js/lib/onboarding.js";

const BASE = "mbtest-template:base";

const TEMPLATES = {
  baseTemplate: BASE,
  templates: [
    { ref: "node:24", hostId: "local", size: 1024 },
    { ref: BASE, hostId: "local", size: 2048 },
  ],
};

const CATALOG = {
  groups: [],
  presets: [
    { name: "readonly", scopes: ["box:read", "files:read"], boxes: "created-by-me", hosts: "local" },
    { name: "operator", scopes: ["box:read", "box:write", "exec"], boxes: "created-by-me", hosts: "local" },
    { name: "sandboxed-agent", scopes: ["box:read", "box:write", "exec"], boxes: "created-by-me", hosts: "local" },
    { name: "admin", scopes: ["box:read", "box:write", "exec"], boxes: "all", hosts: "all" },
  ],
};

const COMPONENT = readFileSync(join(ROOT, "web", "js", "components", "onboarding.js"), "utf8");
/** Product names, which read the same in both languages. */
const PROPER_NAMES = new Set(["ob.client.claudeCode", "ob.client.codex"]);

/** A localStorage stand-in, so the state a browser would keep can be read and written here. */
const store = new Map<string, string>();
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  },
});

afterEach(() => store.clear());
afterAll(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("when the guide is shown", () => {
  test("a console with no box shows it, and a page that opens with a box never does", () => {
    expect(onboardingShown({ boxes: [], state: { dismissed: false, done: false, client: "" } })).toBe(true);
    expect(onboardingShown({ boxes: [{ boxId: "bx_1" }], state: { dismissed: false, done: false, client: "" } })).toBe(
      false,
    );
  });

  test("a guide already open keeps its last step reachable when the first box appears", () => {
    // The page drew the guide while there was no box, so the box the user just created does not cut the guide off
    // before the agent step: it moves to that step instead, and a reload then leaves it away.
    const state = { dismissed: false, done: false, client: "" as const };
    expect(onboardingShown({ boxes: [{ boxId: "bx_1" }], state, inProgress: true })).toBe(true);
    // Hiding it or finishing it still ends it at once, whatever the page showed before.
    expect(onboardingShown({ boxes: [], state: { ...state, dismissed: true }, inProgress: true })).toBe(false);
    expect(onboardingShown({ boxes: [], state: { ...state, done: true }, inProgress: true })).toBe(false);
    expect(onboardingShown({ boxes: null, state, inProgress: true })).toBe(false);
  });

  test("a box retires the guide whatever this browser saved, so the box list is the judge", () => {
    // A dismissal and a finished guide are both remembered, and a box overrides neither into showing the guide.
    const saved = [
      { dismissed: true, done: false, client: "" as const },
      { dismissed: false, done: true, client: "" as const },
      { dismissed: true, done: true, client: "" as const },
    ];
    for (const state of saved) {
      expect(onboardingShown({ boxes: [{ boxId: "bx_1" }], state })).toBe(false);
    }
    expect(onboardingShown({ boxes: [], state: { dismissed: true, done: false, client: "" } })).toBe(false);
    expect(onboardingShown({ boxes: [], state: { dismissed: false, done: true, client: "" } })).toBe(false);
  });

  test("a box list that has not been read yet shows nothing, so the guide cannot flash on a console that has boxes", () => {
    expect(onboardingShown({ boxes: null, state: { dismissed: false, done: false, client: "" } })).toBe(false);
    expect(onboardingShown({ boxes: undefined, state: null })).toBe(false);
  });
});

describe("which step is open", () => {
  test("the steps are the base template, a box and the agent, in that order", () => {
    expect(ONBOARDING_STEPS).toEqual(["template", "box", "agent"]);
    expect(onboardingSteps({ templates: null, boxes: [] }).map((step) => step.id)).toEqual([
      "template",
      "box",
      "agent",
    ]);
  });

  test("with nothing done the first step is open and the two after it stay shut", () => {
    const steps = onboardingSteps({ templates: { baseTemplate: BASE, templates: [] }, boxes: [] });
    expect(steps.map((step) => [step.id, step.done, step.open, step.locked])).toEqual([
      ["template", false, true, false],
      ["box", false, false, true],
      ["agent", false, false, true],
    ]);
  });

  test("a built base template moves the open step to the box, and a box moves it to the agent", () => {
    const built = onboardingSteps({ templates: TEMPLATES, boxes: [] });
    expect(built.map((step) => [step.id, step.done, step.open, step.locked])).toEqual([
      ["template", true, false, false],
      ["box", false, true, false],
      ["agent", false, false, true],
    ]);
    const boxed = onboardingSteps({ templates: TEMPLATES, boxes: [{ boxId: "bx_1" }] });
    expect(boxed.map((step) => [step.id, step.done, step.open])).toEqual([
      ["template", true, false],
      ["box", true, false],
      ["agent", false, true],
    ]);
  });

  test("the agent step is done once it has created a token, and then no step is open", () => {
    const steps = onboardingSteps({ templates: TEMPLATES, boxes: [{ boxId: "bx_1" }], agentDone: true });
    expect(steps.every((step) => step.done)).toBe(true);
    expect(steps.some((step) => step.open)).toBe(false);
    expect(steps.some((step) => step.locked)).toBe(false);
  });

  test("a step before an open one is never locked, even when the steps after it are done", () => {
    // A template missing on a console that already has a box is an odd state, and the guide still opens that step.
    const steps = onboardingSteps({ templates: { baseTemplate: BASE, templates: [] }, boxes: [{ boxId: "bx_1" }] });
    expect(steps.map((step) => [step.id, step.open, step.locked])).toEqual([
      ["template", true, false],
      ["box", false, false],
      ["agent", false, true],
    ]);
  });
});

describe("the base template step", () => {
  test("a list that has not answered yet is unknown, so the step says it is reading rather than claiming a state", () => {
    expect(baseTemplateState(null)).toEqual({
      status: "unknown",
      ref: "",
      hosts: [],
      buildable: false,
      reason: "reading",
    });
    expect(isBaseBuilt(null)).toBe(false);
  });

  test("a host that holds the base template finishes the step, and one that does not offers the build", () => {
    expect(baseTemplateState(TEMPLATES)).toEqual({
      status: "built",
      ref: BASE,
      hosts: ["local"],
      buildable: false,
      reason: "",
    });
    expect(baseTemplateState({ baseTemplate: BASE, templates: [{ ref: "node:24", hostId: "local" }] })).toEqual({
      status: "missing",
      ref: BASE,
      hosts: [],
      buildable: true,
      reason: "",
    });
  });

  test("the step follows the base template's own reference, not the first template on the host", () => {
    // A host holding only other templates has not built the base one, so its step is still the one to do.
    expect(isBaseBuilt({ baseTemplate: BASE, templates: [{ ref: "python:3", hostId: "local" }] })).toBe(false);
    // Two hosts holding it both count, and the step names each of them.
    const both = baseTemplateState({
      baseTemplate: BASE,
      templates: [
        { ref: BASE, hostId: "local" },
        { ref: BASE, hostId: "box-2" },
      ],
    });
    expect(both.hosts).toEqual(["local", "box-2"]);
    expect(both.status).toBe("built");
  });
});

describe("the agent step", () => {
  test("Claude Code and Codex start from the sandboxed agent preset, and another client from read only", () => {
    expect(defaultPreset("claude-code", CATALOG)).toBe("sandboxed-agent");
    expect(defaultPreset("codex", CATALOG)).toBe("sandboxed-agent");
    expect(defaultPreset("other", CATALOG)).toBe("readonly");
  });

  test("a catalog without the preferred preset falls back to the first one it lists", () => {
    const slim = { presets: [{ name: "operator", scopes: ["box:read"] }] };
    expect(defaultPreset("claude-code", slim)).toBe("operator");
    expect(defaultPreset("other", { presets: [] })).toBe("readonly");
    expect(defaultPreset("claude-code", null)).toBe("sandboxed-agent");
  });

  test("the token the step creates is named for its client, so a second run is recognisable in Settings", () => {
    expect(tokenName("claude-code")).toBe("first-claude-code");
    expect(tokenName("codex")).toBe("first-codex");
    expect(tokenName("other")).toBe("first-other");
    expect(tokenName("unknown")).toBe("first-agent");
    expect(tokenRequest({ client: "codex", preset: "sandboxed-agent" })).toEqual({
      name: "first-codex",
      preset: "sandboxed-agent",
    });
  });

  test("a name the console already has is skipped, so a guide that runs again is not refused", () => {
    // A token keeps its name after it is revoked, so the guide must look at the whole list, not only live tokens.
    expect(tokenName("codex", ["first-codex"])).toBe("first-codex-2");
    expect(tokenName("codex", ["First-Codex", "first-codex-2"])).toBe("first-codex-3");
    expect(tokenName("codex", ["first-other"])).toBe("first-codex");
    expect(tokenRequest({ client: "codex", preset: "sandboxed-agent", taken: ["first-codex"] })).toEqual({
      name: "first-codex-2",
      preset: "sandboxed-agent",
    });
    // A base at the 63-character limit keeps the suffix rather than growing past it.
    const long = ["first-agent"];
    const name = tokenName("unknown", long);
    expect(name).toBe("first-agent-2");
    expect(name.length).toBeLessThanOrEqual(63);
  });

  test("Claude Code gets a .mcp.json entry with a type, which its config needs to read a url", () => {
    const snippet = mcpSnippet({ client: "claude-code", origin: "http://127.0.0.1:3920", secret: "mbx_secret" });
    expect(snippet.kind).toBe("json");
    expect(snippet.path).toBe(".mcp.json");
    expect(JSON.parse(snippet.text)).toEqual({
      mcpServers: {
        minibox: {
          type: "http",
          url: "http://127.0.0.1:3920/mcp",
          headers: { Authorization: "Bearer mbx_secret" },
        },
      },
    });
  });

  test("Codex gets a config.toml table with the token in a plain header", () => {
    const snippet = mcpSnippet({ client: "codex", origin: "http://127.0.0.1:3920", secret: "mbx_secret" });
    expect(snippet.kind).toBe("toml");
    expect(snippet.path).toBe("~/.codex/config.toml");
    expect(snippet.text).toBe(
      [
        "[mcp_servers.minibox]",
        'url = "http://127.0.0.1:3920/mcp"',
        'http_headers = { "Authorization" = "Bearer mbx_secret" }',
      ].join("\n"),
    );
  });

  test("any other client gets the plain JSON the token dialog shows, with no type of its own", () => {
    const snippet = mcpSnippet({ client: "other", origin: "https://minibox.example.com/", secret: "mbx_secret" });
    expect(snippet.kind).toBe("json");
    expect(snippet.path).toBe("mcpServers");
    expect(JSON.parse(snippet.text)).toEqual({
      mcpServers: {
        minibox: { url: "https://minibox.example.com/mcp", headers: { Authorization: "Bearer mbx_secret" } },
      },
    });
  });

  test("the origin's trailing slash and a missing secret never break the snippet", () => {
    // A URL of `//mcp` or a header of `Bearer undefined` would be pasted as it is, so both are normalised here.
    expect(mcpSnippet({ client: "other", origin: "http://host:1//", secret: null }).text).toContain(
      '"url": "http://host:1/mcp"',
    );
    expect(mcpSnippet({ client: "codex", origin: "http://host:1", secret: undefined }).text).toContain(
      '"Authorization" = "Bearer "',
    );
    expect(mcpSnippet({ client: "claude-code", origin: null, secret: "s" }).text).toContain('"url": "/mcp"');
  });

  test("the snippet carries the token once, in the header, and nowhere else", () => {
    for (const client of ["claude-code", "codex", "other"]) {
      const text = mcpSnippet({ client, origin: "http://host:1", secret: "mbx_secret" }).text;
      expect([client, text.split("mbx_secret").length - 1]).toEqual([client, 1]);
    }
  });
});

describe("what this browser remembers", () => {
  test("nothing saved reads as neither dismissed nor done, with no client chosen", () => {
    expect(loadOnboardingState()).toEqual({ dismissed: false, done: false, client: "" });
  });

  test("a saved choice is kept, and saving one field keeps the others", () => {
    saveOnboardingState({ client: "codex" });
    saveOnboardingState({ dismissed: true });
    expect(loadOnboardingState()).toEqual({ dismissed: true, done: false, client: "codex" });
    saveOnboardingState({ done: true });
    expect(loadOnboardingState()).toEqual({ dismissed: true, done: true, client: "codex" });
  });

  test("a saved client the guide does not offer reads as none, and a broken value as nothing saved", () => {
    store.set("minibox.onboarding.v1", JSON.stringify({ client: "vim" }));
    expect(loadOnboardingState().client).toBe("");
    store.set("minibox.onboarding.v1", "{oops");
    expect(loadOnboardingState()).toEqual({ dismissed: false, done: false, client: "" });
    store.set("minibox.onboarding.v1", JSON.stringify(["codex"]));
    expect(loadOnboardingState()).toEqual({ dismissed: false, done: false, client: "" });
  });

  test("storage that refuses to save still returns the state for this page view", () => {
    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    const saved = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: failing });
    try {
      expect(saveOnboardingState({ client: "codex" })).toEqual({ dismissed: false, done: false, client: "codex" });
    } finally {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: saved });
    }
  });
});

describe("the guide's wiring", () => {
  test("every string the guide shows is in both dictionaries, and the Chinese is its own text", () => {
    const keys = [...COMPONENT.matchAll(/\bt\("([\w.]+)"/g), ...COMPONENT.matchAll(/key: "([\w.]+)"/g)].map(
      (m) => m[1] ?? "",
    );
    expect(keys.length).toBeGreaterThan(20);
    for (const key of new Set(keys)) {
      // `st.preset.*` comes from the settings dictionary the guide reuses for the preset names.
      const own = key.startsWith("st.") ? null : key;
      expect([key, typeof en[key], own === null ? "string" : typeof zh[key]]).toEqual([key, "string", "string"]);
      // A client's own name is a product name, so it reads the same in both languages.
      if (own !== null && !PROPER_NAMES.has(key)) expect([key, zh[key] !== en[key]]).toEqual([key, true]);
    }
  });

  test("the guide names the client's file and says the secret is shown once, in both languages", () => {
    expect(en["ob.agentSecretOnce"]).toMatch(/only time/i);
    expect(zh["ob.agentSecretOnce"]).toContain("只会显示这一次");
    expect(en["ob.agentSnippetWhere"]).toContain("{path}");
    expect(zh["ob.agentSnippetWhere"]).toContain("{path}");
  });
});
