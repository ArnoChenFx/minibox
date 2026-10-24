import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { type Browser, type BrowserContext, chromium, type Page } from "@playwright/test";

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
  throw new Error("The login page test needs Chromium: run `bunx playwright install --with-deps chromium`.");
}

const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const TIMEOUT_MS = 30_000;

type Stored = { id: string; password: string };

describe.skipIf(!executablePath)("the sign-in page (real browser)", () => {
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

  /** A fresh visitor. `recordStore` replaces the Credential Management API with one that records what is saved. */
  async function visit(
    locale: string,
    recordStore = true,
  ): Promise<{ page: Page; context: BrowserContext; saved: Stored[] }> {
    const saved: Stored[] = [];
    const context = await browser.newContext({ locale, viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    // The login page navigates away, so what it saved is kept on the test side.
    await page.exposeFunction("keepCredential", (credential: Stored) => {
      saved.push(credential);
    });
    // Browser-side code is a string so these tests need no DOM types.
    await page.addInitScript(
      recordStore
        ? `
      window.PasswordCredential = class { constructor(init) { this.id = init.id; this.password = init.password; } };
      Object.defineProperty(navigator, "credentials", {
        configurable: true,
        value: { store: (credential) => window.keepCredential({ id: credential.id, password: credential.password }) },
      });`
        : "delete window.PasswordCredential;",
    );
    await page.goto(`${url}/login`);
    return { page, context, saved };
  }

  test(
    "has a user name field that password managers can see, and the page shows only the key field",
    async () => {
      const { page, context } = await visit("en-US");
      const username = page.locator("#loginForm input[name=username]");
      expect(await username.getAttribute("autocomplete")).toBe("username");
      expect(await username.inputValue()).toBe("minibox");
      expect(await page.locator("#key").getAttribute("autocomplete")).toBe("current-password");
      expect(await page.locator("#loginForm").getAttribute("method")).toBe("post");

      // Rendered, so a password manager counts it, but nowhere on screen.
      const style = (await page.evaluate(
        `(() => { const el = document.querySelector("#username"); const css = getComputedStyle(el); return { display: css.display, visibility: css.visibility, opacity: css.opacity }; })()`,
      )) as { display: string; visibility: string; opacity: string };
      expect(style.display).not.toBe("none");
      expect(style.visibility).toBe("visible");
      expect(style.opacity).toBe("0");
      const box = await username.boundingBox();
      expect(box).not.toBeNull();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThan(0);
      expect(await page.evaluate(`document.activeElement.id`)).not.toBe("username");

      // The card keeps its layout: one field above the button, and the key field is still the focus.
      expect(await page.evaluate(`document.activeElement.id`)).toBe("key");
      const onScreen = await page.evaluate(
        `[...document.querySelectorAll("#loginForm input")].filter((el) => el.getBoundingClientRect().right > 0).map((el) => el.id)`,
      );
      expect(onScreen).toEqual(["key"]);
      await context.close();
    },
    TIMEOUT_MS,
  );

  test(
    "names the hidden field in both languages",
    async () => {
      const en = await visit("en-US");
      expect(await en.page.locator("#username").getAttribute("aria-label")).toBe("Username");
      await en.context.close();
      const zh = await visit("zh-CN");
      expect(await zh.page.locator("#username").getAttribute("aria-label")).toBe("用户名");
      await zh.context.close();
    },
    TIMEOUT_MS,
  );

  test(
    "a wrong key shows the error and keeps the form, saving nothing",
    async () => {
      const { page, context, saved } = await visit("en-US");
      await page.fill("#key", "wrong".repeat(13));
      await page.click("#submit");
      await page.locator("#err:not(:empty)").waitFor();
      expect(page.url()).toBe(`${url}/login`);
      expect(await page.locator("#key").getAttribute("class")).toContain("invalid");
      expect(await page.locator("#submit").isEnabled()).toBe(true);
      expect(saved).toEqual([]);
      await context.close();
    },
    TIMEOUT_MS,
  );

  test(
    "an empty key is refused before anything is sent",
    async () => {
      const { page, context } = await visit("en-US");
      await page.click("#submit");
      expect(await page.locator("#err").textContent()).toBe("Please enter the access key.");
      expect(page.url()).toBe(`${url}/login`);
      await context.close();
    },
    TIMEOUT_MS,
  );

  test(
    "the right key is saved as the user name and the trimmed key through the Credential Management API, then the console opens",
    async () => {
      const { page, context, saved } = await visit("en-US");
      await page.fill("#key", `  ${TEST_KEY}  `);
      await page.click("#submit");
      await page.waitForURL(`${url}/`);
      expect(saved).toEqual([{ id: "minibox", password: TEST_KEY }]);
      await context.close();
    },
    TIMEOUT_MS,
  );

  test(
    "signs in without the Credential Management API",
    async () => {
      const { page, context } = await visit("en-US", false);
      expect(await page.evaluate("'PasswordCredential' in window")).toBe(false);
      await page.fill("#key", TEST_KEY);
      await page.click("#submit");
      await page.waitForURL(`${url}/`);
      await context.close();
    },
    TIMEOUT_MS,
  );
});
