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
import { type TakeCheckpointInput, takeCheckpoint } from "../src/services/checkpoints";
import { createIndependentVolume, provisionDefaultMounts } from "../src/volumes/provision";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";

const executablePath = chromiumFor("The storage checkpoints test");
const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const TIMEOUT_MS = 30_000;
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const NOTHING: TakeCheckpointInput = {
  pinned: false,
  include: { system: false, volumes: [] },
  consistency: "live",
  label: "",
};

/** A checkpoint whose data holds the given number of bytes, so its size column has something to show. */
async function take(host: Parameters<typeof takeCheckpoint>[0], ref: string, label: string, bytes = 0) {
  const view = await takeCheckpoint(host, ref, { ...NOTHING, label }, "owner");
  const record = host.checkpoints.read(view.id);
  if (record && bytes) host.checkpoints.write({ ...record, data: record.data.map((layer) => ({ ...layer, bytes })) });
  return view;
}

describe.skipIf(!executablePath)("the storage checkpoints page on a phone (real browser)", () => {
  let app: App | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page;
  let consoleUrl = "";

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

    // alpha carries a long label, a pinned checkpoint, and enough of them to fold behind the show-all button; gamma mounts
    // an extra volume, and one checkpoint of beta holds no data at all, which is the field the phone card leaves out.
    const alpha = await boxes.createBox(host, { name: "alpha", cpus: 1, memoryMb: 512, createdBy: "owner" });
    const beta = await boxes.createBox(host, { name: "beta", cpus: 1, memoryMb: 512, createdBy: "owner" });
    const extra = await createIndependentVolume(host, { name: "notes", role: null, createdBy: "owner" }, new Set());
    const gammaId = "bx_gammagammagammagamma";
    const gammaMounts = await provisionDefaultMounts(
      host,
      { id: gammaId, name: "gamma", createdBy: "owner" },
      new Set(),
    );
    await boxes.createBox(host, {
      name: "gamma",
      id: gammaId,
      cpus: 1,
      memoryMb: 512,
      createdBy: "owner",
      mounts: [...gammaMounts, { volume: extra.name, path: "/notes", mode: "rw" }],
    });

    for (let index = 1; index <= 6; index += 1) await take(host, alpha.boxId, `nightly ${index}`, 1024 * index);
    await take(host, beta.boxId, "hand-off");
    const empty = await take(host, beta.boxId, "no data at all");
    const record = host.checkpoints.read(empty.id);
    if (record) host.checkpoints.write({ ...record, data: [], system: null });
    await take(host, gammaId, "with a pinned extra volume and a label long enough to wrap", 23_500_000);
    const pinned = await take(host, gammaId, "pinned", 12_345_678);
    const pinnedRecord = host.checkpoints.read(pinned.id);
    if (pinnedRecord) host.checkpoints.write({ ...pinnedRecord, pinned: true });

    browser = await chromium.launch({ executablePath: executablePath ?? undefined, args: ["--no-sandbox"] });
    context = await signedIn({ viewport: PHONE });
    page = await context.newPage();
    await page.goto(`${consoleUrl}/#/storage/checkpoints`);
    await webExpect(page.locator("#sckRows .sck-label").first()).toBeVisible();
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
    "each checkpoint is a card, nothing scrolls sideways, and no two fields overlap",
    async () => {
      const shape = await page.evaluate(() => {
        interface Box {
          x: number;
          y: number;
          width: number;
          height: number;
          top: number;
          left: number;
          right: number;
          bottom: number;
        }
        interface Node {
          scrollWidth: number;
          clientWidth: number;
          textContent: string | null;
          className: string;
          getBoundingClientRect(): Box;
          querySelector(selector: string): Node | null;
          querySelectorAll(selector: string): Node[];
          hasAttribute(name: string): boolean;
        }
        const view = globalThis as unknown as {
          document: Node & {
            querySelector(selector: string): Node | null;
            querySelectorAll(selector: string): Node[];
            documentElement: Node;
          };
          getComputedStyle(
            element: Node,
            pseudo?: string,
          ): { display: string; gridTemplateAreas: string; content: string; paddingLeft: string };
        };
        const doc = view.document;
        const wrap = doc.querySelector("#sckWrap")!;
        const cards = [...doc.querySelectorAll("#sckRows > tr:not(.group-row):not(.toggle-row)")];
        const overlaps = (a: Box, b: Box) =>
          Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0 &&
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0;
        return {
          row: view.getComputedStyle(cards[0]!).display,
          areas: view.getComputedStyle(cards[0]!).gridTemplateAreas,
          header: view.getComputedStyle(doc.querySelector(".sck-table thead")!).display,
          fits: {
            page: doc.documentElement.scrollWidth <= doc.documentElement.clientWidth,
            wrap: wrap.scrollWidth <= wrap.clientWidth,
            cards: cards.every((card) => card.scrollWidth <= card.clientWidth),
          },
          overlaps: cards.flatMap((card) => {
            const cells = [...card.querySelectorAll("td")].filter((cell) => cell.getBoundingClientRect().width > 0);
            return cells.flatMap((a, index) =>
              cells
                .slice(index + 1)
                .filter((b) => overlaps(a.getBoundingClientRect(), b.getBoundingClientRect()))
                .map((b) => `${index}|${a.textContent?.trim().slice(0, 10)}|${b.textContent?.trim().slice(0, 10)}`),
            );
          }),
          contentsLabel: view.getComputedStyle(doc.querySelector("#sckRows .sck-contents")!, "::before").content,
          // Only the contents field names itself: a date, a label, a size and a kind badge read as what they are.
          labelled: [...doc.querySelectorAll("#sckRows > tr:not(.group-row):not(.toggle-row) td")]
            .filter((cell) => cell.hasAttribute("data-label"))
            .map((cell) => cell.className),
          // The first and last fields of a card line up with the card's own padding, as the rest of the page does.
          padding: {
            card: Number.parseFloat(view.getComputedStyle(cards[0]!).paddingLeft),
            first: Math.round(cards[0]!.querySelector("td")!.getBoundingClientRect().left),
            cardLeft: Math.round(cards[0]!.getBoundingClientRect().left),
          },
          // Every card stays inside the wrapper, and no card is wider than the viewport.
          widest: Math.max(...cards.map((card) => Math.round(card.getBoundingClientRect().width))),
          wrapWidth: Math.round(wrap.getBoundingClientRect().width),
        };
      });
      expect(shape.row).toBe("grid");
      expect(shape.areas).toContain("label");
      expect(shape.areas).toContain("actions");
      expect(shape.header).toBe("none");
      expect(shape.fits).toEqual({ page: true, wrap: true, cards: true });
      expect(shape.overlaps).toEqual([]);
      expect(shape.contentsLabel).toContain("Contents");
      // Only the contents cell is labelled, so no other field repeats its column's name on the card.
      expect([...new Set(shape.labelled)]).toEqual(["sck-contents", "sck-contents sck-empty"]);
      expect(shape.labelled.length).toBeGreaterThan(1);
      // The first field starts where the card's padding ends, rather than being pushed out by the table's own padding.
      expect(shape.padding.first - shape.padding.cardLeft).toBe(shape.padding.card);
      expect(shape.widest).toBeLessThanOrEqual(shape.wrapWidth);
    },
    TIMEOUT_MS,
  );

  test(
    "the group header keeps a full-width row of its own, and the show-all button is still reachable",
    async () => {
      const head = page.locator("#sckRows tr.group-row").first();
      await webExpect(head).toBeVisible();
      const [headBox, wrapBox] = await Promise.all([head.boundingBox(), page.locator("#sckWrap").boundingBox()]);
      if (!headBox || !wrapBox) throw new Error("the group header has no layout box");
      expect(Math.abs(headBox.width - wrapBox.width)).toBeLessThanOrEqual(1);
      const toggle = page.locator("#sckRows .toggle-row button");
      await webExpect(toggle).toBeVisible();
      await toggle.click();
      await webExpect(toggle).toContainText("Show less");
    },
    TIMEOUT_MS,
  );

  test(
    "a checkpoint with no data leaves the contents line out instead of drawing a dash",
    async () => {
      const empty = page.locator("#sckRows tr", { hasText: "no data at all" });
      await webExpect(empty).toBeVisible();
      await webExpect(empty.locator(".sck-empty")).toBeHidden();
      await webExpect(empty.locator(".sck-contents")).toHaveCount(1);
      // The row is still there, with its label and its actions.
      await webExpect(empty.locator(".sck-label")).toBeVisible();
      await webExpect(empty.locator(".sck-actions button")).toHaveCount(4);
    },
    TIMEOUT_MS,
  );

  test(
    "the desktop table keeps every cell where it was",
    async () => {
      const desktopContext = await signedIn({ viewport: DESKTOP });
      const desktopPage = await desktopContext.newPage();
      try {
        await desktopPage.goto(`${consoleUrl}/#/storage/checkpoints`);
        await webExpect(desktopPage.locator("#sckRows .sck-label").first()).toBeVisible();
        const shape = await desktopPage.evaluate(() => {
          interface Box {
            width: number;
            height: number;
            left: number;
            top: number;
          }
          interface Node {
            getBoundingClientRect(): Box;
            scrollWidth: number;
            clientWidth: number;
            querySelector(selector: string): Node | null;
          }
          const view = globalThis as unknown as {
            document: Node & { querySelector(selector: string): Node | null };
            getComputedStyle(element: Node): { display: string };
          };
          const doc = view.document;
          const table = doc.querySelector(".sck-table")!;
          const row = doc.querySelector("#sckRows tr:not(.group-row)")!;
          return {
            table: view.getComputedStyle(table).display,
            row: view.getComputedStyle(row).display,
            wrap: doc.querySelector("#sckWrap")!.scrollWidth <= doc.querySelector("#sckWrap")!.clientWidth,
            // The six cells of the desktop row: time, label, kinds, contents, size, actions.
            cells: [...(row as unknown as { querySelectorAll(s: string): Node[] }).querySelectorAll("td")].map((cell) =>
              Math.round(cell.getBoundingClientRect().width),
            ),
            headers: [
              ...(table as unknown as { querySelectorAll(s: string): Node[] }).querySelectorAll("thead th"),
            ].map((cell) => Math.round(cell.getBoundingClientRect().width)),
            // The named columns of the colgroup, each keeping a width of its own on the desktop table.
            widths: [...(table as unknown as { querySelectorAll(s: string): Node[] }).querySelectorAll("colgroup col")]
              .map((col): [string, number] => [
                (col as unknown as { className: string }).className,
                Math.round(col.getBoundingClientRect().width),
              ])
              .filter(([name]) => name !== ""),
          };
        });
        expect(shape.table).toBe("table");
        expect(shape.row).toBe("table-row");
        expect(shape.cells.length).toBe(6);
        expect(shape.headers.length).toBe(6);
        // The cells line up under the headers they belong to.
        expect(shape.cells).toEqual(shape.headers);
        // The five named columns of the colgroup each take a width, so a long label cannot squeeze them to nothing.
        expect(shape.widths.map(([name]) => name)).toEqual([
          "sck-c-time",
          "sck-c-kind",
          "sck-c-contents",
          "sck-c-size",
          "sck-c-actions",
        ]);
        for (const [name, width] of shape.widths) expect([name, width > 0]).toEqual([name, true]);
      } finally {
        await desktopContext.close();
      }
    },
    TIMEOUT_MS,
  );
});
