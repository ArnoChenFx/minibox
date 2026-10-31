import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  chromium,
  expect as webExpect,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";

import type { App } from "../src/app";
import { ulid } from "../src/events/ulid";
import { startServer } from "../src/server";
import { sleepBox } from "../src/services/box-lifecycle";
import en from "../web/js/i18n/en.js";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";

const executablePath = chromiumFor("The Box detail test");
const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const TIMEOUT_MS = 30_000;
const RENAME_TIMEOUT_MS = 60_000;
const VIEWPORT = { width: 1280, height: 800 };

/** Matches the address a page ends on as a whole, so an extra segment or a query cannot pass by accident. */
const at = (hash: string) => (url: URL) => url.hash === hash;

const tab = (page: Page, label: string): Locator => page.locator("#view [role='tab']", { hasText: label });

const checkpointButton = (page: Page): Locator => page.locator(".detail-head [data-action='checkpoint']");

/** The English text of a dictionary key, which a locator looks for. */
const english = (key: string): string => en[key] ?? key;

const chipMeta = (page: Page, session: string): Locator =>
  page.locator(`.session-chip[data-session='${session}'] .chip-meta`);

/** A checkpoint opens the task drawer, which covers the page until it is closed. */
async function closeTaskDrawer(page: Page): Promise<void> {
  const drawer = page.locator("#taskDrawer");
  await webExpect(drawer).toBeVisible();
  await drawer.locator(".task-head [data-close]").click();
  await webExpect(drawer).toBeHidden();
}

interface BoxRow {
  id: string;
  boxId: string;
  name: string;
  revision: number;
  running: boolean;
  sleeping: boolean;
  /** `null` inherits the global default, `0` never sleeps, a positive number is the box's own timeout. */
  idleTimeoutSec: number | null;
  /** `null` means no TTL, a positive number is a lifetime counted from creation. */
  ttlSec: number | null;
}

interface CheckpointRow {
  boxId: string;
  label: string;
}

async function waitUntil(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe.skipIf(!executablePath)("the Box detail page (real browser)", () => {
  let app: App | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser;
  let context: BrowserContext | undefined;
  let page: Page;
  let consoleUrl = "";
  let bearer: Record<string, string> = {};
  let running: BoxRow;
  let stopped: BoxRow;

  async function signedIn(options: BrowserContextOptions = {}): Promise<BrowserContext> {
    const fresh = await browser.newContext(options);
    const login = await fresh.request.post(`${consoleUrl}/api/auth/login`, {
      data: { key: TEST_KEY },
      headers: { origin: consoleUrl },
    });
    expect(login.status()).toBe(200);
    return fresh;
  }

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

  async function boxNow(box: BoxRow): Promise<BoxRow> {
    const { box: fresh } = await rest<{ box: BoxRow }>("GET", `/api/boxes/${encodeURIComponent(box.boxId)}`);
    return fresh;
  }

  async function setRunning(box: BoxRow, wanted: boolean): Promise<void> {
    if ((await boxNow(box)).running === wanted) return;
    await rest("POST", `/api/boxes/${encodeURIComponent(box.boxId)}/${wanted ? "start" : "stop"}`);
    await waitUntil(async () => (await boxNow(box)).running === wanted, `${box.name} running=${wanted}`);
  }

  async function makeBox(name: string): Promise<BoxRow> {
    const { box } = await rest<{ box: BoxRow }>("POST", "/api/boxes", { name, cpus: 1, memoryMb: 512 });
    return box;
  }

  async function checkpointLabels(box: BoxRow): Promise<string[]> {
    const { checkpoints } = await rest<{ checkpoints: CheckpointRow[] }>("GET", "/api/checkpoints");
    return checkpoints.filter((checkpoint) => checkpoint.boxId === box.boxId).map((checkpoint) => checkpoint.label);
  }

  const boxUrl = (box: BoxRow, suffix = "") => `${consoleUrl}/#/boxes/${encodeURIComponent(box.id)}${suffix}`;

  beforeAll(async () => {
    const harness = createTestApp();
    app = harness.app;
    const keys = app.hosts.get().keys;
    harness.runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
    server = startServer(app);
    consoleUrl = `http://127.0.0.1:${server.port}`;
    bearer = { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}`, origin: consoleUrl };

    running = await makeBox("api");
    await setRunning(running, true);
    await rest("POST", `/api/boxes/${encodeURIComponent(running.boxId)}/sessions`, { name: "build" });

    stopped = await makeBox("cold");
    await setRunning(stopped, false);

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
    "box activity matches the overview's compact rows and keeps audit details available by keyboard and after refresh",
    async () => {
      if (!app) throw new Error("the console did not start");
      app.events.append({
        id: ulid(Date.now()),
        ts: Date.now(),
        durationMs: 0,
        status: "ok",
        op: "ssh.connect",
        kind: "write",
        principal: { type: "owner", id: "owner", name: "owner" },
        source: "ssh",
        hostId: "local",
        summary: "SSH connect",
        target: { kind: "box", id: running.id, name: running.name },
        detail: { user: "dev", method: "publickey" },
      });
      await page.goto(`${consoleUrl}/#/overview`);
      const homeRow = page.locator("#ovActivity li").filter({ hasText: "SSH connect" }).first();
      await webExpect(homeRow).toBeVisible();
      const homeSize = await homeRow.evaluate((row) => ({
        height: row.getBoundingClientRect().height,
        font: row.ownerDocument.defaultView?.getComputedStyle(row).fontSize,
        icon: row.querySelector(".ico")?.getBoundingClientRect().width,
      }));

      await page.goto(boxUrl(running, "/activity"));
      const entry = page.locator(".event-entry").filter({ hasText: "SSH connect" }).first();
      const summary = entry.locator("summary.activity-summary");
      await webExpect(summary).toBeVisible();
      const boxSize = await summary.evaluate((row) => ({
        height: row.getBoundingClientRect().height,
        font: row.ownerDocument.defaultView?.getComputedStyle(row).fontSize,
        icon: row.querySelector(".ico")?.getBoundingClientRect().width,
      }));
      expect(Math.abs(homeSize.height - boxSize.height)).toBeLessThanOrEqual(1);
      expect(boxSize.font).toBe(homeSize.font);
      expect(boxSize.icon).toBe(homeSize.icon);
      await webExpect(entry.locator(".event-expanded")).toBeHidden();
      await webExpect(summary.locator("time")).toHaveAttribute("title", /\d{4}/);
      await summary.focus();
      await page.keyboard.press("Enter");
      await webExpect(entry.locator(".event-meta")).toContainText("SSH");
      await entry.locator(".event-json summary").click();
      await webExpect(entry.locator("pre")).toContainText('"method": "publickey"');
      await Promise.all([
        page.waitForResponse((response) => response.url().includes("/api/events?box=") && response.ok()),
        page.locator("#aRefresh").click(),
      ]);
      await webExpect(entry).toHaveAttribute("open", "");
      await summary.focus();
      await page.keyboard.press("Enter");
      await webExpect(entry.locator(".event-expanded")).toBeHidden();
      await page.setViewportSize({ width: 390, height: 844 });
      try {
        await webExpect(summary.locator(".time-full")).toBeHidden();
        await webExpect(summary.locator(".time-compact")).toBeVisible();
        expect(await summary.evaluate((row) => row.scrollWidth <= row.clientWidth)).toBe(true);
      } finally {
        await page.setViewportSize(VIEWPORT);
      }
    },
    TIMEOUT_MS,
  );

  describe("the tabs", () => {
    test(
      "are Overview, Terminal, Files, Ports, Activity and Settings, in that order",
      async () => {
        await page.goto(boxUrl(running));
        await webExpect(page.locator("#view [role='tab']")).toHaveText([
          "Overview",
          "Terminal",
          "Files",
          "Ports",
          "Activity",
          "Settings",
        ]);
      },
      TIMEOUT_MS,
    );

    test(
      "are 概览, 终端, 文件, 端口, 活动 and 设置 in Chinese",
      async () => {
        const zh = await signedIn({ locale: "zh-CN", viewport: VIEWPORT });
        try {
          const zhPage = await zh.newPage();
          await zhPage.goto(boxUrl(running));
          await webExpect(zhPage.locator("#view [role='tab']")).toHaveText([
            "概览",
            "终端",
            "文件",
            "端口",
            "活动",
            "设置",
          ]);
        } finally {
          await zh.close();
        }
      },
      TIMEOUT_MS,
    );

    test(
      "each opens its own address, marks only itself as selected, and shows its content",
      async () => {
        await page.goto(boxUrl(running));
        const steps = [
          ["Overview", "", page.locator("#ovMain")],
          ["Terminal", "/terminal", page.locator("#tSessions")],
          ["Files", "/files", page.locator("#fbCard")],
          ["Ports", "/ports", page.locator("#tabBody h3", { hasText: english("bd.portsTitle") }).first()],
          ["Activity", "/activity", page.locator("#tabBody").getByText(english("bd.dockerLogs")).first()],
          ["Settings", "/settings", page.locator(".settings-nav")],
        ] as const;
        for (const [label, path, shown] of steps) {
          await tab(page, label).click();
          await webExpect(page).toHaveURL(at(`#/boxes/${encodeURIComponent(running.id)}${path}`));
          await webExpect(shown).toBeVisible();
          await webExpect(tab(page, label)).toHaveAttribute("aria-selected", "true");
          await webExpect(page.locator("#view [role='tab'][aria-selected='true']")).toHaveCount(1);
        }
      },
      TIMEOUT_MS,
    );

    test(
      "the arrow keys walk the strip without opening a tab, and Home and End jump to its ends",
      async () => {
        await page.goto(boxUrl(running));
        // The page's globals are not in this project's tsconfig, so they are read through one cast, as other browser
        // tests do.
        const focused = (): Promise<string | null> =>
          page.evaluate(() => {
            const active = (
              globalThis as unknown as {
                document: {
                  activeElement: { getAttribute(name: string): string | null; textContent: string | null } | null;
                };
              }
            ).document.activeElement;
            return active && active.getAttribute("role") === "tab" ? (active.textContent?.trim() ?? null) : null;
          });
        await tab(page, "Overview").focus();
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowRight");
        expect(await focused()).toBe("Files");
        // Focus moves; the address and the open tab stay put until Enter or a click.
        await webExpect(page).toHaveURL(at(`#/boxes/${encodeURIComponent(running.id)}`));
        await webExpect(tab(page, "Overview")).toHaveAttribute("aria-selected", "true");
        await page.keyboard.press("ArrowLeft");
        expect(await focused()).toBe("Terminal");
        await page.keyboard.press("End");
        expect(await focused()).toBe("Settings");
        await page.keyboard.press("ArrowRight");
        expect(await focused()).toBe("Overview");
        await page.keyboard.press("Home");
        expect(await focused()).toBe("Overview");
        await page.keyboard.press("ArrowLeft");
        expect(await focused()).toBe("Settings");
        // Enter then opens the tab the keys reached.
        await page.keyboard.press("Enter");
        await webExpect(page).toHaveURL(at(`#/boxes/${encodeURIComponent(running.id)}/settings`));
        await webExpect(tab(page, "Settings")).toHaveAttribute("aria-selected", "true");
      },
      TIMEOUT_MS,
    );

    test(
      "Overview keeps the metrics and the details, and none of the settings cards",
      async () => {
        await page.goto(boxUrl(running));
        await webExpect(page.locator("#ovMain .metric-value")).toHaveCount(3);
        await webExpect(page.locator("#ovMain")).toContainText(english("bd.info"));
        for (const card of ["#ovEgress", "#ovEnv", "#ovStartup", "#ovMounts"]) {
          await webExpect(page.locator(card)).toHaveCount(0);
        }
      },
      TIMEOUT_MS,
    );

    test(
      "Overview fits the window without scrolling",
      async () => {
        await page.goto(boxUrl(running));
        await webExpect(page.locator("#ovMain")).toBeVisible();
        const size = await page.evaluate(() => {
          const view = globalThis as unknown as {
            document: { documentElement: { scrollHeight: number } };
            innerHeight: number;
          };
          return { scroll: view.document.documentElement.scrollHeight, height: view.innerHeight };
        });
        expect(size.scroll).toBeLessThanOrEqual(size.height);
      },
      TIMEOUT_MS,
    );
  });

  describe("the Settings tab", () => {
    test(
      "lists seven sections in order, and opens the first one when the address names none",
      async () => {
        await page.goto(boxUrl(running, "/settings"));
        await webExpect(page.locator(".settings-nav a")).toHaveText([
          "Resources",
          "Storage and mounts",
          "Tools",
          "Environment variables",
          "Lifecycle",
          "Security",
          "Checkpoints",
        ]);
        await webExpect(page.locator(".settings-nav [aria-current='page']")).toHaveText("Resources");
      },
      TIMEOUT_MS,
    );

    test(
      "a section opens from its link, and its address names it",
      async () => {
        await page.goto(boxUrl(running, "/settings"));
        await page.locator(".settings-nav a", { hasText: "Lifecycle" }).click();
        await webExpect(page).toHaveURL(at(`#/boxes/${encodeURIComponent(running.id)}/settings/lifecycle`));
        await webExpect(page.locator(".settings-nav [aria-current='page']")).toHaveText("Lifecycle");
        await webExpect(page.locator("#bsLifecycle h3")).toHaveText(english("bd.setLifecycle"));
      },
      TIMEOUT_MS,
    );

    test(
      "the Lifecycle card changes the idle timeout and the TTL in place, and the rows show the saved values",
      async () => {
        await page.goto(boxUrl(running, "/settings/lifecycle"));
        const card = page.locator("#bsLifecycle");
        await webExpect(card.locator(".kv")).toContainText(english("bd.idleInherit"));
        await card.locator("[data-lc-action='edit']").click();
        await card.locator("[data-lc-idle-mode='custom']").click();
        await card.locator("[data-lc-value='idle']").fill("30");
        await card.locator("[data-lc-unit='idle']").selectOption("minutes");
        await card.locator("[data-lc-ttl-mode='set']").click();
        await card.locator("[data-lc-value='ttl']").fill("2");
        await card.locator("[data-lc-unit='ttl']").selectOption("hours");
        await card.locator("[data-lc-action='save']").click();
        await webExpect.poll(async () => (await boxNow(running)).idleTimeoutSec).toBe(1800);
        expect(await boxNow(running)).toMatchObject({ idleTimeoutSec: 1800, ttlSec: 7200 });
        // The card returns to its rows and shows what the box now holds, without a reload.
        await webExpect(card.locator(".kv")).toContainText("1800 s");
        await webExpect(card.locator(".kv")).toContainText("7200 s");

        // The two other choices clear a value: the global default for the idle timeout, no TTL for the lifetime.
        await card.locator("[data-lc-action='edit']").click();
        await card.locator("[data-lc-idle-mode='inherit']").click();
        await card.locator("[data-lc-ttl-mode='none']").click();
        await card.locator("[data-lc-action='save']").click();
        await webExpect.poll(async () => (await boxNow(running)).ttlSec).toBeNull();
        expect(await boxNow(running)).toMatchObject({ idleTimeoutSec: null, ttlSec: null });
        await webExpect(card.locator(".kv")).toContainText(english("bd.idleInherit"));
        await webExpect(card.locator(".kv")).toContainText(english("bd.ttlNone"));
      },
      TIMEOUT_MS,
    );

    test(
      "the Lifecycle card refuses a lifetime the server would refuse, and keeps the editor open",
      async () => {
        await page.goto(boxUrl(running, "/settings/lifecycle"));
        const card = page.locator("#bsLifecycle");
        await card.locator("[data-lc-action='edit']").click();
        await card.locator("[data-lc-idle-mode='custom']").click();
        await card.locator("[data-lc-value='idle']").fill("0");
        await card.locator("[data-lc-action='save']").click();
        await webExpect(card.locator("[data-lc-error]")).toHaveText(
          english("lc.idleInvalid").replace("{max}", "31536000"),
        );
        // The editor stays open, so the number can be corrected where it is.
        await webExpect(card.locator("[data-lc-action='save']")).toBeVisible();
        expect((await boxNow(running)).idleTimeoutSec).toBeNull();
        await card.locator("[data-lc-action='cancel']").click();
        await webExpect(card.locator("[data-lc-action='edit']")).toBeVisible();
      },
      TIMEOUT_MS,
    );

    test(
      "the tool groups start open, a group folds from its header, and a search shows its matches inside it",
      async () => {
        await page.goto(boxUrl(running, "/settings/tools"));
        const toggles = page.locator("#bdToolRows .group-toggle");
        await webExpect(toggles.first()).toBeVisible();
        for (const toggle of await toggles.all()) await webExpect(toggle).toHaveAttribute("aria-expanded", "true");
        const codex = page.locator("#bdToolRows td.mono", { hasText: /^codex$/ });
        await webExpect(codex).toBeVisible();
        await toggles.first().click();
        await webExpect(page.locator("#bdToolRows .group-toggle").first()).toHaveAttribute("aria-expanded", "false");
        await page.locator("#bdToolSearch input").fill("codex");
        await webExpect(codex).toBeVisible();
      },
      TIMEOUT_MS,
    );

    test(
      "a tools address from before the tabs changed opens the Tools section",
      async () => {
        await page.goto(boxUrl(running, "/tools"));
        await webExpect(page).toHaveURL(at(`#/boxes/${encodeURIComponent(running.id)}/settings/tools`));
        await webExpect(page.locator(".settings-nav [aria-current='page']")).toHaveText("Tools");
      },
      TIMEOUT_MS,
    );
  });

  describe("the title-bar checkpoint button", () => {
    test(
      "takes a checkpoint from the overview, and the Checkpoints section lists it",
      async () => {
        await page.goto(boxUrl(running));
        await checkpointButton(page).click();
        await page.locator("#ckLabel").fill("from the title bar");
        await page.locator("#ckTakeOk").click();
        await webExpect.poll(() => checkpointLabels(running)).toContain("from the title bar");
        await closeTaskDrawer(page);
        await page.goto(boxUrl(running, "/settings/checkpoints"));
        await webExpect(page.locator("#view")).toContainText("from the title bar");
      },
      TIMEOUT_MS,
    );

    test(
      "cancelling the dialog takes no checkpoint",
      async () => {
        await page.goto(boxUrl(running));
        await checkpointButton(page).click();
        await page.locator("#ckLabel").fill("never taken");
        await page.locator(".dialog-foot [data-close]").click();
        await webExpect(page.locator(".dialog")).toHaveCount(0);
        expect(await checkpointLabels(running)).not.toContain("never taken");
      },
      TIMEOUT_MS,
    );

    test(
      "on the Checkpoints section the new checkpoint is listed without a reload",
      async () => {
        await page.goto(boxUrl(running, "/settings/checkpoints"));
        await webExpect(page.locator("#view")).toContainText("from the title bar");
        await page.evaluate(() => {
          (globalThis as unknown as { pageMarker?: string }).pageMarker = "same page";
        });
        await checkpointButton(page).click();
        await page.locator("#ckLabel").fill("without a reload");
        await page.locator("#ckTakeOk").click();
        await webExpect(page.locator("#view")).toContainText("without a reload");
        const marker = await page.evaluate(() => (globalThis as unknown as { pageMarker?: string }).pageMarker);
        expect(marker).toBe("same page");
        await closeTaskDrawer(page);
      },
      TIMEOUT_MS,
    );

    test(
      "a card's toolbar keeps the title bar's gap between its buttons, on Checkpoints and on Ports",
      async () => {
        for (const tab of ["/settings/checkpoints", "/ports"]) {
          await page.goto(boxUrl(running, tab));
          const buttons = page.locator("#tabBody .card-head .actions > .btn");
          await webExpect(buttons.nth(1)).toBeVisible();
          const gaps = await buttons.evaluateAll((list) =>
            list.slice(1).map((b, i) => b.getBoundingClientRect().left - list[i]!.getBoundingClientRect().right),
          );
          const titleBarGap = await page
            .locator(".detail-head .page-actions")
            .evaluate((bar) => parseFloat(bar.ownerDocument.defaultView!.getComputedStyle(bar).columnGap));
          expect(titleBarGap).toBe(8);
          for (const gap of gaps) expect([tab, Math.round(gap)]).toEqual([tab, titleBarGap]);
        }
      },
      TIMEOUT_MS,
    );
  });

  describe("terminal sessions", () => {
    test(
      "a session the agent created reads Created by agent, and one created in the console reads Created by you",
      async () => {
        await page.goto(boxUrl(running, "/terminal"));
        await webExpect(chipMeta(page, "build")).toHaveText("Created by agent");
        await page.locator("#tNew").click();
        await page.locator("#pd-input").fill("console-made");
        await page.locator("#pd-ok").click();
        await webExpect(page.locator(".session-chip[data-session='console-made']")).toHaveAttribute(
          "title",
          "Created by you",
        );
        await webExpect(chipMeta(page, "console-made")).toHaveText("Created by you");
        await webExpect(chipMeta(page, "build")).toHaveText("Created by agent");
      },
      TIMEOUT_MS,
    );
  });

  describe("waking a sleeping box from the terminal", () => {
    test(
      "Wake starts the box and opens its terminal in place",
      async () => {
        const host = app?.hosts.get();
        if (!host) throw new Error("the test server is not running");
        const sleeper = await makeBox("nap");
        await setRunning(sleeper, true);
        expect(await sleepBox(host, sleeper.boxId, "idle")).toBe(true);
        expect(await boxNow(sleeper)).toMatchObject({ running: false, sleeping: true });

        await page.goto(boxUrl(sleeper, "/terminal"));
        await page.locator("#tabBody [data-action='wake']").click();

        await webExpect(page.locator("#tSessions")).toBeVisible();
        await webExpect(page.locator(".session-chip[data-session='console']")).toBeVisible();
        expect(await boxNow(sleeper)).toMatchObject({ running: true, sleeping: false });
      },
      TIMEOUT_MS,
    );
  });

  describe("the Files tab", () => {
    test(
      "shows the file browser while the box is stopped",
      async () => {
        await page.goto(boxUrl(stopped, "/files"));
        await webExpect(page.locator("#fbCard")).toBeVisible();
      },
      TIMEOUT_MS,
    );
  });

  describe("the page header", () => {
    test(
      "the toolbar is right-aligned on a wide and on a narrow window, and never covers the name",
      async () => {
        try {
          for (const viewport of [
            VIEWPORT,
            { width: 1440, height: 900 },
            { width: 1920, height: 1000 },
            { width: 720, height: 800 },
          ]) {
            await page.setViewportSize(viewport);
            await page.goto(boxUrl(running));
            const toolbar = page.locator(".detail-head .page-actions");
            await webExpect(toolbar).toBeVisible();
            const [head, actions, deleteButton, title] = await Promise.all([
              page.locator(".detail-head").boundingBox(),
              toolbar.boundingBox(),
              page.locator(".detail-head [data-action='delete']").boundingBox(),
              page.locator(".detail-head .detail-title").boundingBox(),
            ]);
            if (!head || !actions || !deleteButton || !title) throw new Error("the header has no layout box");
            // The last button ends at the header's right edge, so the buttons on each line sit at the right.
            expect(Math.abs(deleteButton.x + deleteButton.width - (head.x + head.width))).toBeLessThanOrEqual(1);
            // The toolbar is either to the right of the title or below it, so it never covers the name.
            const beside = actions.x >= title.x + title.width;
            const below = actions.y >= title.y + title.height;
            expect(beside || below).toBe(true);
          }
        } finally {
          await page.setViewportSize(VIEWPORT);
        }
      },
      TIMEOUT_MS,
    );

    test(
      "on a phone the toolbar is one row, and the open tab and settings section are scrolled into view",
      async () => {
        try {
          await page.setViewportSize({ width: 390, height: 844 });
          await page.goto(boxUrl(running, "/settings/checkpoints"));
          await webExpect(page.locator(".settings-nav [aria-current='page']")).toBeVisible();
          const tops = await page
            .locator(".detail-head .page-actions > .btn")
            .evaluateAll((buttons) => new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top))).size);
          expect(tops).toBe(1);
          for (const selector of [".tabs [aria-selected='true']", ".settings-nav [aria-current='page']"]) {
            const box = await page.locator(selector).boundingBox();
            if (!box) throw new Error(`${selector} has no layout box`);
            expect([selector, box.x >= 0 && box.x + box.width <= 390]).toEqual([selector, true]);
          }
        } finally {
          await page.setViewportSize(VIEWPORT);
        }
      },
      TIMEOUT_MS,
    );
  });

  describe("addresses from before the tabs changed", () => {
    test(
      "each old tab address opens the place that replaced it",
      async () => {
        const id = encodeURIComponent(running.id);
        for (const [from, to, label] of [
          ["checkpoints", "settings/checkpoints", "Settings"],
          ["resources", "settings/resources", "Settings"],
          ["tools", "settings/tools", "Settings"],
          ["snapshots", "settings/checkpoints", "Settings"],
          ["logs", "activity", "Activity"],
        ] as const) {
          await page.goto(`${consoleUrl}/#/boxes/${id}/${from}`);
          await webExpect(page).toHaveURL(at(`#/boxes/${id}/${to}`));
          await webExpect(tab(page, label)).toHaveAttribute("aria-selected", "true");
        }
      },
      TIMEOUT_MS,
    );
  });

  describe("renaming a box", () => {
    let stopSampler: (() => void) | undefined;

    // The console's live frames come from the host sampler, which the other tests here do not need. Starting it makes this
    // describe see the frames a real install sends, so the lists can be checked without a reload.
    beforeAll(async () => {
      if (!app) throw new Error("the test server is not running");
      const sampler = app.hosts.get().sampler;
      sampler.start();
      stopSampler = () => sampler.stop();
      await waitUntil(async () => sampler.ready(), "the box sampler");
    });

    afterAll(() => stopSampler?.());

    test(
      "renaming a running box updates its page, its address and every list that shows the name",
      async () => {
        if (!context) throw new Error("the test browser context did not open");
        const listPage = await context.newPage();
        const overviewPage = await context.newPage();
        const pickerPage = await context.newPage();
        try {
          await Promise.all([
            listPage.goto(`${consoleUrl}/#/boxes`),
            overviewPage.goto(`${consoleUrl}/#/overview`),
            pickerPage.goto(`${consoleUrl}/#/library/tools`),
          ]);
          await webExpect(listPage.locator("#bxBody")).toContainText(running.name);
          await webExpect(overviewPage.locator("#ovBoxes")).toContainText(running.name);
          await webExpect(pickerPage.locator("#boxPick option").filter({ hasText: running.name })).toHaveCount(1);

          await page.goto(boxUrl(running));
          const before = await boxNow(running);
          expect(before.running).toBe(true);
          const newName = "api-renamed";
          await page.locator(".detail-head [data-action='rename']").click();
          await webExpect(page.locator("#rnName")).toHaveValue(before.name);
          await page.locator("#rnName").fill(newName);
          const sent = page.waitForRequest(
            (request) => request.method() === "PATCH" && new URL(request.url()).pathname === `/api/boxes/${running.id}`,
          );
          await page.locator("#rnSave").click();
          expect((await sent).headers()["if-match"]).toBe(String(before.revision));

          await webExpect(page.locator(".detail-head .detail-name")).toHaveText(newName);
          await webExpect(page.locator("#crumbs")).toContainText(newName);
          expect(await page.title()).toBe(`${newName} · MiniBox`);
          await webExpect(page).toHaveURL(at(`#/boxes/${encodeURIComponent(running.id)}`));
          await webExpect(page.locator(".toast").filter({ hasText: english("ba.renamed") })).toBeVisible();

          await webExpect(listPage.locator("#bxBody")).toContainText(newName);
          await webExpect(overviewPage.locator("#ovBoxes")).toContainText(newName);
          await webExpect(pickerPage.locator("#boxPick option").filter({ hasText: newName })).toHaveCount(1);
          expect((await boxNow(running)).name).toBe(newName);
        } finally {
          await Promise.all([listPage.close(), overviewPage.close(), pickerPage.close()]);
        }
      },
      RENAME_TIMEOUT_MS,
    );

    test(
      "a stopped box can be renamed too, and its breadcrumb and window title follow",
      async () => {
        const newName = "cold-renamed";
        expect((await boxNow(stopped)).running).toBe(false);
        await page.goto(boxUrl(stopped));
        await page.locator(".detail-head [data-action='rename']").click();
        await page.locator("#rnName").fill(newName);
        await page.locator("#rnSave").click();
        await webExpect(page.locator(".dialog")).toHaveCount(0);
        await webExpect(page.locator(".detail-head .detail-name")).toHaveText(newName);
        await webExpect(page.locator("#crumbs")).toContainText(newName);
        expect(await page.title()).toBe(`${newName} · MiniBox`);
        expect((await boxNow(stopped)).name).toBe(newName);
      },
      RENAME_TIMEOUT_MS,
    );

    test(
      "a name another box holds keeps the dialog open with the server's message and changes nothing",
      async () => {
        const first = await makeBox("rename-taken-a");
        const second = await makeBox("rename-taken-b");
        await page.goto(boxUrl(first));
        await page.locator(".detail-head [data-action='rename']").click();
        await page.locator("#rnName").fill(second.name);
        await page.locator("#rnSave").click();
        await webExpect(page.locator("#rnErr")).toContainText(second.name);
        await webExpect(page.locator("#rnErr")).toContainText("already exists");
        await webExpect(page.locator(".dialog")).toBeVisible();
        await webExpect(page.locator("#rnName")).toHaveValue(second.name);
        expect(await boxNow(first)).toMatchObject({ name: first.name, revision: first.revision });
        await page.locator(".dialog-head [data-close]").click();
        await webExpect(page.locator(".dialog")).toHaveCount(0);
      },
      RENAME_TIMEOUT_MS,
    );

    test(
      "a name that did not change closes the dialog without sending a request",
      async () => {
        const patches: string[] = [];
        const onRequest = (request: Request) => {
          if (request.method() === "PATCH" && new URL(request.url()).pathname.startsWith("/api/boxes/")) {
            patches.push(request.url());
          }
        };
        page.on("request", onRequest);
        try {
          await page.goto(boxUrl(running));
          await page.locator(".detail-head [data-action='rename']").click();
          await page.locator("#rnSave").click();
          await webExpect(page.locator(".dialog")).toHaveCount(0);
          expect(patches).toEqual([]);
        } finally {
          page.off("request", onRequest);
        }
      },
      RENAME_TIMEOUT_MS,
    );

    test(
      "an empty or malformed name is refused under the field and sends no request",
      async () => {
        const box = await makeBox("rename-invalid");
        const patches: string[] = [];
        const onRequest = (request: Request) => {
          if (request.method() === "PATCH" && new URL(request.url()).pathname.startsWith("/api/boxes/")) {
            patches.push(request.url());
          }
        };
        page.on("request", onRequest);
        try {
          await page.goto(boxUrl(box));
          await page.locator(".detail-head [data-action='rename']").click();
          await page.locator("#rnName").fill("");
          await page.locator("#rnSave").click();
          await webExpect(page.locator("#rnErr")).toHaveText(english("ui.nameRequired").replace("{what}", "box name"));
          await page.locator("#rnName").fill("not a name");
          await page.locator("#rnSave").click();
          await webExpect(page.locator("#rnErr")).toHaveText(english("ui.nameInvalid").replace("{what}", "Box name"));
          await webExpect(page.locator(".dialog")).toBeVisible();
          expect(patches).toEqual([]);
        } finally {
          page.off("request", onRequest);
        }
      },
      RENAME_TIMEOUT_MS,
    );

    test(
      "on a phone the rename button fits beside the name and the badge in English and in Chinese",
      async () => {
        const longBox = await makeBox("rename-layout-with-a-rather-long-name-0123456789abcdefghij");
        const measure = async (target: Page) => {
          await target.goto(boxUrl(longBox));
          await webExpect(target.locator(".detail-head [data-action='rename']")).toBeVisible();
          return target.evaluate(() => {
            interface Rect {
              x: number;
              y: number;
              width: number;
              height: number;
            }
            interface Element {
              getBoundingClientRect(): Rect;
              scrollWidth: number;
              clientWidth: number;
            }
            const view = globalThis as unknown as {
              innerWidth: number;
              innerHeight: number;
              document: {
                documentElement: { scrollWidth: number; clientWidth: number };
                querySelector(selector: string): Element | null;
              };
            };
            const rect = (selector: string): Rect => {
              const element = view.document.querySelector(selector);
              if (!element) throw new Error(`missing ${selector}`);
              return element.getBoundingClientRect();
            };
            const head = view.document.querySelector(".detail-head");
            if (!head) throw new Error("missing .detail-head");
            return {
              viewport: view.innerWidth,
              viewportHeight: view.innerHeight,
              scroll: view.document.documentElement.scrollWidth,
              client: view.document.documentElement.clientWidth,
              headScroll: head.scrollWidth,
              headClient: head.clientWidth,
              name: rect(".detail-head .detail-name"),
              button: rect(".detail-head [data-action='rename']"),
              badge: rect(".detail-head h1 .badge"),
            };
          });
        };
        try {
          await page.setViewportSize({ width: 390, height: 844 });
          const englishFits = await measure(page);
          const zh = await signedIn({ locale: "zh-CN", viewport: { width: 390, height: 844 } });
          let chineseFits: Awaited<ReturnType<typeof measure>>;
          try {
            const zhPage = await zh.newPage();
            chineseFits = await measure(zhPage);
          } finally {
            await zh.close();
          }
          for (const [language, fits] of [
            ["en-US", englishFits],
            ["zh-CN", chineseFits],
          ] as const) {
            expect([language, fits.scroll]).toEqual([language, fits.client]);
            expect([language, fits.headScroll]).toEqual([language, fits.headClient]);
            expect([language, fits.button.x >= 0]).toEqual([language, true]);
            expect([language, fits.button.x + fits.button.width <= fits.viewport]).toEqual([language, true]);
            expect([language, fits.button.y >= 0]).toEqual([language, true]);
            expect([language, fits.button.y + fits.button.height <= fits.viewportHeight]).toEqual([language, true]);
            expect([language, fits.name.width > 0]).toEqual([language, true]);
            expect([language, fits.button.x >= fits.name.x + fits.name.width]).toEqual([language, true]);
            expect([language, fits.button.x + fits.button.width <= fits.badge.x]).toEqual([language, true]);
          }
        } finally {
          await page.setViewportSize(VIEWPORT);
        }
      },
      RENAME_TIMEOUT_MS,
    );
  });
});
