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

const executablePath = chromiumFor("The terminal height test");

const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const TIMEOUT_MS = 30_000;
const PHONE = { width: 390, height: 844 };
/** The two desktop windows the reader asked about: a 1280x800 laptop and a 1440x900 one. */
const DESKTOPS = [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
];
/** The height the terminal was fixed at before this change, which a desktop has to grow past. */
const LEGACY_HEIGHT = 460;

/**
 * The terminal as the reader sees it: the screen's own box, the grabber's, the key row's, and whether anything spills out
 * of the window sideways. Every measurement is a rounded `getBoundingClientRect()`, so a frame pushed off the window or a
 * page that scrolls sideways shows up here.
 */
async function shape(page: Page) {
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
      querySelector(selector: string): Node | null;
      style: { getPropertyValue(name: string): string };
      getAttribute(name: string): string | null;
    }
    /** The document's own element, which is what a horizontal overflow is measured on. */
    interface Root extends Node {
      scrollWidth: number;
      clientWidth: number;
      scrollHeight: number;
    }
    const view = globalThis as unknown as {
      document: Node & { documentElement: Root; activeElement: Node | null };
      getComputedStyle(element: Node): { display: string; height: string; outlineWidth: string };
      innerWidth: number;
      innerHeight: number;
      scrollY: number;
    };
    const doc = view.document;
    const box = (node: Node | null) => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    const screen = doc.querySelector(".terminal");
    const grabber = doc.querySelector("#tGrabber");
    const keys = doc.querySelector("#tKeys");
    if (!screen || !grabber) throw new Error("the terminal has no screen or no grabber");
    return {
      screen: box(screen)!,
      grabber: box(grabber)!,
      keys: box(keys),
      frame: box(doc.querySelector(".terminal-frame"))!,
      help: box(doc.querySelector(".terminal-frame ~ .help, #view .help")),
      grabberDisplay: view.getComputedStyle(grabber).display,
      keysDisplay: keys ? view.getComputedStyle(keys).display : "none",
      grabberLabel: grabber.getAttribute("aria-label"),
      grabberTitle: grabber.getAttribute("title"),
      grabberRole: grabber.getAttribute("role"),
      grabberOrientation: grabber.getAttribute("aria-orientation"),
      grabberNow: Number(grabber.getAttribute("aria-valuenow")),
      grabberMax: Number(grabber.getAttribute("aria-valuemax")),
      termHeight: screen.style.getPropertyValue("--term-h"),
      focused: doc.activeElement === doc.querySelector(".xterm-helper-textarea"),
      focusedGrabber: doc.activeElement === grabber,
      fits: doc.documentElement.scrollWidth <= doc.documentElement.clientWidth,
      viewport: { width: view.innerWidth, height: view.innerHeight },
      scrollHeight: doc.documentElement.scrollHeight,
    };
  });
}

/** What xterm itself thinks its size is, which is what the panel sends to tmux. */
async function terminalSize(page: Page) {
  return page.evaluate(() => {
    const view = globalThis as unknown as { testTerminal?: { cols: number; rows: number } };
    const terminal = view.testTerminal;
    if (!terminal) throw new Error("the panel's xterm is not on the page");
    return { cols: terminal.cols, rows: terminal.rows };
  });
}

/**
 * A press of the pointer on the grabber, dragged `delta` pixels: positive travels down the window and makes the terminal
 * taller, since it is the frame's bottom edge that follows the pointer; negative travels up and makes it shorter.
 */
async function drag(page: Page, delta: number): Promise<void> {
  const grabber = page.locator("#tGrabber");
  await grabber.scrollIntoViewIfNeeded();
  const box = await grabber.boundingBox();
  if (!box) throw new Error("the grabber is not laid out");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + delta, { steps: 10 });
  await page.mouse.up();
}

let harness: { app: App; runtime: ReturnType<typeof createTestApp>["runtime"] } | undefined;
const harnessOf = () => {
  if (!harness) throw new Error("the test server is not running");
  return harness;
};

/** The sizes the fake tmux server was told, for the attach exec of the box's session. */
function attachedSizes(): { cols: number; rows: number }[] {
  const attach = harnessOf().runtime.execs.findLast((exec) => exec.spec.tty === true && exec.spec.cmd[0] === "tmux");
  if (!attach) throw new Error("the terminal never attached to a session");
  return attach.sizes;
}

describe.skipIf(!executablePath)("the terminal's height (real browser)", () => {
  let app: App | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser | undefined;
  let alpha = "";
  /** The box as the API names it, which is what the fake tmux server keys its sessions by. */
  let consoleBoxId = "";
  let consoleUrl = "";

  /** A context signed in to the console, with the panel's xterm kept for a test that reads its size. */
  async function signedIn(options: BrowserContextOptions = {}): Promise<BrowserContext> {
    const fresh = await browser!.newContext(options);
    await fresh.addInitScript(`
      let constructor;
      Object.defineProperty(window, "Terminal", {
        configurable: true,
        get() { return constructor; },
        set(value) {
          const open = value.prototype.open;
          value.prototype.open = function (...args) {
            window.testTerminal = this;
            return open.apply(this, args);
          };
          constructor = value;
        },
      });
    `);
    const login = await fresh.request.post(`${consoleUrl}/api/auth/login`, {
      data: { key: TEST_KEY },
      headers: { origin: consoleUrl },
    });
    expect(login.status()).toBe(200);
    return fresh;
  }

  const terminalUrl = (boxId = alpha) => `${consoleUrl}/#/boxes/${boxId}/terminal`;

  /** Opens the terminal and waits for the session to be one a person may type in, which is the socket being live. */
  async function openTerminal(page: Page, boxId = alpha): Promise<void> {
    await page.goto(terminalUrl(boxId));
    await webExpect(page.locator("#term")).toBeAttached();
    await webExpect(page.locator("#tStatus")).toHaveClass(/on/, { timeout: 15_000 });
    await webExpect(page.locator(".xterm-helper-textarea")).toBeFocused();
  }

  beforeAll(async () => {
    const created = createTestApp();
    harness = created;
    app = created.app;
    const host = app.hosts.get();
    created.runtime.seedImage(app.cfg.baseTemplateTag, {
      [host.keys.template]: "true",
      [host.keys.templateName]: "base",
    });
    server = startServer(app);
    consoleUrl = `http://127.0.0.1:${server.port}`;
    const first = await boxes.createBox(host, { name: "alpha", cpus: 1, memoryMb: 512, createdBy: "owner" });
    alpha = first.boxId;
    consoleBoxId = first.id;
    browser = await chromium.launch({ executablePath: executablePath ?? undefined, args: ["--no-sandbox"] });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
    app?.throttle.stop();
    app?.sessions.stop();
    app?.tokens.stop();
    app?.events.close();
  });

  describe("on a desktop", () => {
    for (const viewport of DESKTOPS) {
      test(
        `at ${viewport.width}x${viewport.height} the terminal is taller than the old ${LEGACY_HEIGHT}px and still fits the window`,
        async () => {
          const context = await signedIn({ viewport });
          try {
            const page = await context.newPage();
            await openTerminal(page);
            const seen = await shape(page);
            // The empty band under a 460px frame is gone: the screen takes the room the window leaves.
            expect(seen.screen.height).toBeGreaterThan(LEGACY_HEIGHT);
            // And the frame is not pushed so far down that the reader has to scroll to find it.
            expect(seen.screen.top).toBeLessThan(viewport.height);
            expect(seen.screen.bottom).toBeLessThan(viewport.height + 200);
            // Nothing spills out of the window sideways, and the page still scrolls up and down as it always did.
            expect(seen.fits).toBe(true);
            expect(seen.scrollHeight).toBeGreaterThan(viewport.height);
            // The grabber is drawn under the screen, and it is the desktop's: a phone hides it.
            expect(seen.grabberDisplay).toBe("flex");
            expect(seen.grabber.height).toBeGreaterThanOrEqual(8);
            expect(Math.abs(seen.grabber.top - seen.screen.bottom)).toBeLessThanOrEqual(1);
            expect(seen.grabberRole).toBe("separator");
            expect(seen.grabberOrientation).toBe("horizontal");
            // What the reader sees is the height the module worked out, and xterm is fitted to it.
            expect(seen.termHeight).toBe(`${seen.screen.height}px`);
            expect(seen.grabberNow).toBe(seen.screen.height);
            expect(seen.grabberMax).toBeGreaterThanOrEqual(seen.screen.height);
            expect((await terminalSize(page)).rows).toBeGreaterThan(10);
            await page.screenshot({ path: `/tmp/terminal-height-${viewport.width}x${viewport.height}.png` });
          } finally {
            await context.close();
          }
        },
        TIMEOUT_MS,
      );
    }

    test(
      "the grabber is named in English, focusable, and its focus ring is visible",
      async () => {
        const context = await signedIn({ viewport: DESKTOPS[0]! });
        try {
          const page = await context.newPage();
          await openTerminal(page);
          await webExpect(page.locator("#tGrabber")).toHaveAttribute("aria-label", "Terminal height");
          await webExpect(page.locator("#tGrabber")).toHaveAttribute("title", /Drag to make the terminal taller/);
          await webExpect(page.locator("#tGrabber")).toHaveAttribute("tabindex", "0");
          // Tab reaches it: xterm keeps Tab for itself, so the grabber comes before the screen in the page and the
          // stylesheet puts it last in the frame. The focus it draws is the visible outline, not an invisible one.
          await page.locator("#tReconnect").focus();
          let reached = false;
          for (let press = 0; press < 5 && !reached; press += 1) {
            await page.keyboard.press("Tab");
            reached = await page.evaluate(() => {
              const view = globalThis as unknown as { document: { activeElement: { id: string } | null } };
              return view.document.activeElement?.id === "tGrabber";
            });
          }
          expect(reached).toBe(true);
          await webExpect(page.locator("#tGrabber")).toBeFocused();
          const outline = await page.locator("#tGrabber").evaluate((node) => {
            const style = node.ownerDocument.defaultView!.getComputedStyle(node);
            return { width: style.outlineWidth, style: style.outlineStyle, color: style.outlineColor };
          });
          expect(Number.parseFloat(outline.width)).toBeGreaterThanOrEqual(2);
          expect(outline.style).toBe("solid");
          // Its ends read as the range a drag may take.
          await webExpect(page.locator("#tGrabber")).toHaveAttribute("aria-valuemin", "240");
        } finally {
          await context.close();
        }
      },
      TIMEOUT_MS,
    );

    test(
      "a drag makes the terminal shorter or taller, xterm refits, and tmux is told the new size",
      async () => {
        const context = await signedIn({ viewport: DESKTOPS[0]! });
        try {
          const page = await context.newPage();
          await openTerminal(page);
          const before = await shape(page);
          const beforeSize = await terminalSize(page);
          const told = attachedSizes().length;

          await drag(page, 80);
          await page.waitForTimeout(300);
          const taller = await shape(page);
          expect(taller.screen.height).toBeGreaterThan(before.screen.height);
          expect(taller.grabberNow).toBe(taller.screen.height);
          // xterm recomputed its columns and rows for the taller screen, and the panel's `onResize` sent them on: the
          // attach exec inside the box was told a new size, which is what tmux needs to redraw.
          const grown = await terminalSize(page);
          expect(grown.rows).toBeGreaterThan(beforeSize.rows);
          expect(attachedSizes().length).toBeGreaterThan(told);
          expect(attachedSizes().at(-1)).toEqual(grown);

          await drag(page, -60);
          await page.waitForTimeout(300);
          const shorter = await shape(page);
          expect(shorter.screen.height).toBeLessThan(taller.screen.height);
          expect(attachedSizes().at(-1)).toEqual(await terminalSize(page));
          // The page still fits the window sideways, and nothing was left selected by the drag.
          expect(shorter.fits).toBe(true);
          const selection = await page.evaluate(() => {
            const view = globalThis as unknown as { getSelection(): { toString(): string } | null };
            return view.getSelection()?.toString() ?? "";
          });
          expect(selection).toBe("");
        } finally {
          await context.close();
        }
      },
      TIMEOUT_MS,
    );

    test(
      "the height the reader dragged is remembered across a reload, another box and another session",
      async () => {
        const context = await signedIn({ viewport: DESKTOPS[0]! });
        try {
          const page = await context.newPage();
          await openTerminal(page);
          const start = await shape(page);
          await drag(page, 80);
          await page.waitForTimeout(300);
          const chosen = (await shape(page)).screen.height;
          expect(chosen).toBeGreaterThan(start.screen.height);

          await page.reload();
          await webExpect(page.locator("#tStatus")).toHaveClass(/on/, { timeout: 15_000 });
          expect((await shape(page)).screen.height).toBe(chosen);

          // Another box: the height is the reader's, not the box's.
          const host = harnessOf().app.hosts.get();
          const second = await boxes.createBox(host, { name: "gamma", cpus: 1, memoryMb: 512, createdBy: "owner" });
          await openTerminal(page, second.boxId);
          expect((await shape(page)).screen.height).toBe(chosen);

          // Another session of the first box: still the same height.
          await page.goto(terminalUrl());
          await webExpect(page.locator("#tStatus")).toHaveClass(/on/, { timeout: 15_000 });
          await page.locator("#tNew").click();
          await page.locator(".dialog input").fill("second");
          await page.locator(".dialog .btn-primary").click();
          await webExpect(page.locator('#tSessions [data-session="second"]')).toHaveAttribute("aria-pressed", "true", {
            timeout: 15_000,
          });
          await webExpect(page.locator("#tStatus")).toHaveClass(/on/, { timeout: 15_000 });
          expect((await shape(page)).screen.height).toBe(chosen);
          expect(await page.evaluate(() => localStorage.getItem("minibox:termHeight:v1"))).toBe(String(chosen));
        } finally {
          await context.close();
        }
      },
      TIMEOUT_MS,
    );

    test(
      "a window made smaller clamps the height, and a window that grows back gives it back",
      async () => {
        const context = await signedIn({ viewport: { width: 1280, height: 1000 } });
        try {
          const page = await context.newPage();
          await openTerminal(page);
          await drag(page, 200);
          await page.waitForTimeout(300);
          const tall = (await shape(page)).screen.height;
          expect(tall).toBeGreaterThan(LEGACY_HEIGHT);

          // A 700px window leaves 400px for the screen, so the remembered height cannot be drawn as it is: it is clamped
          // to what fits rather than dropped.
          await page.setViewportSize({ width: 1280, height: 700 });
          await page.waitForTimeout(400);
          const small = await shape(page);
          expect(small.screen.height).toBeLessThan(tall);
          expect(small.screen.height).toBe(small.grabberMax);
          expect(small.fits).toBe(true);

          // Growing the window back brings the height the reader asked for back, since it was kept, not overwritten.
          await page.setViewportSize({ width: 1280, height: 1000 });
          await page.waitForTimeout(400);
          expect((await shape(page)).screen.height).toBe(tall);
        } finally {
          await context.close();
        }
      },
      TIMEOUT_MS,
    );

    test(
      "the arrow keys step the height, Home and End restore the default, and a double click does the same",
      async () => {
        const context = await signedIn({ viewport: { width: 1280, height: 1000 } });
        try {
          const page = await context.newPage();
          await openTerminal(page);
          await page.locator("#tGrabber").focus();
          const start = (await shape(page)).screen.height;

          // Up grows the terminal, a step at a time, and Down shrinks it.
          await page.keyboard.press("ArrowUp");
          await page.waitForTimeout(200);
          const up = await shape(page);
          expect(up.screen.height).toBe(start + 24);
          expect(up.focusedGrabber).toBe(true);
          expect(attachedSizes().at(-1)).toEqual(await terminalSize(page));

          await page.keyboard.press("ArrowDown");
          await page.keyboard.press("ArrowDown");
          await page.waitForTimeout(200);
          const down = await shape(page);
          expect(down.screen.height).toBe(start - 24);
          expect(await page.evaluate(() => localStorage.getItem("minibox:termHeight:v1"))).toBe(String(start - 24));

          // Home puts the default height back and forgets the reader's own, so the screen follows the window again.
          await page.keyboard.press("Home");
          await page.waitForTimeout(200);
          expect((await shape(page)).screen.height).toBe(start);
          expect(await page.evaluate(() => localStorage.getItem("minibox:termHeight:v1"))).toBeNull();

          // End does the same from a dragged height, and so does a double click on the grabber.
          await drag(page, 60);
          await page.waitForTimeout(300);
          expect((await shape(page)).screen.height).not.toBe(start);
          await page.keyboard.press("End");
          await page.waitForTimeout(200);
          expect((await shape(page)).screen.height).toBe(start);

          await drag(page, 60);
          await page.waitForTimeout(300);
          expect((await shape(page)).screen.height).not.toBe(start);
          await page.locator("#tGrabber").dblclick();
          await page.waitForTimeout(300);
          const restored = await shape(page);
          expect(restored.screen.height).toBe(start);
          expect(await page.evaluate(() => localStorage.getItem("minibox:termHeight:v1"))).toBeNull();
        } finally {
          await context.close();
        }
      },
      TIMEOUT_MS,
    );

    test(
      "a drag leaves the terminal able to type, so the next character still reaches the session",
      async () => {
        const context = await signedIn({ viewport: DESKTOPS[0]! });
        try {
          const page = await context.newPage();
          await openTerminal(page);
          await drag(page, 60);
          await page.waitForTimeout(300);
          expect((await shape(page)).focused).toBe(true);
          const before = (harnessOf().runtime.tmux.paneText(consoleBoxId, "console") ?? "").length;
          await page.keyboard.type("h");
          const typed = [...(harnessOf().runtime.tmux.paneText(consoleBoxId, "console") ?? "")].slice(before);
          expect(typed).toEqual(["h"]);
        } finally {
          await context.close();
        }
      },
      TIMEOUT_MS,
    );

    test(
      "the grabber is 终端高度 in Chinese, with a hint that says how it works",
      async () => {
        const context = await signedIn({ locale: "zh-CN", viewport: DESKTOPS[0]! });
        try {
          const page = await context.newPage();
          await openTerminal(page);
          await webExpect(page.locator("#tGrabber")).toHaveAttribute("aria-label", "终端高度");
          await webExpect(page.locator("#tGrabber")).toHaveAttribute("title", /拖动/);
        } finally {
          await context.close();
        }
      },
      TIMEOUT_MS,
    );
  });

  describe("on a 390x844 phone", () => {
    test(
      "there is no grabber, the terminal keeps min(52vh, 340px), and the key row sits where it always did",
      async () => {
        const context = await signedIn({ viewport: PHONE });
        try {
          const page = await context.newPage();
          await openTerminal(page);
          const seen = await shape(page);
          // The phone's own height: `min(52vh, 340px)` is 340px on an 844px-tall screen, which is what it was before.
          expect(seen.screen.height).toBe(Math.min(Math.round(PHONE.height * 0.52), 340));
          // The panel sets no height of its own here, so the stylesheet's rule is the only one that applies.
          expect(seen.termHeight).toBe("");
          // No grabber: it is not drawn, and it takes no room from the frame.
          expect(seen.grabberDisplay).toBe("none");
          expect(seen.grabber.height).toBe(0);
          // The key row is still the frame's last line, exactly as the key row test measures it.
          expect(seen.keysDisplay).toBe("flex");
          expect(seen.keys).not.toBeNull();
          expect(Math.abs(seen.keys!.bottom - seen.frame.bottom)).toBeLessThanOrEqual(1);
          expect(Math.abs(seen.keys!.top - seen.screen.bottom)).toBeLessThanOrEqual(1);
          expect(seen.keys!.height).toBeGreaterThanOrEqual(36);
          expect(seen.fits).toBe(true);
          await page.screenshot({ path: "/tmp/terminal-height-phone.png" });
        } finally {
          await context.close();
        }
      },
      TIMEOUT_MS,
    );

    test(
      "a remembered desktop height does not change a phone's terminal",
      async () => {
        const context = await signedIn({ viewport: PHONE });
        try {
          const page = await context.newPage();
          // The same browser, the same storage: a height dragged on a desktop, then the window narrowed to a phone's.
          await page.setViewportSize(DESKTOPS[0]!);
          await openTerminal(page);
          await drag(page, 80);
          await page.waitForTimeout(300);
          expect((await shape(page)).screen.height).toBeGreaterThan(LEGACY_HEIGHT);
          expect(await page.evaluate(() => localStorage.getItem("minibox:termHeight:v1"))).not.toBeNull();

          await page.setViewportSize(PHONE);
          await page.waitForTimeout(400);
          const phone = await shape(page);
          // The phone's rule wins: no height of the reader's, no grabber, and the row where the keyboard leaves it.
          expect(phone.termHeight).toBe("");
          expect(phone.screen.height).toBe(Math.min(Math.round(PHONE.height * 0.52), 340));
          expect(phone.grabberDisplay).toBe("none");
          expect(phone.keysDisplay).toBe("flex");
          expect(phone.fits).toBe(true);
        } finally {
          await context.close();
        }
      },
      TIMEOUT_MS,
    );
  });
});
