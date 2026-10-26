import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "../src/config";
import en from "../web/js/i18n/en.js";
import zh from "../web/js/i18n/zh-CN.js";

/**
 * The bottom tab bar a phone gets: Overview, Boxes, Activity and More. The browser test next to this file
 * (`web-tabbar-browser.test.ts`) measures the bar; this one reads the markup, the stylesheet and the wiring, so a rule
 * that stops matching or a key that loses its text fails without a browser.
 */
const WEB = join(ROOT, "web");
const INDEX = readFileSync(join(WEB, "index.html"), "utf8");
const APP = readFileSync(join(WEB, "js", "app.js"), "utf8");
const TABBAR = readFileSync(join(WEB, "css", "app", "tabbar.css"), "utf8");
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

/** The `z-index` a rule declares. */
const zIndex = (rule: string): number => Number(/z-index: (\d+);/.exec(rule)?.[1] ?? NaN);

/** The bar's markup, between its opening tag and the end of its list of entries. */
const BAR = INDEX.slice(
  INDEX.indexOf('<nav class="tabbar"'),
  INDEX.indexOf("</nav>", INDEX.indexOf('<nav class="tabbar"')),
);

describe("the bottom tab bar's markup", () => {
  test("it is inside the shell, after the main column, so it can sit under both", () => {
    const shell = INDEX.indexOf('<div class="shell" id="shell">');
    const main = INDEX.indexOf('<div class="main">');
    const bar = INDEX.indexOf('<nav class="tabbar"');
    expect(shell).toBeGreaterThanOrEqual(0);
    expect(bar).toBeGreaterThan(main);
    // The shell closes after the bar, so the bar is a child of it rather than a sibling of the whole page.
    const shellEnd = INDEX.indexOf("</div>", INDEX.indexOf('<div id="toasts"'));
    expect(bar).toBeLessThan(shellEnd);
  });

  test("it has the four entries, each with the address of the page it opens", () => {
    expect([...BAR.matchAll(/data-tab="(\w+)"/g)].map((m) => m[1])).toEqual(["overview", "boxes", "activity", "more"]);
    expect([...BAR.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual(["#/overview", "#/boxes", "#/activity"]);
    // More is a button, since it opens the drawer rather than an address of its own.
    expect(BAR).toContain('<button type="button" id="moreBtn" data-tab="more"');
  });

  test("More says whether the drawer is open, and which element it opens", () => {
    expect(BAR).toContain('aria-expanded="false"');
    expect(BAR).toContain('aria-controls="sidebar"');
    expect(INDEX).toContain('<aside class="sidebar" id="sidebar"');
  });

  test("each entry draws an existing icon and takes its text from the dictionaries", () => {
    expect([...BAR.matchAll(/data-icon="(\w+)"/g)].map((m) => m[1])).toEqual(["dashboard", "box", "activity", "menu"]);
    expect([...BAR.matchAll(/data-i18n="([\w.]+)"/g)].map((m) => m[1])).toEqual([
      "nav.overview",
      "nav.boxes",
      "nav.activity",
      "nav.more",
    ]);
  });

  test("the scrim and the bar name themselves in both languages", () => {
    expect(INDEX).toContain('<button type="button" class="nav-scrim" id="navScrim"');
    expect(INDEX).toContain('data-i18n-attr="aria-label:shell.closeNav"');
    expect(BAR).toContain('data-i18n-attr="aria-label:shell.tabbar"');
  });

  test("the viewport lets the page reach the home-indicator area, so the bar's inset is not zero", () => {
    expect(INDEX).toContain('content="width=device-width, initial-scale=1, viewport-fit=cover"');
  });
});

describe("the tab bar's stylesheet", () => {
  test("app.css imports it, so the served stylesheet carries the rules", () => {
    expect(APP_CSS).toContain('@import "app/tabbar.css";');
  });

  test("it is hidden everywhere until the 640px phone breakpoint", () => {
    const off = block(TABBAR, ".tabbar,\n.nav-scrim");
    expect(off).toContain("display: none;");
    // The phone rules are all inside one 640px block, the breakpoint the cards on the storage pages use.
    const phone = mediaBlock(TABBAR, 640, ".tabbar {");
    expect(phone).not.toContain("@media (max-width: 900px)");
    expect(phone).not.toContain("@media (max-width: 560px)");
  });

  test("on a phone the bar is fixed to the bottom, one column per entry", () => {
    const bar = block(TABBAR, ".tabbar");
    expect(bar).toContain("position: fixed;");
    expect(bar).toContain("inset: auto 0 0;");
    expect(bar).toContain("grid-template-columns: repeat(4, minmax(0, 1fr));");
    // A fixed bar covers the page, so the page's own bottom padding is what keeps the last line clear of it.
    expect(block(TABBAR, ".content")).toContain("var(--tabbar-h)");
    expect(block(TABBAR, ".content")).toContain("env(safe-area-inset-bottom, 0px)");
  });

  test("the bar keeps clear of the iPhone home indicator", () => {
    expect(block(TABBAR, ".tabbar")).toContain("padding-bottom: env(safe-area-inset-bottom, 0px);");
  });

  test("the current entry is marked in colour, and an open drawer marks More", () => {
    expect(
      block(TABBAR, '.tabbar > a.active,\n  .tabbar > button[aria-expanded="true"],\n  .tabbar > button.active'),
    ).toContain("color: var(--accent-text);");
  });

  test("the menu button is gone on a phone, so there is one entry to the drawer", () => {
    expect(block(TABBAR, ".icon-btn.menu-btn")).toContain("display: none;");
    // While the bar steps aside for a keyboard it comes back, so navigation is never lost.
    expect(block(TABBAR, ".shell.typing .icon-btn.menu-btn")).toContain("display: inline-grid;");
    // Under 641..900px the existing rule still shows it; the phone rule is the later, equal-or-higher one.
    expect(TABBAR.indexOf(".icon-btn.menu-btn")).toBeGreaterThan(-1);
    const responsive = readFileSync(join(WEB, "css", "app", "responsive-fixes.css"), "utf8");
    expect(responsive).toContain("@media (max-width: 900px) {");
    expect(responsive).toContain(".icon-btn.menu-btn {\n    display: inline-grid;");
  });

  test("the scrim only exists while the drawer is open, and only over the page", () => {
    const scrim = block(TABBAR, ".shell.nav-open .nav-scrim");
    expect(scrim).toContain("display: block;");
    expect(scrim).toContain("position: fixed;");
    // The top bar, the bar and the drawer each stay above it, so each keeps working while the drawer is open.
    const responsive = readFileSync(join(WEB, "css", "app", "responsive-fixes.css"), "utf8");
    const drawer = Number(/z-index: (\d+);/.exec(responsive.slice(responsive.indexOf(".sidebar {")))?.[1] ?? NaN);
    const topbar = Number(
      /z-index: (\d+);/.exec(readFileSync(join(WEB, "css", "app", "layout.css"), "utf8"))?.[1] ?? NaN,
    );
    expect(zIndex(scrim)).toBeLessThan(topbar);
    expect(zIndex(scrim)).toBeLessThan(zIndex(block(TABBAR, ".tabbar")));
    expect(zIndex(scrim)).toBeLessThan(drawer);
  });
});

describe("the tab bar's wiring in app.js", () => {
  test("the current entry follows the route, and the other pages mark More", () => {
    expect(APP).toContain('const TABS = ["overview", "boxes", "activity"];');
    expect(APP).toContain('const tab = TABS.includes(nav) ? nav : "more";');
    // The same active class and aria-current the sidebar uses, on the bar's own entries.
    expect(APP).toContain('item.classList.toggle("active", current);');
    expect(APP).toContain('item.setAttribute("aria-current", "page");');
    expect(APP).toContain('item.removeAttribute("aria-current");');
    // A route change closes the drawer, and the bar says so.
    expect(APP).toMatch(/markNav\(hit\.nav\);\n\s+setNavOpen\(false\);/);
  });

  test("More and the scrim open and close the drawer, and aria-expanded follows it", () => {
    expect(APP).toContain('$("#shell").classList.toggle("nav-open", open);');
    expect(APP).toContain('$("#moreBtn").setAttribute("aria-expanded", String(open));');
    expect(APP).toContain('$("#moreBtn").addEventListener("click", () => setNavOpen(!navOpen()));');
    expect(APP).toContain('$("#navScrim").addEventListener("click", () => setNavOpen(false));');
  });

  test("Escape closes the open drawer", () => {
    expect(APP).toMatch(/e\.key === "Escape" && navOpen\(\).*setNavOpen\(false\)/);
  });

  test("while a field on the page has the keyboard, the bar steps aside so the input is not covered", () => {
    expect(block(TABBAR, ".shell.typing .tabbar")).toContain("display: none;");
    expect(block(TABBAR, ".shell.typing .icon-btn.menu-btn")).toContain("display: inline-grid;");
    expect(APP).toContain(
      "node.matches(\"input:not([type='checkbox']):not([type='radio']), textarea, [contenteditable='true']\")",
    );
    expect(APP).toContain('if (isField(target) && !target.closest(".sidebar")) setTyping(true);');
    expect(APP).toContain('const setTyping = (typing) => $("#shell").classList.toggle("typing", typing);');
    // A press on the page itself brings the bar back, and a new page starts without the keyboard's state.
    expect(APP).toContain('if (isField(target) || !target?.closest("#view")) return;');
    expect(APP).toContain('else if (target?.closest("#view")) setTyping(false);');
    expect(APP).toMatch(/setNavOpen\(false\);\n\s+setTyping\(false\);/);
  });

  test("a dialog hides the bar, and a toast rises above it", () => {
    // A dialog holds attention, so the bar is not part of it, even when the dialog has no field to focus.
    expect(block(TABBAR, "body:has(.overlay) .tabbar")).toContain("display: none;");
    const toasts = block(TABBAR, ".toasts");
    expect(toasts).toContain("bottom: calc(20px + var(--tabbar-h) + env(safe-area-inset-bottom, 0px));");
  });

  test("the drawer's own foot keeps clear of the home indicator", () => {
    expect(block(TABBAR, ".sidebar")).toContain("padding-bottom: calc(14px + env(safe-area-inset-bottom, 0px));");
  });
});

describe("the tab bar's strings", () => {
  test("More and the bar's accessible names are in both dictionaries", () => {
    expect([en["nav.more"], zh["nav.more"]]).toEqual(["More", "更多"]);
    expect(en["shell.tabbar"]).toBe("Sections");
    expect(zh["shell.tabbar"]).toBe("页面导航");
    expect([en["shell.closeNav"], zh["shell.closeNav"]]).toEqual(["Close navigation", "关闭导航"]);
  });

  test("the bar's labels are the ones the sidebar already uses, so both languages agree", () => {
    for (const key of ["nav.overview", "nav.boxes", "nav.activity"]) {
      expect([key, en[key], zh[key]]).toEqual([key, expect.any(String), expect.any(String)]);
      expect([key, zh[key] !== en[key]]).toEqual([key, true]);
    }
  });
});
