import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { type APIRequestContext, type Browser, chromium, type Page } from "@playwright/test";

import type { App } from "../src/app";
import { startServer } from "../src/server";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";

/** Chromium comes from PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH or Playwright's own install; locally the suite is skipped without one. */
function chromiumPath(): string | null {
  const configured = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (configured) return configured;
  const bundled = chromium.executablePath();
  return existsSync(bundled) ? bundled : null;
}

const executablePath = chromiumPath();
if (!executablePath && process.env.CI) {
  throw new Error("The token page test needs Chromium: run `bunx playwright install --with-deps chromium`.");
}

const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const TIMEOUT_MS = 30_000;

describe.skipIf(!executablePath)("deleting tokens on the settings page (real browser)", () => {
  let app: App | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser;
  let url = "";

  beforeAll(async () => {
    app = createTestApp().app;
    server = startServer(app);
    url = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ executablePath: executablePath ?? undefined, args: ["--no-sandbox"] });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
    app?.throttle.stop();
    app?.sessions.stop();
    app?.tokens.stop();
    app?.events.close();
  });

  async function createToken(request: APIRequestContext, name: string): Promise<string> {
    const res = await request.post(`${url}/api/tokens`, { data: { name, preset: "readonly" } });
    expect(res.status()).toBe(201);
    return ((await res.json()) as { record: { id: string } }).record.id;
  }

  /** An owner session on the tokens page, with one live token and two revoked ones. */
  async function openTokens(locale: string, names: string[], revoke: string[]): Promise<Page> {
    const context = await browser.newContext({ locale, viewport: { width: 1280, height: 900 } });
    const login = await context.request.post(`${url}/api/auth/login`, { data: { key: TEST_KEY } });
    expect(login.status()).toBe(200);
    // The app is shared, so each test starts without the previous one's ended tokens.
    expect((await context.request.post(`${url}/api/tokens/prune`, { data: {} })).status()).toBe(200);
    for (const name of names) {
      const id = await createToken(context.request, name);
      if (revoke.includes(name)) expect((await context.request.delete(`${url}/api/tokens/${id}`)).status()).toBe(200);
    }
    const page = await context.newPage();
    await page.goto(`${url}/#/settings/tokens`);
    await page.waitForSelector("#stTokenCreate");
    return page;
  }

  test(
    "ended tokens get Delete, live ones keep Revoke, and deleting asks first",
    async () => {
      const page = await openTokens("zh-CN", ["live-one", "gone-one", "gone-two"], ["gone-one", "gone-two"]);
      const row = (name: string) => page.locator("tbody tr", { hasText: name });
      expect(await row("live-one").locator("[data-revoke-token]").count()).toBe(1);
      expect(await row("live-one").locator("[data-delete-token]").count()).toBe(0);
      expect(await row("gone-one").locator("[data-delete-token]").count()).toBe(1);
      expect(await row("gone-one").locator("[data-revoke-token]").count()).toBe(0);

      // Cancelling leaves the record alone.
      await row("gone-one").locator("[data-delete-token]").click();
      await page.waitForSelector(".overlay .dialog");
      expect(await page.locator(".overlay .dialog").innerText()).toContain("gone-one");
      await page.locator(".overlay .dialog-foot [data-close]").click();
      await page.locator(".overlay").waitFor({ state: "detached" });
      expect(await row("gone-one").count()).toBe(1);

      await row("gone-one").locator("[data-delete-token]").click();
      await page.locator(".overlay .dialog .btn-danger").click();
      await row("gone-one").waitFor({ state: "detached" });
      expect(await row("gone-two").count()).toBe(1);
      expect(await row("live-one").count()).toBe(1);
      await page.context().close();
    },
    TIMEOUT_MS,
  );

  test(
    "the clean-up button states how many records it deletes and leaves live tokens alone",
    async () => {
      const page = await openTokens("zh-CN", ["keep-me", "old-a", "old-b"], ["old-a", "old-b"]);
      await page.locator("#stTokenPrune").click();
      await page.waitForSelector(".overlay .dialog");
      expect(await page.locator(".overlay .dialog").innerText()).toContain("2");
      await page.locator(".overlay .dialog .btn-danger").click();
      await page.locator("tbody tr", { hasText: "old-a" }).waitFor({ state: "detached" });
      expect(await page.locator("tbody tr", { hasText: "old-b" }).count()).toBe(0);
      expect(await page.locator("tbody tr", { hasText: "keep-me" }).count()).toBe(1);
      // With nothing left to clean up the button is gone.
      expect(await page.locator("#stTokenPrune").count()).toBe(0);
      await page.context().close();
    },
    TIMEOUT_MS,
  );
});
