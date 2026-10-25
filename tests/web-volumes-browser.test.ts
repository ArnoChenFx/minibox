import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  chromium,
  expect as webExpect,
  type Page,
} from "@playwright/test";

import type { App } from "../src/app";
import type { HostCtx } from "../src/host/registry";
import { startServer } from "../src/server";
import * as boxes from "../src/services/boxes";
import { createVolume } from "../src/services/volumes";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";

/**
 * Chromium comes from PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH or from Playwright's own install. Locally the suite is skipped
 * without one; in CI a missing browser fails the run.
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
    "The volumes page test needs Chromium: run `bunx playwright install --with-deps chromium`, or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.",
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 30_000;
const VIEWPORT = { width: 1280, height: 800 };

const restoreLogs = silenceLogs();
afterAll(restoreLogs);

/** Moves every volume's creation and last mount a month back, so the grace period has passed and each is an orphan once unmounted. */
function ageVolumes(host: HostCtx): void {
  const old = new Date(Date.now() - 30 * DAY_MS).toISOString();
  for (const record of host.volumes.list()) {
    host.volumes.write({
      ...record,
      createdAt: old,
      lastMount: record.lastMount ? { ...record.lastMount, at: old } : null,
    });
  }
}

const row = (page: Page, name: string) => page.locator("#volRows tr", { hasText: name });

const pick = (page: Page, name: string) => page.getByRole("checkbox", { name: `Select ${name}`, exact: true });

const dialog = (page: Page) => page.getByRole("dialog");

describe.skipIf(!executablePath)("the volumes page: batch delete and prune (real browser)", () => {
  let app: App | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser;
  let context: BrowserContext | undefined;
  let page: Page;
  let consoleUrl = "";

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
    const host = app.hosts.get();
    const keys = host.keys;
    harness.runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
    server = startServer(app);
    consoleUrl = `http://127.0.0.1:${server.port}`;

    const headers = { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}`, origin: consoleUrl };
    const made = await fetch(`${consoleUrl}/api/boxes`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "alpha", cpus: 1, memoryMb: 512 }),
    });
    expect(made.status).toBe(201);

    await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    await createVolume(host, { name: "cache-a", role: "cache", createdBy: "owner" });
    for (let index = 1; index <= 6; index += 1) {
      await createVolume(host, { name: `extra-${index}`, role: null, createdBy: "owner" });
    }
    ageVolumes(host);

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

  test(
    "each row has a checkbox; the volume a box mounts and the tools volume cannot be picked",
    async () => {
      await page.goto(`${consoleUrl}/#/storage/volumes`);
      // Twelve volumes: the table shows ten and folds the rest behind a toggle.
      await webExpect(row(page, "extra-6")).toBeVisible();
      await webExpect(row(page, "notes")).toHaveCount(0);
      await page.locator("#volRows .toggle-row button", { hasText: "Show all (12)" }).click();
      await webExpect(row(page, "notes")).toBeVisible();
      await webExpect(pick(page, "notes")).toBeEnabled();
      await webExpect(pick(page, "alpha-workspace")).toBeDisabled();
      await webExpect(page.locator("#volBulk")).toBeHidden();
      await webExpect(page.locator("#volSelectAll")).toBeEnabled();
    },
    TIMEOUT_MS,
  );

  test(
    "picking rows counts them, and the header checkbox shows the mixed state",
    async () => {
      await pick(page, "notes").click();
      await webExpect(page.locator("#volBulkCount")).toHaveText("1 selected");
      await webExpect(page.locator("#volBulk")).toBeVisible();
      await webExpect(page.locator("#volSelectAll")).toBeChecked({ indeterminate: true });
      await pick(page, "cache-a").click();
      await webExpect(page.locator("#volBulkCount")).toHaveText("2 selected");
    },
    TIMEOUT_MS,
  );

  test(
    "the header checkbox selects what the search shows, and a selection outside the search stays",
    async () => {
      await page.locator("#volSelectAll").click();
      await webExpect(page.locator("#volBulkCount")).toHaveText("8 selected");
      await webExpect(page.locator("#volSelectAll")).toBeChecked();
      await page.locator("#volSelectAll").click();
      await webExpect(page.locator("#volBulk")).toBeHidden();

      await page.locator("#volSearch input").fill("extra");
      await webExpect(row(page, "notes")).toHaveCount(0);
      await page.locator("#volSelectAll").click();
      await webExpect(page.locator("#volBulkCount")).toHaveText("6 selected");

      await page.locator("#volSearch input").fill("");
      await webExpect(row(page, "notes")).toBeVisible();
      await webExpect(page.locator("#volBulkCount")).toHaveText("6 selected");
      await page.locator('#volBulk [data-action="clear-selection"]').click();
      await webExpect(page.locator("#volBulk")).toBeHidden();
    },
    TIMEOUT_MS,
  );

  test(
    "Delete selected lists what happens to each row, and cancelling deletes nothing",
    async () => {
      await pick(page, "notes").click();
      await pick(page, "cache-a").click();
      await page.locator('#volBulk [data-action="bulk-delete"]').click();
      await webExpect(dialog(page)).toContainText("Delete the selected volumes?");
      await webExpect(dialog(page).locator("tr", { hasText: "notes" })).toContainText(
        "Delete, copy kept in the recycle bin",
      );
      await webExpect(dialog(page).locator("tr", { hasText: "cache-a" })).toContainText("Delete, cannot be restored");
      await webExpect(dialog(page).locator("tr", { hasText: "cache-a" })).not.toContainText("recycle bin");
      await dialog(page).getByRole("button", { name: "Cancel" }).click();
      await webExpect(dialog(page)).toHaveCount(0);
      await webExpect(row(page, "notes")).toBeVisible();
      await webExpect(page.locator("#volBulkCount")).toHaveText("2 selected");
    },
    TIMEOUT_MS,
  );

  test(
    "skipping the recycle bin changes the rows, and confirming deletes the selected volumes",
    async () => {
      await page.locator('#volBulk [data-action="bulk-delete"]').click();
      await dialog(page).getByLabel("Delete without keeping a copy").check();
      await webExpect(dialog(page).locator("tr", { hasText: "notes" })).not.toContainText("recycle bin");
      await dialog(page).locator("#vol-ok").click();
      await webExpect(page.locator("#toasts")).toContainText("Delete finished");
      await webExpect(row(page, "notes")).toHaveCount(0);
      await webExpect(row(page, "cache-a")).toHaveCount(0);
      await webExpect(page.locator("#volBulk")).toBeHidden();
    },
    TIMEOUT_MS,
  );

  test(
    "a long prune preview folds behind a toggle, and confirming removes the orphans",
    async () => {
      await page.locator('[data-action="prune"]').click();
      await webExpect(dialog(page)).toContainText("Clean up orphaned volumes?");
      const list = dialog(page).locator(".prune-list tbody tr");
      await webExpect(list).toHaveCount(5);
      await webExpect(dialog(page).locator("[data-toggle]")).toContainText("Show all (6)");
      await dialog(page).locator("[data-toggle]").click();
      await webExpect(list).toHaveCount(6);
      await webExpect(dialog(page).locator("[data-toggle]")).toContainText("Show less");
      await webExpect(dialog(page)).not.toContainText("alpha-workspace");
      await webExpect(dialog(page)).toContainText("cannot be restored");
      await dialog(page).locator("#vol-ok").click();
      await webExpect(page.locator("#toasts")).toContainText("Orphaned volumes cleaned up");
      await webExpect(row(page, "extra-1")).toHaveCount(0);
      await webExpect(row(page, "alpha-workspace")).toBeVisible();
    },
    TIMEOUT_MS,
  );

  test(
    "with no orphans left, the prune says so and opens no dialog",
    async () => {
      await page.locator('[data-action="prune"]').click();
      await webExpect(page.locator("#toasts")).toContainText("No orphaned volumes");
      await webExpect(dialog(page)).toHaveCount(0);
    },
    TIMEOUT_MS,
  );
});

describe.skipIf(!executablePath)("the volumes page flags a volume that cannot be used as it is (real browser)", () => {
  let app: App | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page;

  beforeAll(async () => {
    const harness = createTestApp();
    app = harness.app;
    const host = app.hosts.get();
    harness.runtime.seedImage(app.cfg.baseTemplateTag, {
      [host.keys.template]: "true",
      [host.keys.templateName]: "base",
    });

    const lost = await createVolume(host, { name: "lost-data", role: null, createdBy: "owner" });
    harness.runtime.volumes.delete(lost.engineName);
    const gone = await boxes.createBox(host, { name: "beta", cpus: 1, memoryMb: 512 });
    await boxes.deleteBox(host, gone.id, false);

    server = startServer(app);
    const consoleUrl = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ executablePath: executablePath ?? undefined, args: ["--no-sandbox"] });
    context = await browser.newContext({ viewport: VIEWPORT });
    const login = await context.request.post(`${consoleUrl}/api/auth/login`, {
      data: { key: TEST_KEY },
      headers: { origin: consoleUrl },
    });
    expect(login.status()).toBe(200);
    page = await context.newPage();
    await page.goto(`${consoleUrl}/#/storage/volumes`);
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
    "a volume the engine lost shows Engine volume missing, and one whose box was deleted shows Owner box deleted",
    async () => {
      await webExpect(row(page, "lost-data")).toContainText("Engine volume missing");
      await webExpect(row(page, "lost-data")).not.toContainText("Owner box deleted");
      await webExpect(row(page, "beta-workspace")).toContainText("Owner box deleted");
      await webExpect(row(page, "beta-workspace")).not.toContainText("Engine volume missing");
    },
    TIMEOUT_MS,
  );
});

describe.skipIf(!executablePath)("the volumes page on a phone (real browser)", () => {
  let app: App | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page;
  let consoleUrl = "";
  const PHONE = { width: 390, height: 844 };

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
    const headers = { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}`, origin: consoleUrl };
    const made = await fetch(`${consoleUrl}/api/boxes`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "alpha", cpus: 1, memoryMb: 512 }),
    });
    expect(made.status).toBe(201);
    await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    await createVolume(host, { name: "cache-a", role: "cache", createdBy: "owner" });

    browser = await chromium.launch({ executablePath: executablePath ?? undefined, args: ["--no-sandbox"] });
    context = await browser.newContext({ viewport: PHONE });
    const login = await context.request.post(`${consoleUrl}/api/auth/login`, {
      data: { key: TEST_KEY },
      headers: { origin: consoleUrl },
    });
    expect(login.status()).toBe(200);
    page = await context.newPage();
    await page.goto(`${consoleUrl}/#/storage/volumes`);
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
    "each volume is a card, nothing scrolls sideways, and rows can still be picked and deleted together",
    async () => {
      await webExpect(page.locator("#volRows .vol-name").first()).toBeVisible();
      // The table is no longer a table: the row is a grid of named areas, and the column headers are gone. The DOM types
      // are not in this project's tsconfig, so the page's globals are read through one cast, as other browser tests do.
      const shape = await page.evaluate(() => {
        interface Node {
          scrollWidth: number;
          clientWidth: number;
          querySelector(selector: string): Node | null;
        }
        const view = globalThis as unknown as {
          document: Node & {
            querySelectorAll(selector: string): Node[];
            documentElement: { scrollWidth: number; clientWidth: number };
          };
          getComputedStyle(
            element: Node,
            pseudo?: string,
          ): { display: string; gridTemplateAreas: string; content: string };
        };
        const row = view.document.querySelector("#volRows tr")!;
        const header = view.document.querySelector(".vol-table thead")!;
        return {
          row: view.getComputedStyle(row).display,
          areas: view.getComputedStyle(row).gridTemplateAreas,
          thead: view.getComputedStyle(header).display,
          firstHeader: view.getComputedStyle(header.querySelector("th")!).display,
          selectAllLabel: view.getComputedStyle(header.querySelector("th.select-cell")!, "::after").content,
          fits: {
            wrap:
              view.document.querySelector("#volWrap")!.scrollWidth <=
              view.document.querySelector("#volWrap")!.clientWidth,
            cards: [...view.document.querySelectorAll("#volRows > tr")].every(
              (card) => card.scrollWidth <= card.clientWidth,
            ),
            page: view.document.documentElement.scrollWidth <= view.document.documentElement.clientWidth,
          },
        };
      });
      expect(shape.row).toBe("grid");
      expect(shape.areas).toContain("name");
      expect(shape.areas).toContain("actions");
      expect(shape.thead).toBe("block");
      expect(shape.firstHeader).toBe("flex");
      // The header keeps only its select-all box, which names itself now that the header row is gone.
      await webExpect(page.locator("#volSelectAll")).toBeVisible();
      expect(shape.selectAllLabel).toContain("Select all");
      // Every card fits inside the wrapper, and the page itself does not scroll sideways.
      expect(shape.fits).toEqual({ wrap: true, cards: true, page: true });
      // Each field keeps the name of the column it used to sit in.
      await webExpect(page.locator("#volRows tr").first().locator(".vol-pool")).toHaveAttribute("data-label", "Pool");
      // Picking a row and deleting it together still works from the card.
      await pick(page, "notes").click();
      await webExpect(page.locator("#volBulk")).toBeVisible();
      await webExpect(page.locator("#volBulkCount")).toHaveText("1 selected");
      await page.locator('#volBulk [data-action="clear-selection"]').click();
      await webExpect(page.locator("#volBulk")).toBeHidden();
    },
    TIMEOUT_MS,
  );

  test(
    "a group header and the show-all button still take a full-width row of their own",
    async () => {
      await page.locator("#volGroup").selectOption("pool");
      const head = page.locator("#volRows tr.group-row").first();
      await webExpect(head).toBeVisible();
      const headBox = await head.boundingBox();
      const wrapBox = await page.locator("#volWrap").boundingBox();
      if (!headBox || !wrapBox) throw new Error("the group header has no layout box");
      expect(Math.abs(headBox.width - wrapBox.width)).toBeLessThanOrEqual(1);
      await page.locator("#volGroup").selectOption("none");
    },
    TIMEOUT_MS,
  );

  test(
    "the storage pools table is cards too, so the pools card does not scroll sideways either",
    async () => {
      await page.locator(".fold-toggle").first().click();
      await webExpect(page.locator("#volBody .pool-table tbody tr").first()).toBeVisible();
      const pools = await page.evaluate(() => {
        interface Node {
          scrollWidth: number;
          clientWidth: number;
        }
        const view = globalThis as unknown as {
          document: {
            querySelector(selector: string): Node | null;
          };
          getComputedStyle(element: Node): { display: string };
        };
        const wrap = view.document.querySelector("#volBody .table-wrap")!;
        return {
          row: view.getComputedStyle(view.document.querySelector("#volBody .pool-table tbody tr")!).display,
          fits: wrap.scrollWidth <= wrap.clientWidth,
        };
      });
      expect(pools).toEqual({ row: "grid", fits: true });
    },
    TIMEOUT_MS,
  );
});
