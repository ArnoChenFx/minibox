import { describe, expect, test } from "bun:test";

import type { Server } from "bun";

import { type App, createApp } from "../src/app";
import { type Config, loadConfig } from "../src/config";
import { setLogLevel } from "../src/lib/logger";
import { startServer } from "../src/server";
import type { TerminalData } from "../src/ws/terminal";

setLogLevel("error");

const KEY = "k".repeat(64);

function testConfig(env: Record<string, string> = {}): Config {
  const cfg = loadConfig({ ACCESS_KEY: KEY, HOST: "127.0.0.1", LOG_LEVEL: "error", ...env });
  return { ...cfg, port: 0 };
}

async function withServer(
  env: Record<string, string>,
  fn: (ctx: { base: string; app: App }) => Promise<void>,
): Promise<void> {
  const app = createApp(testConfig(env), "test");
  const server: Server<TerminalData> = startServer(app);
  try {
    await fn({ base: `http://127.0.0.1:${server.port}`, app });
  } finally {
    app.throttle.stop();
    app.monitor.stop();
    server.stop(true);
  }
}

const login = (base: string, key: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ key }),
  });

describe("login rate limit (end to end)", () => {
  test("forged X-Forwarded-For cannot reset the failure count when no proxy is trusted", async () => {
    await withServer({ TRUST_PROXY: "false" }, async ({ base }) => {
      for (let i = 0; i < 10; i++) {
        const res = await login(base, "wrong", { "x-forwarded-for": `198.51.100.${i + 1}` });
        expect(res.status).toBe(401);
      }
      const blocked = await login(base, KEY, { "x-forwarded-for": "192.0.2.250" });
      expect(blocked.status).toBe(429);
    });
  });

  test("with TRUST_PROXY, each forwarded client gets its own bucket", async () => {
    await withServer({ TRUST_PROXY: "true" }, async ({ base }) => {
      for (let i = 0; i < 10; i++) {
        expect((await login(base, "wrong", { "x-forwarded-for": "198.51.100.1" })).status).toBe(401);
      }
      expect((await login(base, KEY, { "x-forwarded-for": "198.51.100.1" })).status).toBe(429);
      expect((await login(base, KEY, { "x-forwarded-for": "198.51.100.2" })).status).toBe(200);
    });
  });

  test("with TRUST_PROXY, a client-supplied leading entry does not change the proxy-appended one", async () => {
    await withServer({ TRUST_PROXY: "true" }, async ({ base }) => {
      for (let i = 0; i < 10; i++) {
        expect((await login(base, "wrong", { "x-forwarded-for": `10.9.9.${i}, 198.51.100.7` })).status).toBe(401);
      }
      expect((await login(base, KEY, { "x-forwarded-for": "10.1.1.1, 198.51.100.7" })).status).toBe(429);
    });
  });
});
