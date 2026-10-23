import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { ROOT } from "../src/config";
import en from "../web/js/i18n/en.js";
import zh from "../web/js/i18n/zh-CN.js";

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

const SETTINGS = { settings: join(LIB, "box-settings.js") };
const CHIPS = { panel: join(COMPONENTS, "terminal-panel.js") };

describe("the settings sections of a box", () => {
  test("the sub-nav lists seven sections in order, and none of them is a history section", () => {
    const ids = inBrowser<string[]>("en-US", SETTINGS, `return settings.BOX_SETTINGS.map((section) => section.id);`);
    expect(ids).toEqual(["resources", "storage", "tools", "env", "lifecycle", "security", "checkpoints"]);
  });

  test("the sections are named in English and in Chinese", () => {
    const english = inBrowser<string[]>(
      "en-US",
      SETTINGS,
      `return settings.BOX_SETTINGS.map((section) => section.label);`,
    );
    const chinese = inBrowser<string[]>(
      "zh-CN",
      SETTINGS,
      `return settings.BOX_SETTINGS.map((section) => section.label);`,
    );
    expect(english.map((key) => en[key as keyof typeof en])).toEqual([
      "Resources",
      "Storage and mounts",
      "Tools",
      "Environment variables",
      "Lifecycle",
      "Security",
      "Checkpoints",
    ]);
    expect(chinese.map((key) => zh[key as keyof typeof zh])).toEqual([
      "资源",
      "存储与挂载",
      "工具",
      "环境变量",
      "生命周期",
      "安全",
      "检查点",
    ]);
  });

  test("a settings address with no section, or with one that does not exist, shows the first section", () => {
    const picked = inBrowser<string[]>(
      "en-US",
      SETTINGS,
      `return [undefined, "", "history", "resources", "checkpoints"].map((name) => settings.boxSettingsOf(name).id);`,
    );
    expect(picked).toEqual(["resources", "resources", "resources", "resources", "checkpoints"]);
  });
});

const chip = (language: "en-US" | "zh-CN", session: Record<string, unknown>, current = "") =>
  inBrowser<string>(
    language,
    CHIPS,
    `return panel.sessionChipHtml(${JSON.stringify(session)}, ${JSON.stringify(current)});`,
  );

describe("the origin marker of a terminal session", () => {
  test("a session a person created reads Created by you, and is the current one when it is open", () => {
    const html = chip("en-US", { name: "console", origin: "human", controller: "human" }, "console");
    expect(html).toContain('data-session="console"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('title="Created by you"');
    expect(html).toContain('<span class="chip-meta">Created by you</span>');
  });

  test("an agent's session reads Created by agent, and a session with no origin mark reads the same way", () => {
    const agent = chip("en-US", { name: "build", origin: "agent", controller: "agent" });
    expect(agent).toContain('<span class="chip-meta">Created by agent</span>');
    expect(agent).toContain('aria-pressed="false"');
    const unmarked = chip("en-US", { name: "minibox-init", controller: "agent" });
    expect(unmarked).toContain('<span class="chip-meta">Created by agent</span>');
  });

  test("the markers are Chinese in zh-CN", () => {
    expect(chip("zh-CN", { name: "console", origin: "human" })).toContain('<span class="chip-meta">你创建</span>');
    expect(chip("zh-CN", { name: "build", origin: "agent" })).toContain('<span class="chip-meta">Agent 创建</span>');
  });

  test("the session name is escaped, so a name never becomes markup", () => {
    const html = chip("en-US", { name: 'a"><img src=x>', origin: "agent" });
    expect(html).toContain('data-session="a&quot;&gt;&lt;img src=x&gt;"');
    expect(html).not.toContain("<img");
  });
});
