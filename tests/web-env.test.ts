import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { ROOT } from "../src/config";
import {
  canonicalEnv,
  checkEnvRows,
  ENV_MAX,
  ENV_VALUE_MAX,
  type EnvRow,
  envRowsOf,
  isEnvErrorKey,
  validSecretValue,
} from "../web/js/lib/env.js";

const ENV_EDITOR = join(ROOT, "web", "js", "components", "env-editor.js");
const BOX_ACTIONS = join(ROOT, "web", "js", "components", "box-actions.js");

const plain = (name: string, value: string): EnvRow => ({ name, kind: "value", value, secretRef: "" });
const secret = (name: string, secretRef: string): EnvRow => ({ name, kind: "secret", value: "", secretRef });
const plainRows = (n: number): EnvRow[] => Array.from({ length: n }, (_, i) => plain(`V${i}`, ""));

describe("env rows", () => {
  test("a name follows the server's rule: a letter or underscore first, then letters, digits and underscores", () => {
    expect(checkEnvRows([plain("_OK_1", "x")])).toEqual({ env: [{ name: "_OK_1", value: "x" }] });
    for (const name of ["1A", "a.b", "A-B", "A B", ""]) {
      expect([name, checkEnvRows([plain(name, "x")])]).toEqual([name, { problem: { code: "name" } }]);
    }
  });

  test("a name is trimmed, and the same name twice is refused", () => {
    expect(checkEnvRows([plain(" A ", "1"), plain("A", "2")])).toEqual({ problem: { code: "duplicate", name: "A" } });
  });

  test("a secret row sends its secret name and no value, whatever the value field holds", () => {
    expect(checkEnvRows([{ name: "TOKEN", kind: "secret", value: "stale", secretRef: "gh-token" }])).toStrictEqual({
      env: [{ name: "TOKEN", secretRef: "gh-token" }],
    });
  });

  test("a secret row with no secret chosen, or with a name the store refuses, is refused", () => {
    expect(checkEnvRows([secret("TOKEN", "")])).toEqual({ problem: { code: "secret", name: "TOKEN" } });
    expect(checkEnvRows([secret("TOKEN", "bad name")])).toEqual({ problem: { code: "secret", name: "TOKEN" } });
  });

  test("a plain value with a control character is refused, and the length limit is the server's", () => {
    for (const value of ["a\nb", "a\tb", "a\u0000b", "x".repeat(ENV_VALUE_MAX + 1)]) {
      expect(checkEnvRows([plain("A", value)])).toEqual({ problem: { code: "value", name: "A" } });
    }
    expect(checkEnvRows([plain("A", "x".repeat(ENV_VALUE_MAX))])).toEqual({
      env: [{ name: "A", value: "x".repeat(ENV_VALUE_MAX) }],
    });
  });

  test("a box takes at most ENV_MAX variables", () => {
    expect(checkEnvRows(plainRows(ENV_MAX))).toEqual({ env: expect.any(Array) });
    expect(checkEnvRows(plainRows(ENV_MAX + 1))).toEqual({ problem: { code: "count", max: ENV_MAX } });
  });

  test("the env list of a box maps to rows without any secret value", () => {
    expect(
      envRowsOf([
        { name: "MODE", value: "dev" },
        { name: "TOKEN", secretRef: "gh-token" },
      ]),
    ).toEqual([
      { name: "MODE", kind: "value", value: "dev", secretRef: "" },
      { name: "TOKEN", kind: "secret", value: "", secretRef: "gh-token" },
    ]);
    expect(envRowsOf(null)).toEqual([]);
  });
});

describe("env comparison", () => {
  test("two lists with the same entries in another order are the same, so a save sends nothing", () => {
    const a = [
      { name: "B", value: "2" },
      { name: "A", secretRef: "s" },
    ];
    const b = [
      { name: "A", secretRef: "s" },
      { name: "B", value: "2" },
    ];
    expect(canonicalEnv(a)).toBe(canonicalEnv(b));
  });

  test("a plain value and a secret of the same name are different entries", () => {
    expect(canonicalEnv([{ name: "A", value: "s" }])).not.toBe(canonicalEnv([{ name: "A", secretRef: "s" }]));
  });
});

describe("secret values and error keys", () => {
  test("a secret value is 1 to ENV_VALUE_MAX characters with no control character", () => {
    expect(validSecretValue("")).toBe(false);
    expect(validSecretValue("x")).toBe(true);
    expect(validSecretValue("x".repeat(ENV_VALUE_MAX))).toBe(true);
    expect(validSecretValue("x".repeat(ENV_VALUE_MAX + 1))).toBe(false);
    expect(validSecretValue("a\nb")).toBe(false);
  });

  test("the env errors are the ones the create dialog shows in its Environment section", () => {
    for (const key of ["env_invalid", "env_secret_missing", "secret_reference_forbidden"]) {
      expect(isEnvErrorKey(key)).toBe(true);
    }
    for (const key of ["secret_in_use", "mount_invalid", "volume_missing", undefined]) {
      expect(isEnvErrorKey(key)).toBe(false);
    }
  });
});

/** Loads a browser module in a fresh process, with the globals it reads at import, and returns what `call` renders. */
function inBrowser(moduleFile: string, call: string): string {
  const stubs = [
    `const stub = { documentElement: {}, body: {}, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };`,
    `Object.defineProperty(globalThis, "document", { configurable: true, value: stub });`,
    `Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {} } });`,
    `Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"], language: "en-US" } });`,
    `Object.defineProperty(globalThis, "location", { configurable: true, value: { hash: "", search: "", pathname: "/", origin: "http://localhost" } });`,
  ];
  const script = [
    ...stubs,
    `const mod = await import(${JSON.stringify(moduleFile)});`,
    `console.log(JSON.stringify(${call}));`,
  ].join("\n");
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000 });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout) as string;
}

function rowMarkup(row: Record<string, string>, secrets: string[] | null): string {
  return inBrowser(ENV_EDITOR, `mod.envRowHtml(${JSON.stringify(row)}, ${JSON.stringify(secrets)})`);
}

function previewMarkup(preview: Record<string, unknown>): string {
  return inBrowser(BOX_ACTIONS, `mod.rebuildPreviewHtml(${JSON.stringify(preview)})`);
}

describe("env row markup", () => {
  test("a plain row shows a masked value field and hides the secret chooser", () => {
    const html = rowMarkup({ name: "MODE", kind: "value", value: "dev", secretRef: "" }, ["gh-token"]);
    expect(html).toContain('data-env-field="value">');
    expect(html).toContain('<input class="input mono" data-env-value type="password" value="dev"');
    expect(html).toContain('<div class="env-field" data-env-field="secret" hidden>');
    expect(html).toContain('<option value="value" selected>');
    expect(html).toContain('<button type="button" class="icon-btn" data-env-reveal aria-pressed="false"');
  });

  test("a secret row shows the chooser with the chosen name, and hides the value field", () => {
    const html = rowMarkup({ name: "TOKEN", kind: "secret", value: "", secretRef: "gh-token" }, ["gh-token", "npm"]);
    expect(html).toContain('<div class="env-field" data-env-field="value" hidden>');
    expect(html).toContain('<div class="env-field" data-env-field="secret">');
    expect(html).toContain('<option value="gh-token" selected>gh-token</option>');
    expect(html).toContain('<option value="npm">npm</option>');
    expect(html).toContain('<option value="secret" selected>');
  });

  test("the chooser offers names only, and says so when there is none or the list is unavailable", () => {
    const none = rowMarkup({ name: "A", kind: "secret", value: "", secretRef: "" }, []);
    expect(none).toContain("No secrets yet");
    const unavailable = rowMarkup({ name: "A", kind: "secret", value: "", secretRef: "" }, null);
    expect(unavailable).toContain("Secrets could not be loaded");
  });

  test("names and values are escaped", () => {
    const html = rowMarkup({ name: '"><img src=x>', kind: "value", value: '"<b>', secretRef: "" }, []);
    expect(html).not.toContain("<img");
    expect(html).toContain('value="&quot;&lt;b&gt;"');
  });
});

describe("rebuild preview of an environment change", () => {
  test("each entry reads NAME=value, and a secret shows its name only", () => {
    const html = previewMarkup({
      changes: [
        {
          field: "env",
          from: JSON.stringify([{ name: "MODE", value: "standard", secretRef: null }]),
          to: JSON.stringify([
            { name: "MODE", value: "production", secretRef: null },
            { name: "TOKEN", value: null, secretRef: "gh-token" },
          ]),
        },
      ],
      diff: [],
      keeps: [],
      loses: [],
      containerName: { from: "minibox-a", to: "minibox-a" },
      revision: { current: 1, next: 2 },
    });
    expect(html).toContain("Environment: MODE=standard → MODE=production, TOKEN=🔒 secret: gh-token");
    expect(html).not.toContain("secretRef");
  });

  test("a rotated secret is shown as the server wrote it, since it is not a list", () => {
    const html = previewMarkup({
      changes: [{ field: "env", from: "secret gh-token: value in use", to: "secret gh-token: new value" }],
      diff: [],
      keeps: [],
      loses: [],
      containerName: { from: "a", to: "a" },
      revision: { current: 1, next: 2 },
    });
    expect(html).toContain("Environment: secret gh-token: value in use → secret gh-token: new value");
  });
});
