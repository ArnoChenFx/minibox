import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  chromium,
  expect as webExpect,
  type Locator,
  type Page,
} from "@playwright/test";

import type { App } from "../src/app";
import { startServer } from "../src/server";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";

/**
 * Chromium comes from PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH or from Playwright's own install (`bunx playwright install
 * chromium`). Locally the suite is skipped without one. In CI a missing browser fails the run.
 */
function chromiumPath(): string | null {
  const configured = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (configured) return configured;
  const bundled = chromium.executablePath();
  return existsSync(bundled) ? bundled : null;
}

const executablePath = chromiumPath();
if (!executablePath && process.env.CI) {
  throw new Error(
    "The console navigation test needs Chromium: run `bunx playwright install --with-deps chromium`, or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.",
  );
}

const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const TIMEOUT_MS = 30_000;
const VIEWPORT = { width: 1280, height: 800 };

/** Matches the address a page ends on as a whole, so an extra segment or a query cannot pass by accident. */
const at = (hash: string) => (url: URL) => url.hash === hash;

const tab = (page: Page, label: string): Locator => page.locator("#view [role='tab']", { hasText: label });

const currentEntry = (page: Page): Locator => page.locator(".sidebar [aria-current='page']");

describe.skipIf(!executablePath)("the console's top navigation (real browser)", () => {
  let app: App | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser;
  let context: BrowserContext | undefined;
  let page: Page;
  let consoleUrl = "";
  let alpha = "";
  let beta = "";

  async function signedIn(options: BrowserContextOptions = {}): Promise<BrowserContext> {
    const fresh = await browser.newContext(options);
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
    const keys = app.hosts.get().keys;
    harness.runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
    server = startServer(app);
    consoleUrl = `http://127.0.0.1:${server.port}`;

    const headers = { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}`, origin: consoleUrl };
    const ids: string[] = [];
    for (const name of ["alpha", "beta"]) {
      const response = await fetch(`${consoleUrl}/api/boxes`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name, cpus: 1, memoryMb: 512 }),
      });
      expect(response.status).toBe(201);
      ids.push(((await response.json()) as { box: { boxId: string } }).box.boxId);
    }
    [alpha = "", beta = ""] = ids;

    browser = await chromium.launch({ executablePath: executablePath ?? undefined, args: ["--no-sandbox"] });
    context = await signedIn({ viewport: VIEWPORT });
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

  describe("the sidebar", () => {
    test(
      "lists the six entries in order, each with its own address",
      async () => {
        await page.goto(`${consoleUrl}/#/overview`);
        const entries = await page.locator(".sidebar .nav > a").all();
        const navs = await Promise.all(entries.map((entry) => entry.getAttribute("data-nav")));
        const hrefs = await Promise.all(entries.map((entry) => entry.getAttribute("href")));
        expect(navs).toEqual(["overview", "boxes", "storage", "library", "activity", "settings"]);
        expect(hrefs).toEqual([
          "#/overview",
          "#/boxes",
          "#/storage/volumes",
          "#/library/templates",
          "#/activity",
          "#/settings",
        ]);
        await webExpect(page.locator('.sidebar a[href="#/settings"]')).toHaveCount(1);
      },
      TIMEOUT_MS,
    );

    test(
      "names the entries in English",
      async () => {
        await page.goto(`${consoleUrl}/#/overview`);
        await webExpect(page.locator(".sidebar .nav > a > span[data-i18n]")).toHaveText([
          "Overview",
          "Boxes",
          "Storage",
          "Library",
          "Activity",
          "Settings",
        ]);
      },
      TIMEOUT_MS,
    );

    test(
      "each entry opens its page, and only that entry is marked as the current page",
      async () => {
        for (const [nav, heading] of [
          ["overview", "Overview"],
          ["boxes", "Boxes"],
          ["storage", "Storage"],
          ["library", "Library"],
          ["settings", "Settings"],
        ] as const) {
          await page.locator(`.sidebar a[data-nav="${nav}"]`).click();
          await webExpect(page.locator("#view h1").first()).toHaveText(heading);
          await webExpect(currentEntry(page)).toHaveCount(1);
          await webExpect(currentEntry(page)).toHaveAttribute("data-nav", nav);
        }
      },
      TIMEOUT_MS,
    );

    test(
      "a box address opens that box, and Boxes stays the current entry",
      async () => {
        await page.goto(`${consoleUrl}/#/boxes/${alpha}`);
        await webExpect(page.locator("#view h1").first()).toContainText("alpha");
        await webExpect(currentEntry(page)).toHaveAttribute("data-nav", "boxes");
      },
      TIMEOUT_MS,
    );

    test(
      "Activity opens the overview with its recent-activity card in view, and Activity is the current entry",
      async () => {
        await page.goto(`${consoleUrl}/#/overview`);
        await page.locator('.sidebar a[data-nav="activity"]').click();
        await webExpect(page).toHaveURL(at("#/activity"));
        await webExpect(page.locator("#ovRecentCard")).toHaveClass(/is-focus/);
        await webExpect(page.locator("#ovRecentCard")).toBeInViewport();
        await webExpect(currentEntry(page)).toHaveAttribute("data-nav", "activity");
      },
      TIMEOUT_MS,
    );

    test(
      "About is the version link at the foot of the sidebar, and it opens the About page",
      async () => {
        await page.goto(`${consoleUrl}/#/overview`);
        const footer = page.locator(".sidebar a.sidebar-foot");
        await webExpect(footer).toHaveAttribute("href", "#/about");
        await footer.click();
        await webExpect(page).toHaveURL(at("#/about"));
        await webExpect(page.locator("#view h1").first()).toHaveText("About");
        await webExpect(currentEntry(page)).toHaveAttribute("data-nav", "about");
      },
      TIMEOUT_MS,
    );
  });

  describe("the Storage section", () => {
    test(
      "opens on Volumes, which has no box picker",
      async () => {
        await page.goto(`${consoleUrl}/#/storage`);
        await webExpect(page).toHaveURL(at("#/storage/volumes"));
        await webExpect(tab(page, "Volumes")).toHaveAttribute("aria-selected", "true");
        await webExpect(tab(page, "Checkpoints")).toHaveAttribute("aria-selected", "false");
        await webExpect(page.locator("#volRows")).toContainText("alpha");
        await webExpect(page.locator("#boxPick")).toHaveCount(0);
      },
      TIMEOUT_MS,
    );

    test(
      "Checkpoints puts the box it shows into the address, and picking another box changes the address",
      async () => {
        await tab(page, "Checkpoints").click();
        await webExpect(page.locator("#boxPick")).toBeVisible();
        const first = await page.locator("#boxPick").inputValue();
        expect([alpha, beta]).toContain(first);
        await webExpect(page).toHaveURL(at(`#/storage/checkpoints/${first}`));
        await webExpect(page.locator("#boxTabBody")).toContainText("No checkpoints yet");
        const other = first === alpha ? beta : alpha;
        await page.locator("#boxPick").selectOption(other);
        await webExpect(page).toHaveURL(at(`#/storage/checkpoints/${other}`));
        await webExpect(tab(page, "Checkpoints")).toHaveAttribute("aria-selected", "true");
      },
      TIMEOUT_MS,
    );

    test(
      "the tab and the box it shows survive a reload",
      async () => {
        const options = await Promise.all(
          (await page.locator("#boxPick option").all()).map((option) => option.getAttribute("value")),
        );
        const chosen = options[1] ?? "";
        expect(options).toHaveLength(2);
        await page.locator("#boxPick").selectOption(chosen);
        await webExpect(page).toHaveURL(at(`#/storage/checkpoints/${chosen}`));
        await page.reload();
        await webExpect(page).toHaveURL(at(`#/storage/checkpoints/${chosen}`));
        await webExpect(tab(page, "Checkpoints")).toHaveAttribute("aria-selected", "true");
        await webExpect(page.locator("#boxPick")).toHaveValue(chosen);
      },
      TIMEOUT_MS,
    );

    test(
      "Volumes drops the box from the address",
      async () => {
        await tab(page, "Volumes").click();
        await webExpect(page).toHaveURL(at("#/storage/volumes"));
        await webExpect(tab(page, "Volumes")).toHaveAttribute("aria-selected", "true");
        await webExpect(page.locator("#boxPick")).toHaveCount(0);
      },
      TIMEOUT_MS,
    );

    test(
      "the Recycle bin opens from Storage, and Storage stays the current entry",
      async () => {
        await page.locator('#view a[href="#/trash"]').click();
        await webExpect(page).toHaveURL(at("#/trash"));
        await webExpect(page.locator("#view h1").first()).toHaveText("Recycle bin");
        await webExpect(currentEntry(page)).toHaveAttribute("data-nav", "storage");
      },
      TIMEOUT_MS,
    );
  });

  describe("the Library section", () => {
    test(
      "opens on Templates, which lists the base template",
      async () => {
        await page.goto(`${consoleUrl}/#/library`);
        await webExpect(page).toHaveURL(at("#/library/templates"));
        await webExpect(tab(page, "Templates")).toHaveAttribute("aria-selected", "true");
        await webExpect(page.locator('#tpGrid [data-name="base"]')).toBeVisible();
      },
      TIMEOUT_MS,
    );

    test(
      "Tool catalog puts the box it lists into the address, and lists that box's tools",
      async () => {
        await tab(page, "Tool catalog").click();
        await webExpect(page.locator("#boxPick")).toBeVisible();
        const box = await page.locator("#boxPick").inputValue();
        await webExpect(page).toHaveURL(at(`#/library/tools/${box}`));
        await webExpect(tab(page, "Tool catalog")).toHaveAttribute("aria-selected", "true");
        await webExpect(page.locator("#bdToolRows .spinner")).toHaveCount(0);
        await webExpect(page.locator("#bdToolRows").getByText("Claude Code", { exact: true }).first()).toBeVisible();
      },
      TIMEOUT_MS,
    );

    test(
      "a template address opens Library on Templates, with that template in focus",
      async () => {
        await page.goto(`${consoleUrl}/#/templates/base`);
        await webExpect(page).toHaveURL(at("#/library/templates/base"));
        await webExpect(tab(page, "Templates")).toHaveAttribute("aria-selected", "true");
        await webExpect(page.locator('#tpGrid [data-name="base"]')).toHaveClass(/is-focus/);
      },
      TIMEOUT_MS,
    );
  });

  describe("addresses that moved", () => {
    test(
      "Volumes, Templates and Snapshots open the pages that replaced them",
      async () => {
        for (const [from, to, nav] of [
          ["#/volumes", "#/storage/volumes", "storage"],
          ["#/templates", "#/library/templates", "library"],
          ["#/snapshots", "#/library/templates", "library"],
        ] as const) {
          await page.goto(`${consoleUrl}/${from}`);
          await webExpect(page).toHaveURL(at(to));
          await webExpect(currentEntry(page)).toHaveAttribute("data-nav", nav);
        }
      },
      TIMEOUT_MS,
    );

    test(
      "an address that never had a page opens the overview",
      async () => {
        await page.goto(`${consoleUrl}/#/nowhere`);
        await webExpect(page).toHaveURL(at("#/overview"));
        await webExpect(currentEntry(page)).toHaveAttribute("data-nav", "overview");
      },
      TIMEOUT_MS,
    );
  });

  describe("the host filter", () => {
    test(
      "stays hidden while the control plane has one host",
      async () => {
        await page.goto(`${consoleUrl}/#/overview`);
        await webExpect(page.locator("#hostFilter option")).toHaveCount(2);
        await webExpect(page.locator("#hostFilter")).toBeHidden();
      },
      TIMEOUT_MS,
    );

    test(
      "appears in the top bar once the control plane holds two hosts",
      async () => {
        const twoHosts = await signedIn({ viewport: VIEWPORT });
        try {
          await twoHosts.route("**/api/hosts", async (route) => {
            const response = await route.fetch();
            const body = (await response.json()) as { hosts: Record<string, unknown>[] };
            const [local = {}] = body.hosts;
            await route.fulfill({
              response,
              json: { ...body, hosts: [...body.hosts, { ...local, id: "lab", name: "Lab" }] },
            });
          });
          const hostsPage = await twoHosts.newPage();
          await hostsPage.goto(`${consoleUrl}/#/overview`);
          await webExpect(hostsPage.locator("#hostFilter option")).toHaveCount(3);
          await webExpect(hostsPage.locator("#hostFilter")).toBeVisible();
        } finally {
          await twoHosts.close();
        }
      },
      TIMEOUT_MS,
    );
  });

  describe("the Chinese console", () => {
    test(
      "names the entries 概览, Box, 存储, 库, 活动 and 设置",
      async () => {
        const zh = await signedIn({ locale: "zh-CN", viewport: VIEWPORT });
        try {
          const zhPage = await zh.newPage();
          await zhPage.goto(`${consoleUrl}/#/overview`);
          await webExpect(zhPage.locator(".sidebar .nav > a > span[data-i18n]")).toHaveText([
            "概览",
            "Box",
            "存储",
            "库",
            "活动",
            "设置",
          ]);
        } finally {
          await zh.close();
        }
      },
      TIMEOUT_MS,
    );
  });
});
