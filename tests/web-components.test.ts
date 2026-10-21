import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "../src/config";

const WEB = join(ROOT, "web");
const BOX_ACTIONS = join(WEB, "js", "components", "box-actions.js");
const MOUNT_EDITOR = join(WEB, "js", "components", "mount-editor.js");

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

/** Loads the mount editor in a fresh process and renders one row. */
function mountRowMarkup(mount: Record<string, string>, options: Record<string, unknown> = {}): string {
  const script = [
    ...stubs,
    `const { mountRowHtml } = await import(${JSON.stringify(MOUNT_EDITOR)});`,
    `console.log(JSON.stringify(mountRowHtml(${JSON.stringify(mount)}, ${JSON.stringify(options)})));`,
  ].join("\n");
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000 });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout) as string;
}

describe("mount row", () => {
  test("a row names its volume, path and mode, escapes them, and carries the remove button", () => {
    const html = mountRowMarkup({ volume: "data", path: '/srv/"x"', mode: "ro" });
    expect(html).toContain('data-volume value="data"');
    expect(html).toContain('data-path value="/srv/&quot;x&quot;"');
    expect(html).toContain('<option value="ro" selected>');
    expect(html).toContain("data-remove-mount");
  });

  test("with volumes, the volume is a choice, and a volume another box owns cannot be picked", () => {
    const html = mountRowMarkup(
      { volume: "vol_2", path: "/data", mode: "rw" },
      {
        volumes: [
          { id: "vol_1", name: "owned", disabled: true },
          { id: "vol_2", name: "shared", disabled: false },
        ],
      },
    );
    expect(html).toContain('<select class="select" data-volume');
    expect(html).toContain('<option value="">');
    expect(html).toMatch(/<option value="vol_1"[^>]* disabled[^>]*>owned<\/option>/);
    expect(html).toMatch(/<option value="vol_2"[^>]* selected[^>]*>shared<\/option>/);
    expect(html).not.toMatch(/<option value="vol_2"[^>]* disabled/);
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

describe("rebuildBody", () => {
  test("a non-empty template field is always included, even when it matches the box", () => {
    const src = readFileSync(BOX_ACTIONS, "utf8");
    const fn = src.slice(src.indexOf("function rebuildBody"), src.indexOf("/** The HTML for a rebuild preview"));
    expect(fn).toContain("if (template) body.template = template");
    expect(fn).not.toContain("template !== (box.template");
  });
});
