import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type Browser, type BrowserContext, chromium, expect as webExpect, type Page } from "@playwright/test";

import type { App } from "../src/app";
import { startServer } from "../src/server";
import * as boxes from "../src/services/boxes";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";

const executablePath = chromiumFor("The narrow phone layout test");

const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const TIMEOUT_MS = 30_000;
/** The narrowest phone the console claims: a 320pt iPhone SE in portrait. */
const NARROW = { width: 320, height: 720 };
const WIDE_PHONE = { width: 390, height: 844 };

/**
 * What each page needs to keep on a narrow phone: the window itself never scrolls sideways, the icons in the top bar
 * stay inside it, and a box's title bar keeps every button on one row.
 */
async function layoutOf(page: Page) {
  return page.evaluate(() => {
    interface El {
      getBoundingClientRect(): { top: number; left: number; right: number; width: number };
      getAttribute(name: string): string | null;
      textContent: string | null;
      scrollWidth: number;
      clientWidth: number;
    }
    /** The elements a selector names, as a plain array: a browser's list has no `map` or `filter` of its own. */
    const all = (selector: string): El[] => {
      const found: El[] = [];
      for (const el of view.document.querySelectorAll(selector) as unknown as Iterable<El>) found.push(el);
      return found;
    };
    const view = globalThis as unknown as {
      document: {
        documentElement: { scrollWidth: number; clientWidth: number };
        querySelector(selector: string): El | null;
        querySelectorAll(selector: string): unknown;
      };
      getComputedStyle(el: El): { fontSize: string };
    };
    const root = view.document.documentElement;
    const width = root.clientWidth;
    const inside = (el: El) => {
      const r = el.getBoundingClientRect();
      return r.width === 0 || (r.left >= -0.5 && r.right <= width + 0.5);
    };
    const icons = all(".topbar .icon-btn").filter((el) => el.getBoundingClientRect().width > 0);
    const trail = view.document.querySelector(".topbar .crumbs");
    const buttons = all(".detail-head .page-actions > .btn");
    const rows = new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top)));
    return {
      scrollWidth: root.scrollWidth,
      clientWidth: width,
      iconsInside: icons.map((el) => inside(el)),
      trailInside: trail ? inside(trail) : null,
      trailClipped: trail ? trail.scrollWidth >= trail.clientWidth : null,
      buttons: buttons.length,
      buttonRows: rows.size,
      buttonsInside: buttons.map((b) => inside(b)),
      // Each button's text stays its accessible name, even when the label itself is hidden.
      buttonsNamed: buttons.map((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").trim() !== ""),
      firstButtonLabelShown: buttons[0] ? Number.parseFloat(view.getComputedStyle(buttons[0]).fontSize) > 0 : null,
    };
  });
}

describe.skipIf(!executablePath)("the console on a narrow phone (real browser)", () => {
  let app: App | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page;
  let consoleUrl = "";
  let running = "";

  beforeAll(async () => {
    const harness = createTestApp();
    app = harness.app;
    const host = app.hosts.get();
    harness.runtime.seedImage(app.cfg.baseTemplateTag, {
      [host.keys.template]: "true",
      [host.keys.templateName]: "base",
    });
    server = startServer(app);
    consoleUrl = `http://127.0.0.1:${server.port}`;
    // A name long enough that the trail would push the top bar's icons off a 320px window if it did not clip.
    const box = await boxes.createBox(host, {
      name: "a-very-long-box-name-for-the-crumbs",
      cpus: 1,
      memoryMb: 512,
      createdBy: "owner",
    });
    running = box.boxId;

    browser = await chromium.launch({ executablePath: executablePath ?? undefined, args: ["--no-sandbox"] });
    context = await browser.newContext({ viewport: NARROW });
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
    "the window never scrolls sideways, whatever the page and however long the box's name is",
    async () => {
      for (const path of [
        `/boxes/${running}`,
        `/boxes/${running}/terminal`,
        `/boxes/${running}/files`,
        `/boxes/${running}/ports`,
        `/boxes/${running}/settings/general`,
        `/boxes/${running}/settings/security`,
        "/boxes",
        "/overview",
        "/activity",
        "/storage/volumes",
        "/storage/checkpoints",
        "/library/templates",
        "/settings/general",
        "/trash",
        "/about",
      ]) {
        await page.goto(`${consoleUrl}/#${path}`);
        await page.waitForTimeout(700);
        const layout = await layoutOf(page);
        if (layout.scrollWidth !== layout.clientWidth) {
          const spills = await page.evaluate(() => {
            interface El {
              getBoundingClientRect(): { left: number; right: number; width: number };
              tagName: string;
              className: string;
              textContent: string | null;
            }
            const view = globalThis as unknown as {
              document: { documentElement: { clientWidth: number }; querySelectorAll(selector: string): unknown };
            };
            const width = view.document.documentElement.clientWidth;
            const found: El[] = [];
            for (const el of view.document.querySelectorAll("body *") as unknown as Iterable<El>) found.push(el);
            return found
              .filter((el) => {
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.right > width + 0.5;
              })
              .map((el) => {
                const r = el.getBoundingClientRect();
                return `${el.tagName}.${(el.className || "").toString().slice(0, 40)} ${Math.round(r.left)}-${Math.round(r.right)} ${(el.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 40)}`;
              })
              .slice(0, 8);
          });
          throw new Error(`${path} spills: ${JSON.stringify(spills)}`);
        }
        expect([path, layout.scrollWidth]).toEqual([path, layout.clientWidth]);
      }
    },
    TIMEOUT_MS,
  );

  test(
    "the top bar keeps its icons on the window, and the trail gives way with an ellipsis instead of pushing them off",
    async () => {
      await page.goto(`${consoleUrl}/#/boxes/${running}/terminal`);
      await page.waitForTimeout(700);
      const layout = await layoutOf(page);
      expect(layout.iconsInside.length).toBeGreaterThan(0);
      expect(layout.iconsInside.every(Boolean)).toBe(true);
      expect(layout.trailInside).toBe(true);
      // The name is too long for the room left, so it is clipped rather than laid out past the window.
      expect(layout.trailClipped).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    "a box's title bar keeps all seven buttons on one row at 320px, each one still named for a screen reader",
    async () => {
      await page.goto(`${consoleUrl}/#/boxes/${running}`);
      await page.waitForTimeout(700);
      const layout = await layoutOf(page);
      expect(layout.buttons).toBe(7);
      expect(layout.buttonRows).toBe(1);
      expect(layout.buttonsInside.every(Boolean)).toBe(true);
      expect(layout.buttonsNamed.every(Boolean)).toBe(true);
      // Below 353px even the first button is an icon, since a labelled one would not fit beside the other six.
      expect(layout.firstButtonLabelShown).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    "the Security section's three editors fit a 320px window, even with a profile's long hint",
    async () => {
      await page.goto(`${consoleUrl}/#/boxes/${running}/settings/security`);
      await page.waitForTimeout(700);
      const width = await page.evaluate(
        () =>
          (globalThis as unknown as { document: { documentElement: { clientWidth: number } } }).document.documentElement
            .clientWidth,
      );
      /** The elements of the section that stick out past the window, and how far. */
      const spills = () =>
        page.evaluate((limit) => {
          interface El {
            getBoundingClientRect(): { right: number };
            tagName: string;
            className: string;
          }
          const found: string[] = [];
          const view = globalThis as unknown as { document: { querySelectorAll(selector: string): unknown } };
          for (const el of view.document.querySelectorAll("#bsPanel *") as unknown as Iterable<El>) {
            const right = el.getBoundingClientRect().right;
            if (right > limit + 0.5) found.push(`${el.tagName}.${el.className} ${Math.round(right)}`);
          }
          return found;
        }, width);

      expect(await spills()).toEqual([]);
      // The profile row names three profiles with a hint each, the widest thing the section draws.
      await page.locator("#bsSecurity [data-profile-action='edit']").click();
      await webExpect(page.locator("#bsSecurity [data-profile-choice='relaxed']")).toBeVisible();
      expect(await spills()).toEqual([]);

      await page.locator("#bsSecurity [data-profile-action='cancel']").click();
      await page.locator("#bsEgress [data-egress-action='edit']").click();
      await page.locator("#bsEgress [data-egress-tier='proxy-only']").click();
      await webExpect(page.locator("#bsEgress [data-egress-proxy]")).toBeVisible();
      expect(await spills()).toEqual([]);

      await page.locator("#bsEgress [data-egress-action='cancel']").click();
      await page.locator("#bsTemplate [data-template-action='edit']").click();
      await webExpect(page.locator("#bsTemplate #bsTemplateRef")).toBeVisible();
      expect(await spills()).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    "a 390px phone keeps the word on the first button, and every button still fits one row",
    async () => {
      try {
        await page.setViewportSize(WIDE_PHONE);
        await page.goto(`${consoleUrl}/#/boxes/${running}`);
        await page.waitForTimeout(700);
        const layout = await layoutOf(page);
        expect(layout.scrollWidth).toBe(layout.clientWidth);
        expect(layout.buttonRows).toBe(1);
        expect(layout.buttonsInside.every(Boolean)).toBe(true);
        expect(layout.firstButtonLabelShown).toBe(true);
        await webExpect(page.locator(".detail-head .page-actions > .btn").first()).toHaveText(/Stop/);
      } finally {
        await page.setViewportSize(NARROW);
      }
    },
    TIMEOUT_MS,
  );
});
