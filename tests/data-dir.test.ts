import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { accessKeyPath, createSecretFile, ensureDataDir, readSecretFile, resolveDataDir } from "../src/data-dir";

const mode = (path: string) => statSync(path).mode & 0o777;

describe("resolveDataDir", () => {
  const root = "/srv/minibox";
  const home = "/home/dev";

  test("unset or blank means <root>/data", () => {
    expect(resolveDataDir(undefined, root, home)).toBe("/srv/minibox/data");
    expect(resolveDataDir("   ", root, home)).toBe("/srv/minibox/data");
  });
  test("relative paths resolve from the project root", () => {
    expect(resolveDataDir("./state", root, home)).toBe("/srv/minibox/state");
    expect(resolveDataDir("../shared", root, home)).toBe("/srv/shared");
  });
  test("absolute paths are kept and ~ expands to the home directory", () => {
    expect(resolveDataDir("/var/lib/minibox", root, home)).toBe("/var/lib/minibox");
    expect(resolveDataDir("~/minibox", root, home)).toBe("/home/dev/minibox");
    expect(resolveDataDir("~", root, home)).toBe("/home/dev");
  });
});

test("accessKeyPath sits directly in DATA_DIR", () => {
  expect(accessKeyPath("/data")).toBe("/data/access_key");
});

describe("layout and secret files", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "minibox-data-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("ensureDataDir creates the documented subdirectories with mode 700", () => {
    const dataDir = join(dir, "data");
    ensureDataDir(dataDir);
    for (const path of [dataDir, join(dataDir, "boxes"), join(dataDir, "exec"), join(dataDir, "secrets")]) {
      expect(mode(path)).toBe(0o700);
    }
  });
  test("ensureDataDir is idempotent and creates nothing beyond the layout", () => {
    const dataDir = join(dir, "data");
    ensureDataDir(dataDir);
    ensureDataDir(dataDir);
    expect(readdirSync(dataDir).toSorted()).toEqual(["boxes", "exec", "secrets"]);
  });
  test("ensureDataDir tightens a looser existing directory", () => {
    const dataDir = join(dir, "data");
    mkdirSync(dataDir);
    chmodSync(dataDir, 0o755);
    ensureDataDir(dataDir);
    expect(mode(dataDir)).toBe(0o700);
  });
  test("createSecretFile writes a 600 file once and never overwrites it", () => {
    const path = join(dir, "access_key");
    expect(createSecretFile(path, "first")).toBe(true);
    expect(mode(path)).toBe(0o600);
    expect(createSecretFile(path, "second")).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("first\n");
  });
  test("readSecretFile returns null when missing or blank, trims, and tightens the mode", () => {
    const path = join(dir, "access_key");
    expect(readSecretFile(path)).toBeNull();

    writeFileSync(path, "  value \n");
    chmodSync(path, 0o644);
    expect(readSecretFile(path)).toBe("value");
    expect(mode(path)).toBe(0o600);

    writeFileSync(path, "  \n");
    expect(readSecretFile(path)).toBeNull();
  });
});
