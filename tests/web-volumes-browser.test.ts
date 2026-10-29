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
import type { HostCtx } from "../src/host/registry";
import { startServer } from "../src/server";
import * as boxes from "../src/services/boxes";
import { createVolume } from "../src/services/volumes";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";

const executablePath = chromiumFor("The volumes page test");

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
    "above 640px the rows are still a table, with the nine cells the columns are in",
    async () => {
      await page.goto(`${consoleUrl}/#/storage/volumes`);
      await webExpect(row(page, "extra-6")).toBeVisible();
      const shape = await page.evaluate(() => {
        interface Node {
          display: string;
        }
        const view = globalThis as unknown as {
          document: {
            querySelector(selector: string): (Node & { querySelectorAll(s: string): Node[] }) | null;
          };
          getComputedStyle(element: Node): { display: string; gridTemplateAreas: string };
        };
        const table = view.document.querySelector(".vol-table")!;
        const first = view.document.querySelector("#volRows tr")!;
        const cells = first.querySelectorAll("td");
        return {
          table: view.getComputedStyle(table).display,
          row: view.getComputedStyle(first).display,
          // No card layout leaks out of the phone block.
          areas: view.getComputedStyle(first).gridTemplateAreas,
          count: cells.length,
          first: (cells[0] as unknown as { className: string }).className,
          last: (cells[cells.length - 1] as unknown as { className: string }).className,
        };
      });
      expect(shape.table).toBe("table");
      expect(shape.row).toBe("table-row");
      expect(shape.areas).toBe("none");
      // The checkbox comes first and the actions last, so every column is still where the header says.
      expect(shape.count).toBe(9);
      expect(shape.first).toBe("select-cell");
      expect(shape.last).toContain("vol-actions");
      // The desktop row keeps every field on one line, so a long name or mount ends in an ellipsis rather than wrapping.
      const layout = await page.evaluate(() => {
        interface Node {
          querySelectorAll(selector: string): Node[];
        }
        const view = globalThis as unknown as {
          document: { querySelectorAll(selector: string): Node[] };
          getComputedStyle(element: Node): { whiteSpace: string };
        };
        return [...view.document.querySelectorAll("#volRows tr:first-child td")].map(
          (cell) => view.getComputedStyle(cell).whiteSpace,
        );
      });
      expect([...new Set(layout)]).toEqual(["nowrap"]);
    },
    TIMEOUT_MS,
  );

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

describe.skipIf(!executablePath)(
  "the volumes page deletes a spare tools volume but not the shared one (real browser)",
  () => {
    let app: App | undefined;
    let server: ReturnType<typeof startServer> | undefined;
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let page: Page;
    let shared = "";

    beforeAll(async () => {
      const harness = createTestApp();
      app = harness.app;
      const host = app.hosts.get();
      harness.runtime.seedImage(app.cfg.baseTemplateTag, {
        [host.keys.template]: "true",
        [host.keys.templateName]: "base",
      });
      // The box makes the shared tools volume and mounts it; the spare one sits beside it, mounted by nothing.
      await boxes.createBox(host, { name: "alpha", cpus: 1, memoryMb: 512 });
      await createVolume(host, { name: "spare-tools", role: "tools", createdBy: "owner" });
      shared = host.volumes.list().find((volume) => volume.role === "tools" && volume.name !== "spare-tools")!.name;

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
      "the shared tools volume cannot be picked or deleted, and says why",
      async () => {
        await webExpect(row(page, shared)).toBeVisible();
        await webExpect(pick(page, shared)).toBeDisabled();
        const remove = row(page, shared).locator('[data-action="delete"]');
        await webExpect(remove).toBeDisabled();
        await webExpect(remove).toHaveAttribute("title", "Delete: The shared tools volume cannot be deleted");
        await webExpect(row(page, shared).locator(".vol-hint")).toHaveCount(0);
      },
      TIMEOUT_MS,
    );

    test(
      "a spare tools volume can be picked, is flagged for cleanup, and its delete button removes it",
      async () => {
        await webExpect(pick(page, "spare-tools")).toBeEnabled();
        await webExpect(row(page, "spare-tools").locator(".vol-hint")).toHaveAttribute(
          "title",
          /spare tools volume.*Clean up orphaned volumes skips tools volumes/,
        );
        await row(page, "spare-tools").locator('[data-action="delete"]').click();
        await webExpect(dialog(page)).toContainText("Delete this volume?");
        await dialog(page).locator("#cfm-ok").click();
        await webExpect(page.locator("#toasts")).toContainText("Volume deleted");
        await webExpect(row(page, "spare-tools")).toHaveCount(0);
        await webExpect(row(page, shared)).toBeVisible();
      },
      TIMEOUT_MS,
    );
  },
);

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
    const cache = await createVolume(host, { name: "cache-a", role: "cache", createdBy: "owner" });
    // One volume over its soft limit, so its card can be seen to carry the accent the desktop table put on the first cell.
    const record = host.volumes.read(cache.id);
    if (!record) throw new Error("the cache volume has a record");
    host.volumes.write({
      ...record,
      bytes: 3_000_000,
      limits: { softBytes: 1_000_000, hardBytes: null, action: "warn" },
    });

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
          querySelectorAll(selector: string): Node[];
        }
        const view = globalThis as unknown as {
          document: Node & {
            documentElement: { scrollWidth: number; clientWidth: number };
          };
          getComputedStyle(
            element: Node,
            pseudo?: string,
          ): { display: string; gridTemplateAreas: string; content: string; gridArea: string };
        };
        const row = view.document.querySelector("#volRows tr")!;
        const header = view.document.querySelector(".vol-table thead")!;
        return {
          row: view.getComputedStyle(row).display,
          areas: view.getComputedStyle(row).gridTemplateAreas,
          thead: view.getComputedStyle(header).display,
          firstHeader: view.getComputedStyle(header.querySelector("th")!).display,
          selectAllLabel: view.getComputedStyle(header.querySelector("th.select-cell")!, "::after").content,
          // The visible fields of the first card, and the area each of them took, so a field placed nowhere shows up.
          cells: [...row.querySelectorAll("td")]
            .filter((cell) => view.getComputedStyle(cell).display !== "none")
            .map((cell): [string, string] => [
              (cell as unknown as { className: string }).className,
              view.getComputedStyle(cell).gridArea,
            ]),
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
      // Every field takes the named area the grid lays out for it, so no column is left to overflow.
      expect(shape.cells.every(([, area]) => area !== "")).toBe(true);
      for (const [, area] of shape.cells) expect(shape.areas).toContain(area);
      expect(shape.cells.map(([, area]) => area).toSorted()).toEqual(
        ["actions", "mounts", "name", "owner", "pool", "select", "status", "usage"].toSorted(),
      );
      expect(shape.thead).toBe("block");
      expect(shape.firstHeader).toBe("flex");
      // The select-all box in the header lines up with the checkbox of the card below, so the two form one column.
      const insets = await page.evaluate(() => {
        const view = globalThis as unknown as {
          document: { querySelector(selector: string): { getBoundingClientRect(): { left: number } } | null };
        };
        const header = view.document.querySelector("th.select-cell")!;
        const first = view.document.querySelector("#volRows tr td")!;
        return {
          header: Math.round(header.getBoundingClientRect().left),
          card: Math.round(first.getBoundingClientRect().left),
        };
      });
      expect(Math.abs(insets.header - insets.card)).toBeLessThanOrEqual(1);
      // The header keeps only its select-all box, which names itself now that the header row is gone.
      await webExpect(page.locator("#volSelectAll")).toBeVisible();
      expect(shape.selectAllLabel).toContain("Select all");
      // Every card fits inside the wrapper, and the page itself does not scroll sideways.
      expect(shape.fits).toEqual({ wrap: true, cards: true, page: true });
      // Each field carries the name of the column it used to sit in, and draws it above its value.
      await webExpect(page.locator("#volRows tr").first().locator(".vol-pool")).toHaveAttribute("data-label", "Pool");
      const labels = await page.evaluate(() => {
        interface Node {
          className: string;
          hasAttribute(name: string): boolean;
          getAttribute(name: string): string | null;
        }
        const view = globalThis as unknown as {
          document: { querySelector(selector: string): (Node & { querySelectorAll(s: string): Node[] }) | null };
          getComputedStyle(element: Node, pseudo?: string): { content: string };
        };
        const card = view.document.querySelector("#volRows tr")!;
        return [...card.querySelectorAll("td")]
          .filter((cell) => cell.hasAttribute("data-label"))
          .map((cell) => [
            cell.className,
            cell.getAttribute("data-label"),
            view.getComputedStyle(cell, "::before").content,
          ]);
      });
      // Every field but the name, the status and the actions names itself, in the order the columns were in.
      expect(labels.map(([, label]) => label)).toEqual(["Size", "Mounts", "Ownership", "Pool", "Latest checkpoint"]);
      // The name is drawn from `data-label` itself, so it never drifts from the column it came from.
      for (const [cls, label, content] of labels) expect([cls, label, content]).toEqual([cls, label, `"${label}"`]);
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
    "while the list loads, a skeleton row is one line instead of nine empty cells",
    async () => {
      // Hold the volume list so the page's own skeleton stays on screen long enough to be measured.
      const held = Promise.withResolvers<void>();
      const settled = Promise.withResolvers<void>();
      await page.route("**/api/volumes", async (route) => {
        await held.promise;
        await route.continue();
        settled.resolve();
      });
      try {
        await page.reload();
        await webExpect(page.locator("#volRows tr").first()).toBeVisible();
        const skeleton = await page.evaluate(() => {
          interface Node {
            querySelectorAll(selector: string): Node[];
            getBoundingClientRect(): { height: number };
          }
          const view = globalThis as unknown as {
            document: { querySelector(selector: string): Node | null };
            getComputedStyle(element: Node): { display: string; gridColumn: string };
          };
          const row = view.document.querySelector("#volRows tr")!;
          const cells = [...row.querySelectorAll("td")];
          const shown = cells.filter((cell) => view.getComputedStyle(cell).display !== "none");
          return {
            cells: cells.length,
            shown: shown.length,
            span: view.getComputedStyle(shown[0]!).gridColumn,
            height: Math.round(row.getBoundingClientRect().height),
          };
        });
        // Nine cells are drawn, but only the first takes the row, stretched across every column.
        expect(skeleton.cells).toBe(9);
        expect(skeleton.span).toBe("1 / -1");
        expect(skeleton.shown).toBeLessThanOrEqual(2);

        held.resolve();
        await settled.promise;
        await page.unroute("**/api/volumes");
        await webExpect(page.locator("#volRows .vol-name").first()).toBeVisible();
        // A loaded card is far taller than the loading row, so the placeholder never looks like a filled card.
        const card = await page.locator("#volRows tr").first().boundingBox();
        if (!card) throw new Error("the first card has no layout box");
        expect(skeleton.height).toBeLessThan(Math.round(card.height) / 2);
      } finally {
        held.resolve();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a field with nothing in it is left out, so a card is not a column of dashes",
    async () => {
      // `notes` mounts nowhere and has no checkpoint, so the two fields that would only draw a dash are hidden.
      const empty = page.locator("#volRows tr", { hasText: "notes" }).locator("td.vol-empty");
      await webExpect(empty).toHaveCount(2);
      const shape = await page.evaluate(() => {
        interface Node {
          className: string;
          textContent: string | null;
          querySelectorAll(selector: string): Node[];
        }
        const view = globalThis as unknown as {
          document: { querySelectorAll(selector: string): Node[] };
          getComputedStyle(element: Node): { display: string };
        };
        const card = [...view.document.querySelectorAll("#volRows tr")].find((row) =>
          row.textContent?.includes("notes"),
        )!;
        return [...card.querySelectorAll("td")]
          .filter((cell) => cell.className.includes("vol-empty"))
          .map((cell) => [cell.className, view.getComputedStyle(cell).display]);
      });
      expect(shape).toEqual([
        ["vol-mounts vol-empty", "none"],
        ["vol-latest-cell vol-empty", "none"],
      ]);
    },
    TIMEOUT_MS,
  );

  test(
    "a volume over its limit marks its whole card, and the first cell no longer carries the accent on its own",
    async () => {
      const shape = await page.evaluate(() => {
        interface Node {
          className: string;
          textContent: string | null;
          querySelector(selector: string): Node | null;
        }
        const view = globalThis as unknown as {
          document: { querySelectorAll(selector: string): Node[] };
          getComputedStyle(element: Node): { boxShadow: string };
        };
        const card = [...view.document.querySelectorAll("#volRows tr")].find((row) =>
          row.textContent?.includes("cache-a"),
        )!;
        const first = card.querySelector("td")!;
        return {
          row: card.className,
          rowShadow: view.getComputedStyle(card).boxShadow,
          firstShadow: view.getComputedStyle(first).boxShadow,
        };
      });
      expect(shape.row).toBe("volume-over-soft");
      expect(shape.rowShadow).not.toBe("none");
      expect(shape.firstShadow).toBe("none");
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
      // The pools card folds under the volumes table; another test may already have opened it, so only open it when shut.
      if (!(await page.locator("#volBody .pool-table tbody tr").first().isVisible())) {
        await page.locator(".fold-toggle").first().click();
      }
      await webExpect(page.locator("#volBody .pool-table tbody tr").first()).toBeVisible();
      const pools = await page.evaluate(() => {
        interface Node {
          scrollWidth: number;
          clientWidth: number;
          className: string;
          querySelectorAll(selector: string): Node[];
        }
        const view = globalThis as unknown as {
          document: { querySelector(selector: string): (Node & { querySelectorAll(s: string): Node[] }) | null };
          getComputedStyle(element: Node): { display: string; gridArea: string; gridTemplateAreas: string };
        };
        const wrap = view.document.querySelector("#volBody .table-wrap")!;
        const card = view.document.querySelector("#volBody .pool-table tbody tr")!;
        const style = view.getComputedStyle(card);
        return {
          row: style.display,
          areas: style.gridTemplateAreas,
          // Each field of the pool card takes the area the grid lays out for it.
          cells: [...card.querySelectorAll("td")].map((cell): [string, string] => [
            cell.className,
            view.getComputedStyle(cell).gridArea,
          ]),
          fits: wrap.scrollWidth <= wrap.clientWidth,
        };
      });
      expect(pools.row).toBe("grid");
      expect(pools.fits).toBe(true);
      // Every named area the pool card lays out is claimed by a field, so none is left empty.
      const laid = new Set(
        (pools.areas.match(/"[^"]+"/g) ?? []).flatMap((line) => line.replace(/"/g, "").trim().split(/\s+/)),
      );
      expect([...laid].toSorted()).toEqual(["actions", "backend", "free", "health", "name", "note"]);
      for (const [cls, area] of pools.cells) expect([cls, laid.has(area)]).toEqual([cls, true]);
    },
    TIMEOUT_MS,
  );

  test(
    "a pool with no note leaves that line out, as the volumes card does",
    async () => {
      // The pools card folds under the volumes table; another test may already have opened it, so only open it when shut.
      if (!(await page.locator("#volBody .pool-table tbody tr").first().isVisible())) {
        await page.locator(".fold-toggle").first().click();
      }
      await webExpect(page.locator("#volBody .pool-table tbody tr").first()).toBeVisible();
      // The local pool answers with no note, so its cell is marked and the card leaves the line out.
      const shape = await page.evaluate(() => {
        interface Node {
          className: string;
          textContent: string | null;
          querySelectorAll(selector: string): Node[];
        }
        const view = globalThis as unknown as {
          document: { querySelectorAll(selector: string): Node[] };
          getComputedStyle(element: Node): { display: string };
        };
        const card = view.document.querySelectorAll("#volBody .pool-table tbody tr")[0]!;
        return [...card.querySelectorAll("td")].map((cell) => [cell.className, view.getComputedStyle(cell).display]);
      });
      expect(shape).toContainEqual(["pool-note pool-empty", "none"]);
    },
    TIMEOUT_MS,
  );
});
