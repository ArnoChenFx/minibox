import { spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type App, type AppDeps, createApp } from "../../src/app";
import { DEFAULT_BOX_PROFILE, DEFAULT_PIDS_LIMIT } from "../../src/box-profile";
import { type Config, DEFAULT_SESSION_TTL_MS, ROOT } from "../../src/config";
import type { ExecutorHooks } from "../../src/operations/executor";
import { FakeRuntime } from "./fake-runtime";
import { FakeCheckpointEngine } from "./fake-snapshots";
import { memoizeScryptSync } from "./scrypt";

export const TEST_KEY = "k".repeat(64);

const DATA_ROOT = mkdtempSync(join(tmpdir(), "minibox-test-data-"));
process.on("exit", () => rmSync(DATA_ROOT, { recursive: true, force: true }));

/**
 * Config for tests: no real Docker socket, an ephemeral port, and a label prefix that cannot collide with a real
 * install. Each config gets a DATA_DIR of its own, so browser sessions never carry over between apps.
 */
export function testConfig(overrides: Partial<Config> = {}): Config {
  const labelPrefix = overrides.labelPrefix ?? "mbtest";
  memoizeScryptSync();
  return {
    host: "127.0.0.1",
    port: 0,
    accessKey: TEST_KEY,
    accessKeySource: "env",
    dataDir: mkdtempSync(join(DATA_ROOT, "app-")),
    dockerSocket: "/nonexistent-minibox-test.sock",
    labelPrefix,
    baseTemplateTag: `${labelPrefix}-template:base`,
    stopTimeoutSec: 3,
    webDir: join(ROOT, "web"),
    templatesDir: join(ROOT, "templates"),
    metricsIntervalMs: 60_000,
    metricsHistory: 10,
    eventRetentionAuditDays: 365,
    eventRetentionActivityDays: 30,
    eventOutputRetentionDays: 7,
    eventOutputMaxMb: 512,
    logLevel: "error",
    trustProxy: false,
    cookieSecure: false,
    allowedOrigins: [],
    boxProfile: DEFAULT_BOX_PROFILE,
    boxPidsLimit: DEFAULT_PIDS_LIMIT,
    containerRuntime: null,
    sessionTtlMs: DEFAULT_SESSION_TTL_MS,
    sessionIdleMs: null,
    streamMaxConnections: 256,
    takeoverIdleSec: 300,
    boxIdleTimeoutSec: 0,
    boxIdleCpuPercent: 5,
    lifecycleIntervalMs: 30_000,
    checkpointKeepLast: 20,
    checkpointKeepDays: 30,
    checkpointCapacityMb: 0,
    checkpointPackageMaxMb: 2048,
    fileUploadMaxMb: 1024,
    hostOvercommit: 1,
    ...overrides,
  };
}

export function createTestApp(
  overrides: Partial<Config> = {},
  runtime = new FakeRuntime(),
  hooks: Partial<ExecutorHooks> = {},
  deps: Pick<AppDeps, "cliBuild"> = {},
): { app: App; runtime: FakeRuntime; checkpoints: FakeCheckpointEngine } {
  const cfg = testConfig(overrides);
  const checkpoints = new FakeCheckpointEngine(runtime);
  const app = createApp(cfg, "0.0.0-test", {
    runtime,
    connect: () => new FakeRuntime(),
    hooks,
    eventsPath: ":memory:",
    checkpointEngine: checkpoints,
    ...deps,
  });
  return { app, runtime, checkpoints };
}

/** The logger writes expected failures (e.g. 5xx responses) to the console. Mute it so test output stays readable. */
export function silenceLogs(): () => void {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const logs = spyOn(console, "log").mockImplementation(() => {});
  return () => {
    errors.mockRestore();
    logs.mockRestore();
  };
}

export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to fail");
}
