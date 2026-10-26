import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  chromium,
  expect as webExpect,
  type Page,
} from "@playwright/test";

import type { App } from "../src/app";
import { startServer } from "../src/server";
import * as boxes from "../src/services/boxes";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";

const executablePath = chromiumFor("The bottom tab bar test");

const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const TIMEOUT_MS = 30_000;
const PHONE = { width: 390, height: 844 };
const TABLET = { width: 768, height: 1024 };
const DESKTOP = { width: 1280, height: 800 };

/** An element as these measurements touch it. The page's own globals are not in this project's tsconfig. */
interface El {
  getBoundingClientRect(): { top: number; left: number; right: number; bottom: number; width: number; height: number };
  getAttribute(name: string): string | null;
  dataset: Record<string, string>;
  textContent: string | null;
}

/** The tab the bar marks as the current page, or null when it marks none. */
const currentTab = (page: Page): Promise<string | null> =>
  page.evaluate(() => {
    const view = globalThis as unknown as {
      document: {
        querySelector(
          selector: string,
        ): { getAttribute(name: string): string | null; dataset: Record<string, string> } | null;
      };
    };
    return view.document.querySelector("#tabbar [aria-current='page']")?.dataset.tab ?? null;
  });

/**
 * What a page shows about the bar: where it sits, whether the page scrolls sideways, and where the last thing in the
 * page ends once the page is scrolled to its bottom.
 */
async function measure(page: Page) {
  // A page fills in its rows after it renders, which makes it taller than where it was scrolled. Wait until the height
  // holds still for a few polls, then scroll to the bottom and wait until the position holds still too, so the
  // measurement is of the finished page.
  await page.waitForFunction(
    () => {
      const view = globalThis as unknown as {
        document: { documentElement: { scrollHeight: number } };
        measureState?: { height: number; count: number };
      };
      const height = view.document.documentElement.scrollHeight;
      const seen = (view.measureState ??= { height, count: 0 });
      seen.count = seen.height === height ? seen.count + 1 : 0;
      seen.height = height;
      return seen.count >= 4;
    },
    undefined,
    { timeout: 10_000, polling: 150 },
  );
  await page.evaluate(() => (globalThis as unknown as { scrollTo(x: number, y: number): void }).scrollTo(0, 1e6));
  await page.waitForFunction(
    () => {
      const view = globalThis as unknown as {
        document: { documentElement: { scrollHeight: number } };
        scrollY: number;
        innerHeight: number;
        measureAt?: { y: number; count: number };
      };
      const y = view.scrollY;
      const seen = (view.measureAt ??= { y, count: 0 });
      seen.count = seen.y === y ? seen.count + 1 : 0;
      seen.y = y;
      return seen.count >= 3 && Math.abs(y + view.innerHeight - view.document.documentElement.scrollHeight) <= 2;
    },
    undefined,
    { timeout: 10_000, polling: 150 },
  );
  return page.evaluate(() => {
    interface Node {
      getBoundingClientRect(): {
        top: number;
        left: number;
        right: number;
        bottom: number;
        width: number;
        height: number;
      };
      querySelectorAll(selector: string): Node[];
      scrollWidth: number;
      clientWidth: number;
      scrollHeight: number;
    }
    const view = globalThis as unknown as {
      document: Node & { querySelector(selector: string): Node | null; documentElement: Node };
      getComputedStyle(element: Node): { display: string; paddingBottom: string; position: string };
      innerWidth: number;
      innerHeight: number;
      scrollY: number;
    };
    const doc = view.document;
    const bar = doc.querySelector("#tabbar")!;
    const barStyle = view.getComputedStyle(bar);
    const barBox = bar.getBoundingClientRect();
    // The last element the page draws: the deepest box with a size, which is what a reader scrolls to.
    const drawn = [...doc.querySelectorAll("#view *")]
      .map((node) => node.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.height > 0);
    const lastBottom = Math.max(0, ...drawn.map((box) => box.bottom));
    const content = doc.querySelector("#view")!;
    return {
      bar: {
        display: barStyle.display,
        top: Math.round(barBox.top),
        height: Math.round(barBox.height),
        width: Math.round(barBox.width),
      },
      contentPaddingBottom: view.getComputedStyle(content).paddingBottom,
      viewport: { width: view.innerWidth, height: view.innerHeight },
      fits: {
        page: doc.documentElement.scrollWidth <= doc.documentElement.clientWidth,
        content: content.scrollWidth <= content.clientWidth,
      },
      lastBottom: Math.round(lastBottom),
      scrollY: Math.round(view.scrollY),
      height: doc.documentElement.scrollHeight,
      // How much clear space the page keeps under its last element, before the bar starts.
      gap: Math.round(barBox.top - lastBottom),
    };
  });
}

describe.skipIf(!executablePath)("the bottom tab bar (real browser)", () => {
  let app: App | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page;
  let consoleUrl = "";
  let alpha = "";

  async function signedIn(options: BrowserContextOptions = {}): Promise<BrowserContext> {
    const fresh = await browser!.newContext(options);
    const login = await fresh.request.post(`${consoleUrl}/api/auth/login`, {
      data: { key: TEST_KEY },
      headers: { origin: consoleUrl },
    });
    expect(login.status()).toBe(200);
    return fresh;
  }

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
    const first = await boxes.createBox(host, { name: "alpha", cpus: 1, memoryMb: 512, createdBy: "owner" });
    alpha = first.boxId;
    await boxes.createBox(host, { name: "beta", cpus: 1, memoryMb: 512, createdBy: "owner" });

    browser = await chromium.launch({ executablePath: executablePath ?? undefined, args: ["--no-sandbox"] });
    context = await signedIn({ viewport: PHONE });
    page = await context.newPage();
    await page.goto(`${consoleUrl}/#/overview`);
    await webExpect(page.locator("#tabbar")).toBeVisible();
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

  describe("on a 390x844 phone", () => {
    test(
      "the bar sits at the bottom of the window with the four entries, and the menu button is gone",
      async () => {
        const bar = await page.locator("#tabbar").boundingBox();
        if (!bar) throw new Error("the bar has no layout box");
        expect(Math.round(bar.y + bar.height)).toBe(PHONE.height);
        expect(Math.round(bar.width)).toBe(PHONE.width);
        await webExpect(page.locator("#tabbar [data-tab]")).toHaveCount(4);
        await webExpect(page.locator("#tabbar > a > span[data-i18n]")).toHaveText(["Overview", "Boxes", "Activity"]);
        await webExpect(page.locator("#moreBtn > span[data-i18n]")).toHaveText("More");
        await webExpect(page.locator("#menuBtn")).toBeHidden();
        await webExpect(page.locator("#tabbar [aria-current='page']")).toHaveAttribute("data-tab", "overview");
      },
      TIMEOUT_MS,
    );

    test(
      "Boxes opens #/boxes, and the bar and the sidebar both mark it",
      async () => {
        await page.locator('#tabbar [data-tab="boxes"]').click();
        await webExpect(page).toHaveURL((url) => url.hash === "#/boxes");
        await webExpect(page.locator("#view h1").first()).toHaveText("Boxes");
        expect(await currentTab(page)).toBe("boxes");
        await webExpect(page.locator(".sidebar [aria-current='page']")).toHaveAttribute("data-nav", "boxes");
        // The bar's current entry is drawn in the accent colour, as the sidebar's is.
        const colour = await page.evaluate(() => {
          const view = globalThis as unknown as {
            document: { querySelector(selector: string): El | null };
            getComputedStyle(element: El): { color: string };
          };
          const tab = view.document.querySelector("#tabbar [data-tab='boxes']")!;
          const other = view.document.querySelector("#tabbar [data-tab='overview']")!;
          return [view.getComputedStyle(tab).color, view.getComputedStyle(other).color];
        });
        expect(colour[0]).not.toBe(colour[1]);
      },
      TIMEOUT_MS,
    );

    test(
      "More opens the sidebar drawer in place, and aria-expanded says so",
      async () => {
        await page.locator("#moreBtn").click();
        await webExpect(page.locator("#moreBtn")).toHaveAttribute("aria-expanded", "true");
        await webExpect(page.locator("#sidebar")).toBeInViewport();
        await webExpect(page.locator("#navScrim")).toBeVisible();
        // The drawer slides in over 0.2s; measure it once it has arrived.
        await page.waitForFunction(() => {
          const view = globalThis as unknown as { document: { querySelector(selector: string): El | null } };
          const sidebar = view.document.querySelector("#sidebar");
          return sidebar !== null && Math.round(sidebar.getBoundingClientRect().left) === 0;
        });
        const drawer = await page.locator("#sidebar").boundingBox();
        if (!drawer) throw new Error("the drawer has no layout box");
        // A hair off zero from the slide's own rounding, which Math.round() would report as -0.
        expect(Math.abs(drawer.x)).toBeLessThan(1);
        expect(drawer.width).toBeGreaterThan(200);
        // Opening the drawer keeps the page where it was; the bar itself does not navigate.
        await webExpect(page).toHaveURL((url) => url.hash === "#/boxes");
      },
      TIMEOUT_MS,
    );

    test(
      "choosing an entry in the drawer closes it, and More stays the current tab on pages of its own",
      async () => {
        await page.locator('.sidebar a[data-nav="storage"]').click();
        await webExpect(page).toHaveURL((url) => url.hash === "#/storage/volumes");
        await webExpect(page.locator("#moreBtn")).toHaveAttribute("aria-expanded", "false");
        await webExpect(page.locator("#navScrim")).toBeHidden();
        expect(await currentTab(page)).toBe("more");

        for (const [hash, nav] of [
          ["#/library/templates", "library"],
          ["#/settings", "settings"],
          ["#/about", "about"],
        ] as const) {
          await page.goto(`${consoleUrl}/${hash}`);
          await webExpect(page.locator(".sidebar [aria-current='page']")).toHaveAttribute("data-nav", nav);
          expect([hash, await currentTab(page)]).toEqual([hash, "more"]);
        }
      },
      TIMEOUT_MS,
    );

    test(
      "the open drawer ends above the bar, so all four entries stay reachable and none opens About by mistake",
      async () => {
        await page.goto(`${consoleUrl}/#/settings`);
        await webExpect(page.locator("#view h1").first()).toBeVisible();
        await page.locator("#moreBtn").click();
        await webExpect(page.locator("#moreBtn")).toHaveAttribute("aria-expanded", "true");
        await page.waitForFunction(() => {
          const view = globalThis as unknown as { document: { querySelector(selector: string): El | null } };
          const sidebar = view.document.querySelector("#sidebar");
          return sidebar !== null && Math.round(sidebar.getBoundingClientRect().left) === 0;
        });
        // A fixed drawer runs the full height of the window and covers the bar's left half; ending it above the bar is
        // what keeps Overview and Boxes pressable. What is on top at each entry's centre says which one it is.
        const hits = await page.evaluate(() => {
          const view = globalThis as unknown as {
            document: {
              querySelectorAll(selector: string): El[];
              querySelector(selector: string): El | null;
              elementFromPoint(x: number, y: number): (El & { closest(selector: string): unknown }) | null;
            };
            innerHeight: number;
          };
          const doc = view.document;
          const bar = doc.querySelector("#tabbar")!;
          const drawer = doc.querySelector("#sidebar")!;
          return {
            drawerBottom: Math.round(drawer.getBoundingClientRect().bottom),
            barTop: Math.round(bar.getBoundingClientRect().top),
            onTop: [...doc.querySelectorAll("#tabbar [data-tab]")].map((entry) => {
              const rect = entry.getBoundingClientRect();
              const hit = doc.elementFromPoint(
                Math.round(rect.left + rect.width / 2),
                Math.round(rect.top + rect.height / 2),
              );
              return [entry.dataset.tab, hit === entry || Boolean(hit?.closest("#tabbar"))];
            }),
          };
        });
        expect(hits.drawerBottom).toBeLessThanOrEqual(hits.barTop);
        expect(hits.onTop).toEqual([
          ["overview", true],
          ["boxes", true],
          ["activity", true],
          ["more", true],
        ]);
        // Pressing Boxes while the drawer is open goes to Boxes, not to the drawer's own foot.
        await page.locator('#tabbar [data-tab="boxes"]').click();
        await webExpect(page).toHaveURL((url) => url.hash === "#/boxes");
        await webExpect(page.locator("#view h1").first()).toHaveText("Boxes");
        await webExpect(page.locator("#moreBtn")).toHaveAttribute("aria-expanded", "false");
      },
      TIMEOUT_MS,
    );

    test(
      "a press beside the open drawer closes it, and so does Escape",
      async () => {
        await page.goto(`${consoleUrl}/#/overview`);
        await page.locator("#moreBtn").click();
        await webExpect(page.locator("#moreBtn")).toHaveAttribute("aria-expanded", "true");
        await page.locator("#navScrim").click({ position: { x: 350, y: 200 } });
        await webExpect(page.locator("#moreBtn")).toHaveAttribute("aria-expanded", "false");
        await webExpect(page.locator("#navScrim")).toBeHidden();

        await page.locator("#moreBtn").click();
        await webExpect(page.locator("#moreBtn")).toHaveAttribute("aria-expanded", "true");
        await page.keyboard.press("Escape");
        await webExpect(page.locator("#moreBtn")).toHaveAttribute("aria-expanded", "false");
        await webExpect(page).toHaveURL((url) => url.hash === "#/overview");
      },
      TIMEOUT_MS,
    );

    test(
      "the page leaves room for the bar: nothing scrolls sideways, and the last element ends above it",
      async () => {
        for (const hash of ["#/overview", "#/boxes", "#/storage/volumes", "#/settings"]) {
          await page.goto(`${consoleUrl}/${hash}`);
          await webExpect(page.locator("#view h1").first()).toBeVisible();
          const shape = await measure(page);
          expect([hash, shape.bar.display, shape.bar.top + shape.bar.height]).toEqual([hash, "grid", PHONE.height]);
          expect([hash, shape.bar.width]).toEqual([hash, PHONE.width]);
          expect([hash, shape.fits]).toEqual([hash, { page: true, content: true }]);
          // The content's own bottom padding is at least the bar's height, so the last element clears it.
          expect([hash, Number.parseFloat(shape.contentPaddingBottom) >= shape.bar.height]).toEqual([hash, true]);
          // The last thing the page draws ends above the bar, and the clear space under it is at least zero.
          expect({
            hash,
            bar: shape.bar,
            lastBottom: shape.lastBottom,
            gap: shape.gap,
            scrollY: shape.scrollY,
            height: shape.height,
            clears: shape.lastBottom <= shape.bar.top,
          }).toMatchObject({ hash, clears: true });
        }
      },
      TIMEOUT_MS,
    );

    test(
      "a dialog covers the bar, and closing it brings the bar back",
      async () => {
        await page.goto(`${consoleUrl}/#/settings/secrets`);
        await page.locator("#view h1").first().waitFor();
        await webExpect(page.locator("#tabbar")).toBeVisible();
        await page.locator("#stSecretsAdd, #stSecretAdd, [data-action='add-secret']").first().click();
        await webExpect(page.locator(".overlay .dialog")).toBeVisible();
        await webExpect(page.locator("#tabbar")).toBeHidden();
        await page.keyboard.press("Escape");
        await webExpect(page.locator(".overlay")).toHaveCount(0);
        await webExpect(page.locator("#tabbar")).toBeVisible();
      },
      TIMEOUT_MS,
    );

    test(
      "a box's terminal takes the keyboard, so the bar steps aside there and the page still ends above where it sits",
      async () => {
        await page.goto(`${consoleUrl}/#/boxes/${alpha}/terminal`);
        await webExpect(page.locator("#view h1").first()).toContainText("alpha");
        // The terminal's own input takes focus when it opens, which is what a phone's keyboard comes up for, so the bar
        // is out of the keyboard's way and the menu button stands in for it.
        await webExpect(page.locator("#tabbar")).toBeHidden();
        await webExpect(page.locator("#menuBtn")).toBeVisible();
        const shape = await measure(page);
        expect(shape.fits).toEqual({ page: true, content: true });
        // The page keeps the bar's height as padding, so the terminal frame ends above where the bar would be.
        expect(Number.parseFloat(shape.contentPaddingBottom)).toBeGreaterThanOrEqual(52);
        expect(shape.lastBottom).toBeLessThanOrEqual(PHONE.height - 52);
        // A press on the page itself, such as the session bar, puts the keyboard away and brings the bar back.
        await page.locator(".terminal-bar").click();
        await webExpect(page.locator("#tabbar")).toBeVisible();
        await webExpect(page.locator("#menuBtn")).toBeHidden();
      },
      TIMEOUT_MS,
    );

    test(
      "a focused field on the page hides the bar, so the keyboard never covers it, and a press on the page brings it back",
      async () => {
        // The box's lifecycle editor holds a number field on its settings tab, which a phone reaches without a dialog.
        await page.goto(`${consoleUrl}/#/boxes/${alpha}/settings/lifecycle`);
        await page.locator('[data-lc-action="edit"]').click();
        await page.locator('[data-lc-idle-mode="custom"]').click();
        const field = page.locator("#lc-idle");
        await webExpect(field).toBeVisible();
        await field.focus();
        await webExpect(page.locator("#tabbar")).toBeHidden();
        // The top bar's menu button takes the bar's place, so the drawer stays one press away.
        await webExpect(page.locator("#menuBtn")).toBeVisible();
        await page.locator("#menuBtn").click();
        await webExpect(page.locator("#moreBtn")).toHaveAttribute("aria-expanded", "true");
        await page.locator("#navScrim").click({ position: { x: 350, y: 700 } });
        await webExpect(page.locator("#moreBtn")).toHaveAttribute("aria-expanded", "false");
        // The page keeps the bar's padding, so nothing shifts when the bar returns.
        const padding = await page.evaluate(() => {
          const view = globalThis as unknown as {
            document: { querySelector(selector: string): El | null };
            getComputedStyle(element: El): { paddingBottom: string };
          };
          return view.getComputedStyle(view.document.querySelector("#view")!).paddingBottom;
        });
        expect(Number.parseFloat(padding)).toBeGreaterThanOrEqual(53);
        // A press on the page itself puts the field away, and the bar comes back.
        await page.locator("#view h1").first().click();
        await webExpect(page.locator("#tabbar")).toBeVisible();
        await webExpect(page.locator("#menuBtn")).toBeHidden();
      },
      TIMEOUT_MS,
    );
  });

  describe("on a 768x1024 tablet", () => {
    test(
      "the bar is gone and the menu button still opens the drawer, as it did",
      async () => {
        const tablet = await signedIn({ viewport: TABLET });
        try {
          const tabletPage = await tablet.newPage();
          await tabletPage.goto(`${consoleUrl}/#/overview`);
          await webExpect(tabletPage.locator("#tabbar")).toBeHidden();
          await webExpect(tabletPage.locator("#menuBtn")).toBeVisible();
          await webExpect(tabletPage.locator("#sidebar")).not.toBeInViewport();
          await tabletPage.locator("#menuBtn").click();
          await webExpect(tabletPage.locator("#sidebar")).toBeInViewport();
          await tabletPage.locator('.sidebar a[data-nav="activity"]').click();
          await webExpect(tabletPage).toHaveURL((url) => url.hash === "#/activity");
          await webExpect(tabletPage.locator("#sidebar")).not.toBeInViewport();
          // Without a bar there is no extra bottom padding on the page.
          const padding = await tabletPage.evaluate(() => {
            const view = globalThis as unknown as {
              document: { querySelector(selector: string): El | null };
              getComputedStyle(element: El): { paddingBottom: string };
            };
            return view.getComputedStyle(view.document.querySelector("#view")!).paddingBottom;
          });
          expect(padding).toBe("20px");
        } finally {
          await tablet.close();
        }
      },
      TIMEOUT_MS,
    );
  });

  describe("on a 1280x800 desktop", () => {
    test(
      "there is no bar, the sidebar is in place, and the page keeps its desktop padding",
      async () => {
        const desktop = await signedIn({ viewport: DESKTOP });
        try {
          const desktopPage = await desktop.newPage();
          await desktopPage.goto(`${consoleUrl}/#/overview`);
          await webExpect(desktopPage.locator("#tabbar")).toBeHidden();
          await webExpect(desktopPage.locator("#navScrim")).toBeHidden();
          await webExpect(desktopPage.locator("#menuBtn")).toBeHidden();
          await webExpect(desktopPage.locator("#sidebar")).toBeInViewport();
          const layout = await desktopPage.evaluate(() => {
            const view = globalThis as unknown as {
              document: { querySelector(selector: string): El | null };
              getComputedStyle(element: El): { paddingBottom: string; position: string };
            };
            const box = (selector: string) => {
              const node = view.document.querySelector(selector);
              if (!node) throw new Error(`no ${selector}`);
              const rect = node.getBoundingClientRect();
              return { left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) };
            };
            return {
              sidebar: {
                ...box(".sidebar"),
                position: view.getComputedStyle(view.document.querySelector(".sidebar")!).position,
              },
              main: box(".main"),
              topbar: box(".topbar"),
              contentPaddingBottom: view.getComputedStyle(view.document.querySelector("#view")!).paddingBottom,
            };
          });
          expect(layout.sidebar).toEqual({ left: 0, width: 232, height: DESKTOP.height, position: "sticky" });
          expect(layout.main).toEqual({ left: 232, width: DESKTOP.width - 232, height: layout.main.height });
          expect(layout.topbar.height).toBe(56);
          expect(layout.contentPaddingBottom).toBe("28px");
        } finally {
          await desktop.close();
        }
      },
      TIMEOUT_MS,
    );
  });
});
