import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "../src/config";
import en from "../web/js/i18n/en.js";
import zh from "../web/js/i18n/zh-CN.js";

/**
 * The bottom tab bar a phone gets: Overview, Boxes, Activity and More. `web-tabbar-browser.test.ts` next to this file
 * measures the real bar in Chromium: where it sits, how each entry navigates, that the drawer stops above it, that it
 * steps aside for a keyboard or a dialog, and that a toast clears it. What is left here is what a browser cannot cheaply
 * say: the markup the bar is built from, the accessible names it carries, and the words in both dictionaries.
 */
const WEB = join(ROOT, "web");
const INDEX = readFileSync(join(WEB, "index.html"), "utf8");

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

  test("the scrim and the bar name themselves in both languages", () => {
    expect(INDEX).toContain('<button type="button" class="nav-scrim" id="navScrim"');
    expect(INDEX).toContain('data-i18n-attr="aria-label:shell.closeNav"');
    expect(BAR).toContain('data-i18n-attr="aria-label:shell.tabbar"');
  });

  test("the viewport lets the page reach the home-indicator area, so the bar's inset is not zero", () => {
    expect(INDEX).toContain('content="width=device-width, initial-scale=1, viewport-fit=cover"');
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
