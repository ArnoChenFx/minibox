import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { type Browser, type BrowserContext, chromium } from "@playwright/test";

import type { App } from "../src/app";
import { startServer } from "../src/server";
import { listVolumes } from "../src/services/volumes";
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
  throw new Error("The hidden files test needs Chromium: run `bunx playwright install --with-deps chromium`.");
}

const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const file = (text: string) => ({
  type: "file" as const,
  content: Buffer.from(text),
  mode: 0o644,
  uid: 1000,
  gid: 1000,
});
const dir = () => ({ type: "dir" as const, mode: 0o755, uid: 1000, gid: 1000 });

describe.skipIf(!executablePath)("the file browser's hidden files (real browser)", () => {
  let app: App | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser;
  let context: BrowserContext | undefined;
  let url = "";
  let boxId = "";

  beforeAll(async () => {
    const harness = createTestApp();
    app = harness.app;
    const host = app.hosts.get();
    harness.runtime.seedImage(app.cfg.baseTemplateTag, {
      [host.keys.template]: "true",
      [host.keys.templateName]: "base",
    });
    server = startServer(app);
    url = `http://127.0.0.1:${server.port}`;
    const made = await fetch(`${url}/api/boxes`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}`, origin: url },
      body: JSON.stringify({ name: "dots", cpus: 1, memoryMb: 512 }),
    });
    expect(made.status).toBe(201);
    boxId = ((await made.json()) as { box: { id: string } }).box.id;

    const volume = (await listVolumes(host)).find((entry) => entry.name === "dots-workspace");
    if (!volume) throw new Error("the new box has no workspace volume");
    const files = harness.runtime.filesOf(volume.engineName);
    files.set(".env", file("TOKEN=1\n"));
    files.set(".config", dir());
    files.set("README.md", file("# hi\n"));
    files.set("src", dir());

    browser = await chromium.launch({ executablePath: executablePath ?? undefined, args: ["--no-sandbox"] });
    context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1280, height: 900 } });
    const login = await context.request.post(`${url}/api/auth/login`, {
      data: { key: TEST_KEY },
      headers: { origin: url },
    });
    expect(login.status()).toBe(200);
  }, 60_000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    server?.stop(true);
    app?.throttle.stop();
    app?.sessions.stop();
    app?.tokens.stop();
    app?.events.close();
  });

  const names = async (page: import("@playwright/test").Page) =>
    (await page.locator("#fbBody .fb-name").allInnerTexts()).map((text) => text.trim()).toSorted();

  test("dotfiles are listed and the checkbox is on when the tab opens, and turning it off hides them again", async () => {
    const page = await context!.newPage();
    await page.goto(`${url}/#/boxes/${encodeURIComponent(boxId)}/files`);
    await page.waitForSelector("#fbBody .fb-name", { timeout: 8000 });
    expect(await page.locator("#fbHidden").isChecked()).toBe(true);
    expect(await names(page)).toEqual([".config", ".env", "README.md", "src"]);

    await page.locator("#fbHidden").uncheck();
    expect(await names(page)).toEqual(["README.md", "src"]);

    await page.locator("#fbHidden").check();
    expect(await names(page)).toEqual([".config", ".env", "README.md", "src"]);
    await page.close();
  }, 30_000);

  test("a fresh visit lists dotfiles again, because the choice is not saved", async () => {
    const first = await context!.newPage();
    await first.goto(`${url}/#/boxes/${encodeURIComponent(boxId)}/files`);
    await first.waitForSelector("#fbBody .fb-name");
    await first.locator("#fbHidden").uncheck();
    await first.close();

    const second = await context!.newPage();
    await second.goto(`${url}/#/boxes/${encodeURIComponent(boxId)}/files`);
    await second.waitForSelector("#fbBody .fb-name");
    expect(await second.locator("#fbHidden").isChecked()).toBe(true);
    expect(await names(second)).toContain(".env");
    await second.close();
  }, 30_000);
});
