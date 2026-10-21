import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "../src/config";

const WEB = join(ROOT, "web");
const BOX_ACTIONS = join(WEB, "js", "components", "box-actions.js");

const stubs = [
  `const stub = { documentElement: {}, body: {}, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };`,
  `Object.defineProperty(globalThis, "document", { configurable: true, value: stub });`,
  `Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) } });`,
  `Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {} } });`,
  `Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"], language: "en-US" } });`,
  `Object.defineProperty(globalThis, "location", { configurable: true, value: { hash: "", search: "", pathname: "/", origin: "http://localhost" } });`,
];

/** Loads the box actions module in a fresh process, with the browser globals it reads at import, and renders a preview. */
function rebuildPreview(preview: Record<string, unknown>): string {
  const script = [
    ...stubs,
    `const { rebuildPreviewHtml } = await import(${JSON.stringify(BOX_ACTIONS)});`,
    `console.log(JSON.stringify(rebuildPreviewHtml(${JSON.stringify(preview)})));`,
  ].join("\n");
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000 });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout) as string;
}

describe("rebuild preview", () => {
  test("the markup is one .rebuild-preview block, so its long mount lines wrap in any dialog that shows it", () => {
    const html = rebuildPreview({
      changes: [{ field: "mounts", from: "[]", to: "[]" }],
      diff: [],
      keeps: ["volumes"],
      loses: ["processes"],
      containerName: { from: "mb-bx_1", to: "mb-bx_1" },
      revision: { current: 3, next: 4 },
    });
    expect(html.startsWith('<div class="rebuild-preview"><strong>')).toBe(true);
    expect(html.endsWith("</div></div>")).toBe(true);
  });
});

describe("overlay layout", () => {
  test("the overlay grid is as wide as the viewport, so a wide child cannot push a dialog off screen", () => {
    const css = readFileSync(join(WEB, "css", "app.css"), "utf8");
    const overlay = css.match(/\.overlay \{[^}]*\}/)?.[0] ?? "";
    expect(overlay).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(overlay).toContain("place-items: center;");
  });
});
