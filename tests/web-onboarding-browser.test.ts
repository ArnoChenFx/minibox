import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type Browser, type BrowserContext, chromium, expect as webExpect, type Page } from "@playwright/test";

import type { App } from "../src/app";
import { startServer } from "../src/server";
import en from "../web/js/i18n/en.js";
import zh from "../web/js/i18n/zh-CN.js";
import { mcpSnippet, tokenName } from "../web/js/lib/onboarding.js";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";

const executablePath = chromiumFor("The first-run guide test");
const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const TIMEOUT_MS = 60_000;
const VIEWPORT = { width: 1280, height: 900 };
/** The widest phone the guide is designed for, and the narrowest one the console claims. */
const PHONE = { width: 390, height: 844 };
const NARROW = { width: 320, height: 720 };

const english = (key: string, vars: Record<string, string | number> = {}): string =>
  (en[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ""));

const chineseText = (key: string): string => zh[key] ?? key;

/** The guide's steps as the page draws them: their ids, whether each reads as done, and whether it is open. */
async function stepsOf(page: Page) {
  return page.locator("#onboarding .onboarding-step").evaluateAll((nodes) =>
    nodes.map((node) => ({
      id: node.getAttribute("data-step") ?? "",
      done: node.classList.contains("is-done"),
      open: node.classList.contains("is-open"),
      locked: node.classList.contains("is-locked"),
      text: (node as unknown as { textContent: string | null }).textContent?.trim() ?? "",
    })),
  );
}

/** The boxes of the elements `selector` names, each with whether it sits inside the window. */
async function insideOf(root: ReturnType<Page["locator"]>, selector: string) {
  return root.locator(selector).evaluateAll((nodes) => {
    const width = (globalThis as unknown as { document: { documentElement: { clientWidth: number } } }).document
      .documentElement.clientWidth;
    return nodes.map((node) => {
      const rect = (
        node as unknown as { getBoundingClientRect(): { left: number; right: number; width: number } }
      ).getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        width: rect.width,
        inside: rect.left >= -0.5 && rect.right <= width + 0.5,
      };
    });
  });
}

/** The page's width and whether it scrolls sideways, which is what a narrow screen must not do. */
async function overflowOf(page: Page) {
  return page.evaluate(() => {
    const root = (
      globalThis as unknown as {
        document: { documentElement: { scrollWidth: number; clientWidth: number } };
      }
    ).document.documentElement;
    return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth };
  });
}

describe.skipIf(!executablePath)("the overview's first-run guide (real browser)", () => {
  let app: App | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser;
  let context: BrowserContext | undefined;
  let page: Page;
  let consoleUrl = "";
  let bearer: Record<string, string> = {};
  let baseRef = "";

  /** The boxes the console holds, as the API lists them. */
  async function boxesNow(): Promise<{ boxId: string; name: string }[]> {
    const listed = (await (await fetch(`${consoleUrl}/api/boxes?stats=false`, { headers: bearer })).json()) as {
      boxes: { boxId: string; name: string }[];
    };
    return listed.boxes;
  }

  beforeAll(async () => {
    const harness = createTestApp();
    app = harness.app;
    server = startServer(app);
    consoleUrl = `http://127.0.0.1:${server.port}`;
    baseRef = app.cfg.baseTemplateTag;
    bearer = { authorization: `Bearer ${TEST_KEY}`, origin: consoleUrl, "content-type": "application/json" };

    browser = await chromium.launch({ executablePath: executablePath ?? undefined, args: ["--no-sandbox"] });
    context = await browser.newContext({ viewport: VIEWPORT, permissions: ["clipboard-read", "clipboard-write"] });
    const login = await context.request.post(`${consoleUrl}/api/auth/login`, {
      data: { key: TEST_KEY },
      headers: { origin: consoleUrl },
    });
    expect(login.status()).toBe(200);
    page = await context.newPage();
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

  test(
    "the guide opens on the base template, and building it moves the guide to the box",
    async () => {
      await page.goto(`${consoleUrl}/#/overview`);
      const guide = page.locator("#onboarding");
      await webExpect(guide).toBeVisible();
      await webExpect(guide.locator("#obTitle")).toHaveText(english("ob.title"));

      // No host holds the base template yet, so the first step offers the build and the two after it stay shut.
      await webExpect(guide.locator('[data-step="template"]')).toHaveClass(/is-open/);
      await webExpect(guide.locator('[data-step="template"] .onboarding-body')).toContainText(baseRef);
      await webExpect(guide.locator('[data-step="box"]')).toHaveClass(/is-locked/);
      await webExpect(guide.locator('[data-step="agent"]')).toHaveClass(/is-locked/);
      expect(await stepsOf(page)).toEqual([
        { id: "template", done: false, open: true, locked: false, text: expect.any(String) },
        { id: "box", done: false, open: false, locked: true, text: expect.any(String) },
        { id: "agent", done: false, open: false, locked: true, text: expect.any(String) },
      ]);

      // The button posts the templates page's own endpoint and opens the build in the task drawer.
      const buildCall = page.waitForRequest(
        (request) => request.url().endsWith("/api/templates/base/build") && request.method() === "POST",
      );
      await guide.locator('[data-action="build"]').click();
      const request = await buildCall;
      expect(request.headers().authorization).toBeUndefined();
      await webExpect(page.locator("#taskDrawer")).toBeVisible();

      // Once the build ends, the guide reads the template list again and the first step reads as done.
      await webExpect(guide.locator('[data-step="template"]')).toHaveClass(/is-done/, { timeout: 20_000 });
      await webExpect(guide.locator('[data-step="template"] .badge')).toHaveText(english("ob.done"));
      await webExpect(guide.locator('[data-step="box"]')).toHaveClass(/is-open/);
      await webExpect(guide.locator('[data-step="template"] [data-action="build"]')).toHaveCount(0);

      // The build opened the task drawer, which covers the page until its own close button is pressed.
      await page.locator("#taskDrawer .task-head [data-close]").click();
      await webExpect(page.locator("#taskDrawer")).toBeHidden();
    },
    TIMEOUT_MS,
  );

  test(
    "the box step opens the create dialog, and the agent step then hands over a working token and its configuration",
    async () => {
      await page.goto(`${consoleUrl}/#/overview`);
      const guide = page.locator("#onboarding");
      await webExpect(guide.locator('[data-step="box"]')).toHaveClass(/is-open/);
      await webExpect(guide.locator('[data-step="agent"]')).toHaveClass(/is-locked/);

      // The second step opens the page's own create dialog, and the box it makes moves the guide on.
      await guide.locator('[data-action="create-box"]').click();
      const dialog = page.getByRole("dialog");
      await webExpect(dialog).toBeVisible();
      await dialog.locator("#cbName").fill("first-box");
      await dialog.locator("#cbSubmit").click();
      await webExpect(dialog).toHaveCount(0);
      await webExpect(guide.locator('[data-step="box"]')).toHaveClass(/is-done/);
      await webExpect(guide.locator('[data-step="agent"]')).toHaveClass(/is-open/);
      expect((await boxesNow()).map((box) => box.name)).toContain("first-box");

      // Codex writes a config.toml table, and its preset is the sandboxed agent one.
      await guide.locator('[data-action="client"][data-client="codex"]').click();
      await webExpect(guide.locator('[data-client="codex"]')).toHaveAttribute("aria-pressed", "true");
      await webExpect(guide.locator("#obPreset")).toHaveValue("sandboxed-agent");

      // The token is the settings page's own: the endpoint it posts to is the one the settings dialog uses.
      const tokenCall = page.waitForRequest(
        (request) => request.url().endsWith("/api/tokens") && request.method() === "POST",
      );
      await guide.locator('[data-action="create-token"]').click();
      const sent = JSON.parse((await tokenCall).postData() ?? "{}") as { name?: string; preset?: string };
      expect(sent).toEqual({ name: tokenName("codex"), preset: "sandboxed-agent" });

      const secret = (await guide.locator("#obSecret").textContent())?.trim() ?? "";
      expect(secret.startsWith("mbx_")).toBe(true);
      const listed = (await (await fetch(`${consoleUrl}/api/tokens`, { headers: bearer })).json()) as {
        tokens: { name: string; preset: string | null }[];
      };
      expect(listed.tokens.map((token) => [token.name, token.preset])).toContainEqual([
        tokenName("codex"),
        "sandboxed-agent",
      ]);

      // The snippet is the client's own, carries the secret, and says the secret is shown only once.
      const snippet = (await guide.locator("#obSnippet").textContent()) ?? "";
      expect(snippet).toBe(mcpSnippet({ client: "codex", origin: consoleUrl, secret }).text);
      await webExpect(guide.locator(".token-secret")).toHaveText(secret);
      await webExpect(guide).toContainText(english("ob.agentSecretOnce"));
      // Nothing this browser saved holds the secret.
      const stored = await page.evaluate(() => {
        const storage = (globalThis as unknown as { localStorage: Storage }).localStorage;
        const values: string[] = [];
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (key) values.push(storage.getItem(key) ?? "");
        }
        return values.join("\n");
      });
      expect(stored).not.toContain(secret);

      // Copying the configuration puts the snippet on the clipboard, not the bare secret: that is what the button says,
      // and it is what a client reads.
      await guide.locator('[data-action="copy"]').click();
      const clipboard = await page.evaluate(() =>
        (
          globalThis as unknown as { navigator: { clipboard: { readText(): Promise<string> } } }
        ).navigator.clipboard.readText(),
      );
      expect(clipboard).toBe(mcpSnippet({ client: "codex", origin: consoleUrl, secret }).text);
      expect(clipboard).not.toBe(secret);
      await webExpect(page.locator("#onboarding")).toHaveCount(0);
      await page.reload();
      await webExpect(page.locator("#onboarding")).toHaveCount(0);

      // The token really works: the secret opens /mcp as a bearer token.
      const rpc = await fetch(`${consoleUrl}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
        }),
      });
      expect(rpc.status).toBe(200);
    },
    TIMEOUT_MS,
  );

  test(
    "the whole guide fits a phone without scrolling sideways, in both themes",
    async () => {
      // A fresh browser, and a console with no box: the state a new install starts in.
      for (const box of await boxesNow()) {
        await fetch(`${consoleUrl}/api/boxes/${encodeURIComponent(box.boxId)}`, { method: "DELETE", headers: bearer });
      }
      const phone = await browser.newContext({ viewport: PHONE, permissions: ["clipboard-read", "clipboard-write"] });
      const login = await phone.request.post(`${consoleUrl}/api/auth/login`, {
        data: { key: TEST_KEY },
        headers: { origin: consoleUrl },
      });
      expect(login.status()).toBe(200);
      const small = await phone.newPage();
      try {
        await small.goto(`${consoleUrl}/#/overview`);
        const guide = small.locator("#onboarding");
        await webExpect(guide).toBeVisible();
        // The first step is done from the desktop walkthrough above, so this one opens on the box step.
        await webExpect(guide.locator('[data-step="box"]')).toHaveClass(/is-open/);

        // Step two from the phone itself: the create dialog, then the guide moves to its last step.
        await guide.locator('[data-action="create-box"]').click();
        const dialog = small.getByRole("dialog");
        await webExpect(dialog).toBeVisible();
        await dialog.locator("#cbName").fill("phone-box");
        await dialog.locator("#cbSubmit").click();
        await webExpect(dialog).toHaveCount(0);
        await webExpect(guide.locator('[data-step="agent"]')).toHaveClass(/is-open/);

        // Every control of the agent step, before the token and after it, stays inside each phone window.
        for (const viewport of [PHONE, NARROW]) {
          await small.setViewportSize(viewport);
          const before = await insideOf(guide, ".onboarding-client, #obPreset, .onboarding-actions .btn");
          // Three client buttons, the preset select and the button that creates the token.
          expect([viewport.width, before.length]).toEqual([viewport.width, 5]);
          expect(before.filter((rect) => !rect.inside)).toEqual([]);
          expect(before.filter((rect) => rect.width <= 0)).toEqual([]);
        }

        // Step three from the phone: the token, then the snippet.
        await guide.locator('[data-action="create-token"]').click();
        await webExpect(guide.locator("#obSnippet")).toBeVisible();
        for (const viewport of [PHONE, NARROW]) {
          await small.setViewportSize(viewport);
          const overflow = await overflowOf(small);
          expect([viewport.width, overflow.scrollWidth <= overflow.clientWidth]).toEqual([viewport.width, true]);
          const after = await insideOf(guide, ".onboarding-actions .btn, .token-secret");
          // The two copy buttons, the one that ends the guide, and the secret itself.
          expect([viewport.width, after.length]).toEqual([viewport.width, 4]);
          expect(after.filter((rect) => !rect.inside)).toEqual([]);
          // The snippet scrolls inside its own box rather than pushing the page sideways.
          const snippet = await guide.locator("#obSnippet").evaluate((node) => {
            const el = node as unknown as { scrollWidth: number; clientWidth: number };
            return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
          });
          expect(snippet.scrollWidth).toBeGreaterThanOrEqual(snippet.clientWidth);
        }

        // Dark mode, chosen in the console itself: the guide draws its text in a colour that is not its own background.
        await small.locator("#themeBtn").click();
        await webExpect(small.locator("#onboarding")).toBeVisible();
        const colors = await small.evaluate(() => {
          interface El {
            textContent: string | null;
          }
          const view = globalThis as unknown as {
            document: {
              documentElement: { dataset: Record<string, string>; querySelector(selector: string): El | null };
            };
            getComputedStyle(el: El): { color: string; backgroundColor: string };
          };
          const root = view.document.documentElement;
          const name = root.querySelector("#onboarding .onboarding-name");
          const card = root.querySelector("#onboarding");
          return {
            theme: root.dataset.theme,
            name: name ? view.getComputedStyle(name).color : "",
            card: card ? view.getComputedStyle(card).backgroundColor : "",
          };
        });
        expect(colors.theme).toBe("dark");
        expect(colors.name).not.toBe(colors.card);
      } finally {
        await phone.close();
        for (const box of await boxesNow()) {
          if (box.name !== "phone-box") continue;
          await fetch(`${consoleUrl}/api/boxes/${encodeURIComponent(box.boxId)}`, {
            method: "DELETE",
            headers: bearer,
          });
        }
      }
    },
    TIMEOUT_MS,
  );

  test(
    "the guide speaks Chinese when the console does",
    async () => {
      const chinese = await browser.newContext({ viewport: VIEWPORT, locale: "zh-CN" });
      const login = await chinese.request.post(`${consoleUrl}/api/auth/login`, {
        data: { key: TEST_KEY },
        headers: { origin: consoleUrl },
      });
      expect(login.status()).toBe(200);
      const zhPage = await chinese.newPage();
      try {
        await zhPage.goto(`${consoleUrl}/#/overview`);
        const guide = zhPage.locator("#onboarding");
        await webExpect(guide).toBeVisible();
        await webExpect(guide.locator("#obTitle")).toHaveText(chineseText("ob.title"));
        await webExpect(guide.locator('[data-step="template"] .onboarding-name')).toHaveText(
          chineseText("ob.step.template"),
        );
        await webExpect(guide.locator('[data-step="agent"] .onboarding-name')).toHaveText(chineseText("ob.step.agent"));
      } finally {
        await chinese.close();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "hiding the guide keeps it away in this browser, and a console with a box never shows it",
    async () => {
      const own = await browser.newContext({ viewport: VIEWPORT });
      const login = await own.request.post(`${consoleUrl}/api/auth/login`, {
        data: { key: TEST_KEY },
        headers: { origin: consoleUrl },
      });
      expect(login.status()).toBe(200);
      const fresh = await own.newPage();
      try {
        await fresh.goto(`${consoleUrl}/#/overview`);
        await webExpect(fresh.locator("#onboarding")).toBeVisible();
        await fresh.locator('[data-action="dismiss"]').click();
        await webExpect(fresh.locator("#onboarding")).toHaveCount(0);
        await fresh.reload();
        await webExpect(fresh.locator("#onboarding")).toHaveCount(0);

        // The same browser, with a box: the guide stays away even though the saved state is untouched.
        await fresh.evaluate(() => {
          (globalThis as unknown as { localStorage: Storage }).localStorage.removeItem("minibox.onboarding.v1");
        });
        const made = await fetch(`${consoleUrl}/api/boxes`, {
          method: "POST",
          headers: bearer,
          body: JSON.stringify({ name: "box-after-dismiss", cpus: 1, memoryMb: 512 }),
        });
        expect(made.status).toBe(201);
        await fresh.reload();
        await webExpect(fresh.locator("#onboarding")).toHaveCount(0);
      } finally {
        await own.close();
        for (const box of await boxesNow()) {
          if (box.name !== "box-after-dismiss") continue;
          await fetch(`${consoleUrl}/api/boxes/${encodeURIComponent(box.boxId)}`, {
            method: "DELETE",
            headers: bearer,
          });
        }
      }
    },
    TIMEOUT_MS,
  );
});
