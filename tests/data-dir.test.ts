import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  accessKeyPath,
  createSecretFile,
  ensureDataDir,
  readSecretFile,
  resolveDataDir,
  sessionsPath,
  writeFileAtomic,
} from "../src/data-dir";

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

test("sessionsPath sits directly in DATA_DIR", () => {
  expect(sessionsPath("/data")).toBe("/data/sessions.json");
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
    for (const path of [
      dataDir,
      join(dataDir, "boxes"),
      join(dataDir, "exec"),
      join(dataDir, "secrets"),
      join(dataDir, "volumes"),
    ]) {
      expect(mode(path)).toBe(0o700);
    }
  });
  test("ensureDataDir is idempotent and creates nothing beyond the layout", () => {
    const dataDir = join(dir, "data");
    ensureDataDir(dataDir);
    ensureDataDir(dataDir);
    expect(readdirSync(dataDir).toSorted()).toEqual(["boxes", "checkpoints", "exec", "secrets", "volumes"]);
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

describe("writeFileAtomic", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "minibox-atomic-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("replaces the contents and leaves no temporary file behind", () => {
    const path = join(dir, "sessions.json");
    writeFileAtomic(path, "first\n");
    writeFileAtomic(path, "second\n");
    expect(readFileSync(path, "utf8")).toBe("second\n");
    expect(readdirSync(dir)).toEqual(["sessions.json"]);
  });
  test("creates files with mode 600 unless told otherwise", () => {
    const secret = join(dir, "secret");
    writeFileAtomic(secret, "x");
    expect(mode(secret)).toBe(0o600);

    const shared = join(dir, "shared");
    writeFileAtomic(shared, "x", 0o644);
    expect(mode(shared)).toBe(0o644);
  });
  test("a failed write throws and leaves nothing behind", () => {
    const path = join(dir, "missing", "sessions.json");
    expect(() => writeFileAtomic(path, "x")).toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});
