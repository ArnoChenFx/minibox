import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type Browser, type BrowserContext, chromium, expect as webExpect, type Page } from "@playwright/test";

import type { App } from "../src/app";
import { startServer } from "../src/server";
import { saveTemplateDraft } from "../src/services/template-builds";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";
import type { FakeRuntime } from "./support/fake-runtime";

const executablePath = chromiumFor("The template draft test");

const TIMEOUT_MS = 30_000;
const DESKTOP = { width: 1024, height: 800 };
const PHONE = { width: 390, height: 844 };
const FROM_ALPINE = "FROM alpine:3.20\nRUN true\n";

const restoreLogs = silenceLogs();
afterAll(restoreLogs);

/** A box on the page, in page coordinates, so a test can say two buttons overlap or stick out. */
interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

const overlap = (a: Box, b: Box): boolean =>
  a.width > 0 &&
  a.height > 0 &&
  b.width > 0 &&
  b.height > 0 &&
  a.left < b.right &&
  b.left < a.right &&
  a.top < b.bottom &&
  b.top < a.bottom;

/** The bounding boxes of the buttons inside `selector`, as the page draws them. */
async function boxes(on: Page, selector: string): Promise<Box[]> {
  return on.evaluate((where) => {
    interface El {
      getBoundingClientRect(): Box;
    }
    interface Doc {
      querySelectorAll(selector: string): El[];
    }
    const view = globalThis as unknown as { document: Doc };
    const found: Box[] = [];
    for (const node of view.document.querySelectorAll(where)) {
      const box = node.getBoundingClientRect();
      found.push({
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
      });
    }
    return found;
  }, selector);
}

describe.skipIf(!executablePath)("saving a template without building it (real browser)", () => {
  let app: App | undefined;
  let runtime: FakeRuntime;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser;
  let context: BrowserContext | undefined;
  let page: Page;
  let consoleUrl = "";
  /** The API paths the page asked for, in order, so a test can say a save did not build. */
  const sent: { method: string; path: string }[] = [];

  beforeAll(async () => {
    const harness = createTestApp();
    app = harness.app;
    runtime = harness.runtime;
    const host = app.hosts.get();
    harness.runtime.seedImage(app.cfg.baseTemplateTag, {
      [host.keys.template]: "true",
      [host.keys.templateName]: "base",
    });
    // Two drafts the page did not make: one to edit and delete, one for the layout checks in every language and width.
    saveTemplateDraft(host, {
      name: "edit-draft",
      description: "Edit me",
      source: { kind: "dockerfile", text: FROM_ALPINE },
      createdBy: "owner",
    });
    saveTemplateDraft(host, {
      name: "layout-draft",
      description: "A saved template whose description is long enough to wrap on a phone",
      source: { kind: "dockerfile", text: FROM_ALPINE },
      createdBy: "owner",
    });
    server = startServer(app);
    consoleUrl = `http://127.0.0.1:${server.port}`;

    browser = await chromium.launch({ executablePath: executablePath ?? undefined, args: ["--no-sandbox"] });
    context = await browser.newContext({ viewport: DESKTOP });
    const login = await context.request.post(`${consoleUrl}/api/auth/login`, {
      data: { key: TEST_KEY },
      headers: { origin: consoleUrl },
    });
    expect(login.status()).toBe(200);
    page = await context.newPage();
    page.on("request", (request) => {
      if (!request.url().includes("/api/")) return;
      sent.push({ method: request.method(), path: new URL(request.url()).pathname });
    });
    await page.goto(`${consoleUrl}/#/library/templates`);
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

  const card = (name: string) => page.locator(`#tpGrid [data-name="${name}"]`);
  const dialog = () => page.getByRole("dialog");

  test(
    "the create dialog offers Save beside Build, and Save stores the source without a build",
    async () => {
      await webExpect(card("layout-draft")).toBeVisible();
      await page.locator('[data-action="new-template"]').click();
      await webExpect(dialog()).toBeVisible();
      // Both actions sit in the dialog footer, and the build is still the primary one.
      const save = dialog().getByRole("button", { name: "Save", exact: true });
      const build = dialog().getByRole("button", { name: "Build template" });
      await webExpect(save).toBeVisible();
      await webExpect(build).toHaveClass(/btn-primary/);
      await webExpect(dialog()).toContainText("or save the source to build later");

      sent.length = 0;
      await dialog().locator("#tnName").fill("saved-tool");
      await dialog().locator("#tnDockerfile").fill(FROM_ALPINE);
      await save.click();

      await webExpect(dialog()).toHaveCount(0);
      await webExpect(page.locator("#toasts")).toContainText("Template saved, not built");
      // The save went to the draft route alone, so nothing was queued to build.
      expect(sent.filter((request) => request.method === "POST").map((request) => request.path)).toEqual([
        "/api/templates/drafts",
      ]);

      await webExpect(card("saved-tool")).toBeVisible();
      await webExpect(card("saved-tool")).toContainText("Not built");
      await webExpect(card("saved-tool")).toContainText("Saved but not built yet");
      await webExpect(card("saved-tool").getByRole("button", { name: "Build", exact: true })).toBeVisible();
      await webExpect(card("saved-tool").getByRole("button", { name: "Edit", exact: true })).toBeVisible();
      // A draft cannot start a box, so the card offers no Create from this.
      await webExpect(card("saved-tool").getByRole("button", { name: "Create from this" })).toHaveCount(0);
      expect(runtime.builds).toHaveLength(0);
    },
    TIMEOUT_MS,
  );

  test(
    "editing a draft changes the recipe without building it",
    async () => {
      const builds = runtime.builds.length;
      await card("edit-draft").getByRole("button", { name: "Edit", exact: true }).click();
      await webExpect(dialog()).toBeVisible();
      await webExpect(dialog().locator("#teDockerfile")).toHaveValue(FROM_ALPINE);
      await dialog().locator("#teDesc").fill("Edited draft");
      await dialog().getByRole("button", { name: "Save changes" }).click();

      await webExpect(dialog()).toHaveCount(0);
      await webExpect(page.locator("#toasts")).toContainText("Template updated");
      await webExpect(card("edit-draft")).toContainText("Edited draft");
      // Saving a draft only writes the recipe: no build ran, and the card still says it is not built.
      expect(runtime.builds.length).toBe(builds);
      await webExpect(card("edit-draft")).toContainText("Not built");
      const drafts = await callDrafts();
      expect(drafts.find((draft) => draft.name === "edit-draft")?.description).toBe("Edited draft");
    },
    TIMEOUT_MS,
  );

  test(
    "deleting a draft removes its card and keeps every image",
    async () => {
      const removed = runtime.callsTo("removeImage").length ?? 0;
      await card("edit-draft").getByRole("button", { name: "Delete template" }).click();
      await webExpect(dialog()).toContainText("It was never built, so no image is removed.");
      await dialog().getByRole("button", { name: "Delete template" }).click();

      await webExpect(card("edit-draft")).toHaveCount(0);
      await webExpect(page.locator("#toasts")).toContainText("Template deleted");
      expect(runtime.callsTo("removeImage").length).toBe(removed);
      expect((await callDrafts()).map((draft) => draft.name)).not.toContain("edit-draft");
    },
    TIMEOUT_MS,
  );

  test(
    "the card's Build button builds the draft, and the card becomes a normal template",
    async () => {
      await card("saved-tool").getByRole("button", { name: "Build", exact: true }).click();
      await webExpect(page.locator("#toasts")).toContainText("Building template");
      // The task ends and the page reloads, so the card now offers Rebuild and no longer says Not built.
      await webExpect(card("saved-tool").getByRole("button", { name: "Rebuild", exact: true })).toBeVisible({
        timeout: TIMEOUT_MS,
      });
      await webExpect(card("saved-tool")).toContainText("Custom");
      await webExpect(card("saved-tool")).not.toContainText("Not built");
      expect(runtime.builds.map((build) => build.tag)).toContain("mbtest-template:saved-tool");
      const drafts = await callDrafts();
      expect(drafts.map((draft) => draft.name)).not.toContain("saved-tool");
    },
    TIMEOUT_MS,
  );

  /** The drafts the server holds, read through the page's own session. */
  async function callDrafts(): Promise<{ name: string; description: string | null }[]> {
    const res = await page.request.get(`${consoleUrl}/api/templates/drafts`);
    expect(res.status()).toBe(200);
    return ((await res.json()) as { templates: { name: string; description: string | null }[] }).templates;
  }

  test(
    "the draft card and the create dialog hold at 1024 and 390, in English and Chinese",
    async () => {
      for (const locale of ["en", "zh-CN"] as const) {
        for (const viewport of [DESKTOP, PHONE]) {
          const fresh = await browser.newContext({ viewport, locale });
          try {
            const login = await fresh.request.post(`${consoleUrl}/api/auth/login`, {
              data: { key: TEST_KEY },
              headers: { origin: consoleUrl },
            });
            expect(login.status()).toBe(200);
            const wide = await fresh.newPage();
            await wide.goto(`${consoleUrl}/#/library/templates`);
            await webExpect(wide.locator('#tpGrid [data-name="layout-draft"]')).toBeVisible();

            // The page itself does not scroll sideways, and the card's actions stay inside the window.
            const pageWidth = await wide.evaluate(() => {
              const view = globalThis as unknown as {
                document: { documentElement: { scrollWidth: number } };
                innerWidth: number;
              };
              return { scroll: view.document.documentElement.scrollWidth, window: view.innerWidth };
            });
            expect([locale, viewport.width, pageWidth.scroll <= pageWidth.window]).toEqual([
              locale,
              viewport.width,
              true,
            ]);
            const cardButtons = await boxes(wide, '#tpGrid [data-name="layout-draft"] .actions button');
            expect([locale, viewport.width, cardButtons.length]).toEqual([locale, viewport.width, 2]);
            for (const box of cardButtons) {
              expect([locale, viewport.width, box.left >= 0, box.right <= viewport.width + 0.5]).toEqual([
                locale,
                viewport.width,
                true,
                true,
              ]);
            }
            expect([locale, viewport.width, overlap(cardButtons[0]!, cardButtons[1]!)]).toEqual([
              locale,
              viewport.width,
              false,
            ]);

            // The create dialog's three actions stay inside the window and never overlap.
            await wide.locator('[data-action="new-template"]').click();
            const footer = wide.getByRole("dialog").locator(".dialog-foot");
            await webExpect(footer).toBeVisible();
            const dialogButtons = await boxes(wide, '[role="dialog"] .dialog-foot button');
            expect([locale, viewport.width, dialogButtons.length]).toEqual([locale, viewport.width, 3]);
            for (const box of dialogButtons) {
              expect([locale, viewport.width, box.left >= 0, box.right <= viewport.width + 0.5]).toEqual([
                locale,
                viewport.width,
                true,
                true,
              ]);
            }
            for (let i = 0; i < dialogButtons.length; i++)
              for (let j = i + 1; j < dialogButtons.length; j++)
                expect([locale, viewport.width, i, j, overlap(dialogButtons[i]!, dialogButtons[j]!)]).toEqual([
                  locale,
                  viewport.width,
                  i,
                  j,
                  false,
                ]);
          } finally {
            await fresh.close();
          }
        }
      }
    },
    TIMEOUT_MS * 2,
  );
});
