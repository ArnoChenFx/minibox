import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Server } from "bun";

import { type App, createApp } from "../src/app";
import {
  clearLegacyKeyCookie,
  clearSessionCookie,
  COOKIE_NAME,
  LEGACY_KEY_COOKIE,
  LoginLimiter,
  type LoginLimits,
} from "../src/auth";
import { type Config, loadConfig } from "../src/config";
import { setLogLevel } from "../src/lib/logger";
import { startServer, startupFields, warnIfWeakAccessKey } from "../src/server";
import type { TerminalData } from "../src/ws/terminal";

setLogLevel("error");

const KEY = "k".repeat(64);
const SANDBOX = mkdtempSync(join(tmpdir(), "minibox-server-test-"));
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

/** Uses a temp DATA_DIR and .env, so the suite never creates the repository's data/ or reads its .env. */
function testConfig(env: Record<string, string> = {}): Config {
  const cfg = loadConfig(
    { ACCESS_KEY: KEY, HOST: "127.0.0.1", LOG_LEVEL: "error", DATA_DIR: join(SANDBOX, "data"), ...env },
    { envFile: join(SANDBOX, ".env") },
  );
  return { ...cfg, port: 0 };
}

/**
 * Starts a server for `fn` and stops it afterwards. Each server gets its own DATA_DIR unless `env.DATA_DIR` names
 * one, so sessions never leak between tests and a test can restart MiniBox over the same directory.
 */
async function withServer(
  env: Record<string, string>,
  fn: (ctx: { base: string; app: App }) => Promise<void>,
  limits: Partial<LoginLimits> = {},
): Promise<void> {
  const dataDir = env.DATA_DIR ?? mkdtempSync(join(SANDBOX, "data-"));
  const app = createApp(testConfig({ ...env, DATA_DIR: dataDir }), "test", {
    throttle: new LoginLimiter({ penaltyMs: 0, ...limits }),
  });
  const server: Server<TerminalData> = startServer(app);
  try {
    await fn({ base: `http://127.0.0.1:${server.port}`, app });
  } finally {
    app.throttle.stop();
    app.monitor.stop();
    app.sessions.stop();
    server.stop(true);
  }
}

const login = (base: string, key: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ key }),
  });

/** The session token that a sign-in response sets, or an empty string when it sets none. */
function sessionToken(res: Response): string {
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`)) ?? "";
  return decodeURIComponent(cookie.slice(COOKIE_NAME.length + 1).split(";")[0] ?? "");
}

async function signIn(base: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await login(base, KEY, { origin: base, ...headers });
  expect(res.status).toBe(200);
  return sessionToken(res);
}

const cookieFor = (token: string) => ({ cookie: `${COOKIE_NAME}=${token}` });
/** A day count in the form SESSION_TTL_DAYS and SESSION_IDLE_DAYS take, for a span given in seconds. */
const days = (seconds: number) => String(seconds / 86400);

async function statusWith(base: string, token: string): Promise<number> {
  return (await fetch(`${base}/api/auth/sessions`, { headers: cookieFor(token) })).status;
}

interface SessionList {
  sessions: { id: string; current: boolean; userAgent: string; createdAt: string; lastSeenAt: string }[];
}

async function sessionList(base: string, token: string): Promise<SessionList> {
  return (await fetch(`${base}/api/auth/sessions`, { headers: cookieFor(token) })).json() as Promise<SessionList>;
}

/** Sends a raw WebSocket handshake and resolves with the HTTP status the server answers with. */
function upgradeStatus(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      const lines = [
        "GET /api/boxes/demo/terminal HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        "",
        "",
      ];
      socket.write(lines.join("\r\n"));
    });
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString("latin1");
      const status = /^HTTP\/1\.1 (\d{3})/.exec(received);
      if (status) {
        socket.destroy();
        resolve(Number(status[1]));
      }
    });
    socket.on("error", reject);
  });
}

describe("login rate limit (end to end)", () => {
  test("after 10 wrong keys from one address, a further wrong key is refused with 429", async () => {
    await withServer({}, async ({ base }) => {
      for (let i = 0; i < 10; i++) expect((await login(base, "wrong")).status).toBe(401);
      expect((await login(base, "wrong")).status).toBe(429);
    });
  });

  test("behind one shared address, a correct key still signs in while wrong keys are refused", async () => {
    await withServer({}, async ({ base }) => {
      for (let i = 0; i < 10; i++) await login(base, "wrong");
      expect((await login(base, "wrong")).status).toBe(429);
      const res = await login(base, KEY);
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toStartWith(`${COOKIE_NAME}=`);
    });
  });

  test("forged X-Forwarded-For cannot reset the failure count when no proxy is trusted", async () => {
    await withServer({ TRUST_PROXY: "false" }, async ({ base }) => {
      for (let i = 0; i < 10; i++) {
        const res = await login(base, "wrong", { "x-forwarded-for": `198.51.100.${i + 1}` });
        expect(res.status).toBe(401);
      }
      expect((await login(base, "wrong", { "x-forwarded-for": "192.0.2.250" })).status).toBe(429);
      expect((await login(base, KEY, { "x-forwarded-for": "192.0.2.251" })).status).toBe(200);
    });
  });

  test("with TRUST_PROXY, each forwarded client gets its own bucket", async () => {
    await withServer({ TRUST_PROXY: "true" }, async ({ base }) => {
      for (let i = 0; i < 10; i++) {
        expect((await login(base, "wrong", { "x-forwarded-for": "198.51.100.1" })).status).toBe(401);
      }
      expect((await login(base, "wrong", { "x-forwarded-for": "198.51.100.1" })).status).toBe(429);
      expect((await login(base, "wrong", { "x-forwarded-for": "198.51.100.2" })).status).toBe(401);
      expect((await login(base, KEY, { "x-forwarded-for": "198.51.100.1" })).status).toBe(200);
    });
  });

  test("with TRUST_PROXY, a client-supplied leading entry does not change the proxy-appended one", async () => {
    await withServer({ TRUST_PROXY: "true" }, async ({ base }) => {
      for (let i = 0; i < 10; i++) {
        expect((await login(base, "wrong", { "x-forwarded-for": `10.9.9.${i}, 198.51.100.7` })).status).toBe(401);
      }
      expect((await login(base, "wrong", { "x-forwarded-for": "10.1.1.1, 198.51.100.7" })).status).toBe(429);
    });
  });

  test("the total cap refuses wrong keys across rotating X-Forwarded-For addresses under TRUST_PROXY", async () => {
    await withServer(
      { TRUST_PROXY: "true" },
      async ({ base }) => {
        for (let i = 1; i <= 3; i++) {
          expect((await login(base, "wrong", { "x-forwarded-for": `198.51.100.${i}` })).status).toBe(401);
        }
        expect((await login(base, "wrong", { "x-forwarded-for": "198.51.100.200" })).status).toBe(429);
        expect((await login(base, KEY, { "x-forwarded-for": "198.51.100.201" })).status).toBe(200);
      },
      { total: 3 },
    );
  });

  test("a refused wrong key is held for the penalty before its 429", async () => {
    await withServer(
      {},
      async ({ base }) => {
        for (let i = 0; i < 10; i++) await login(base, "wrong");
        const started = performance.now();
        expect((await login(base, "wrong")).status).toBe(429);
        expect(performance.now() - started).toBeGreaterThanOrEqual(90);
      },
      { penaltyMs: 100 },
    );
  });
});

describe("proxy header warning (end to end)", () => {
  test("proxied requests without TRUST_PROXY log a single warning that names the setting", async () => {
    const lines: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    setLogLevel("warn");
    try {
      await withServer({ TRUST_PROXY: "false" }, async ({ base }) => {
        await fetch(`${base}/login`, { headers: { "x-forwarded-for": "198.51.100.1" } });
        await fetch(`${base}/login`, { headers: { "x-forwarded-for": "198.51.100.2" } });
      });
    } finally {
      spy.mockRestore();
      setLogLevel("error");
    }
    const warnings = lines.filter((line) => line.includes("proxy.headers_ignored"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("TRUST_PROXY=true");
  });
});

describe("cross-site protection (end to end)", () => {
  const CROSS_SITE = "https://evil.example";

  test("cross-site logins are refused before they can count as failures", async () => {
    await withServer({}, async ({ base }) => {
      for (let i = 0; i < 12; i++) {
        expect((await login(base, "wrong", { origin: CROSS_SITE })).status).toBe(403);
      }
      expect((await login(base, KEY, { origin: base })).status).toBe(200);
    });
  });

  test("same-origin login sets a HttpOnly SameSite=Strict session cookie", async () => {
    await withServer({}, async ({ base }) => {
      const cookie = (await login(base, KEY, { origin: base })).headers.get("set-cookie") ?? "";
      expect(cookie).toStartWith(`${COOKIE_NAME}=`);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).not.toContain("Secure");
    });
  });

  test("a login from an https Origin sets Secure without TRUST_PROXY, as behind a same-host tunnel", async () => {
    await withServer({}, async ({ base }) => {
      const tunnelOrigin = base.replace("http://", "https://");
      const cookie = (await login(base, KEY, { origin: tunnelOrigin })).headers.get("set-cookie") ?? "";
      expect(cookie).toContain("; Secure");
    });
  });

  test("COOKIE_SECURE sets Secure on the session cookie even over plain http", async () => {
    await withServer({ COOKIE_SECURE: "1" }, async ({ base }) => {
      const cookie = (await login(base, KEY, { origin: base })).headers.get("set-cookie") ?? "";
      expect(cookie).toContain("; Secure");
    });
  });

  test("API writes must carry a JSON body; form posts get 415 even from the same origin", async () => {
    await withServer({}, async ({ base }) => {
      const form = await fetch(`${base}/api/auth/logout`, {
        method: "POST",
        headers: { origin: base, "content-type": "application/x-www-form-urlencoded" },
        body: "x=1",
      });
      expect(form.status).toBe(415);
      const json = await fetch(`${base}/api/auth/logout`, {
        method: "POST",
        headers: { origin: base, "content-type": "application/json" },
        body: "{}",
      });
      expect(json.status).toBe(200);
    });
  });

  test("cross-site writes are refused even when the browser attaches the session cookie", async () => {
    await withServer({}, async ({ base }) => {
      const token = await signIn(base);
      const res = await fetch(`${base}/api/auth/logout`, {
        method: "POST",
        headers: { origin: CROSS_SITE, "content-type": "application/json", ...cookieFor(token) },
        body: "{}",
      });
      expect(res.status).toBe(403);
      expect(await statusWith(base, token)).toBe(200);
    });
  });

  test("a cross-site WebSocket upgrade is refused with 403 even with a valid session cookie", async () => {
    await withServer({}, async ({ base }) => {
      const port = Number(new URL(base).port);
      const token = await signIn(base);
      expect(await upgradeStatus(port, { origin: CROSS_SITE, ...cookieFor(token) })).toBe(403);
      expect(await upgradeStatus(port, { origin: base })).toBe(401);
    });
  });
});

describe("browser sessions (end to end)", () => {
  test("sign-in issues a random token of 32 bytes in a 30-day cookie, and the token is not the access key", async () => {
    await withServer({}, async ({ base }) => {
      const res = await login(base, KEY, { origin: base });
      const token = sessionToken(res);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
      expect(token).not.toContain(KEY);
      expect(res.headers.getSetCookie().join(";")).toContain("Max-Age=2592000");
      expect(await statusWith(base, token)).toBe(200);
    });
  });

  test("the access key is not accepted as a session cookie, and the bearer header still works", async () => {
    await withServer({}, async ({ base }) => {
      expect(await statusWith(base, KEY)).toBe(401);
      const bearer = await fetch(`${base}/api/auth/sessions`, { headers: { authorization: `Bearer ${KEY}` } });
      expect(bearer.status).toBe(200);
    });
  });

  test("logout ends the session on the server at once, and clears the cookie", async () => {
    await withServer({}, async ({ base }) => {
      const token = await signIn(base);
      const res = await fetch(`${base}/api/auth/logout`, {
        method: "POST",
        headers: { origin: base, "content-type": "application/json", ...cookieFor(token) },
        body: "{}",
      });
      expect(res.status).toBe(200);
      expect(res.headers.getSetCookie()).toContain(clearSessionCookie());
      expect(await statusWith(base, token)).toBe(401);
    });
  });

  test("the console opens for a signed-in browser and sends everyone else to sign in", async () => {
    await withServer({}, async ({ base }) => {
      const token = await signIn(base);
      const page = await fetch(`${base}/`, { headers: cookieFor(token), redirect: "manual" });
      expect(page.status).toBe(200);
      const signedOut = await fetch(`${base}/`, { redirect: "manual" });
      expect(signedOut.status).toBe(302);
      expect(signedOut.headers.get("location")).toBe("/login");
    });
  });

  test("a minibox_key cookie holding the access key is never honoured, and it is cleared", async () => {
    await withServer({}, async ({ base }) => {
      const legacy = { cookie: `${LEGACY_KEY_COOKIE}=${KEY}` };
      expect((await fetch(`${base}/api/auth/sessions`, { headers: legacy })).status).toBe(401);
      const page = await fetch(`${base}/login`, { headers: legacy });
      expect(page.status).toBe(200);
      expect(page.headers.getSetCookie()).toContain(clearLegacyKeyCookie());
      const signedIn = await login(base, KEY, { origin: base, ...legacy });
      expect(signedIn.headers.getSetCookie()).toContain(clearLegacyKeyCookie());
    });
  });

  test("a session survives a restart over the same DATA_DIR, and the file holds no token", async () => {
    const dataDir = mkdtempSync(join(SANDBOX, "restart-"));
    let token = "";
    await withServer({ DATA_DIR: dataDir }, async ({ base }) => {
      token = await signIn(base);
    });
    const stored = readFileSync(join(dataDir, "sessions.json"), "utf8");
    expect(stored).not.toContain(token);
    expect(stored).not.toContain(KEY);
    await withServer({ DATA_DIR: dataDir }, async ({ base }) => {
      expect(await statusWith(base, token)).toBe(200);
    });
  });

  test("changing ACCESS_KEY ends every session on the next start", async () => {
    const dataDir = mkdtempSync(join(SANDBOX, "rekey-"));
    const NEW_KEY = "n".repeat(64);
    let token = "";
    await withServer({ DATA_DIR: dataDir }, async ({ base }) => {
      token = await signIn(base);
    });
    await withServer({ DATA_DIR: dataDir, ACCESS_KEY: NEW_KEY }, async ({ base }) => {
      expect(await statusWith(base, token)).toBe(401);
      expect((await login(base, KEY, { origin: base })).status).toBe(401);
      expect((await login(base, NEW_KEY, { origin: base })).status).toBe(200);
    });
  });

  test("the cookie lasts as long as SESSION_TTL_DAYS says, 30 days by default", async () => {
    await withServer({}, async ({ base }) => {
      const cookies = (await login(base, KEY, { origin: base })).headers.getSetCookie().join(";");
      expect(cookies).toContain("Max-Age=2592000");
    });
    await withServer({ SESSION_TTL_DAYS: "2" }, async ({ base }) => {
      const cookies = (await login(base, KEY, { origin: base })).headers.getSetCookie().join(";");
      expect(cookies).toContain("Max-Age=172800");
    });
  });

  test("SESSION_TTL_DAYS caps a session's life, and SESSION_IDLE_DAYS renews it only up to that cap", async () => {
    await withServer({ SESSION_TTL_DAYS: days(3), SESSION_IDLE_DAYS: days(2) }, async ({ base }) => {
      const token = await signIn(base);
      await Bun.sleep(1000);
      expect(await statusWith(base, token)).toBe(200);
      await Bun.sleep(1000);
      expect(await statusWith(base, token)).toBe(200);
      await Bun.sleep(1500);
      expect(await statusWith(base, token)).toBe(401);
    });
  }, 10_000);

  test("the session list marks this browser, revoking one ends only that session, and an unknown id is a 404", async () => {
    await withServer({}, async ({ base }) => {
      const a = await signIn(base, { "user-agent": "Browser A" });
      const b = await signIn(base, { "user-agent": "Browser B" });
      const { sessions } = await sessionList(base, a);
      expect(sessions.map((s) => s.userAgent).toSorted()).toEqual(["Browser A", "Browser B"]);
      expect(sessions.filter((s) => s.current).map((s) => s.userAgent)).toEqual(["Browser A"]);

      const bId = sessions.find((s) => s.userAgent === "Browser B")?.id ?? "";
      const revoked = await fetch(`${base}/api/auth/sessions/${bId}`, { method: "DELETE", headers: cookieFor(a) });
      expect(revoked.status).toBe(200);
      expect(revoked.headers.getSetCookie()).toEqual([]);
      expect(await statusWith(base, b)).toBe(401);
      expect(await statusWith(base, a)).toBe(200);

      const missing = await fetch(`${base}/api/auth/sessions/${"0".repeat(32)}`, {
        method: "DELETE",
        headers: cookieFor(a),
      });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ error: { code: "not_found", key: "session_not_found" } });
    });
  });

  test("sign out other sessions keeps this browser and reports how many it ended", async () => {
    await withServer({}, async ({ base }) => {
      const a = await signIn(base);
      const b = await signIn(base);
      const c = await signIn(base);
      const res = await fetch(`${base}/api/auth/sessions/revoke-others`, {
        method: "POST",
        headers: { origin: base, "content-type": "application/json", ...cookieFor(a) },
        body: "{}",
      });
      expect(await res.json()).toEqual({ ok: true, revoked: 2 });
      expect(await statusWith(base, a)).toBe(200);
      expect(await statusWith(base, b)).toBe(401);
      expect(await statusWith(base, c)).toBe(401);
    });
  });

  test("revoking the current session signs this browser out and clears its cookie", async () => {
    await withServer({}, async ({ base }) => {
      const token = await signIn(base);
      const id = (await sessionList(base, token)).sessions[0]?.id ?? "";
      const res = await fetch(`${base}/api/auth/sessions/${id}`, { method: "DELETE", headers: cookieFor(token) });
      expect(res.status).toBe(200);
      expect(res.headers.getSetCookie()).toContain(clearSessionCookie());
      expect(await statusWith(base, token)).toBe(401);
    });
  });

  test("signing in again while signed in replaces the earlier session", async () => {
    await withServer({}, async ({ base }) => {
      const first = await signIn(base);
      const second = sessionToken(await login(base, KEY, { origin: base, ...cookieFor(first) }));
      expect(second).not.toBe(first);
      expect(await statusWith(base, first)).toBe(401);
      expect(await statusWith(base, second)).toBe(200);
    });
  });

  test("no token or access key reaches the logs, even at debug level", async () => {
    const lines: string[] = [];
    const capture = (line: unknown) => {
      lines.push(String(line));
    };
    const errors = spyOn(console, "error").mockImplementation(capture);
    const logs = spyOn(console, "log").mockImplementation(capture);
    setLogLevel("debug");
    let token = "";
    try {
      await withServer({}, async ({ base }) => {
        token = await signIn(base);
        await statusWith(base, token);
        await login(base, "wrong-key-value", { origin: base });
        await fetch(`${base}/api/auth/logout`, {
          method: "POST",
          headers: { origin: base, "content-type": "application/json", ...cookieFor(token) },
          body: "{}",
        });
      });
    } finally {
      errors.mockRestore();
      logs.mockRestore();
      setLogLevel("error");
    }
    const text = lines.join("\n");
    expect(text).toContain("auth.login");
    expect(text).toContain("session.revoked");
    expect(text).not.toContain(token);
    expect(text).not.toContain(KEY);
  });

  test("a terminal upgrade with a session cookie gets past authentication, and a made-up cookie does not", async () => {
    await withServer({}, async ({ base }) => {
      const port = Number(new URL(base).port);
      const token = await signIn(base);
      expect(await upgradeStatus(port, { origin: base, ...cookieFor(token) })).not.toBe(401);
      expect(await upgradeStatus(port, { origin: base, ...cookieFor("not-a-session") })).toBe(401);
    });
  });
});

describe("console delivery (end to end)", () => {
  test("pages are served under the strict Content-Security-Policy", async () => {
    await withServer({}, async ({ base }) => {
      const res = await fetch(`${base}/login`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(res.headers.get("strict-transport-security")).toBeNull();
    });
  });

  test("the terminal library is served by MiniBox itself", async () => {
    await withServer({}, async ({ base }) => {
      const res = await fetch(`${base}/vendor/xterm/xterm.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("javascript");
    });
  });

  test("HSTS is sent for requests a trusted proxy reports as HTTPS", async () => {
    const forwarded = { "x-forwarded-proto": "https" };
    await withServer({ TRUST_PROXY: "true" }, async ({ base }) => {
      const res = await fetch(`${base}/login`, { headers: forwarded });
      expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000");
    });
    await withServer({ TRUST_PROXY: "false" }, async ({ base }) => {
      const res = await fetch(`${base}/login`, { headers: forwarded });
      expect(res.headers.get("strict-transport-security")).toBeNull();
    });
  });

  test("HSTS is sent for an https Origin behind a same-host tunnel, without TRUST_PROXY", async () => {
    await withServer({}, async ({ base }) => {
      const res = await fetch(`${base}/login`, { headers: { origin: base.replace("http://", "https://") } });
      expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000");
    });
  });
});

describe("startup logging", () => {
  const FIXTURE_KEY = "Q9wZk3Lm7Xv2Bn5Tc8Rp4Hd6";

  test("server.started carries no part of the access key", () => {
    const fields = startupFields(testConfig({ ACCESS_KEY: FIXTURE_KEY }), "test");
    const text = JSON.stringify(fields);
    expect(fields).not.toHaveProperty("keyPrefix");
    expect(text).not.toContain(FIXTURE_KEY.slice(0, 4));
    expect(text).not.toContain(FIXTURE_KEY);
  });
});

function weakKeyWarnings(cfg: Config): string[] {
  const lines: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  setLogLevel("warn");
  try {
    warnIfWeakAccessKey(cfg);
  } finally {
    spy.mockRestore();
    setLogLevel("error");
  }
  return lines.filter((line) => line.includes("auth.weak_key"));
}

describe("weak access key warning", () => {
  const WEAK_KEY = "Q9wZk3Lm7Xv2";
  const STRONG_KEY = "Q9wZk3Lm7Xv2Bn5Tc8Rp";

  test("a weak key logs one warning with neither the key, a prefix of it, nor its length", () => {
    const warnings = weakKeyWarnings(testConfig({ ACCESS_KEY: WEAK_KEY }));
    expect(warnings).toHaveLength(1);
    const [line = ""] = warnings;
    const entry = JSON.parse(line);
    expect(entry).toMatchObject({ level: "warn", msg: "auth.weak_key", source: "env" });
    expect(Object.keys(entry).toSorted()).toEqual(["hint", "level", "msg", "source", "ts"]);
    expect(line).not.toContain(WEAK_KEY);
    expect(line).not.toContain(WEAK_KEY.slice(0, 4));
  });

  test("a strong key logs nothing", () => {
    expect(weakKeyWarnings(testConfig({ ACCESS_KEY: STRONG_KEY }))).toEqual([]);
  });

  test("a weak key still starts and signs in", async () => {
    await withServer({ ACCESS_KEY: WEAK_KEY }, async ({ base }) => {
      expect((await login(base, WEAK_KEY)).status).toBe(200);
    });
  });
});
