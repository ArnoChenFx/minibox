import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "../src/config";
import { icon } from "../web/js/lib/icons.js";

const WEB = join(ROOT, "web");
const app = readFileSync(join(WEB, "js", "app.js"), "utf8");
const index = readFileSync(join(WEB, "index.html"), "utf8");

const routes = [...app.matchAll(/\{ re: .*?, page: (\w+), nav: "([\w-]+)"/g)].map((m) => ({
  page: m[1] ?? "",
  nav: m[2] ?? "",
}));
const pageImports = new Map(
  [...app.matchAll(/^import \* as (\w+) from "\.\/pages\/([\w-]+)\.js";$/gm)].map((m) => [m[1] ?? "", m[2] ?? ""]),
);
const sidebar = [...index.matchAll(/data-nav="([\w-]+)"/g)].map((m) => m[1] ?? "");

/** The console's own scripts, plus the two HTML pages. Vendored libraries are excluded. */
function consoleSources(): string[] {
  const scripts = readdirSync(join(WEB, "js"), { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".js"))
    .map((name) => join(WEB, "js", name));
  return [...scripts, join(WEB, "index.html"), join(WEB, "login.html")].map((path) => readFileSync(path, "utf8"));
}

describe("console navigation", () => {
  test("every route has a sidebar link, and every sidebar link has a route", () => {
    expect([...new Set(routes.map((r) => r.nav))].toSorted()).toEqual([...new Set(sidebar)].toSorted());
  });

  test("Snapshots is not a page of its own: the snapshots that remain are listed on Templates", () => {
    expect(sidebar).not.toContain("snapshots");
    expect(routes.map((r) => r.nav)).not.toContain("snapshots");
  });

  test("About sits directly after Settings in the sidebar", () => {
    expect(routes.some((r) => r.nav === "about")).toBe(true);
    expect(sidebar.indexOf("about")).toBe(sidebar.indexOf("settings") + 1);
  });

  test("every route renders an imported page module that exports render()", () => {
    expect(routes.length).toBeGreaterThan(5);
    for (const { page } of routes) {
      const file = pageImports.get(page);
      expect(file, `route page ${page} is imported`).toBeDefined();
      const path = join(WEB, "js", "pages", `${file}.js`);
      expect(existsSync(path), path).toBe(true);
      expect(readFileSync(path, "utf8"), path).toMatch(/^export function render\(/m);
    }
  });
});

describe("console icons", () => {
  test("every icon the console names is in the icon set", () => {
    const names = consoleSources().flatMap((text) =>
      [...text.matchAll(/\bicon\("(\w+)"/g), ...text.matchAll(/data-icon="(\w+)"/g)].map((m) => m[1] ?? ""),
    );
    expect(names.length).toBeGreaterThan(20);
    // An unknown name falls back to the info icon rather than failing, so compare against that fallback.
    const unknown = [...new Set(names)].filter((name) => name !== "info" && icon(name) === icon("info"));
    expect(unknown).toEqual([]);
  });
});
