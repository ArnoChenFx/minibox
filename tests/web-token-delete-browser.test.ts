import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type APIRequestContext, type Browser, chromium, type Page } from "@playwright/test";

import type { App } from "../src/app";
import { startServer } from "../src/server";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";

const executablePath = chromiumFor("The token page test");
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
      expect(await row("gone-one").locator("[data-edit-token]").count()).toBe(0);

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
  test(
    "storage deletion is disabled for scoped tokens while the admin preset remains usable",
    async () => {
      const page = await openTokens("en-US", [], []);
      try {
        await page.locator("#stTokenCreate").click();
        const deletion = page.locator('input[name="scope"][value="volume:delete"]');
        expect(await deletion.isDisabled()).toBe(true);
        await page.locator('[data-preset="admin"]').click();
        expect(await deletion.isDisabled()).toBe(false);
        expect(await deletion.isChecked()).toBe(true);
        await page.locator('select[name="boxes"]').selectOption("created-by-me");
        expect(await deletion.isDisabled()).toBe(true);
        // A scope that cannot count is cleared, not left ticked behind a disabled box.
        expect(await deletion.isChecked()).toBe(false);
        await page.locator('select[name="boxes"]').selectOption("*");
        expect(await deletion.isDisabled()).toBe(false);
        expect(await deletion.isChecked()).toBe(true);
        // Unticking it under the admin preset leaves it usable, so it can be ticked again without re-choosing the preset.
        await page.locator("#stPermsToggle").click();
        await deletion.uncheck();
        expect(await deletion.isDisabled()).toBe(false);
        await deletion.check();
        expect(await deletion.isChecked()).toBe(true);
        expect(await page.getByRole("dialog").innerText()).toContain("Only an unmodified admin token");
      } finally {
        await page.context().close();
      }
    },
    TIMEOUT_MS,
  );
  test("editing permissions round-trips resource grants and quotas, saves and cancels in both languages", async () => {
    for (const locale of ["zh-CN", "en-US"]) {
      const page = await openTokens(locale, [], []);
      try {
        const name = `editable-${locale}`;
        const minted = await page.request.post(`${url}/api/tokens`, {
          data: {
            name,
            preset: "sandboxed-agent",
            scopes: ["box:read", "files:read"],
            boxes: { tags: ["env=prod"] },
            volumes: ["vol_shared"],
            hosts: ["lab"],
            expiresInSec: 3600,
            quotas: { maxBoxes: 3, maxTtlSec: 1234, rateLimit: 17, rateWindowSec: 90 },
          },
        });
        expect(minted.status()).toBe(201);
        const original = (await minted.json()).record;
        await page.reload();
        const edit = page.locator(`[data-edit-token="${original.id}"]`);
        await edit.click();
        const form = page.locator("#stTokenForm");
        expect(await form.locator('[name="boxTags"]').inputValue()).toBe("env=prod");
        expect(await form.locator('[name="hosts"]').inputValue()).toBe("ids");
        expect(await form.locator('[name="hostIds"]').inputValue()).toBe("lab");
        expect(await form.locator('[name="volumes"]').inputValue()).toBe("vol_shared");
        expect(await form.locator('[name="rateWindowSec"]').inputValue()).toBe("90");
        expect(
          await form
            .locator('[name="scope"]:checked')
            .evaluateAll((nodes) => nodes.map((node) => (node as unknown as { value: string }).value)),
        ).toEqual(original.scopes);
        // An unchanged save must preserve custom hosts, every quota (including seconds), scopes and expiry.
        await page.locator("#stTokenSave").click();
        await page.locator("#stTokenForm").waitFor({ state: "detached" });
        const getRecord = async () =>
          (await (await page.request.get(`${url}/api/tokens`)).json()).tokens.find(
            (token: { id: string }) => token.id === original.id,
          );
        expect(await getRecord()).toEqual(original);
        await edit.click();
        await page.locator('[data-preset="admin"]').click();
        await page.locator(".dialog-foot [data-close]").click();
        expect(await getRecord()).toEqual(original);
        await edit.click();
        await page.locator("#stPermsToggle").click();
        await form.locator('[name="scope"][value="exec"]').check();
        await form.locator('[name="boxes"]').selectOption("*");
        await form.locator('[name="hosts"]').selectOption("local");
        await form.locator('[name="volumes"]').fill("");
        await form.locator('[name="maxBoxes"]').fill("");
        await form.locator('[name="rateLimit"]').fill("");
        await page.locator("#stTokenSave").click();
        await form.waitFor({ state: "detached" });
        const changed = await getRecord();
        expect(changed.scopes).toContain("exec");
        expect(changed.boxes).toEqual({ type: "all" });
        expect(changed.volumes).toEqual({ type: "list", ids: [] });
        expect(changed.hosts).toEqual({ type: "list", ids: ["local"] });
        expect(changed.quotas).toMatchObject({ maxBoxes: null, rateLimit: null, rateWindowSec: null, maxTtlSec: 1234 });
        expect(changed.expiresAt).toBe(original.expiresAt);
        expect(changed.prefix).toBe(original.prefix);
        expect(await page.locator("#stTokenSecret").count()).toBe(0);
      } finally {
        await page.context().close();
      }
    }
  }, 60_000);

  test(
    "opening a custom admin does not elevate it, invalid edits stay open and mobile fits",
    async () => {
      const page = await openTokens("zh-CN", [], []);
      try {
        // Explicit full scopes are still scoped: saving without choosing admin must not add storage authority.
        const catalog = await (await page.request.get(`${url}/api/tokens/presets`)).json();
        const admin = catalog.presets.find((p: { name: string }) => p.name === "admin");
        const minted = await page.request.post(`${url}/api/tokens`, {
          data: { name: "scoped-admin", preset: "admin", scopes: admin.scopes },
        });
        const { record } = await minted.json();
        expect(record.audit).toBe("scoped");
        await page.setViewportSize({ width: 390, height: 844 });
        await page.reload();
        await page.locator(`[data-edit-token="${record.id}"]`).click();
        await page.locator("#stTokenSave").click();
        await page.locator("#stTokenForm").waitFor({ state: "detached" });
        let current = (await (await page.request.get(`${url}/api/tokens`)).json()).tokens.find(
          (token: { id: string }) => token.id === record.id,
        );
        expect(current.audit).toBe("scoped");
        await page.locator(`[data-edit-token="${record.id}"]`).click();
        await page.locator('[name="hosts"]').selectOption("ids");
        await page.locator('[name="hostIds"]').fill("invalid host id");
        const refused = page.waitForResponse(
          (res) => res.url().endsWith(`/api/tokens/${record.id}`) && res.request().method() === "PUT",
        );
        await page.locator("#stTokenSave").click();
        expect((await refused).status()).toBe(400);
        expect(await page.locator("#stTokenSave").isEnabled()).toBe(true);
        expect(await page.locator("#stTokenForm").isVisible()).toBe(true);
        expect(
          await page.evaluate(() => {
            const doc = globalThis as unknown as {
              document: { documentElement: { scrollWidth: number } };
              innerWidth: number;
            };
            return doc.document.documentElement.scrollWidth <= doc.innerWidth;
          }),
        ).toBe(true);
        current = (await (await page.request.get(`${url}/api/tokens`)).json()).tokens.find(
          (token: { id: string }) => token.id === record.id,
        );
        expect(current.hosts).toEqual({ type: "all" });
      } finally {
        await page.context().close();
      }
    },
    TIMEOUT_MS,
  );
});
