import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { DEFAULT_MCP_ALLOW_OWNER_KEY, loadConfig, ROOT } from "../src/config";
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
  test("TRUST_PROXY is off unless explicitly enabled", () => {
    expect(load({ ACCESS_KEY: KEY }).trustProxy).toBe(false);
    expect(load({ ACCESS_KEY: KEY, TRUST_PROXY: "false" }).trustProxy).toBe(false);
    expect(load({ ACCESS_KEY: KEY, TRUST_PROXY: "0" }).trustProxy).toBe(false);
    expect(load({ ACCESS_KEY: KEY, TRUST_PROXY: "true" }).trustProxy).toBe(true);
    expect(load({ ACCESS_KEY: KEY, TRUST_PROXY: " ON " }).trustProxy).toBe(true);
  });
  test("COOKIE_SECURE is off unless enabled", () => {
    expect(load({ ACCESS_KEY: KEY }).cookieSecure).toBe(false);
    expect(load({ ACCESS_KEY: KEY, COOKIE_SECURE: "0" }).cookieSecure).toBe(false);
    expect(load({ ACCESS_KEY: KEY, COOKIE_SECURE: "1" }).cookieSecure).toBe(true);
  });
  test("ALLOWED_ORIGINS is a comma-separated list normalized to origins", () => {
    const cfg = load({
      ACCESS_KEY: KEY,
      ALLOWED_ORIGINS: "https://panel.example.net/, http://192.168.1.5:3920 ,",
    });
    expect(cfg.allowedOrigins).toEqual(["https://panel.example.net", "http://192.168.1.5:3920"]);
  });
  test("ALLOWED_ORIGINS rejects entries that are not http(s) origins", () => {
    expect(() => load({ ACCESS_KEY: KEY, ALLOWED_ORIGINS: "minibox.example.com" })).toThrow("ALLOWED_ORIGINS");
    expect(() => load({ ACCESS_KEY: KEY, ALLOWED_ORIGINS: "ftp://files.example.com" })).toThrow("ALLOWED_ORIGINS");
  });
  test("event retention and output limits default to 365, 30, 7 days and 512 MB", () => {
    expect(load({ ACCESS_KEY: KEY })).toMatchObject({
      eventRetentionAuditDays: 365,
      eventRetentionActivityDays: 30,
      eventOutputRetentionDays: 7,
      eventOutputMaxMb: 512,
    });
  });
  test("event retention and output limits are read from the environment or .env", () => {
    writeFileSync(envFile, "EVENT_OUTPUT_MAX_MB=64\n");
    expect(
      load({
        ACCESS_KEY: KEY,
        EVENT_RETENTION_AUDIT_DAYS: "90",
        EVENT_RETENTION_ACTIVITY_DAYS: "7",
        EVENT_OUTPUT_RETENTION_DAYS: "2",
      }),
    ).toMatchObject({
      eventRetentionAuditDays: 90,
      eventRetentionActivityDays: 7,
      eventOutputRetentionDays: 2,
      eventOutputMaxMb: 64,
    });
  });
  test("event retention values that are not positive whole numbers fall back to the defaults", () => {
    expect(
      load({
        ACCESS_KEY: KEY,
        EVENT_RETENTION_AUDIT_DAYS: "0",
        EVENT_RETENTION_ACTIVITY_DAYS: "forever",
        EVENT_OUTPUT_RETENTION_DAYS: "1.5",
        EVENT_OUTPUT_MAX_MB: "-3",
      }),
    ).toMatchObject({
      eventRetentionAuditDays: 365,
      eventRetentionActivityDays: 30,
      eventOutputRetentionDays: 7,
      eventOutputMaxMb: 512,
    });
  });
  test("STOP_TIMEOUT_SEC defaults to 3 seconds and accepts whole numbers from 0 to 300", () => {
    expect(load({ ACCESS_KEY: KEY }).stopTimeoutSec).toBe(3);
    expect(load({ ACCESS_KEY: KEY, STOP_TIMEOUT_SEC: "0" }).stopTimeoutSec).toBe(0);
    expect(load({ ACCESS_KEY: KEY, STOP_TIMEOUT_SEC: " 20 " }).stopTimeoutSec).toBe(20);
    expect(load({ ACCESS_KEY: KEY, STOP_TIMEOUT_SEC: "300" }).stopTimeoutSec).toBe(300);
  });
  test.each(["301", "-1", "1.5", "soon", ""])("STOP_TIMEOUT_SEC=%p falls back to 3 seconds", (value) => {
    expect(load({ ACCESS_KEY: KEY, STOP_TIMEOUT_SEC: value }).stopTimeoutSec).toBe(3);
  });
});

describe("box security settings", () => {
  test("default to the standard profile, 1024 processes and the engine's default runtime", () => {
    expect(load({ ACCESS_KEY: KEY })).toMatchObject({
      boxProfile: "standard",
      boxPidsLimit: 1024,
      containerRuntime: null,
    });
  });
  test("BOX_PROFILE, BOX_PIDS_LIMIT and RUNTIME are read from the environment", () => {
    expect(load({ ACCESS_KEY: KEY, BOX_PROFILE: "strict", BOX_PIDS_LIMIT: "256", RUNTIME: "runsc" })).toMatchObject({
      boxProfile: "strict",
      boxPidsLimit: 256,
      containerRuntime: "runsc",
    });
  });
  test("they can also come from .env", () => {
    writeFileSync(envFile, "BOX_PROFILE=relaxed\nBOX_PIDS_LIMIT=512\nRUNTIME=runsc\n");
    expect(loadConfig({ ACCESS_KEY: KEY, DATA_DIR: dataDir }, { envFile })).toMatchObject({
      boxProfile: "relaxed",
      boxPidsLimit: 512,
      containerRuntime: "runsc",
    });
  });
  test("blank values count as unset", () => {
    expect(load({ ACCESS_KEY: KEY, BOX_PROFILE: " ", BOX_PIDS_LIMIT: "", RUNTIME: "  " })).toMatchObject({
      boxProfile: "standard",
      boxPidsLimit: 1024,
      containerRuntime: null,
    });
  });
  test("invalid values stop startup instead of silently changing box hardening", () => {
    expect(() => load({ ACCESS_KEY: KEY, BOX_PROFILE: "paranoid" })).toThrow("BOX_PROFILE");
    expect(() => load({ ACCESS_KEY: KEY, BOX_PIDS_LIMIT: "0" })).toThrow("BOX_PIDS_LIMIT");
    expect(() => load({ ACCESS_KEY: KEY, BOX_PIDS_LIMIT: "-1" })).toThrow("BOX_PIDS_LIMIT");
    expect(() => load({ ACCESS_KEY: KEY, BOX_PIDS_LIMIT: "1.5" })).toThrow("BOX_PIDS_LIMIT");
    expect(() => load({ ACCESS_KEY: KEY, RUNTIME: "runsc --debug" })).toThrow("RUNTIME");
  });
});

describe("BLOCK_HOST_GATEWAY", () => {
  test("is off when unset or blank", () => {
    expect(load({ ACCESS_KEY: KEY }).blockHostGateway).toBe(false);
    expect(load({ ACCESS_KEY: KEY, BLOCK_HOST_GATEWAY: "  " }).blockHostGateway).toBe(false);
  });
  test("1, true, yes and on turn it on in any letter case", () => {
    for (const value of ["1", "true", "TRUE", "yes", "On"]) {
      expect(load({ ACCESS_KEY: KEY, BLOCK_HOST_GATEWAY: value }).blockHostGateway).toBe(true);
    }
  });
  test("any other value leaves it off", () => {
    for (const value of ["0", "false", "no", "off", "maybe"]) {
      expect(load({ ACCESS_KEY: KEY, BLOCK_HOST_GATEWAY: value }).blockHostGateway).toBe(false);
    }
  });
  test("can come from .env, and the process env wins over it", () => {
    writeFileSync(envFile, "BLOCK_HOST_GATEWAY=true\n");
    expect(loadConfig({ ACCESS_KEY: KEY, DATA_DIR: dataDir }, { envFile }).blockHostGateway).toBe(true);
    expect(
      loadConfig({ ACCESS_KEY: KEY, DATA_DIR: dataDir, BLOCK_HOST_GATEWAY: "0" }, { envFile }).blockHostGateway,
    ).toBe(false);
  });
});

describe("MCP_ALLOW_OWNER_KEY", () => {
  test("is false by default, so /mcp refuses the owner access key unless the operator opts in", () => {
    expect(DEFAULT_MCP_ALLOW_OWNER_KEY).toBe(false);
    expect(load({ ACCESS_KEY: KEY }).mcpAllowOwnerKey).toBe(false);
    expect(load({ ACCESS_KEY: KEY, MCP_ALLOW_OWNER_KEY: "  " }).mcpAllowOwnerKey).toBe(false);
  });
  test("true and false are read in any letter case, with the usual yes, no, on, off, 1 and 0 spellings", () => {
    for (const value of ["true", "TRUE", "1", "yes", "On"]) {
      expect(load({ ACCESS_KEY: KEY, MCP_ALLOW_OWNER_KEY: value }).mcpAllowOwnerKey).toBe(true);
    }
    for (const value of ["false", "False", "0", "no", "OFF"]) {
      expect(load({ ACCESS_KEY: KEY, MCP_ALLOW_OWNER_KEY: value }).mcpAllowOwnerKey).toBe(false);
    }
  });
  test("true in .env restores the earlier behavior, and the process env wins over .env", () => {
    writeFileSync(envFile, "MCP_ALLOW_OWNER_KEY=true\n");
    expect(loadConfig({ ACCESS_KEY: KEY, DATA_DIR: dataDir }, { envFile }).mcpAllowOwnerKey).toBe(true);
    expect(
      loadConfig({ ACCESS_KEY: KEY, DATA_DIR: dataDir, MCP_ALLOW_OWNER_KEY: "false" }, { envFile }).mcpAllowOwnerKey,
    ).toBe(false);
  });
  test("a value that is neither true nor false stops startup, since it guards a credential", () => {
    expect(() => load({ ACCESS_KEY: KEY, MCP_ALLOW_OWNER_KEY: "maybe" })).toThrow(
      'MCP_ALLOW_OWNER_KEY: "maybe" must be true or false',
    );
    expect(() => load({ ACCESS_KEY: KEY, MCP_ALLOW_OWNER_KEY: "2" })).toThrow("MCP_ALLOW_OWNER_KEY");
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
  test("a value Bun mirrored from .env into the process env is reported as env-file", () => {
    writeFileSync(envFile, "ACCESS_KEY=from-file\n");
    expect(load({ ACCESS_KEY: "from-file" })).toMatchObject({ accessKey: "from-file", accessKeySource: "env-file" });
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

describe("ACCESS_KEY strength", () => {
  test("a weak key still loads, so the startup warning never blocks a deployment", () => {
    expect(load({ ACCESS_KEY: "short" })).toMatchObject({ accessKey: "short", accessKeySource: "env" });
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

describe("browser session lifetime", () => {
  const DAY = 24 * 60 * 60 * 1000;

  test("defaults to 30 days from sign-in, with no sliding renewal", () => {
    expect(load({ ACCESS_KEY: KEY })).toMatchObject({ sessionTtlMs: 30 * DAY, sessionIdleMs: null });
  });
  test("SESSION_TTL_DAYS and SESSION_IDLE_DAYS are read as days, fractions included", () => {
    expect(load({ ACCESS_KEY: KEY, SESSION_TTL_DAYS: "7", SESSION_IDLE_DAYS: "0.5" })).toMatchObject({
      sessionTtlMs: 7 * DAY,
      sessionIdleMs: DAY / 2,
    });
  });
  test("blank values fall back to the defaults", () => {
    expect(load({ ACCESS_KEY: KEY, SESSION_TTL_DAYS: " ", SESSION_IDLE_DAYS: "" })).toMatchObject({
      sessionTtlMs: 30 * DAY,
      sessionIdleMs: null,
    });
  });
  test("the longest allowed lifetime is 3650 days", () => {
    expect(load({ ACCESS_KEY: KEY, SESSION_TTL_DAYS: "3650" }).sessionTtlMs).toBe(3650 * DAY);
  });
  test.each(["0", "-3", "abc", "3651", "Infinity"])("%s stops startup instead of being guessed at", (value) => {
    expect(() => load({ ACCESS_KEY: KEY, SESSION_TTL_DAYS: value })).toThrow(
      `SESSION_TTL_DAYS must be a number of days above 0 and at most 3650, got "${value}"`,
    );
    expect(() => load({ ACCESS_KEY: KEY, SESSION_IDLE_DAYS: value })).toThrow("SESSION_IDLE_DAYS must be a number");
  });
});

describe("live stream cap", () => {
  test("STREAM_MAX_CONNECTIONS is 256 by default and can be set", () => {
    expect(load({ ACCESS_KEY: KEY }).streamMaxConnections).toBe(256);
    expect(load({ ACCESS_KEY: KEY, STREAM_MAX_CONNECTIONS: "32" }).streamMaxConnections).toBe(32);
  });
  test("a blank, zero or non-numeric STREAM_MAX_CONNECTIONS falls back to the default", () => {
    for (const value of ["", "0", "many"]) {
      expect(load({ ACCESS_KEY: KEY, STREAM_MAX_CONNECTIONS: value }).streamMaxConnections).toBe(256);
    }
  });
});

describe("checkpoint retention and capacity", () => {
  test("keeps 20 automatic checkpoints per box for 30 days, with no capacity limit, by default", () => {
    expect(load({ ACCESS_KEY: KEY })).toMatchObject({
      checkpointKeepLast: 20,
      checkpointKeepDays: 30,
      checkpointCapacityMb: 0,
    });
  });
  test("CHECKPOINT_KEEP_LAST, CHECKPOINT_KEEP_DAYS and CHECKPOINT_CAPACITY_MB set the policy, and 0 days or 0 MB turn their bound off", () => {
    expect(
      load({
        ACCESS_KEY: KEY,
        CHECKPOINT_KEEP_LAST: "5",
        CHECKPOINT_KEEP_DAYS: "0",
        CHECKPOINT_CAPACITY_MB: "2048",
      }),
    ).toMatchObject({ checkpointKeepLast: 5, checkpointKeepDays: 0, checkpointCapacityMb: 2048 });
  });
  test.each(["0", "-3", "1.5", "many"])("CHECKPOINT_KEEP_LAST=%s falls back to the default", (value) => {
    expect(load({ ACCESS_KEY: KEY, CHECKPOINT_KEEP_LAST: value })).toMatchObject({ checkpointKeepLast: 20 });
  });
  test("a recycle bin keeps deleted boxes and volumes for 7 days by default", () => {
    expect(load({ ACCESS_KEY: KEY })).toMatchObject({ trashRetentionDays: 7 });
  });
  test("TRASH_RETENTION_DAYS sets the retention, and a value outside 1 to 365 falls back to 7", () => {
    expect(load({ ACCESS_KEY: KEY, TRASH_RETENTION_DAYS: "30" })).toMatchObject({ trashRetentionDays: 30 });
    for (const value of ["0", "366", "-2", "soon"]) {
      expect(load({ ACCESS_KEY: KEY, TRASH_RETENTION_DAYS: value })).toMatchObject({ trashRetentionDays: 7 });
    }
  });
});

describe("host overcommit", () => {
  test("is 1, which books no more than a host has, when HOST_OVERCOMMIT is unset or blank", () => {
    expect(load({ ACCESS_KEY: KEY }).hostOvercommit).toBe(1);
    expect(load({ ACCESS_KEY: KEY, HOST_OVERCOMMIT: "  " }).hostOvercommit).toBe(1);
  });
  test("accepts a ratio from 1 to 10, fractions included", () => {
    expect(load({ ACCESS_KEY: KEY, HOST_OVERCOMMIT: "1.5" }).hostOvercommit).toBe(1.5);
    expect(load({ ACCESS_KEY: KEY, HOST_OVERCOMMIT: "3" }).hostOvercommit).toBe(3);
    expect(load({ ACCESS_KEY: KEY, HOST_OVERCOMMIT: "10" }).hostOvercommit).toBe(10);
  });
  test("a ratio below 1 or above 10, or one that is not a number, stops startup", () => {
    for (const value of ["0.5", "0", "11", "abc", "NaN", "Infinity"]) {
      expect(() => load({ ACCESS_KEY: KEY, HOST_OVERCOMMIT: value })).toThrow("HOST_OVERCOMMIT");
    }
  });
});

describe("volume usage sampling and the host disk floor", () => {
  test("a volume is sampled every 600 seconds by default, and VOLUME_USAGE_INTERVAL_SEC sets it from 60 to 86400", () => {
    expect(load({ ACCESS_KEY: KEY }).volumeUsageIntervalSec).toBe(600);
    expect(load({ ACCESS_KEY: KEY, VOLUME_USAGE_INTERVAL_SEC: "60" }).volumeUsageIntervalSec).toBe(60);
    expect(load({ ACCESS_KEY: KEY, VOLUME_USAGE_INTERVAL_SEC: "86400" }).volumeUsageIntervalSec).toBe(86400);
    for (const value of ["30", "86401", "1.5", "often"]) {
      expect(load({ ACCESS_KEY: KEY, VOLUME_USAGE_INTERVAL_SEC: value }).volumeUsageIntervalSec).toBe(600);
    }
  });
  test("the forward check is every 600 seconds by default, and EGRESS_FORWARD_CHECK_INTERVAL_SEC sets it from 60 to 86400", () => {
    expect(load({ ACCESS_KEY: KEY }).egressForwardCheckIntervalSec).toBe(600);
    expect(load({ ACCESS_KEY: KEY, EGRESS_FORWARD_CHECK_INTERVAL_SEC: "60" }).egressForwardCheckIntervalSec).toBe(60);
    expect(load({ ACCESS_KEY: KEY, EGRESS_FORWARD_CHECK_INTERVAL_SEC: "86400" }).egressForwardCheckIntervalSec).toBe(
      86400,
    );
    for (const value of ["30", "86401", "1.5", "often"]) {
      expect(load({ ACCESS_KEY: KEY, EGRESS_FORWARD_CHECK_INTERVAL_SEC: value }).egressForwardCheckIntervalSec).toBe(
        600,
      );
    }
  });

  test("HOST_DISK_MIN_FREE_PERCENT is 10 by default, 0 turns the floor off, and a value above 100 is ignored", () => {
    expect(load({ ACCESS_KEY: KEY }).hostDiskMinFreePercent).toBe(10);
    expect(load({ ACCESS_KEY: KEY, HOST_DISK_MIN_FREE_PERCENT: "0" }).hostDiskMinFreePercent).toBe(0);
    expect(load({ ACCESS_KEY: KEY, HOST_DISK_MIN_FREE_PERCENT: "25" }).hostDiskMinFreePercent).toBe(25);
    expect(load({ ACCESS_KEY: KEY, HOST_DISK_MIN_FREE_PERCENT: "101" }).hostDiskMinFreePercent).toBe(10);
  });
});

describe("file upload limit", () => {
  test("FILE_UPLOAD_MAX_MB is 1024 by default and can be set from the environment", () => {
    expect(load({ ACCESS_KEY: KEY }).fileUploadMaxMb).toBe(1024);
    expect(load({ ACCESS_KEY: KEY, FILE_UPLOAD_MAX_MB: "64" }).fileUploadMaxMb).toBe(64);
  });
  test("it can come from .env, and the process env wins over it", () => {
    writeFileSync(envFile, "FILE_UPLOAD_MAX_MB=256\n");
    expect(loadConfig({ ACCESS_KEY: KEY, DATA_DIR: dataDir }, { envFile }).fileUploadMaxMb).toBe(256);
    expect(
      loadConfig({ ACCESS_KEY: KEY, DATA_DIR: dataDir, FILE_UPLOAD_MAX_MB: "32" }, { envFile }).fileUploadMaxMb,
    ).toBe(32);
  });
  test("a value that is not a whole number from 1 to 65536 falls back to 1024", () => {
    for (const value of ["0", "-5", "1.5", "many", "65537"]) {
      expect(load({ ACCESS_KEY: KEY, FILE_UPLOAD_MAX_MB: value }).fileUploadMaxMb).toBe(1024);
    }
  });
});

describe("terminal takeover", () => {
  test("a human's takeover returns to the agent after 300 seconds without input by default", () => {
    expect(load({ ACCESS_KEY: KEY })).toMatchObject({ takeoverIdleSec: 300 });
  });
  test("SESSION_TAKEOVER_IDLE_SEC sets the idle time, and 0 turns auto-return off", () => {
    expect(load({ ACCESS_KEY: KEY, SESSION_TAKEOVER_IDLE_SEC: "45" })).toMatchObject({ takeoverIdleSec: 45 });
    expect(load({ ACCESS_KEY: KEY, SESSION_TAKEOVER_IDLE_SEC: "0" })).toMatchObject({ takeoverIdleSec: 0 });
  });
  test.each(["-1", "1.5", "86401", "soon"])("%s falls back to the default", (value) => {
    expect(load({ ACCESS_KEY: KEY, SESSION_TAKEOVER_IDLE_SEC: value })).toMatchObject({ takeoverIdleSec: 300 });
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

describe("PREVIEW_BASE_DOMAIN", () => {
  beforeEach(() => setLogLevel("error"));
  afterEach(() => setLogLevel("info"));

  test("is off when unset or blank, which keeps path previews", () => {
    expect(load({ ACCESS_KEY: KEY }).previewBaseDomain).toBeNull();
    expect(load({ ACCESS_KEY: KEY, PREVIEW_BASE_DOMAIN: "  " }).previewBaseDomain).toBeNull();
  });
  test("is read as a lower-case domain", () => {
    expect(load({ ACCESS_KEY: KEY, PREVIEW_BASE_DOMAIN: " Minibox-Preview.NET " }).previewBaseDomain).toBe(
      "minibox-preview.net",
    );
  });
  test("refuses startup when it is not a domain", () => {
    expect(() => load({ ACCESS_KEY: KEY, PREVIEW_BASE_DOMAIN: "https://minibox-preview.net" })).toThrow(
      /PREVIEW_BASE_DOMAIN: .* must be a domain name/,
    );
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
    expect(() => load()).toThrow(/Set ACCESS_KEY, or point DATA_DIR at a writable directory/);
  });
  test("refuses to replace an empty key file", () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "access_key"), "\n");
    expect(() => load()).toThrow(/is empty; delete it/);
    expect(readFileSync(join(dataDir, "access_key"), "utf8")).toBe("\n");
  });
});

describe("direct SSH", () => {
  beforeEach(() => setLogLevel("error"));
  afterEach(() => setLogLevel("info"));

  test("is off unless SSH_PORT is set, and binds where the console does by default", () => {
    expect(load({ ACCESS_KEY: KEY })).toMatchObject({ sshPort: null, sshBind: "127.0.0.1", sshPublicHost: null });
    expect(load({ ACCESS_KEY: KEY, HOST: "0.0.0.0", SSH_PORT: "2222" })).toMatchObject({
      sshPort: 2222,
      sshBind: "0.0.0.0",
    });
    expect(load({ ACCESS_KEY: KEY, SSH_PORT: "2222", SSH_BIND: "10.0.0.5" }).sshBind).toBe("10.0.0.5");
  });
  test("SSH_PUBLIC_HOST and SSH_PUBLIC_PORT change only what the console shows", () => {
    expect(
      load({ ACCESS_KEY: KEY, SSH_PORT: "2222", SSH_PUBLIC_HOST: "nas.lan", SSH_PUBLIC_PORT: "22022" }),
    ).toMatchObject({ sshPort: 2222, sshPublicHost: "nas.lan", sshPublicPort: 22022 });
  });
  test("a port that is not 1 to 65535, the web port, or a host with a scheme stops startup", () => {
    expect(() => load({ ACCESS_KEY: KEY, SSH_PORT: "0" })).toThrow(/SSH_PORT/);
    expect(() => load({ ACCESS_KEY: KEY, SSH_PORT: "22x" })).toThrow(/SSH_PORT/);
    expect(() => load({ ACCESS_KEY: KEY, SSH_PORT: "3920" })).toThrow(/already the web PORT/);
    expect(() => load({ ACCESS_KEY: KEY, SSH_PUBLIC_HOST: "ssh://nas" })).toThrow(/SSH_PUBLIC_HOST/);
  });
});

describe("backup folder and retention", () => {
  test("BACKUP_DIR is unset by default, so archives stay in DATA_DIR/backups", () => {
    expect(load({ ACCESS_KEY: KEY }).backupDir).toBe(join(dataDir, "backups"));
    expect(load({ ACCESS_KEY: KEY, BACKUP_DIR: "   " }).backupDir).toBe(join(dataDir, "backups"));
  });
  test("an absolute BACKUP_DIR is kept, a relative one resolves from the project root, and ~ expands", () => {
    expect(load({ ACCESS_KEY: KEY, BACKUP_DIR: "/mnt/archives" }).backupDir).toBe("/mnt/archives");
    expect(load({ ACCESS_KEY: KEY, BACKUP_DIR: "archives" }).backupDir).toBe(join(ROOT, "archives"));
    expect(load({ ACCESS_KEY: KEY, BACKUP_DIR: "../backups" }).backupDir).toBe(resolve(ROOT, "..", "backups"));
  });
  test("BACKUP_DIR can come from .env, and the process env wins over it", () => {
    writeFileSync(envFile, `BACKUP_DIR=${join(root, "from-file")}\n`);
    expect(loadConfig({ ACCESS_KEY: KEY, DATA_DIR: dataDir }, { envFile }).backupDir).toBe(join(root, "from-file"));
    expect(
      loadConfig({ ACCESS_KEY: KEY, DATA_DIR: dataDir, BACKUP_DIR: join(root, "from-env") }, { envFile }).backupDir,
    ).toBe(join(root, "from-env"));
  });
  test("a BACKUP_DIR does not have to exist yet, and loading does not create it", () => {
    const target = join(root, "later");
    expect(load({ ACCESS_KEY: KEY, BACKUP_DIR: target }).backupDir).toBe(target);
    expect(existsSync(target)).toBe(false);
  });

  test("a BACKUP_DIR that is DATA_DIR, or holds it, is refused instead of writing empty archives", () => {
    expect(() => load({ ACCESS_KEY: KEY, BACKUP_DIR: dataDir })).toThrow(/BACKUP_DIR.*data directory itself/);
    expect(() => load({ ACCESS_KEY: KEY, BACKUP_DIR: root })).toThrow(/BACKUP_DIR.*holds the data directory/);
    expect(() => load({ ACCESS_KEY: KEY, BACKUP_DIR: "/" })).toThrow(/BACKUP_DIR/);
    expect(() => load({ ACCESS_KEY: KEY, BACKUP_DIR: `${dataDir}/..` })).toThrow(/BACKUP_DIR/);
  });

  test.skipIf(process.getuid?.() === 0)(
    "a BACKUP_DIR under a folder the server cannot search still loads, as it did before symlinks were resolved",
    () => {
      const locked = join(root, "locked");
      mkdirSync(join(locked, "inner"), { recursive: true });
      chmodSync(locked, 0o000);
      try {
        const target = join(locked, "inner", "backups");
        expect(load({ ACCESS_KEY: KEY, BACKUP_DIR: target }).backupDir).toBe(target);
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );

  test("BACKUP_KEEP is 0 when unset, which keeps every backup", () => {
    expect(load({ ACCESS_KEY: KEY }).backupKeep).toBe(0);
    expect(load({ ACCESS_KEY: KEY, BACKUP_KEEP: "" }).backupKeep).toBe(0);
    expect(load({ ACCESS_KEY: KEY, BACKUP_KEEP: "0" }).backupKeep).toBe(0);
  });
  test("a positive whole number is the number of backups kept, from the environment or .env", () => {
    expect(load({ ACCESS_KEY: KEY, BACKUP_KEEP: "7" }).backupKeep).toBe(7);
    expect(load({ ACCESS_KEY: KEY, BACKUP_KEEP: "10000" }).backupKeep).toBe(10_000);
    writeFileSync(envFile, "BACKUP_KEEP=3\n");
    expect(loadConfig({ ACCESS_KEY: KEY, DATA_DIR: dataDir }, { envFile }).backupKeep).toBe(3);
  });
  test("an invalid BACKUP_KEEP keeps every backup rather than guessing a limit that would delete archives", () => {
    for (const value of ["-1", "1.5", "many", "10001", "  "]) {
      expect(load({ ACCESS_KEY: KEY, BACKUP_KEEP: value }).backupKeep).toBe(0);
    }
  });
});
