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
  test("ALLOWED_ORIGINS is a comma-separated list normalized to origins", () => {
    const cfg = loadConfig({
      ACCESS_KEY: KEY,
      ALLOWED_ORIGINS: "https://panel.example.net/, http://192.168.1.5:3920 ,",
    });
    expect(cfg.allowedOrigins).toEqual(["https://panel.example.net", "http://192.168.1.5:3920"]);
  });
  test("ALLOWED_ORIGINS rejects entries that are not http(s) origins", () => {
    expect(() => loadConfig({ ACCESS_KEY: KEY, ALLOWED_ORIGINS: "minibox.example.com" })).toThrow("ALLOWED_ORIGINS");
    expect(() => loadConfig({ ACCESS_KEY: KEY, ALLOWED_ORIGINS: "ftp://files.example.com" })).toThrow(
      "ALLOWED_ORIGINS",
    );
  });
  test("box hardening defaults to the standard profile, 1024 processes and the daemon's runtime", () => {
    const cfg = loadConfig({ ACCESS_KEY: KEY, BOX_PROFILE: "", BOX_PIDS_LIMIT: "", RUNTIME: "" });
    expect(cfg).toMatchObject({ boxProfile: "standard", boxPidsLimit: 1024, containerRuntime: null });
  });
  test("BOX_PROFILE, BOX_PIDS_LIMIT and RUNTIME are read", () => {
    const cfg = loadConfig({ ACCESS_KEY: KEY, BOX_PROFILE: "strict", BOX_PIDS_LIMIT: "256", RUNTIME: " runsc " });
    expect(cfg).toMatchObject({ boxProfile: "strict", boxPidsLimit: 256, containerRuntime: "runsc" });
  });
  test("an unknown BOX_PROFILE stops startup rather than silently picking another profile", () => {
    expect(() => loadConfig({ ACCESS_KEY: KEY, BOX_PROFILE: "stricter" })).toThrow("BOX_PROFILE");
    expect(() => loadConfig({ ACCESS_KEY: KEY, BOX_PROFILE: "Strict" })).toThrow("BOX_PROFILE");
  });
  test("an invalid BOX_PIDS_LIMIT falls back to the default", () => {
    expect(loadConfig({ ACCESS_KEY: KEY, BOX_PIDS_LIMIT: "-5" }).boxPidsLimit).toBe(1024);
    expect(loadConfig({ ACCESS_KEY: KEY, BOX_PIDS_LIMIT: "many" }).boxPidsLimit).toBe(1024);
  });
});
