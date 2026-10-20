import { spyOn } from "bun:test";
import { join } from "node:path";

import { type App, createApp } from "../../src/app";
import { type Config, ROOT } from "../../src/config";
import type { ExecutorHooks } from "../../src/operations/executor";
import { FakeRuntime } from "./fake-runtime";

export const TEST_KEY = "k".repeat(64);

/** Config for tests: no real Docker socket, an ephemeral port, and a label prefix that cannot collide with a real install. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  const labelPrefix = overrides.labelPrefix ?? "mbtest";
  return {
    host: "127.0.0.1",
    port: 0,
    accessKey: TEST_KEY,
    accessKeySource: "env",
    dataDir: "/nonexistent-minibox-test-data",
    dockerSocket: "/nonexistent-minibox-test.sock",
    labelPrefix,
    baseTemplateTag: `${labelPrefix}-template:base`,
    webDir: join(ROOT, "web"),
    templatesDir: join(ROOT, "templates"),
    metricsIntervalMs: 60_000,
    metricsHistory: 10,
    logLevel: "error",
    trustProxy: false,
    cookieSecure: false,
    allowedOrigins: [],
    ...overrides,
  };
}

export function createTestApp(
  overrides: Partial<Config> = {},
  runtime = new FakeRuntime(),
  hooks: Partial<ExecutorHooks> = {},
): { app: App; runtime: FakeRuntime } {
  return { app: createApp(testConfig(overrides), "0.0.0-test", { runtime, hooks }), runtime };
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
