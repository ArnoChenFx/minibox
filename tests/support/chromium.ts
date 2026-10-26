import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { chromium } from "@playwright/test";

/** The names a Chromium binary goes by on `PATH`, in the order they are preferred. */
const SYSTEM_NAMES = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"];

/** Binaries relative to one `chromium-<version>/chrome-linux*` or `chromium-<version>/chrome-mac*` directory. */
const BUILD_BINARIES = [
  "chrome",
  join("Chromium.app", "Contents", "MacOS", "Chromium"),
  join("Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
];

/** Installed Chrome bundles on macOS, relative to the user's home and to `/Applications`. */
const MAC_CHROME_APPS = [
  ["Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"],
  ["Applications", "Chromium.app", "Contents", "MacOS", "Chromium"],
];

type Readdir = (dir: string) => string[];

/**
 * Everything `resolveChromiumPath` reads from the machine, so a test can stand in for all of it. Every field defaults to
 * the real thing.
 */
export interface ChromiumLookup {
  env?: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
  readdir?: Readdir;
  home?: string;
  platform?: NodeJS.Platform;
  /** Playwright's own idea of where its Chromium is, which is `chromium.executablePath()` unless a test says otherwise. */
  playwrightExecutable?: () => string;
}

const listDir = (dir: string, readdir: Readdir): string[] => {
  try {
    return readdir(dir);
  } catch {
    return [];
  }
};

/** Compares two dotted numeric versions, so `1248` sorts after `1187` and `1187.0.1` after `1187`. */
function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The Playwright browser caches to scan. `PLAYWRIGHT_BROWSERS_PATH` replaces them; the value `0` means Playwright keeps
 * its browsers inside `node_modules`, which is not a cache this can read.
 */
function browserCaches(env: Record<string, string | undefined>, home: string, platform: NodeJS.Platform): string[] {
  const configured = env.PLAYWRIGHT_BROWSERS_PATH;
  if (configured === "0") return [];
  if (configured) return [configured];
  return platform === "darwin"
    ? [join(home, "Library", "Caches", "ms-playwright"), join(home, ".cache", "ms-playwright")]
    : [join(home, ".cache", "ms-playwright")];
}

/** Every Chromium build in one Playwright cache directory, newest version first. */
function cachedChromiumPaths(cache: string, readdir: Readdir): string[] {
  const builds = listDir(cache, readdir)
    .map((name) => ({ name, version: /^chromium-(\d+(?:\.\d+)*)$/.exec(name)?.[1] }))
    .filter((build): build is { name: string; version: string } => build.version !== undefined)
    .toSorted((a, b) => compareVersions(b.version, a.version));
  return builds.flatMap((build) =>
    listDir(join(cache, build.name), readdir)
      .filter((entry) => entry.startsWith("chrome-linux") || entry.startsWith("chrome-mac"))
      .flatMap((entry) => BUILD_BINARIES.map((binary) => join(cache, build.name, entry, binary))),
  );
}

/** A Chromium or Chrome on `PATH`, or the installed Chrome bundle on macOS. */
function systemChromium(
  env: Record<string, string | undefined>,
  home: string,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean,
): string | null {
  const separator = platform === "win32" ? ";" : ":";
  for (const dir of (env.PATH ?? "").split(separator)) {
    if (!dir) continue;
    for (const name of SYSTEM_NAMES) {
      const path = join(dir, name);
      if (exists(path)) return path;
    }
  }
  if (platform === "darwin") {
    for (const root of [home, "/Applications"]) {
      for (const parts of MAC_CHROME_APPS) {
        const path = join(root, ...parts);
        if (exists(path)) return path;
      }
    }
  }
  return null;
}

/**
 * The Chromium a browser test can launch, or null when this machine has none. Tried in order: an explicit
 * `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`, the build Playwright itself installed, the newest build in a Playwright browser
 * cache, then a Chromium or Chrome on `PATH` (or the Chrome bundle on macOS). A path that is set but does not exist is
 * skipped, never used.
 */
export function resolveChromiumPath(lookup: ChromiumLookup = {}): string | null {
  const env = lookup.env ?? process.env;
  const exists = lookup.exists ?? existsSync;
  const readdir = lookup.readdir ?? ((dir: string) => readdirSync(dir));
  const home = lookup.home ?? homedir();
  const platform = lookup.platform ?? process.platform;
  const playwrightExecutable = lookup.playwrightExecutable ?? (() => chromium.executablePath());

  const usable = (path: string | null | undefined): string | null => (path && exists(path) ? path : null);

  const configured = usable(env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
  if (configured) return configured;

  // Some Playwright versions throw from executablePath() when nothing is installed; a browser that cannot be located is
  // simply not a candidate here.
  let bundled: string | null = null;
  try {
    bundled = usable(playwrightExecutable());
  } catch {
    bundled = null;
  }
  if (bundled) return bundled;

  for (const cache of browserCaches(env, home, platform)) {
    const cached = cachedChromiumPaths(cache, readdir).find((path) => exists(path));
    if (cached) return cached;
  }

  return systemChromium(env, home, platform, exists);
}

/**
 * The Chromium for one browser test file, named `testName` so a failure says which file needed it. Locally a missing
 * browser returns null, which skips the suite. In CI it throws instead, so the layout tests cannot pass by being skipped.
 */
export function chromiumFor(testName: string, lookup: ChromiumLookup = {}): string | null {
  const found = resolveChromiumPath(lookup);
  if (found) return found;
  const env = lookup.env ?? process.env;
  if (!env.CI) return null;
  throw new Error(
    `${testName} needs Chromium: run \`bunx playwright install --with-deps chromium\`, or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to an installed Chromium.`,
  );
}
