import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "../src/config";
import en from "../web/js/i18n/en.js";
import zh from "../web/js/i18n/zh-CN.js";

/**
 * The terminal's auxiliary key row on a phone: Esc, Tab, the arrows, a sticky Ctrl and Ctrl-C / Ctrl-D. The browser test
 * next to this file (`web-terminal-keys-browser.test.ts`) measures the row and types through it; this one reads the
 * bytes each key sends, the markup, the stylesheet and the wiring, so a key that maps to the wrong sequence or a rule
 * that stops matching fails without a browser.
 */
const WEB = join(ROOT, "web");
const KEYS = join(WEB, "js", "lib", "terminal-keys.js");
const PANEL = readFileSync(join(WEB, "js", "components", "terminal-panel.js"), "utf8");
const APP = readFileSync(join(WEB, "js", "app.js"), "utf8");
const CSS = readFileSync(join(WEB, "css", "app", "terminal-logs.css"), "utf8");
const APP_CSS = readFileSync(join(WEB, "css", "app.css"), "utf8");

/** The body of a rule, braces matched, from a stylesheet. Throws when the selector is not there. */
function block(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  let depth = 0;
  for (let index = css.indexOf("{", at); index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    else if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(at, index + 1);
    }
  }
  throw new Error(`unbalanced rule for ${selector}`);
}

/** The body of the `@media (max-width: Npx)` block that mentions `needle`, braces matched. */
function mediaBlock(css: string, width: number, needle: string): string {
  const starts = [...css.matchAll(new RegExp(`@media \\(max-width: ${width}px\\) \\{`, "g"))].map(
    (match) => match.index ?? 0,
  );
  for (const at of starts) {
    let depth = 0;
    for (let index = css.indexOf("{", at); index < css.length; index += 1) {
      if (css[index] === "{") depth += 1;
      else if (css[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          const text = css.slice(at, index + 1);
          if (text.includes(needle)) return text;
          break;
        }
      }
    }
  }
  throw new Error(`no ${width}px block mentions ${needle}`);
}

/**
 * The key module, loaded in a fresh process. It has no browser globals of its own, so nothing has to stand in for them.
 */
function keys<T>(body: string): T {
  const script = [
    `const { TERM_KEYS, keyBytes, ctrlChar, keysReveal } = await import(${JSON.stringify(KEYS)});`,
    `const result = await (async () => {\n${body}\n})();`,
    `console.log(JSON.stringify(result));`,
  ].join("\n");
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000 });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout) as T;
}

describe("the bytes each key sends", () => {
  test("application cursor mode uses SS3 for arrows and leaves the other keys unchanged", () => {
    const normal = keys<Record<string, string | null>>(
      `return Object.fromEntries(TERM_KEYS.map((key) => [key.id, keyBytes(key.id, { applicationCursorKeysMode: false })]));`,
    );
    const application = keys<Record<string, string | null>>(
      `return Object.fromEntries(TERM_KEYS.map((key) => [key.id, keyBytes(key.id, { applicationCursorKeysMode: true })]));`,
    );
    expect(application).toEqual({ ...normal, left: "\u001bOD", up: "\u001bOA", down: "\u001bOB", right: "\u001bOC" });
  });
  test("the row is Esc, Tab, Ctrl, the four arrows, Ctrl-C and Ctrl-D, in that order", () => {
    const ids = keys<string[]>(`return TERM_KEYS.map((key) => key.id);`);
    expect(ids).toEqual(["esc", "tab", "ctrl", "left", "up", "down", "right", "ctrlC", "ctrlD"]);
  });

  test("Esc and Tab send ESC and a horizontal tab, and the arrows send the standard cursor sequences", () => {
    const sent = keys<Record<string, string | null>>(
      `return Object.fromEntries(TERM_KEYS.map((key) => [key.id, keyBytes(key.id)]));`,
    );
    expect(sent).toEqual({
      esc: "\u001b",
      tab: "\t",
      ctrl: null,
      left: "\u001b[D",
      up: "\u001b[A",
      down: "\u001b[B",
      right: "\u001b[C",
      ctrlC: "\u0003",
      ctrlD: "\u0004",
    });
  });

  test("the byte strings are the ones a terminal reads, character by character", () => {
    const codes = keys<Record<string, number[]>>(
      `return Object.fromEntries(TERM_KEYS.filter((key) => key.bytes !== undefined).map((key) => [key.id, [...key.bytes].map((c) => c.charCodeAt(0))]));`,
    );
    expect(codes.esc).toEqual([27]);
    expect(codes.tab).toEqual([9]);
    expect(codes.left).toEqual([27, 91, 68]);
    expect(codes.up).toEqual([27, 91, 65]);
    expect(codes.down).toEqual([27, 91, 66]);
    expect(codes.right).toEqual([27, 91, 67]);
    expect(codes.ctrlC).toEqual([3]);
    expect(codes.ctrlD).toEqual([4]);
  });

  test("an id the row does not carry sends nothing, so a stray button cannot write to the session", () => {
    expect(keys<string | null>(`return keyBytes("enter");`)).toBeNull();
    expect(keys<string | null>(`return keyBytes("");`)).toBeNull();
  });
});

describe("the sticky Ctrl", () => {
  test("it turns a letter into its control character, in either case", () => {
    const mapped = keys<Record<string, string | null>>(
      `return Object.fromEntries(["c", "C", "d", "D", "a", "z", "Z"].map((c) => [c, ctrlChar(c)]));`,
    );
    expect(mapped).toEqual({
      c: "\u0003",
      C: "\u0003",
      d: "\u0004",
      D: "\u0004",
      a: "\u0001",
      z: "\u001a",
      Z: "\u001a",
    });
  });

  test("the punctuation beside the letters keeps its bit, as a terminal's Ctrl does", () => {
    const mapped = keys<Record<string, string | null>>(
      `return Object.fromEntries(["[", "\\\\", "]", "^", "_", "?", "@"].map((c) => [c, ctrlChar(c)]));`,
    );
    // Ctrl-[ is ESC, Ctrl-\\ is FS, Ctrl-] is GS, Ctrl-^ is RS, Ctrl-_ is US, Ctrl-? is DEL.
    expect(mapped).toEqual({
      "[": "\u001b",
      "\\": "\u001c",
      "]": "\u001d",
      "^": "\u001e",
      _: "\u001f",
      "?": "\u007f",
      "@": "\u0000",
    });
  });

  test("a paste, an input-method composition or a key it has no meaning for is left as it is", () => {
    const left = keys<Record<string, string | null>>(
      `return Object.fromEntries(["", "ab", "ls -la", "1", "é", "\\u001b"].map((c) => [c, ctrlChar(c)]));`,
    );
    for (const value of Object.values(left)) expect(value).toBeNull();
  });

  test("the page scrolls only as far as the row needs to come into the part of the window the keyboard leaves", () => {
    // The row below the keyboard's top edge scrolls up by the difference; one already inside the visible part, or one
    // shorter than it, does not move the page at all.
    const moves = keys<number[]>(
      `return [
        keysReveal({ top: 700, bottom: 800 }, { top: 0, bottom: 500 }),
        keysReveal({ top: 300, bottom: 400 }, { top: 0, bottom: 500 }),
        keysReveal({ top: 300, bottom: 400 }, { top: 320, bottom: 800 }),
        keysReveal({ top: 100, bottom: 800 }, { top: 320, bottom: 500 }),
        keysReveal({ top: 100, bottom: 800 }, { top: 0, bottom: 800 }),
      ];`,
    );
    // A row taller than the visible part is brought in by its top, which keeps its first keys pressable.
    expect(moves).toEqual([300, 0, -20, -220, 0]);
  });

  test("the module and the panel agree on where the control character is applied", () => {
    // The panel asks the module, and resets the modifier as soon as it used it, so Ctrl is sticky for one key only.
    expect(PANEL).toContain('import { ctrlChar, keyBytes, keysReveal, TERM_KEYS } from "../lib/terminal-keys.js";');
    expect(PANEL).toContain("const control = ctrlArmed() ? ctrlChar(data) : null;");
    expect(PANEL).toContain("if (control !== null) setCtrl(false);");
  });
});

describe("the row's markup", () => {
  test("every key is a real button with an aria-label, and Ctrl says whether it is armed", () => {
    expect(PANEL).toContain('<button type="button" class="term-key');
    expect(PANEL).toContain('data-key="${esc(key.id)}"');
    expect(PANEL).toContain('aria-label="${esc(t(key.aria))}"');
    expect(PANEL).toContain('aria-pressed="false"');
    // The group is named, so a screen reader says what the row of buttons is.
    expect(PANEL).toContain('role="group" aria-label="${esc(t("bd.termKeys"))}"');
  });

  test("the keys' names exist in both dictionaries, and the prose ones are translated rather than copied", () => {
    const named = keys<string[]>(`return TERM_KEYS.map((key) => key.aria);`);
    expect(named.length).toBe(9);
    for (const key of [...named, "bd.termKeys"]) expect([key, key in en && key in zh]).toEqual([key, true]);
    // Esc and Tab are the keys' own names, so the two dictionaries share them. Everything else says something.
    for (const key of [
      "bd.termKeys",
      "bd.termKeyCtrl",
      "bd.termKeyLeft",
      "bd.termKeyUp",
      "bd.termKeyDown",
      "bd.termKeyRight",
    ]) {
      expect([key, zh[key as keyof typeof zh] !== en[key as keyof typeof en]]).toEqual([key, true]);
    }
  });

  test("the keys are named in words a person can act on, in both languages", () => {
    expect([en["bd.termKeys"], zh["bd.termKeys"]]).toEqual(["Terminal keys", "终端快捷键"]);
    expect([en["bd.termKeyEsc"], en["bd.termKeyTab"]]).toEqual(["Escape", "Tab"]);
    expect([zh["bd.termKeyEsc"], zh["bd.termKeyTab"]]).toEqual(["Esc", "Tab"]);
    expect([en["bd.termKeyCtrlC"], en["bd.termKeyCtrlD"]]).toEqual(["Control-C", "Control-D"]);
    expect([zh["bd.termKeyCtrlC"], zh["bd.termKeyCtrlD"]]).toEqual(["Ctrl-C", "Ctrl-D"]);
    expect([en["bd.termKeyLeft"], en["bd.termKeyUp"], en["bd.termKeyDown"], en["bd.termKeyRight"]]).toEqual([
      "Left arrow",
      "Up arrow",
      "Down arrow",
      "Right arrow",
    ]);
    expect([zh["bd.termKeyLeft"], zh["bd.termKeyUp"], zh["bd.termKeyDown"], zh["bd.termKeyRight"]]).toEqual([
      "左方向键",
      "上方向键",
      "下方向键",
      "右方向键",
    ]);
    // Ctrl is a modifier, so its name says what it does to the next key.
    expect(en["bd.termKeyCtrl"]).toContain("modifier");
    expect(zh["bd.termKeyCtrl"]).toContain("修饰");
  });
});

describe("the row's stylesheet", () => {
  test("app.css imports the terminal stylesheet, so the row's rules reach the page", () => {
    expect(APP_CSS).toContain('@import "app/terminal-logs.css";');
  });

  test("the row is hidden everywhere until the 640px phone breakpoint", () => {
    expect(block(CSS, ".term-keys")).toContain("display: none;");
    // The phone rules live in one 640px block, the breakpoint the tab bar and the storage cards use.
    const phone = mediaBlock(CSS, 640, ".term-keys {");
    expect(phone).not.toContain("@media (max-width: 900px)");
    expect(phone).not.toContain("@media (max-width: 560px)");
  });

  test("on a phone the keys are a wrapping row inside the terminal frame, never a sideways scroller", () => {
    const phone = mediaBlock(CSS, 640, ".term-key {");
    const row = phone.slice(phone.indexOf(".term-keys {"));
    expect(row).toContain("display: flex;");
    expect(row).toContain("flex-wrap: wrap;");
    expect(row).toContain("border-top: 1px solid #222;");
    expect(phone).not.toContain("overflow-x: auto");
    // A key is at least 36px wide, which is a thumb's target, and never shrinks below it.
    expect(block(phone, ".term-key")).toContain("min-width: 36px;");
    expect(block(phone, ".term-key")).toContain("height: 36px;");
    expect(block(phone, ".term-key")).toContain("touch-action: manipulation;");
  });

  test("a key has a visible focus outline, and the armed Ctrl is drawn in the accent colour", () => {
    expect(block(CSS, ".term-key:focus-visible")).toContain("outline: 2px solid var(--accent);");
    const armed = block(CSS, '.term-key.on,\n  .term-key[aria-pressed="true"]');
    expect(armed).toContain("background: var(--accent);");
  });

  test("a read-only session's keys are dimmed, so a button that cannot send does not look pressable", () => {
    const off = block(CSS, ".term-keys.off .term-key,\n  .term-key:disabled");
    expect(off).toContain("opacity: 0.45;");
    expect(off).toContain("cursor: not-allowed;");
  });
});

describe("the row's wiring in the terminal panel", () => {
  test("a press cancels the default on pointerdown and mousedown, so the on-screen keyboard stays up", () => {
    expect(PANEL).toContain('keys.addEventListener("pointerdown", holdFocus);');
    expect(PANEL).toContain('keys.addEventListener("mousedown", holdFocus);');
    expect(PANEL).toContain("const holdFocus = (event) => event.preventDefault();");
    // And focus goes back to the terminal's own input, so the next character typed lands in the session.
    expect(PANEL).toContain("xterm.focus();");
  });

  test("a press on the row keeps the bottom tab bar aside, since the row is part of the keyboard", () => {
    // The page's own pointerdown brings the bar back on any press on the page; the row is the one press that must not,
    // or the bar would take the room the row needs while the keyboard is up.
    expect(APP).toContain('if (target.closest(".term-keys")) return;');
    const handler = APP.slice(APP.indexOf('document.addEventListener("pointerdown"'));
    const body = handler.slice(0, handler.indexOf("});"));
    expect(body.indexOf('target.closest(".term-keys")')).toBeLessThan(body.indexOf("setTyping(false)"));
  });

  test("the row comes into view when the keyboard changes the visual viewport, and stops watching on teardown", () => {
    expect(PANEL).toContain('window.visualViewport?.addEventListener("resize", onViewport);');
    expect(PANEL).toContain('window.visualViewport?.removeEventListener("resize", onViewport);');
    expect(PANEL).toContain("const delta = keysReveal(keys.getBoundingClientRect(), { top, bottom });");
    // A desktop hides the row, so there is nothing to scroll for.
    expect(PANEL).toContain("if (!keys || keys.getBoundingClientRect().height === 0) return;");
  });

  test("the keys send through xterm's own input, the channel the keyboard uses", () => {
    expect(PANEL).toContain("xterm.input(data, true);");
    expect(PANEL).toContain("const data = keyBytes(id, xterm.modes);");
  });

  test("the keys follow the session: they are disabled until it can take input, and Ctrl resets when it cannot", () => {
    expect(PANEL).toContain("setKeysEnabled(view.canType);");
    expect(PANEL).toContain('for (const button of keys.querySelectorAll("[data-key]")) button.disabled = !enabled;');
    expect(PANEL).toContain("if (!enabled) setCtrl(false);");
  });

  test("Ctrl is sticky: it arms and disarms, and a key press resets it", () => {
    expect(PANEL).toContain("setCtrl(!ctrlArmed());");
    expect(PANEL).toContain('button.setAttribute("aria-pressed", String(armed));');
    expect(PANEL).toContain("if (ctrlArmed()) setCtrl(false);");
  });
});
