import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config";

const KEY = "k".repeat(64);

describe("loadConfig", () => {
  test("process env wins and numbers are parsed", () => {
    const cfg = loadConfig({ ACCESS_KEY: KEY, HOST: "0.0.0.0", PORT: "4000", LABEL_PREFIX: "mb", LOG_LEVEL: "debug" });
    expect(cfg).toMatchObject({ accessKey: KEY, host: "0.0.0.0", port: 4000, labelPrefix: "mb", logLevel: "debug" });
    expect(cfg.baseTemplateTag).toBe("mb-template:base");
  });
  test("invalid values fall back to defaults", () => {
    const cfg = loadConfig({ ACCESS_KEY: KEY, PORT: "-1", METRICS_INTERVAL_MS: "abc", LOG_LEVEL: "loud" });
    expect(cfg.port).toBe(3920);
    expect(cfg.metricsIntervalMs).toBe(3000);
    expect(cfg.logLevel).toBe("info");
  });
  test("TRUST_PROXY is off unless explicitly enabled", () => {
    expect(loadConfig({ ACCESS_KEY: KEY }).trustProxy).toBe(false);
    expect(loadConfig({ ACCESS_KEY: KEY, TRUST_PROXY: "false" }).trustProxy).toBe(false);
    expect(loadConfig({ ACCESS_KEY: KEY, TRUST_PROXY: "0" }).trustProxy).toBe(false);
    expect(loadConfig({ ACCESS_KEY: KEY, TRUST_PROXY: "true" }).trustProxy).toBe(true);
    expect(loadConfig({ ACCESS_KEY: KEY, TRUST_PROXY: " ON " }).trustProxy).toBe(true);
  });
});
