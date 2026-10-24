import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { type Browser, chromium, type Page } from "@playwright/test";

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
  throw new Error("The recycle bin page test needs Chromium: run `bunx playwright install --with-deps chromium`.");
}

const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const TIMEOUT_MS = 30_000;

describe.skipIf(!executablePath)("emptying the recycle bin on its page (real browser)", () => {
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

  /** An owner session on the recycle bin page. The app is shared, so each test first empties what the last left. */
  async function openTrash(names: string[]): Promise<{ page: Page; ids: Record<string, string> }> {
    const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1280, height: 900 } });
    const login = await context.request.post(`${url}/api/auth/login`, { data: { key: TEST_KEY } });
    expect(login.status()).toBe(200);
    const kept = ((await (await context.request.get(`${url}/api/trash`)).json()) as { trash: { id: string }[] }).trash;
    if (kept.length) {
      const ids = kept.map((entry) => entry.id);
      app?.hosts.get().checkpoints.exporting.clear();
      await context.request.post(`${url}/api/trash/empty`, { data: { confirm: true, ids } });
    }
    const ids: Record<string, string> = {};
    for (const name of names) {
      const made = await context.request.post(`${url}/api/boxes`, { data: { name, cpus: 1, memoryMb: 256 } });
      expect(made.status()).toBe(201);
      const boxId = ((await made.json()) as { box: { boxId: string } }).box.boxId;
      const deleted = await context.request.delete(`${url}/api/boxes/${boxId}`);
      expect(deleted.status()).toBe(200);
      ids[name] = ((await deleted.json()) as { trash: { id: string } }).trash.id;
    }
    const page = await context.newPage();
    await page.goto(`${url}/#/trash`);
    await page.waitForSelector("#trashEmpty");
    return { page, ids };
  }

  test(
    "the button is disabled while the bin is empty, and the dialog states the count and that it cannot be undone",
    async () => {
      const empty = await openTrash([]);
      await empty.page.waitForSelector("#trashRows .empty, #trashRows .empty-state");
      expect(await empty.page.locator("#trashEmpty").isDisabled()).toBe(true);
      await empty.page.context().close();

      const { page } = await openTrash(["alpha", "beta"]);
      await page.locator("#trashRows tr", { hasText: "alpha" }).waitFor();
      expect(await page.locator("#trashEmpty").isDisabled()).toBe(false);

      // Cancelling leaves every entry.
      await page.locator("#trashEmpty").click();
      await page.waitForSelector(".overlay .dialog");
      const text = await page.locator(".overlay .dialog").innerText();
      expect(text).toContain("清空回收站");
      expect(text).toContain("2 条");
      expect(text).toContain("无法恢复");
      await page.locator(".overlay .dialog-foot [data-close]").click();
      await page.locator(".overlay").waitFor({ state: "detached" });
      expect(await page.locator("#trashRows tr", { hasText: "alpha" }).count()).toBe(1);
      expect(await page.locator("#trashEmpty").isDisabled()).toBe(false);

      await page.locator("#trashEmpty").click();
      await page.locator(".overlay .dialog .btn-danger").click();
      await page.locator("#trashRows tr", { hasText: "alpha" }).waitFor({ state: "detached" });
      expect(await page.locator("#trashRows tr", { hasText: "beta" }).count()).toBe(0);
      expect(await page.locator("#trashRows .empty, #trashRows .empty-state").count()).toBeGreaterThan(0);
      expect(await page.locator("#trashEmpty").isDisabled()).toBe(true);
      const left = (await (await page.context().request.get(`${url}/api/trash`)).json()) as { trash: unknown[] };
      expect(left.trash).toEqual([]);
      await page.context().close();
    },
    TIMEOUT_MS,
  );

  test(
    "an entry in use is named in the dialog and left in the bin, while the rest are purged",
    async () => {
      const { page, ids } = await openTrash(["alpha", "beta"]);
      await page.locator("#trashRows tr", { hasText: "beta" }).waitFor();
      app?.hosts.get().checkpoints.exporting.add(ids.beta ?? "");

      await page.locator("#trashEmpty").click();
      await page.waitForSelector(".overlay .dialog");
      const text = await page.locator(".overlay .dialog").innerText();
      expect(text).toContain("1 条");
      expect(text).toContain("beta");
      expect(text).toContain("正在导出或复制");
      await page.locator(".overlay .dialog .btn-danger").click();
      await page.locator("#trashRows tr", { hasText: "alpha" }).waitFor({ state: "detached" });
      expect(await page.locator("#trashRows tr", { hasText: "beta" }).count()).toBe(1);
      expect(await page.locator("#trashEmpty").isDisabled()).toBe(false);

      // Everything left is in use: the button says so and purges nothing.
      await page.locator("#trashEmpty").click();
      await page.waitForSelector(".toast");
      expect(await page.locator("#trashRows tr", { hasText: "beta" }).count()).toBe(1);
      app?.hosts.get().checkpoints.exporting.clear();
      await page.context().close();
    },
    TIMEOUT_MS,
  );
});
