import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type Browser, type BrowserContext, chromium, expect as webExpect, type Page } from "@playwright/test";

import type { App } from "../src/app";
import { startServer } from "../src/server";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";
import { startWebdavDouble, type WebdavDouble } from "./support/webdav-double";

const executablePath = chromiumFor("The off-site target dialog test");
const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const TIMEOUT_MS = 30_000;
const VIEWPORT = { width: 1280, height: 900 };
const PASSWORD = "app password with a trailing space ";

/** The body the dialog sends to `path` when `act` runs. The request is read as it leaves, whatever the server answers. */
async function sentTo(page: Page, path: string, act: () => Promise<void>): Promise<Record<string, unknown>> {
  const request = page.waitForRequest((candidate) => candidate.method() === "POST" && candidate.url().endsWith(path));
  await act();
  return (await request).postDataJSON() as Record<string, unknown>;
}

describe.skipIf(!executablePath)("the off-site target dialog (real browser)", () => {
  let app: App | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let double: WebdavDouble | undefined;
  let browser: Browser;
  let context: BrowserContext | undefined;
  let page: Page;
  let consoleUrl = "";

  const dialog = () => page.getByRole("dialog");
  const field = (kind: string, name: string) => dialog().locator(`[data-target-kind="${kind}"] [name="${name}"]`);

  beforeAll(async () => {
    app = createTestApp().app;
    double = startWebdavDouble({ user: "me@example.com", password: PASSWORD });
    server = startServer(app);
    consoleUrl = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ executablePath: executablePath ?? undefined, args: ["--no-sandbox"] });
    context = await browser.newContext({ viewport: VIEWPORT, locale: "en-US" });
    const login = await context.request.post(`${consoleUrl}/api/auth/login`, {
      data: { key: TEST_KEY },
      headers: { origin: consoleUrl },
    });
    expect(login.status()).toBe(200);
    page = await context.newPage();
    await page.goto(`${consoleUrl}/#/settings/targets`);
  }, 60_000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    double?.stop();
    server?.stop(true);
    app?.throttle.stop();
    app?.sessions.stop();
    app?.tokens.stop();
    app?.events.close();
  });

  test(
    "an SFTP target keeps the user typed for it, though the WebDAV panel has a user field of its own",
    async () => {
      await page.locator("#stTargetAdd").click();
      await dialog().locator('select[name="kind"]').selectOption("sftp");
      await field("sftp", "host").fill("127.0.0.1");
      await field("sftp", "port").fill("9");
      await field("sftp", "user").fill("sftp-user");
      await field("sftp", "privateKey").fill("not a key");
      const body = await sentTo(page, "/api/targets/test", () => dialog().locator("#stTargetTest").click());
      expect(body).toEqual({ kind: "sftp", host: "127.0.0.1", port: 9, user: "sftp-user", privateKey: "not a key" });
      await dialog().getByRole("button", { name: "Cancel" }).click();
      await webExpect(dialog()).toHaveCount(0);
    },
    TIMEOUT_MS,
  );

  test(
    "a WebDAV target is tested, saved and listed, and its password is sent as typed and shown nowhere",
    async () => {
      const dav = double;
      if (!dav) throw new Error("the WebDAV double is running");
      await page.locator("#stTargetAdd").click();
      await dialog().locator('select[name="kind"]').selectOption("webdav");
      await dialog().locator('input[name="name"]').fill("dav-backup");
      await field("webdav", "url").fill(dav.url);
      await field("webdav", "user").fill("me@example.com");
      await field("webdav", "password").fill(PASSWORD);

      const tested = await sentTo(page, "/api/targets/test", () => dialog().locator("#stTargetTest").click());
      expect(tested).toEqual({ kind: "webdav", url: dav.url, user: "me@example.com", password: PASSWORD });
      await webExpect(dialog().locator("#stTargetResult")).toContainText("Reached the target");

      const saved = await sentTo(page, "/api/targets", () => dialog().locator("#stTargetSave").click());
      expect(saved).toEqual({ ...tested, name: "dav-backup" });
      await webExpect(dialog()).toHaveCount(0);

      const row = page.locator("#stTargets tbody tr", { hasText: "dav-backup" });
      await webExpect(row).toContainText("WebDAV");
      await webExpect(row).toContainText(dav.url);
      expect(await page.locator("#stTargets").innerText()).not.toContain("trailing space");
      expect(dav.requests).toContain("PROPFIND /");
    },
    TIMEOUT_MS,
  );
});
