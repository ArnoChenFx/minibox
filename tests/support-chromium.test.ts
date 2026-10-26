import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type ChromiumLookup, chromiumFor, resolveChromiumPath } from "./support/chromium";

/** A fake machine: a set of existing files, and a set of directory listings. Nothing here touches the real one. */
function machine(
  files: string[],
  dirs: Record<string, string[]> = {},
): Required<Pick<ChromiumLookup, "exists" | "readdir">> {
  const existing = new Set(files);
  return {
    exists: (path) => existing.has(path),
    readdir: (dir) => {
      const entries = dirs[dir];
      if (!entries) throw Object.assign(new Error(`ENOENT: ${dir}`), { code: "ENOENT" });
      return entries;
    },
  };
}

const CACHE = "/home/dev/.cache/ms-playwright";
const home = "/home/dev";

const lookup = (over: Partial<ChromiumLookup> & Pick<ChromiumLookup, "exists" | "readdir">): ChromiumLookup => ({
  env: {},
  home,
  platform: "linux",
  playwrightExecutable: () => `${CACHE}/chromium-1248/chrome-linux64/chrome`,
  ...over,
});

describe("resolveChromiumPath", () => {
  test.each([
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ])("on macOS the system bundle at %s is found", (path) => {
    expect(resolveChromiumPath(lookup({ ...machine([path]), platform: "darwin" }))).toBe(path);
  });
  test("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH wins over every other source", () => {
    const found = resolveChromiumPath(
      lookup({
        ...machine(["/opt/chrome/chrome", "/usr/bin/chromium", `${CACHE}/chromium-1187/chrome-linux/chrome`], {
          [CACHE]: ["chromium-1187"],
          [`${CACHE}/chromium-1187`]: ["chrome-linux"],
        }),
        env: { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: "/opt/chrome/chrome", PATH: "/usr/bin" },
        playwrightExecutable: () => `${CACHE}/chromium-1187/chrome-linux/chrome`,
      }),
    );
    expect(found).toBe("/opt/chrome/chrome");
  });

  test("an env path that does not exist is not used, and the search goes on", () => {
    const found = resolveChromiumPath(
      lookup({
        ...machine(["/usr/bin/chromium-browser"], { [CACHE]: [] }),
        env: { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: "/opt/gone/chrome", PATH: "/usr/bin" },
        playwrightExecutable: () => `${CACHE}/chromium-1248/chrome-linux64/chrome`,
      }),
    );
    expect(found).toBe("/usr/bin/chromium-browser");
  });

  test("Playwright's own Chromium is used when it exists", () => {
    const found = resolveChromiumPath(
      lookup({
        ...machine([`${CACHE}/chromium-1248/chrome-linux64/chrome`], { [CACHE]: ["chromium-1248"] }),
        env: { PATH: "/usr/bin" },
      }),
    );
    expect(found).toBe(`${CACHE}/chromium-1248/chrome-linux64/chrome`);
  });

  test("a Playwright path that does not exist is skipped", () => {
    const found = resolveChromiumPath(
      lookup({
        ...machine([`${CACHE}/chromium-1187/chrome-linux/chrome`], {
          [CACHE]: ["chromium-1187"],
          [`${CACHE}/chromium-1187`]: ["chrome-linux"],
        }),
        env: { PATH: "/usr/bin" },
      }),
    );
    expect(found).toBe(`${CACHE}/chromium-1187/chrome-linux/chrome`);
  });

  test("the cache is scanned newest version first, so an older install still runs the tests", () => {
    const found = resolveChromiumPath(
      lookup({
        ...machine(
          [
            `${CACHE}/chromium-1187/chrome-linux/chrome`,
            `${CACHE}/chromium-1248/chrome-linux64/chrome`,
            `${CACHE}/chromium-999/chrome-linux/chrome`,
          ],
          {
            [CACHE]: ["chromium_headless_shell-1187", "chromium-1187", "chromium-1248", "chromium-999", "ffmpeg-1011"],
            [`${CACHE}/chromium-1187`]: ["chrome-linux"],
            [`${CACHE}/chromium-1248`]: ["chrome-linux64"],
            [`${CACHE}/chromium-999`]: ["chrome-linux"],
          },
        ),
        env: { PATH: "/usr/bin" },
      }),
    );
    expect(found).toBe(`${CACHE}/chromium-1248/chrome-linux64/chrome`);
  });

  test("a cached build without a chrome binary is skipped for the next newest", () => {
    const found = resolveChromiumPath(
      lookup({
        ...machine([`${CACHE}/chromium-1187/chrome-linux/chrome`], {
          [CACHE]: ["chromium-1248", "chromium-1187"],
          // A half-finished install: the version directory exists, its chrome-linux64 does not.
          [`${CACHE}/chromium-1248`]: [],
          [`${CACHE}/chromium-1187`]: ["chrome-linux"],
        }),
        env: { PATH: "/usr/bin" },
      }),
    );
    expect(found).toBe(`${CACHE}/chromium-1187/chrome-linux/chrome`);
  });

  test("a cached chrome-linux directory without the binary is skipped too", () => {
    const found = resolveChromiumPath(
      lookup({
        ...machine([`${CACHE}/chromium-1187/chrome-linux/chrome`], {
          [CACHE]: ["chromium-1248", "chromium-1187"],
          [`${CACHE}/chromium-1248`]: ["chrome-linux64"],
          [`${CACHE}/chromium-1187`]: ["chrome-linux"],
        }),
        env: { PATH: "/usr/bin" },
      }),
    );
    expect(found).toBe(`${CACHE}/chromium-1187/chrome-linux/chrome`);
  });

  test("PLAYWRIGHT_BROWSERS_PATH replaces the default cache", () => {
    const custom = "/opt/ms-playwright";
    const found = resolveChromiumPath(
      lookup({
        ...machine([`${custom}/chromium-1200/chrome-linux/chrome`, `${CACHE}/chromium-1187/chrome-linux/chrome`], {
          [custom]: ["chromium-1200"],
          [`${custom}/chromium-1200`]: ["chrome-linux"],
          [CACHE]: ["chromium-1187"],
          [`${CACHE}/chromium-1187`]: ["chrome-linux"],
        }),
        env: { PLAYWRIGHT_BROWSERS_PATH: custom, PATH: "/usr/bin" },
      }),
    );
    expect(found).toBe(`${custom}/chromium-1200/chrome-linux/chrome`);
  });

  test("a Chromium on PATH is used when neither Playwright nor a cache has one", () => {
    const found = resolveChromiumPath(
      lookup({
        ...machine(["/usr/bin/google-chrome-stable"], { [CACHE]: [] }),
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      }),
    );
    expect(found).toBe("/usr/bin/google-chrome-stable");
  });

  test("PATH is searched in order, like a shell does", () => {
    const found = resolveChromiumPath(
      lookup({
        ...machine(["/usr/bin/chromium", "/opt/bin/google-chrome"], { [CACHE]: [] }),
        env: { PATH: "/opt/bin:/usr/bin" },
      }),
    );
    expect(found).toBe("/opt/bin/google-chrome");
  });

  test("within one PATH directory, chromium is preferred over google-chrome", () => {
    const found = resolveChromiumPath(
      lookup({
        ...machine(["/usr/bin/chromium", "/usr/bin/google-chrome"], { [CACHE]: [] }),
        env: { PATH: "/usr/bin" },
      }),
    );
    expect(found).toBe("/usr/bin/chromium");
  });

  test("empty PATH entries are skipped, so a relative binary is never picked", () => {
    const found = resolveChromiumPath(
      lookup({ ...machine(["/usr/bin/chromium-browser"], { [CACHE]: [] }), env: { PATH: ":/usr/bin:" } }),
    );
    expect(found).toBe("/usr/bin/chromium-browser");
  });

  test("on macOS the installed Chrome bundle is found under the home directory", () => {
    const found = resolveChromiumPath(
      lookup({
        ...machine(["/home/dev/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"], { [CACHE]: [] }),
        env: { PATH: "/usr/bin" },
        platform: "darwin",
      }),
    );
    expect(found).toBe("/home/dev/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  });

  test("on macOS a cached chrome-mac build is recognised", () => {
    const cache = "/home/dev/Library/Caches/ms-playwright";
    const found = resolveChromiumPath(
      lookup({
        ...machine([`${cache}/chromium-1187/chrome-mac/Chromium.app/Contents/MacOS/Chromium`], {
          [cache]: ["chromium-1187"],
          [`${cache}/chromium-1187`]: ["chrome-mac"],
        }),
        env: { PATH: "/usr/bin" },
        platform: "darwin",
      }),
    );
    expect(found).toBe(`${cache}/chromium-1187/chrome-mac/Chromium.app/Contents/MacOS/Chromium`);
  });

  test("returns null when the machine has no browser at all", () => {
    const found = resolveChromiumPath(
      lookup({ ...machine([], { [CACHE]: ["ffmpeg-1011"] }), env: { PATH: "/usr/bin:/bin" } }),
    );
    expect(found).toBeNull();
  });

  test("a Playwright that throws when it has no browser is skipped, not fatal", () => {
    const found = resolveChromiumPath(
      lookup({
        ...machine(["/usr/bin/chromium"], { [CACHE]: [] }),
        env: { PATH: "/usr/bin" },
        playwrightExecutable: () => {
          throw new Error("Executable doesn't exist");
        },
      }),
    );
    expect(found).toBe("/usr/bin/chromium");
  });

  test("an unreadable cache directory does not throw", () => {
    const found = resolveChromiumPath(
      lookup({
        exists: () => false,
        readdir: () => {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        },
        env: { PATH: "" },
      }),
    );
    expect(found).toBeNull();
  });
});

/** A CI machine with no browser anywhere, used by the two tests below. */
const ciWithoutBrowser = () =>
  chromiumFor(
    "The volumes page test",
    lookup({ ...machine([], { [CACHE]: [] }), env: { CI: "true", PATH: "/usr/bin" } }),
  );

describe("chromiumFor", () => {
  test("returns the path it finds", () => {
    const found = chromiumFor(
      "The volumes page test",
      lookup({
        ...machine(["/usr/bin/chromium"], { [CACHE]: [] }),
        env: { PATH: "/usr/bin" },
      }),
    );
    expect(found).toBe("/usr/bin/chromium");
  });

  test("locally a missing browser returns null, so the suite skips", () => {
    expect(chromiumFor("The volumes page test", lookup({ ...machine([], { [CACHE]: [] }), env: {} }))).toBeNull();
  });

  test("in CI a missing browser throws, naming the test and how to install one", () => {
    expect(ciWithoutBrowser).toThrow(/The volumes page test needs Chromium/);
    expect(ciWithoutBrowser).toThrow(/bunx playwright install --with-deps chromium/);
    expect(ciWithoutBrowser).toThrow(/PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH/);
  });

  test("in CI a browser that exists is returned instead of throwing", () => {
    const found = chromiumFor(
      "The volumes page test",
      lookup({
        ...machine(["/usr/bin/chromium"], { [CACHE]: [] }),
        env: { CI: "true", PATH: "/usr/bin" },
      }),
    );
    expect(found).toBe("/usr/bin/chromium");
  });
});

describe("the browser test files", () => {
  /** Every test file that drives a browser: it imports Playwright's `chromium` and launches it. */
  const browserTests = readdirSync(join(import.meta.dir))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => ({ name, source: readFileSync(join(import.meta.dir, name), "utf8") }))
    .filter((file) => file.source.includes('from "@playwright/test"') && /chromium\.launch\s*\(/.test(file.source));

  test("there are browser tests, so this guard cannot pass by covering nothing", () => {
    expect(browserTests.length).toBeGreaterThanOrEqual(11);
  });

  test("each one asks the shared resolver for a browser, rather than copying a lookup of its own", () => {
    // A file that keeps its own resolution skips silently on a machine whose cached build is older than the installed
    // Playwright, which is exactly the gap the shared resolver closes.
    const strays = browserTests
      .filter((file) => !file.source.includes('from "./support/chromium"') || !file.source.includes("chromiumFor("))
      .map((file) => file.name);
    expect(strays).toEqual([]);
  });
});
