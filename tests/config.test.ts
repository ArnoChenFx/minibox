import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config";
import { setLogLevel } from "../src/lib/logger";

const KEY = "k".repeat(64);
const HEX_KEY = /^[0-9a-f]{64}$/;

let root: string;
let dataDir: string;
let envFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "minibox-config-"));
  dataDir = join(root, "data");
  envFile = join(root, ".env");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Every call uses a temp DATA_DIR and a temp .env, so tests never touch the repository's data/ or .env. */
const load = (env: Record<string, string | undefined> = {}) => loadConfig({ DATA_DIR: dataDir, ...env }, { envFile });
const mode = (path: string) => statSync(path).mode & 0o777;

describe("loadConfig", () => {
  test("process env wins and numbers are parsed", () => {
    const cfg = load({ ACCESS_KEY: KEY, HOST: "0.0.0.0", PORT: "4000", LABEL_PREFIX: "mb", LOG_LEVEL: "debug" });
    expect(cfg).toMatchObject({
      accessKey: KEY,
      accessKeySource: "env",
      dataDir,
      host: "0.0.0.0",
      port: 4000,
      labelPrefix: "mb",
      logLevel: "debug",
    });
    expect(cfg.baseTemplateTag).toBe("mb-template:base");
    expect(existsSync(join(dataDir, "access_key"))).toBe(false);
  });
  test("invalid values fall back to defaults", () => {
    const cfg = load({ ACCESS_KEY: KEY, PORT: "-1", METRICS_INTERVAL_MS: "abc", LOG_LEVEL: "loud" });
    expect(cfg.port).toBe(3920);
    expect(cfg.metricsIntervalMs).toBe(3000);
    expect(cfg.logLevel).toBe("info");
  });
  test("DATA_DIR comes from the process env, then .env", () => {
    const fromFile = join(root, "from-file");
    writeFileSync(envFile, `DATA_DIR=${fromFile}\n`);
    expect(loadConfig({ ACCESS_KEY: KEY }, { envFile }).dataDir).toBe(fromFile);
    expect(loadConfig({ ACCESS_KEY: KEY, DATA_DIR: dataDir }, { envFile }).dataDir).toBe(dataDir);
  });
});

describe("ACCESS_KEY precedence", () => {
  test("process env beats .env, which beats DATA_DIR/access_key", () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "access_key"), "stored\n", { mode: 0o600 });
    writeFileSync(envFile, "ACCESS_KEY=from-file\n");

    expect(load({ ACCESS_KEY: "from-env" })).toMatchObject({ accessKey: "from-env", accessKeySource: "env" });
    expect(load()).toMatchObject({ accessKey: "from-file", accessKeySource: "env-file" });

    rmSync(envFile);
    expect(load()).toMatchObject({ accessKey: "stored", accessKeySource: "data-dir" });
  });
  test("blank values count as unset and fall through to the next source", () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "access_key"), "stored\n", { mode: 0o600 });
    writeFileSync(envFile, "ACCESS_KEY=   \n");

    expect(load({ ACCESS_KEY: "" })).toMatchObject({ accessKey: "stored", accessKeySource: "data-dir" });
  });
  test("a generated key is never used once .env provides one", () => {
    writeFileSync(envFile, "ACCESS_KEY=from-file\n");
    expect(load()).toMatchObject({ accessKey: "from-file", accessKeySource: "env-file" });
    expect(existsSync(join(dataDir, "access_key"))).toBe(false);
  });
});

describe("generated ACCESS_KEY", () => {
  test("is written to DATA_DIR/access_key and the same key is read back on restart", () => {
    const first = load();
    expect(first.accessKeySource).toBe("generated");
    expect(first.accessKey).toMatch(HEX_KEY);
    expect(readFileSync(join(dataDir, "access_key"), "utf8")).toBe(`${first.accessKey}\n`);

    const restarted = load();
    expect(restarted).toMatchObject({ accessKey: first.accessKey, accessKeySource: "data-dir" });
    expect(load().accessKey).toBe(first.accessKey);
  });
  test("generated keys are unique per DATA_DIR", () => {
    const other = join(root, "other");
    const a = load();
    const b = loadConfig({ DATA_DIR: other }, { envFile });
    expect(a.accessKey).not.toBe(b.accessKey);
  });
});

describe(".env is never written", () => {
  test.each([
    ["without ACCESS_KEY", "PORT=4100\nDOCKER_SOCKET=/srv/docker.sock\nLABEL_PREFIX=team\n"],
    ["with a blank ACCESS_KEY", "ACCESS_KEY=\nPORT=4100\n# keep this comment\n"],
    ["with ACCESS_KEY set", "ACCESS_KEY=from-file\nHOST=0.0.0.0\n"],
  ])("unchanged when it exists %s", (_name, original) => {
    writeFileSync(envFile, original, { mode: 0o640 });
    chmodSync(envFile, 0o640);
    const before = statSync(envFile);

    load();

    expect(readFileSync(envFile, "utf8")).toBe(original);
    expect(statSync(envFile).mtimeMs).toBe(before.mtimeMs);
    expect(mode(envFile)).toBe(0o640);
  });
  test("is not created when it is missing", () => {
    load();
    expect(existsSync(envFile)).toBe(false);
  });
});

describe("permissions", () => {
  test("DATA_DIR and its subdirectories are 700 and the key file is 600", () => {
    load();
    for (const dir of [dataDir, join(dataDir, "boxes"), join(dataDir, "exec"), join(dataDir, "secrets")]) {
      expect(mode(dir)).toBe(0o700);
    }
    expect(mode(join(dataDir, "access_key"))).toBe(0o600);
  });
  test("a looser key file is tightened to 600 on the next load", () => {
    load();
    chmodSync(join(dataDir, "access_key"), 0o644);
    expect(load().accessKeySource).toBe("data-dir");
    expect(mode(join(dataDir, "access_key"))).toBe(0o600);
  });
  test("a looser DATA_DIR is tightened to 700", () => {
    mkdirSync(dataDir);
    chmodSync(dataDir, 0o755);
    load({ ACCESS_KEY: KEY });
    expect(mode(dataDir)).toBe(0o700);
  });
});

describe("unusable DATA_DIR", () => {
  beforeEach(() => setLogLevel("error"));
  afterEach(() => setLogLevel("info"));

  test("does not block startup when ACCESS_KEY is provided", () => {
    writeFileSync(dataDir, "not a directory");
    expect(load({ ACCESS_KEY: KEY })).toMatchObject({ accessKey: KEY, accessKeySource: "env", dataDir });
  });
  test("fails with an actionable error when a key has to be generated", () => {
    writeFileSync(dataDir, "not a directory");
    expect(() => load()).toThrow(/Set ACCESS_KEY or DATA_DIR/);
  });
  test("refuses to replace an empty key file", () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "access_key"), "\n");
    expect(() => load()).toThrow(/is empty; delete it/);
    expect(readFileSync(join(dataDir, "access_key"), "utf8")).toBe("\n");
  });
});
