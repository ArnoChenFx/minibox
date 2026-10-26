import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server as HttpServer } from "node:http";

import { type Browser, type BrowserContext, chromium } from "@playwright/test";

import type { App } from "../src/app";
import { PREVIEW_COOKIE, TICKET_PARAM } from "../src/preview/grants";
import { startServer } from "../src/server";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";
import { relayOnLoopback } from "./support/relay";

const executablePath = chromiumFor("The preview isolation test");
const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const BASE_DOMAIN = "preview.localhost";

interface Probe {
  origin: string;
  documentCookie: string;
  storage: string | null;
  controlCrossOriginToBox: { error?: string; status?: number; body?: string };
  readConsoleApi: { error?: string; status?: number; body?: string };
  writeConsoleApi: { error?: string; status?: number };
  blindWriteConsoleApi: { error?: string; type?: string };
  consoleSocket: string;
}

/**
 * The page a box serves in this test. It plays the part of a hostile app: it tries to read and write the console API,
 * open the console's terminal socket, and inspect its own cookies and storage. Its results go to `window.probeResults`.
 */
function probeHtml(consoleUrl: string, boxId: string, boxUrl: string): string {
  const script = `
(async () => {
  const consoleUrl = ${JSON.stringify(consoleUrl)};
  const boxUrl = ${JSON.stringify(boxUrl)};
  const boxId = ${JSON.stringify(boxId)};
  const out = { origin: location.origin, documentCookie: document.cookie };
  const attempt = async (name, run) => {
    try {
      out[name] = await run();
    } catch (e) {
      out[name] = { error: String(e) };
    }
  };
  localStorage.setItem("probe", "kept");
  out.storage = localStorage.getItem("probe");
  await attempt("controlCrossOriginToBox", async () => {
    const res = await fetch(boxUrl + "/cors", { mode: "cors" });
    return { status: res.status, body: await res.text() };
  });
  await attempt("readConsoleApi", async () => {
    const res = await fetch(consoleUrl + "/api/boxes", { credentials: "include" });
    return { status: res.status, body: await res.text() };
  });
  await attempt("writeConsoleApi", async () => {
    const res = await fetch(consoleUrl + "/api/boxes/" + boxId + "/stop", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return { status: res.status };
  });
  await attempt("blindWriteConsoleApi", async () => {
    const res = await fetch(consoleUrl + "/api/boxes/" + boxId + "/stop", {
      method: "POST",
      mode: "no-cors",
      credentials: "include",
    });
    return { type: res.type };
  });
  await attempt("consoleSocket", () => new Promise((resolve) => {
    const ws = new WebSocket(consoleUrl.replace("http", "ws") + "/api/boxes/" + boxId + "/terminal?session=main");
    ws.onopen = () => {
      ws.close();
      resolve("open");
    };
    ws.onerror = () => resolve("error");
  }));
  window.probeResults = out;
})();`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head><body><script>${script}</script></body></html>`;
}

describe.skipIf(!executablePath)("a subdomain preview cannot reach the console (real browser)", () => {
  let app: App | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let upstream: HttpServer | undefined;
  let browser: Browser | undefined;
  let consoleUrl = "";
  let previewHost = "";
  let boxId = "";
  let containerId = "";
  let probe: Probe | undefined;
  let grant: { domain: string; path: string; httpOnly: boolean; secure: boolean; sameSite: string } | undefined;
  let consoleControlStatus = 0;
  let boxRunningAfterProbe = false;
  const upstreamCookies: (string | null)[] = [];

  beforeAll(async () => {
    const created = createTestApp({ previewBaseDomain: BASE_DOMAIN });
    app = created.app;
    const runtime = created.runtime;
    const keys = app.hosts.get().keys;
    runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
    // The preview reaches the box through the exec relay, so route it to this machine's python3, where the test's
    // upstream on 127.0.0.1 stands in for the box's own service.
    relayOnLoopback(runtime);
    server = startServer(app);
    consoleUrl = `http://127.0.0.1:${server.port}`;

    const boxServer = createServer((req, res) => {
      upstreamCookies.push(req.headers.cookie ?? null);
      if (req.url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(probeHtml(consoleUrl, boxId, `http://127.0.0.1:${upstreamPort}`));
        return;
      }
      if (req.url === "/cors") {
        res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
        res.end("ok");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    upstream = boxServer;
    await new Promise<void>((resolve) => boxServer.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (boxServer.address() as { port: number }).port;

    const headers = { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}`, origin: consoleUrl };
    const create = await fetch(`${consoleUrl}/api/boxes`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "web", cpus: 1, memoryMb: 512 }),
    });
    expect(create.status).toBe(201);
    const { box } = (await create.json()) as { box: { id: string; boxId: string } };
    boxId = box.boxId;
    containerId = box.id;
    const start = await fetch(`${consoleUrl}/api/boxes/${containerId}/start`, { method: "POST", headers });
    expect(start.status).toBe(200);

    browser = await chromium.launch({
      executablePath: executablePath ?? undefined,
      args: ["--no-sandbox", "--host-resolver-rules=MAP *.preview.localhost 127.0.0.1"],
    });
    const context: BrowserContext = await browser.newContext();
    const login = await context.request.post(`${consoleUrl}/api/auth/login`, {
      data: { key: TEST_KEY },
      headers: { origin: consoleUrl },
    });
    expect(login.status()).toBe(200);

    const consolePage = await context.newPage();
    await consolePage.goto(`${consoleUrl}/`);
    consoleControlStatus = await consolePage.evaluate(async () => (await fetch("/api/boxes")).status);
    await consolePage.close();

    const launch = await context.request.get(`${consoleUrl}/api/boxes/${boxId}/ports/${upstreamPort}/preview`, {
      maxRedirects: 0,
    });
    expect(launch.status()).toBe(302);
    const location = new URL(launch.headers().location ?? "");
    previewHost = location.hostname;
    const ticket = location.searchParams.get(TICKET_PARAM);
    if (!ticket) throw new Error("the launcher did not issue a ticket");
    const previewUrl = `http://${previewHost}:${server.port}/?${TICKET_PARAM}=${ticket}`;

    const page = await context.newPage();
    await page.goto(previewUrl);
    await page.waitForFunction(() => (globalThis as unknown as { probeResults?: unknown }).probeResults !== undefined);
    probe = await page.evaluate(() => (globalThis as unknown as { probeResults: Probe }).probeResults);
    const cookie = (await context.cookies(previewUrl)).find((c) => c.name === PREVIEW_COOKIE);
    if (cookie) grant = cookie;
    await page.close();

    const state = await fetch(`${consoleUrl}/api/boxes/${containerId}`, { headers });
    boxRunningAfterProbe = ((await state.json()) as { box: { running: boolean } }).box.running;
  });

  afterAll(async () => {
    await browser?.close();
    upstream?.closeAllConnections();
    upstream?.close();
    server?.stop(true);
    app?.throttle.stop();
    app?.sessions.stop();
    app?.tokens.stop();
    app?.events.close();
  });

  test("the grant cookie is HttpOnly, Secure and SameSite=Lax, and is scoped to the preview host", () => {
    expect(grant).toMatchObject({
      domain: previewHost,
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    });
  });

  test("the preview page runs on its own origin, and can reach its box across origins", () => {
    expect(probe?.origin).toBe(`http://${previewHost}:${server?.port}`);
    expect(probe?.controlCrossOriginToBox).toEqual({ status: 200, body: "ok" });
  });

  test("the preview page cannot read the console API, write to it, or open its terminal", () => {
    expect(probe?.readConsoleApi.error).toBeDefined();
    expect(probe?.readConsoleApi.body).toBeUndefined();
    expect(probe?.writeConsoleApi.error).toBeDefined();
    expect(probe?.blindWriteConsoleApi.error).toBeDefined();
    expect(probe?.consoleSocket).toBe("error");
  });

  test("the box is still running after the preview's attempts", () => {
    expect(boxRunningAfterProbe).toBe(true);
  });

  test("the preview keeps its own storage, and its script cannot read the grant or the console session", () => {
    expect(probe?.storage).toBe("kept");
    expect(probe?.documentCookie).not.toContain(PREVIEW_COOKIE);
    expect(probe?.documentCookie).not.toContain("minibox_session");
  });

  test("the box never receives MiniBox's session cookie or grant", () => {
    expect(upstreamCookies.length).toBeGreaterThan(0);
    for (const cookie of upstreamCookies) {
      expect(cookie ?? "").not.toContain("minibox_session");
      expect(cookie ?? "").not.toContain(PREVIEW_COOKIE);
    }
  });

  test("the console still reaches its own API from its own origin", () => {
    expect(consoleControlStatus).toBe(200);
  });
});
