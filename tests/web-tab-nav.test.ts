import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "../src/config";

const WEB = join(ROOT, "web");
const TAB_NAV = join(WEB, "js", "lib", "tab-nav.js");
const SECTION_TABS = join(WEB, "js", "components", "section-tabs.js");

/**
 * The strip's key handler reads `event.currentTarget` and `event.target`, so a plain object with the two elements and
 * the methods it calls stands in for a KeyboardEvent. Each element answers `closest` the way the DOM does.
 */
const harness = `
  const { onTabKeydown, tabForKey } = await import(${JSON.stringify(TAB_NAV)});
  const makeTab = (label) => {
    const tab = {
      label,
      focused: false,
      hasAttribute: () => false,
      getAttribute: () => null,
      clicked: 0,
      focus() { this.focused = true; },
      click() { this.clicked += 1; },
      closest(selector) { return selector === "[role='tab']" ? this : null; },
    };
    return tab;
  };
  const strip = (tabs) => ({
    tabs,
    contains(item) { return tabs.includes(item); },
    querySelectorAll(selector) {
      if (selector !== "[role='tab']") throw new Error("unexpected selector " + selector);
      return tabs;
    },
  });
  const stripOf = (tabs) => strip(tabs);
  const press = (strip, tab, key) => {
    for (const item of strip.tabs) item.focused = false;
    let prevented = false;
    onTabKeydown({
      key,
      currentTarget: strip,
      target: tab,
      preventDefault() { prevented = true; },
    });
    return { prevented, focused: strip.tabs.filter((item) => item.focused).map((item) => item.label) };
  };
`;

/** Runs `body` in a fresh process with the tab strip's module and the harness above in scope. */
function tabNav<T>(body: string): T {
  const script = [
    harness,
    `const result = await (async () => {\n${body}\n})();`,
    `console.log(JSON.stringify(result));`,
  ].join("\n");
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000 });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout) as T;
}

describe("tab strip keyboard navigation", () => {
  test("the arrow keys move focus to the next and previous tab, and wrap at either end", () => {
    const out = tabNav<{ right: string[]; left: string[]; wrapRight: string[]; wrapLeft: string[] }>(`
      const tabs = ["Volumes", "Checkpoints", "Third"].map(makeTab);
      const strip = stripOf(tabs);
      return {
        right: press(strip, tabs[0], "ArrowRight").focused,
        left: press(strip, tabs[1], "ArrowLeft").focused,
        wrapRight: press(strip, tabs[2], "ArrowRight").focused,
        wrapLeft: press(strip, tabs[0], "ArrowLeft").focused,
      };`);
    expect(out).toEqual({
      right: ["Checkpoints"],
      left: ["Volumes"],
      wrapRight: ["Volumes"],
      wrapLeft: ["Third"],
    });
  });

  test("Home and End jump to the first and last tab", () => {
    const out = tabNav<{ home: string[]; end: string[] }>(`
      const tabs = ["Volumes", "Checkpoints", "Third"].map(makeTab);
      const strip = stripOf(tabs);
      return { home: press(strip, tabs[1], "Home").focused, end: press(strip, tabs[1], "End").focused };`);
    expect(out).toEqual({ home: ["Volumes"], end: ["Third"] });
  });

  test("a key the strip handles has its default cancelled, so the page does not scroll sideways", () => {
    const out = tabNav<{ handled: boolean; other: boolean; enter: boolean }>(`
      const tabs = ["Volumes", "Checkpoints"].map(makeTab);
      const strip = stripOf(tabs);
      return {
        handled: press(strip, tabs[0], "ArrowRight").prevented,
        other: press(strip, tabs[0], "ArrowUp").prevented,
        enter: press(strip, tabs[0], "Enter").prevented,
      };`);
    // Enter is left to the browser, which follows the tab's link, as a click does.
    expect(out).toEqual({ handled: true, other: false, enter: false });
  });

  test("a strip of one tab keeps focus on it, and a key that names no tab moves nothing", () => {
    const out = tabNav<{ only: string[]; escape: string[]; up: string[]; none: unknown }>(`
      const single = stripOf(["Only"].map(makeTab));
      const tabs = ["Volumes", "Checkpoints"].map(makeTab);
      const strip = stripOf(tabs);
      return {
        only: press(single, single.tabs[0], "ArrowRight").focused,
        escape: press(strip, tabs[0], "Escape").focused,
        up: press(strip, tabs[0], "ArrowUp").focused,
        none: tabForKey([], makeTab("x"), "ArrowRight"),
      };`);
    expect(out).toEqual({ only: ["Only"], escape: [], up: [], none: null });
  });

  test("Space opens the focused tab, as the pattern asks of a tab that is not a native button", () => {
    const out = tabNav<{ opened: number; prevented: boolean }>(`
      const tabs = ["Volumes", "Checkpoints"].map(makeTab);
      const strip = stripOf(tabs);
      const result = press(strip, tabs[1], " ");
      return { opened: tabs[1].clicked, prevented: result.prevented };`);
    expect(out).toEqual({ opened: 1, prevented: true });
  });

  test("a press from outside the strip's tabs is ignored", () => {
    const out = tabNav<{ prevented: boolean; focused: string[] }>(`
      const tabs = ["Volumes", "Checkpoints"].map(makeTab);
      const strip = stripOf(tabs);
      const stray = { focused: false, closest: () => null };
      const event = { key: "ArrowRight", currentTarget: strip, target: stray, preventDefault() { this.hit = true; } };
      onTabKeydown(event);
      return { prevented: Boolean(event.hit), focused: strip.tabs.filter((tab) => tab.focused).map((tab) => tab.label) };`);
    expect(out).toEqual({ prevented: false, focused: [] });
  });

  test("both tab strips of the console are bound, and the section strip names its tablist", () => {
    const sectionTabs = readFileSync(SECTION_TABS, "utf8");
    expect(sectionTabs).toContain('role="tablist"');
    expect(sectionTabs).toContain("export function bindTabStrips(root)");
    expect(sectionTabs).toContain('strip.addEventListener("keydown", onTabKeydown);');
    // The focused tab is scrolled into view, so an arrow press at the end of a narrow strip shows where it landed.
    expect(sectionTabs).toContain('strip.addEventListener("focusin", onFocus);');
    // The two section pages and the Box detail page bind the strips they draw.
    for (const page of ["storage.js", "library.js", "box-detail.js"]) {
      const source = readFileSync(join(WEB, "js", "pages", page), "utf8");
      expect([page, source.includes("bindTabStrips(")]).toEqual([page, true]);
    }
    // The Box detail strip is redrawn with the page, so its listener goes with the old one.
    expect(readFileSync(join(WEB, "js", "pages", "box-detail.js"), "utf8")).toContain("stripCleanup?.();");
  });
});
