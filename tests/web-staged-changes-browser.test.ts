import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { type Browser, type BrowserContext, chromium, expect as webExpect, type Page } from "@playwright/test";

import type { App } from "../src/app";
import { startServer } from "../src/server";
import en from "../web/js/i18n/en.js";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";

/** Chromium as the Box detail browser test finds it. Locally the suite is skipped without one; in CI it must be there. */
function chromiumPath(): string | null {
  const configured = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (configured) return configured;
  const bundled = chromium.executablePath();
  return existsSync(bundled) ? bundled : null;
}

const executablePath = chromiumPath();
if (!executablePath && process.env.CI) {
  throw new Error(
    "The staged changes test needs Chromium: run `bunx playwright install --with-deps chromium`, or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.",
  );
}

const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const TIMEOUT_MS = 30_000;
const VIEWPORT = { width: 1280, height: 800 };

const english = (key: string, vars: Record<string, string | number> = {}): string =>
  (en[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ""));

interface BoxRow {
  id: string;
  boxId: string;
  name: string;
  revision: number;
  profile: string | null;
  env: { name: string; value?: string }[];
  mounts: { volume: string; path: string; mode: string; volumeId: string | null }[];
}

describe.skipIf(!executablePath)("staged rebuild changes in a box's settings (real browser)", () => {
  let app: App | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser;
  let context: BrowserContext | undefined;
  let page: Page;
  let consoleUrl = "";
  let bearer: Record<string, string> = {};

  async function rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${consoleUrl}${path}`, {
      method,
      headers: bearer,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} ${response.status} ${text}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  const boxNow = async (boxId: string) =>
    (await rest<{ box: BoxRow }>("GET", `/api/boxes/${encodeURIComponent(boxId)}`)).box;
  const stagedNow = async (boxId: string) =>
    (await rest<{ staged: { pending: string[] } | null }>("GET", `/api/boxes/${encodeURIComponent(boxId)}/staged`))
      .staged;
  const settingsUrl = (box: BoxRow, section: string) =>
    `${consoleUrl}/#/boxes/${encodeURIComponent(box.id)}/settings/${section}`;

  beforeAll(async () => {
    const harness = createTestApp();
    app = harness.app;
    const keys = app.hosts.get().keys;
    harness.runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
    server = startServer(app);
    consoleUrl = `http://127.0.0.1:${server.port}`;
    bearer = { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}`, origin: consoleUrl };
    browser = await chromium.launch({ executablePath: executablePath ?? undefined, args: ["--no-sandbox"] });
    context = await browser.newContext({ viewport: VIEWPORT });
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
    "saving the environment stages it: the banner counts it, the card marks it, and the box is not rebuilt",
    async () => {
      const box = (await rest<{ box: BoxRow }>("POST", "/api/boxes", { name: "envbox", cpus: 1, memoryMb: 256 })).box;
      await page.goto(settingsUrl(box, "env"));
      await webExpect(page.locator("#bsStaged")).toBeHidden();

      await page.locator("[data-env-action='edit']").click();
      await page.locator("[data-env-action='add']").click();
      await page.locator("[data-env-row] [data-env-name]").last().fill("MODE");
      await page.locator("[data-env-row] [data-env-value]").last().fill("dev");
      await page.locator("[data-env-action='save']").click();

      const banner = page.locator("#bsStaged .staged-banner");
      await webExpect(banner).toBeVisible();
      await webExpect(banner).toContainText(english("stg.banner", { n: 1 }));
      await webExpect(page.locator("[data-env-pending]")).toHaveText(english("stg.pendingBadge"));
      await webExpect(page.locator(".env-kv dt")).toHaveText(["MODE"]);
      const after = await boxNow(box.boxId);
      expect(after.revision).toBe(box.revision);
      expect(after.env).toEqual([]);

      // The banner's actions sit on one line at its right, 8px apart.
      const buttons = banner.locator(".staged-actions button");
      await webExpect(buttons).toHaveText([english("stg.viewDiff"), english("stg.apply"), english("stg.discard")]);
      const boxes = await buttons.evaluateAll((items) => items.map((item) => item.getBoundingClientRect().toJSON()));
      expect(new Set(boxes.map((rect) => Math.round(rect.top))).size).toBe(1);
      expect(Math.round(boxes[1].left - boxes[0].right)).toBe(8);
      const bannerBox = await banner.boundingBox();
      expect(Math.round((bannerBox?.x ?? 0) + (bannerBox?.width ?? 0) - boxes[2].right)).toBeLessThanOrEqual(16);
    },
    TIMEOUT_MS,
  );

  test(
    "detaching a mount stages it, the banner counts both fields, and undo takes the mount back",
    async () => {
      const box = (await rest<{ box: BoxRow }>("POST", "/api/boxes", { name: "mountbox", cpus: 1, memoryMb: 256 })).box;
      await rest("PUT", `/api/boxes/${encodeURIComponent(box.boxId)}/staged`, { profile: "strict" });
      await page.goto(settingsUrl(box, "storage"));
      const banner = page.locator("#bsStaged .staged-banner");
      await webExpect(banner).toContainText(english("stg.banner", { n: 1 }));

      const detachable = box.mounts.find((mount) => mount.volumeId)?.path ?? "";
      await page.locator(`[data-action='detach-mount'][data-path='${detachable}']`).click();

      const row = page.locator("tr[data-pending='remove']");
      await webExpect(row).toContainText(english("stg.pendingRemove"));
      await webExpect(banner).toContainText(english("stg.banner", { n: 2 }));
      expect((await stagedNow(box.boxId))?.pending).toEqual(["mounts", "profile"]);

      await row.locator("[data-action='restore-mount']").click();
      await webExpect(page.locator("tr[data-pending]")).toHaveCount(0);
      await webExpect(banner).toContainText(english("stg.banner", { n: 1 }));
      expect((await stagedNow(box.boxId))?.pending).toEqual(["profile"]);
      expect((await boxNow(box.boxId)).mounts.length).toBe(box.mounts.length);
    },
    TIMEOUT_MS,
  );

  test(
    "view diff, then apply: the dialog shows the changes, sessions, writable layer and volumes, and the box is rebuilt with a checkpoint",
    async () => {
      const box = (await rest<{ box: BoxRow }>("POST", "/api/boxes", { name: "applybox", cpus: 1, memoryMb: 256 })).box;
      await rest("PUT", `/api/boxes/${encodeURIComponent(box.boxId)}/staged`, { profile: "strict" });
      await page.goto(settingsUrl(box, "security"));

      await page.locator("[data-staged='diff']").click();
      const diff = page.locator(".dialog", { hasText: english("stg.diffDialogTitle") });
      await webExpect(diff.locator(".staged-changes")).toContainText("strict");
      await diff.locator("[data-staged-next]").click();

      const confirm = page.locator(".dialog", { hasText: english("stg.confirmTitle", { name: box.name }) });
      await webExpect(confirm).toBeVisible();
      await webExpect(confirm.locator(".staged-changes").first()).toContainText("standard → strict");
      await webExpect(confirm.locator("[data-staged-sessions]")).toBeVisible();
      await webExpect(confirm).toContainText(english("stg.volumesKept"));
      await webExpect(confirm.locator("#stgDiffBody")).toBeHidden();
      await confirm.locator("#stgDiffToggle").click();
      await webExpect(confirm.locator("#stgDiffBody")).toBeVisible();
      const checkpoint = confirm.locator("#cfm-check-checkpoint");
      await webExpect(checkpoint).toBeChecked();
      await webExpect(confirm).toContainText(english("stg.checkpoint"));
      await confirm.locator("#cfm-ok").click();

      await webExpect(page.locator("#bsStaged")).toBeHidden();
      const after = await boxNow(box.boxId);
      expect(after).toMatchObject({ profile: "strict", revision: box.revision + 1 });
      await webExpect(page).toHaveURL(
        (url) => url.hash === `#/boxes/${encodeURIComponent(after.id)}/settings/security`,
      );
      expect(await stagedNow(box.boxId)).toBeNull();
      const { checkpoints } = await rest<{ checkpoints: { boxId: string; label: string; system: unknown }[] }>(
        "GET",
        "/api/checkpoints",
      );
      const taken = checkpoints.filter((item) => item.boxId === box.boxId);
      expect(taken).toHaveLength(1);
      expect(taken[0]).toMatchObject({ label: "Before rebuild" });
      expect(taken[0]?.system).not.toBeNull();
    },
    TIMEOUT_MS,
  );

  test(
    "the apply button says the rebuild is running and cannot start a second one, and a failure brings it back",
    async () => {
      const box = (await rest<{ box: BoxRow }>("POST", "/api/boxes", { name: "busybox", cpus: 1, memoryMb: 256 })).box;
      await rest("PUT", `/api/boxes/${encodeURIComponent(box.boxId)}/staged`, { profile: "strict" });
      await page.goto(settingsUrl(box, "security"));

      // The apply is held open, so the page can be looked at while the rebuild would be running on the server.
      const applies: string[] = [];
      const held = Promise.withResolvers<void>();
      await page.route("**/staged/apply", async (route) => {
        applies.push(route.request().method());
        await held.promise;
        await route.fulfill({
          status: 412,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "revision_conflict", message: "The box changed since the preview." } }),
        });
      });

      await page.locator("[data-staged='apply']").click();
      await page.locator(".dialog #cfm-ok").click();

      const apply = page.locator("[data-staged='apply']");
      await webExpect(apply).toBeDisabled();
      await webExpect(apply).toHaveAttribute("aria-busy", "true");
      await webExpect(apply.locator(".spinner")).toHaveCount(1);
      await webExpect(apply).toHaveText(english("stg.applying"));

      // A second press, forced past the disabled state and then dispatched on it, starts nothing: no request, no dialog.
      await apply.click({ force: true });
      await apply.dispatchEvent("click");
      await page.waitForTimeout(300);
      expect(applies).toEqual(["POST"]);
      await webExpect(page.locator("#cfm-ok")).toHaveCount(0);

      held.resolve();
      await webExpect(apply).toBeEnabled();
      await webExpect(apply).not.toHaveAttribute("aria-busy", "true");
      await webExpect(apply).toHaveText(english("stg.apply"));
      // The banner still shows the staged changes the refused apply left in place.
      await webExpect(page.locator("#bsStaged .staged-banner")).toContainText(english("stg.banner", { n: 1 }));
      expect((await stagedNow(box.boxId))?.pending).toEqual(["profile"]);
      await page.unroute("**/staged/apply");
    },
    TIMEOUT_MS,
  );

  test(
    "discard drops the staged changes after a confirm and leaves the box alone",
    async () => {
      const box = (await rest<{ box: BoxRow }>("POST", "/api/boxes", { name: "dropbox", cpus: 1, memoryMb: 256 })).box;
      await rest("PUT", `/api/boxes/${encodeURIComponent(box.boxId)}/staged`, { profile: "strict" });
      await page.goto(settingsUrl(box, "resources"));

      await page.locator("[data-staged='discard']").click();
      await page.locator(".dialog #cfm-ok").click();

      await webExpect(page.locator("#bsStaged")).toBeHidden();
      expect(await stagedNow(box.boxId)).toBeNull();
      expect(await boxNow(box.boxId)).toMatchObject({ profile: "standard", revision: box.revision });
    },
    TIMEOUT_MS,
  );
});
