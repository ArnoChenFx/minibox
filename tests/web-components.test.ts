import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "../src/config";
import en from "../web/js/i18n/en.js";

const WEB = join(ROOT, "web");
const BOX_ACTIONS = join(WEB, "js", "components", "box-actions.js");
const MOUNT_EDITOR = join(WEB, "js", "components", "mount-editor.js");
const LIST_TOGGLE = join(WEB, "js", "components", "list-toggle.js");
const FOLD_SECTION = join(WEB, "js", "components", "fold-section.js");
const CREATE_BOX = join(WEB, "js", "components", "create-box.js");

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

/** The text of a role's preview option: the dialog's label, with the volume name as HTML escapes it. */
const previewLabel = (name: string) => (en["mount.roleWillCreate"] ?? "").replace("{name}", name);

/** A create's prediction for one role, as `roleVolumeNames` gives it. */
function rolePreview(name: string | null, placeholder?: string) {
  return { name, placeholder, exists: false, exact: true, hostKnown: true };
}

/** The options of a create row whose only choice is the workspace role. */
function roleRowOptions(prediction: Record<string, unknown>) {
  return {
    volumes: [],
    create: true,
    pools: [],
    choices: [{ value: "role:workspace", role: "workspace", shared: false, noShared: false, preview: prediction }],
  };
}

describe("mount row", () => {
  test("a row names its volume, path and mode, escapes them, and carries the remove button", () => {
    const html = mountRowMarkup({ volume: "data", path: '/srv/"x"', mode: "ro" });
    expect(html).toContain('data-volume value="data"');
    expect(html).toContain('data-path value="/srv/&quot;x&quot;"');
    expect(html).toContain('<option value="ro" selected>');
    expect(html).toContain("data-remove-mount");
  });

  test("the mode choices keep the values ro and rw but read as words", () => {
    const html = mountRowMarkup({ volume: "data", path: "/data", mode: "rw" });
    expect(html).toContain('<option value="rw" selected>Read-write</option>');
    expect(html).toContain('<option value="ro" >Read-only</option>');
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

  test("a role row with no box name yet shows the placeholder name, and one with a name shows the real one", () => {
    const row = { volume: "role:workspace", path: "/workspace", mode: "rw" };
    // The naming rule is shown with the placeholder escaped, and still says it is a preview: the volume has no name yet.
    const unnamed = mountRowMarkup(row, roleRowOptions(rolePreview(null, "<box name>-workspace")));
    expect(unnamed).toContain(`>${previewLabel("&lt;box name&gt;-workspace")}</option>`);
    expect(unnamed).not.toContain("New workspace volume");
    // A name replaces the placeholder, so nothing of the naming rule is left in the row.
    const named = mountRowMarkup(row, roleRowOptions(rolePreview("alpha-workspace")));
    expect(named).toContain(`>${previewLabel("alpha-workspace")}</option>`);
    expect(named).not.toContain("box name");
  });
});

describe("dialog spacing", () => {
  test("the method selector of the add-host dialog is one block gap above either form it reveals", () => {
    // app.css is the import list; the rules themselves live in the part it inlines.
    const css = readFileSync(join(WEB, "css", "app", "forms.css"), "utf8");
    // Both method panels are siblings of the selector, so a `+` combinator would leave the second one flush against it.
    const rule = css.match(/\.segmented\s*~\s*\[data-method-panel\]\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain("margin-top: 16px;");
    expect(css).not.toMatch(/\.segmented\s*\+\s*\[data-method-panel\]/);
    // The hint under a row of choices keeps its tighter gap, so the rule cannot be the one that already existed.
    expect(css.match(/\.segmented\s*\+\s*\.help\s*\{[^}]*\}/)?.[0]).toContain("margin-top: 4px;");
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

/** Loads the list toggle in a fresh process and returns what `body` gives, with the module's exports in scope. */
function listToggle<T>(body: string): T {
  const script = [
    ...stubs,
    `const { bindToggles, flip, isToggled, limitList, listToggleHtml } = await import(${JSON.stringify(LIST_TOGGLE)});`,
    `const result = await (async () => {\n${body}\n})();`,
    `console.log(JSON.stringify(result));`,
  ].join("\n");
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000 });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout) as T;
}

const SEVEN = `Array.from({ length: 7 }, (_, id) => ({ id }))`;

describe("list toggle", () => {
  test("a long list shows its first five items under a toggle that names the full length", () => {
    const out = listToggle<{ shown: number[]; toggle: string }>(`
      const { shown, toggle } = limitList({}, "k", ${SEVEN});
      return { shown: shown.map((item) => item.id), toggle };`);
    expect(out.shown).toEqual([0, 1, 2, 3, 4]);
    expect(out.toggle).toContain('data-toggle="k"');
    expect(out.toggle).toContain("Show all (7)");
    expect(out.toggle).not.toContain("is-expanded");
  });

  test("a press expands the list for its own scope only, and the toggle then offers to show less", () => {
    const out = listToggle<{ shown: number; toggle: string; other: number }>(`
      const scope = {};
      flip(scope, "k");
      const { shown, toggle } = limitList(scope, "k", ${SEVEN});
      return { shown: shown.length, toggle, other: limitList({}, "k", ${SEVEN}).shown.length };`);
    expect(out.shown).toBe(7);
    expect(out.toggle).toContain("is-expanded");
    expect(out.toggle).toContain("Show less");
    expect(out.other).toBe(5);
  });

  test("a search shows every match with no toggle, and clearing it brings back the choice the user made", () => {
    const out = listToggle<{ searching: { shown: number; toggle: string }; cleared: number }>(`
      const scope = {};
      flip(scope, "k");
      const { shown, toggle } = limitList(scope, "k", ${SEVEN}, { searching: true });
      return { searching: { shown: shown.length, toggle }, cleared: limitList(scope, "k", ${SEVEN}).shown.length };`);
    expect(out.searching).toEqual({ shown: 7, toggle: "" });
    expect(out.cleared).toBe(7);
  });

  test("a list of five or fewer has no toggle, and a kept item stays visible past the limit", () => {
    const out = listToggle<{ short: string; kept: number[] }>(`
      return {
        short: limitList({}, "k", ${SEVEN}.slice(0, 5)).toggle,
        kept: limitList({}, "k", ${SEVEN}, { keep: (item) => item.id === 6 }).shown.map((item) => item.id),
      };`);
    expect(out.short).toBe("");
    expect(out.kept).toEqual([0, 1, 2, 3, 4, 6]);
  });

  test("a list that opens expanded shows every item, and a press collapses it", () => {
    const out = listToggle<{ open: { shown: number; toggle: string }; pressed: { shown: number; toggle: string } }>(`
      const scope = {};
      const open = limitList(scope, "k", ${SEVEN}, { defaultExpanded: true });
      flip(scope, "k");
      const pressed = limitList(scope, "k", ${SEVEN}, { defaultExpanded: true });
      return {
        open: { shown: open.shown.length, toggle: open.toggle },
        pressed: { shown: pressed.shown.length, toggle: pressed.toggle },
      };`);
    expect(out.open.shown).toBe(7);
    expect(out.open.toggle).toContain("Show less");
    expect(out.pressed.shown).toBe(5);
    expect(out.pressed.toggle).toContain("Show all (7)");
  });

  test("a toggle's key is escaped in its attribute", () => {
    const html = listToggle<string>(`return listToggleHtml('a"b', { expanded: false, total: 3 });`);
    expect(html).toContain('data-toggle="a&quot;b"');
  });

  test("a toggle reports whether its list is expanded", () => {
    expect(listToggle<string>(`return listToggleHtml("k", { expanded: false, total: 9 });`)).toContain(
      'aria-expanded="false"',
    );
    expect(listToggle<string>(`return listToggleHtml("k", { expanded: true, total: 9 });`)).toContain(
      'aria-expanded="true"',
    );
  });

  test("a press redraws the toggles and returns focus to the same toggle", () => {
    const out = listToggle<{ flipped: boolean; focused: boolean; redrawn: boolean }>(`
      const scope = {};
      const button = () => ({
        dataset: { toggle: "k" },
        focused: false,
        listeners: {},
        addEventListener(type, handler) { this.listeners[type] = handler; },
        focus() { this.focused = true; },
      });
      const root = { buttons: [button()], querySelectorAll() { return this.buttons; } };
      const before = root.buttons[0];
      bindToggles(scope, root, () => { root.buttons = [button()]; });
      before.listeners.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const after = root.buttons[0];
      return { flipped: isToggled(scope, "k"), focused: after.focused, redrawn: before !== after };`);
    expect(out).toEqual({ flipped: true, focused: true, redrawn: true });
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

/** Loads the fold section module in a fresh process and renders one section. */
function foldSection(options: Record<string, unknown>): string {
  const script = [
    ...stubs,
    `const { foldSectionHtml } = await import(${JSON.stringify(FOLD_SECTION)});`,
    `console.log(JSON.stringify(foldSectionHtml(${JSON.stringify(options)})));`,
  ].join("\n");
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000 });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout) as string;
}

describe("fold sections", () => {
  test("a folded section's button controls its hidden body", () => {
    const html = foldSection({ id: "s", title: "Tools", body: "<p>x</p>" });
    expect(html).toContain(
      '<button type="button" class="fold-toggle" id="sToggle" aria-expanded="false" aria-controls="sBody">',
    );
    expect(html).toContain('<div class="fold-body" id="sBody" hidden><p>x</p></div>');
  });

  test("an open section shows its body and keeps the heading's extra content", () => {
    const html = foldSection({ id: "s", title: "Tools", open: true, extraHtml: "<i>search</i>", body: "" });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('<div class="fold-body" id="sBody"></div>');
    expect(html).toContain("<i>search</i>");
  });

  test("every section of the create dialog folds with the same toggle", () => {
    const src = readFileSync(CREATE_BOX, "utf8");
    expect(src).not.toContain("<details");
    expect(src.match(/foldSectionHtml\(\{/g)?.length).toBe(6);
  });
});

describe("row editors", () => {
  test("every mount and variable list sits in a row editor with its add button, one row gap apart", () => {
    for (const file of ["create-box.js", "box-actions.js", "env-card.js"]) {
      const source = readFileSync(join(WEB, "js", "components", file), "utf8");
      const lists = source.match(/<div class="(?:rebuild-mounts|env-rows)"[^>]*><\/div>/g) ?? [];
      expect(lists.length).toBeGreaterThan(0);
      for (const list of lists) {
        const at = source.indexOf(list);
        const open = source.lastIndexOf('class="row-editor"', at);
        expect(open).toBeGreaterThan(-1);
        // The list is a direct child: every div opened since the editor's own tag is closed again.
        const between = source.slice(open, at);
        expect((between.match(/<div/g) ?? []).length).toBe((between.match(/<\/div>/g) ?? []).length);
        expect(source.slice(at + list.length).trimStart()).toMatch(/^<button type="button" class="btn"/);
      }
    }
    const css = readFileSync(join(WEB, "css", "app", "modal.css"), "utf8");
    const editor = css.match(/\.row-editor \{[^}]*\}/)?.[0] ?? "";
    expect(editor).toContain("display: flex;");
    expect(editor).toContain("gap: 8px;");
    expect(css).toMatch(/\.row-editor\[hidden\],\s*\.row-editor > :empty \{\s*display: none;/);
  });
});
