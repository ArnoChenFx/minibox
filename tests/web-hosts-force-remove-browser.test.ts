import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type Browser, type BrowserContext, chromium, expect as webExpect, type Page } from "@playwright/test";
import type { Server } from "bun";

import { type App, createApp } from "../src/app";
import { startServer } from "../src/server";
import type { SocketData } from "../src/ws/socket";
import { silenceLogs, TEST_KEY, testConfig } from "./support/app";
import { chromiumFor } from "./support/chromium";
import { FakeRuntime } from "./support/fake-runtime";
import { FakeCheckpointEngine } from "./support/fake-snapshots";

const executablePath = chromiumFor("The host force-removal layout test");
const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const WIDTHS = [1100, 1024, 900, 600, 390, 360];
const LANGUAGES = ["en", "zh-CN"] as const;

/** An element as these measurements touch it. The page's own globals are not in this project's tsconfig. */
interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

interface ActionLayout {
  overflow: number;
  /** The table's width when squeezed to its minimum, so a wider second action shows up even when the card has room. */
  minWidth: number;
  viewport: number;
  remove: Rect;
  force: Rect;
}

/** Where the hosts table's two row actions sit, and how much the table overflows sideways. */
const measure = (page: Page): Promise<ActionLayout | null> =>
  page.evaluate(() => {
    interface El {
      scrollWidth: number;
      clientWidth: number;
      style: { width: string };
      getBoundingClientRect(): {
        left: number;
        right: number;
        top: number;
        bottom: number;
        width: number;
        height: number;
      };
    }
    const view = globalThis as unknown as {
      document: { querySelector(selector: string): El | null };
      innerWidth: number;
    };
    const wrap = view.document.querySelector("#stHosts .table-wrap");
    const table = view.document.querySelector("#stHosts .host-table");
    const remove = view.document.querySelector("#stHosts [data-remove-host='edge']");
    const force = view.document.querySelector("#stHosts [data-force-remove-host='edge']");
    if (!wrap || !table || !remove || !force) return null;
    const box = (el: El): Rect => {
      const rect = el.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };
    const overflow = wrap.scrollWidth - wrap.clientWidth;
    // Squeezed to 1px, the auto-layout table takes its minimum width. Restored before anything else is measured.
    table.style.width = "1px";
    const minWidth = table.getBoundingClientRect().width;
    table.style.width = "";
    return { overflow, minWidth, viewport: view.innerWidth, remove: box(remove), force: box(force) };
  });

/** Whether two boxes share any area. */
function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

describe.skipIf(!executablePath)("the host force-removal button fits the hosts table (real browser)", () => {
  let app: App;
  let server: Server<SocketData>;
  let base: string;
  let browser: Browser;

  beforeAll(async () => {
    const local = new FakeRuntime();
    const edge = new FakeRuntime();
    edge.engine = { cpus: 2, memoryBytes: 4 * 1024 ** 3 };
    app = createApp(testConfig({ labelPrefix: "mbtest", dockerSocket: "/d" }), "0.0.0-test", {
      runtime: local,
      connect: () => edge,
      checkpointEngine: new FakeCheckpointEngine(),
      eventsPath: ":memory:",
    });
    const keys = app.hosts.get().keys;
    for (const runtime of [local, edge]) {
      runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
    }
    server = startServer(app);
    base = `http://127.0.0.1:${server.port}`;
    // A remote host whose machine is gone: the row then offers Remove and Force remove.
    await app.hostAdmin.add({ id: "edge", endpoint: "unix:///test-force-remove.sock" });
    // Stop the probe loop so the host stays offline for every measurement.
    app.hostAdmin.close();
    app.hosts.get("edge").host.status = "offline";
    browser = await chromium.launch({ executablePath: executablePath ?? undefined, args: ["--no-sandbox"] });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    app.sessions.stop();
    app.tokens.stop();
    server.stop(true);
  });

  async function signedIn(language: string, width: number): Promise<BrowserContext> {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addInitScript((lang) => {
      (globalThis as unknown as { localStorage: { setItem(key: string, value: string): void } }).localStorage.setItem(
        "minibox.lang",
        lang as string,
      );
    }, language);
    expect(
      (
        await context.request.post(`${base}/api/auth/login`, {
          data: { key: TEST_KEY },
          headers: { origin: base },
        })
      ).status(),
    ).toBe(200);
    return context;
  }

  for (const language of LANGUAGES) {
    for (const width of WIDTHS) {
      test(`both buttons are whole and apart at ${width}px in ${language}`, async () => {
        const context = await signedIn(language, width);
        try {
          const page = await context.newPage();
          await page.goto(`${base}/#/settings/hosts`);
          await webExpect(page.locator('#stHosts [data-remove-host="edge"]')).toBeVisible();
          // The disk line under the row fills in later; wait for the reading so the measured layout is the finished one.
          await webExpect(page.locator('[data-disk-host="edge"] .host-disk-note')).toBeVisible();

          const layout = await measure(page);
          expect(layout).not.toBeNull();
          if (!layout) return;
          // The table never scrolls sideways, and both actions are whole and apart inside the viewport.
          expect(layout.overflow).toBe(0);
          expect(layout.remove.width).toBeGreaterThan(0);
          expect(layout.force.width).toBeGreaterThan(0);
          expect(overlaps(layout.remove, layout.force)).toBe(false);
          for (const box of [layout.remove, layout.force]) {
            expect(box.left).toBeGreaterThanOrEqual(0);
            expect(box.right).toBeLessThanOrEqual(layout.viewport);
          }

          // The second action does not widen the table: with it hidden, the table's minimum width is the same.
          await page.addStyleTag({ content: "[data-force-remove-host]{display:none!important}" });
          const baseline = await measure(page);
          expect(baseline?.overflow).toBe(0);
          expect(layout.minWidth).toBeLessThanOrEqual((baseline?.minWidth ?? 0) + 1);
        } finally {
          await context.close();
        }
      }, 30_000);
    }
  }
});
