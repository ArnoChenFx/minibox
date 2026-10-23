import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "../src/config";
import { icon } from "../web/js/lib/icons.js";

const WEB = join(ROOT, "web");

/** The console's own scripts, plus the two HTML pages. Vendored libraries are excluded. */
function consoleSources(): string[] {
  const scripts = readdirSync(join(WEB, "js"), { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".js"))
    .map((name) => join(WEB, "js", name));
  return [...scripts, join(WEB, "index.html"), join(WEB, "login.html")].map((path) => readFileSync(path, "utf8"));
}

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
