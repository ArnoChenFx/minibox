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

const executablePath = chromiumFor("The terminal key row test");

const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const TIMEOUT_MS = 30_000;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
/** The order the row shows its keys in. */
const KEY_IDS = ["esc", "tab", "ctrl", "left", "up", "down", "right", "ctrlC", "ctrlD"];

/**
 * What the row looks like on screen: whether it is drawn, where each key sits, and whether anything spills out of the
 * window sideways. A key's box is measured as the reader sees it, so a key pushed off the window or under the frame's
 * edge would show up here.
 */
async function rowShape(page: Page) {
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
      querySelector(selector: string): Node | null;
      scrollWidth: number;
      clientWidth: number;
      scrollHeight: number;
      dataset: Record<string, string>;
      disabled?: boolean;
    }
    const view = globalThis as unknown as {
      document: Node & { querySelector(selector: string): Node | null; documentElement: Node };
      getComputedStyle(element: Node): { display: string };
      innerWidth: number;
      innerHeight: number;
      scrollY: number;
    };
    const doc = view.document;
    const row = doc.querySelector("#tKeys");
    if (!row) throw new Error("the terminal has no key row");
    const frame = doc.querySelector(".terminal-frame")!;
    const box = (node: Node) => {
      const rect = node.getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    const keys = [...row.querySelectorAll("[data-key]")].map((node) => ({
      id: node.dataset.key ?? "",
      box: box(node),
      disabled: node.disabled === true,
    }));
    return {
      display: view.getComputedStyle(row).display,
      row: box(row),
      frame: box(frame),
      keys,
      fits: {
        page: doc.documentElement.scrollWidth <= doc.documentElement.clientWidth,
        row: row.scrollWidth <= row.clientWidth,
      },
      viewport: { width: view.innerWidth, height: view.innerHeight },
    };
  });
}

/** The bytes the fake tmux server received in a session, as the code points of its transcript. */
async function typedInto(boxId: string, session: string): Promise<number[]> {
  const { runtime } = harnessOf();
  return [...(runtime.tmux.paneText(boxId, session) ?? "")].map((char) => char.codePointAt(0) ?? 0);
}

let harness: { app: App; runtime: ReturnType<typeof createTestApp>["runtime"] } | undefined;
const harnessOf = () => {
  if (!harness) throw new Error("the test server is not running");
  return harness;
};

describe.skipIf(!executablePath)("the terminal's key row (real browser)", () => {
  let app: App | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page;
  let consoleUrl = "";
  let alpha = "";
  let consoleBoxId = "";

  async function signedIn(options: BrowserContextOptions = {}): Promise<BrowserContext> {
    const fresh = await browser!.newContext(options);
    // Keep the real panel's xterm instance so a test can feed the output sequence a curses program sends.
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

  /** The terminal tab of the test box, on a session nobody else holds. */
  const terminalUrl = () => `${consoleUrl}/#/boxes/${alpha}/terminal`;

  /** Opens the terminal and waits for the row to be live, which is the socket saying a person may type. */
  async function openTerminal(target: Page): Promise<void> {
    await target.goto(terminalUrl());
    await webExpect(target.locator("#tKeys")).toBeAttached();
    await webExpect(target.locator('#tKeys [data-key="esc"]')).toBeEnabled({ timeout: 15_000 });
    await webExpect(target.locator("#tStatus")).toHaveClass(/on/);
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
    context = await signedIn({ viewport: PHONE });
    page = await context.newPage();
  }, 60_000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    server?.stop(true);
    app?.throttle.stop();
    app?.sessions.stop();
    app?.tokens.stop();
    app?.terminals.shutdown();
    app?.events.close();
  });

  describe("on a 390x844 phone", () => {
    test(
      "the row sits inside the terminal frame, one button per key, each a thumb's target, and nothing overlaps or spills",
      async () => {
        await openTerminal(page);
        const shape = await rowShape(page);
        expect(shape.display).toBe("flex");
        expect(shape.keys.map((key) => key.id)).toEqual(KEY_IDS);
        // Every key is laid out, and a thumb can hit it.
        for (const key of shape.keys) {
          expect([key.id, key.box.width >= 36, key.box.height >= 36]).toEqual([key.id, true, true]);
          expect([key.id, key.box.left >= 0, key.box.right <= PHONE.width]).toEqual([key.id, true, true]);
        }
        // No key overlaps another: each pair is separated on at least one axis.
        for (let i = 0; i < shape.keys.length; i += 1) {
          for (let j = i + 1; j < shape.keys.length; j += 1) {
            const a = shape.keys[i]!.box;
            const b = shape.keys[j]!.box;
            const apart = a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
            expect([shape.keys[i]!.id, shape.keys[j]!.id, apart]).toEqual([shape.keys[i]!.id, shape.keys[j]!.id, true]);
          }
        }
        // The row is the frame's last line, and nothing scrolls sideways, in the row or on the page.
        expect(shape.fits).toEqual({ page: true, row: true });
        expect(Math.abs(shape.row.bottom - shape.frame.bottom)).toBeLessThanOrEqual(1);
        expect(shape.row.top).toBeGreaterThan(shape.frame.top);
      },
      TIMEOUT_MS,
    );

    test(
      "each key is a real button named in English, and Ctrl says it is not armed yet",
      async () => {
        await openTerminal(page);
        await webExpect(page.locator("#tKeys")).toHaveAttribute("role", "group");
        await webExpect(page.locator("#tKeys")).toHaveAttribute("aria-label", "Terminal keys");
        await webExpect(page.locator("#tKeys [data-key]")).toHaveCount(KEY_IDS.length);
        for (const [id, name] of [
          ["esc", "Escape"],
          ["tab", "Tab"],
          ["left", "Left arrow"],
          ["up", "Up arrow"],
          ["down", "Down arrow"],
          ["right", "Right arrow"],
          ["ctrlC", "Control-C"],
          ["ctrlD", "Control-D"],
        ] as const) {
          await webExpect(page.locator(`#tKeys [data-key="${id}"]`)).toHaveAttribute("aria-label", name);
        }
        await webExpect(page.locator('#tKeys [data-key="ctrl"]')).toHaveAttribute(
          "aria-label",
          "Control, a modifier for the next key",
        );
        await webExpect(page.locator('#tKeys [data-key="ctrl"]')).toHaveAttribute("aria-pressed", "false");
        // A button, not a link or a div: it can be reached and pressed without a mouse.
        expect(await page.locator('#tKeys [data-key="esc"]').evaluate((node) => node.tagName)).toBe("BUTTON");
        await page.locator('#tKeys [data-key="esc"]').focus();
        await webExpect(page.locator('#tKeys [data-key="esc"]')).toBeFocused();
      },
      TIMEOUT_MS,
    );

    test(
      "Esc, Tab and the four arrows send their standard bytes into the box's tmux session",
      async () => {
        await openTerminal(page);
        const session = "console";
        // Start from a known transcript, so the bytes measured below are the ones these presses wrote.
        const before = (await typedInto(consoleBoxId, session)).length;
        for (const id of ["esc", "tab", "up", "down", "right", "left"]) {
          await page.locator(`#tKeys [data-key="${id}"]`).click();
        }
        const typed = (await typedInto(consoleBoxId, session)).slice(before);
        // ESC, TAB, then ESC[A, ESC[B, ESC[C, ESC[D: exactly what a keyboard would have sent.
        expect(typed).toEqual([27, 9, 27, 91, 65, 27, 91, 66, 27, 91, 67, 27, 91, 68]);
      },
      TIMEOUT_MS,
    );

    test(
      "auxiliary arrows match physical arrows when application cursor mode is entered and left",
      async () => {
        await openTerminal(page);
        for (const application of [true, false]) {
          await page.evaluate(async (enabled) => {
            const view = globalThis as unknown as {
              testTerminal: { write(data: string, callback: () => void): void; focus(): void };
            };
            await new Promise<void>((resolve) =>
              view.testTerminal.write(enabled ? "\u001b[?1h" : "\u001b[?1l", resolve),
            );
            view.testTerminal.focus();
          }, application);
          const before = (await typedInto(consoleBoxId, "console")).length;
          for (const [key, physical] of [
            ["up", "ArrowUp"],
            ["down", "ArrowDown"],
            ["right", "ArrowRight"],
            ["left", "ArrowLeft"],
          ]) {
            await page.keyboard.press(physical!);
            await page.locator(`#tKeys [data-key="${key}"]`).click();
          }
          const prefix = application ? 79 : 91;
          expect((await typedInto(consoleBoxId, "console")).slice(before)).toEqual(
            [65, 66, 67, 68].flatMap((suffix) => [27, prefix, suffix, 27, prefix, suffix]),
          );
        }
      },
      TIMEOUT_MS,
    );

    test(
      "Ctrl-C and Ctrl-D send their control characters",
      async () => {
        await openTerminal(page);
        const session = "console";
        const before = (await typedInto(consoleBoxId, session)).length;
        await page.locator('#tKeys [data-key="ctrlC"]').click();
        await page.locator('#tKeys [data-key="ctrlD"]').click();
        expect((await typedInto(consoleBoxId, session)).slice(before)).toEqual([3, 4]);
      },
      TIMEOUT_MS,
    );

    test(
      "Ctrl is sticky: it arms, the next typed character goes out as its control character, and it resets",
      async () => {
        await openTerminal(page);
        const session = "console";
        const ctrl = page.locator('#tKeys [data-key="ctrl"]');
        await webExpect(ctrl).toHaveAttribute("aria-pressed", "false");

        // The armed Ctrl is drawn differently from the one at rest, so a phone can see it is on.
        const colour = async () =>
          ctrl.evaluate((node) => {
            const style = node.ownerDocument.defaultView!.getComputedStyle(node);
            return { background: style.backgroundColor, border: style.borderTopColor, text: style.color };
          });
        const atRest = await colour();
        await ctrl.click();
        await webExpect(ctrl).toHaveAttribute("aria-pressed", "true");
        const armed = await colour();
        expect(armed).not.toEqual(atRest);

        // A second press cancels it, and it goes back to the colour it had.
        await ctrl.click();
        await webExpect(ctrl).toHaveAttribute("aria-pressed", "false");
        // Off the button, so its resting colour is measured rather than the hover it has while the mouse sits on it.
        await page.mouse.move(0, 0);
        expect(await colour()).toEqual(atRest);

        // Armed, then a letter typed on the terminal's own input: Ctrl-C is what the session receives, and Ctrl resets.
        const before = (await typedInto(consoleBoxId, session)).length;
        await ctrl.click();
        await webExpect(ctrl).toHaveAttribute("aria-pressed", "true");
        await page.keyboard.type("c");
        expect((await typedInto(consoleBoxId, session)).slice(before)).toEqual([3]);
        await webExpect(ctrl).toHaveAttribute("aria-pressed", "false");
      },
      TIMEOUT_MS,
    );

    test(
      "a key press keeps the terminal's own input focused, so the on-screen keyboard stays up and typing still lands",
      async () => {
        await openTerminal(page);
        const focusedInTerminal = () =>
          page.evaluate(() => {
            const view = globalThis as unknown as {
              document: { activeElement: { classList: { contains(name: string): boolean } } | null };
            };
            return view.document.activeElement?.classList.contains("xterm-helper-textarea") === true;
          });
        await webExpect(page.locator(".xterm-helper-textarea")).toBeFocused();
        const before = (await typedInto(consoleBoxId, "console")).length;
        // The press is dispatched as a phone would send it, with the pointer press first.
        await page.locator('#tKeys [data-key="esc"]').dispatchEvent("pointerdown");
        await page.locator('#tKeys [data-key="esc"]').click();
        expect(await focusedInTerminal()).toBe(true);
        // And a character typed after the press still reaches the session, in the same transcript as the ESC.
        await page.keyboard.type("z");
        const typed = (await typedInto(consoleBoxId, "console")).slice(before);
        expect(typed).toEqual([27, 122]);
      },
      TIMEOUT_MS,
    );

    test(
      "with the keyboard up the row stays in view, above where the bottom tab bar would sit",
      async () => {
        await openTerminal(page);
        // A phone's keyboard shrinks the visible window from the bottom. Standing in for it with a shorter viewport
        // keeps the layout honest: the row has to come into the part of the page the keyboard leaves.
        const KEYBOARD = 300;
        const visible = PHONE.height - KEYBOARD;
        await page.evaluate(() => (globalThis as unknown as { scrollTo(x: number, y: number): void }).scrollTo(0, 0));
        await page.setViewportSize({ width: PHONE.width, height: visible });
        // The terminal holds the keyboard, so the tab bar has stepped aside, and the row is what is at the foot instead.
        await webExpect(page.locator("#shell")).toHaveClass(/typing/);
        await webExpect(page.locator("#tabbar")).toBeHidden();
        // The row is drawn, is not under the window's bottom edge, and has a height a thumb can press.
        await page.waitForFunction(
          () => {
            const view = globalThis as unknown as {
              document: { querySelector(selector: string): { getBoundingClientRect(): { bottom: number } } | null };
              innerHeight: number;
            };
            const row = view.document.querySelector("#tKeys");
            return row !== null && Math.round(row.getBoundingClientRect().bottom) <= view.innerHeight;
          },
          undefined,
          { timeout: 5_000 },
        );
        const shape = await rowShape(page);
        expect(shape.display).toBe("flex");
        expect(shape.row.bottom).toBeLessThanOrEqual(visible);
        expect(shape.row.top).toBeGreaterThanOrEqual(0);
        expect(shape.row.height).toBeGreaterThanOrEqual(36);
        // Every key is inside the visible part too, so the whole row is pressable rather than just its first line.
        expect(shape.keys.map((key) => key.id)).toEqual(KEY_IDS);
        expect(shape.keys.every((key) => key.box.top >= 0 && key.box.bottom <= visible)).toBe(true);
        expect(shape.fits).toEqual({ page: true, row: true });
        await page.screenshot({ path: "/tmp/terminal-keys-phone-keyboard.png" });
        // The row is the last thing on the page, so the page cannot scroll further and the keys stay put.
        await page.evaluate(() => (globalThis as unknown as { scrollTo(x: number, y: number): void }).scrollTo(0, 1e6));
        const scrolled = await rowShape(page);
        expect(scrolled.row.bottom).toBeLessThanOrEqual(visible);
        expect(scrolled.keys.every((key) => key.box.bottom <= visible)).toBe(true);
        await page.setViewportSize(PHONE);
      },
      TIMEOUT_MS,
    );

    test(
      "a read-only session's keys are disabled, so nothing looks pressable that cannot send",
      async () => {
        // A session an agent started opens read-only until someone takes it over.
        const host = harnessOf().app.hosts.get();
        const beta = await boxes.createBox(host, { name: "beta", cpus: 1, memoryMb: 512, createdBy: "owner" });
        await boxes.startBox(host, beta.id);
        await harnessOf().app.terminals.start(host, beta, "build", "rest");
        await page.goto(`${consoleUrl}/#/boxes/${beta.boxId}/terminal/build`);
        await webExpect(page.locator("#tKeys")).toBeAttached();
        await webExpect(page.locator('#tKeys [data-key="esc"]')).toBeDisabled({ timeout: 15_000 });
        expect(await page.locator('#tKeys [data-key="esc"]').evaluate((node) => node.disabled)).toBe(true);
        // The row is dimmed, so it reads as unavailable rather than as a button that quietly does nothing.
        const opacity = await page
          .locator('#tKeys [data-key="esc"]')
          .evaluate((node) => node.ownerDocument.defaultView!.getComputedStyle(node).opacity);
        expect(Number(opacity)).toBeLessThan(1);
        // Taking the session over enables the keys again.
        await page.locator('[data-control="takeover"]').click();
        await webExpect(page.locator('#tKeys [data-key="esc"]')).toBeEnabled({ timeout: 15_000 });
      },
      TIMEOUT_MS,
    );

    test(
      "the keys are 终端快捷键 in Chinese, with Ctrl named as a modifier",
      async () => {
        const zh = await signedIn({ locale: "zh-CN", viewport: PHONE });
        try {
          const zhPage = await zh.newPage();
          await zhPage.goto(terminalUrl());
          await webExpect(zhPage.locator("#tKeys")).toBeAttached();
          await webExpect(zhPage.locator("#tKeys")).toHaveAttribute("aria-label", "终端快捷键");
          await webExpect(zhPage.locator('#tKeys [data-key="left"]')).toHaveAttribute("aria-label", "左方向键");
          await webExpect(zhPage.locator('#tKeys [data-key="ctrl"]')).toHaveAttribute(
            "aria-label",
            "Ctrl，修饰下一个按键",
          );
        } finally {
          await zh.close();
        }
      },
      TIMEOUT_MS,
    );
  });

  describe("on a 1280x800 desktop", () => {
    test(
      "the row is gone, and the terminal keeps the screen a desktop keyboard already drives",
      async () => {
        const desktop = await signedIn({ viewport: DESKTOP });
        try {
          const desktopPage = await desktop.newPage();
          await desktopPage.goto(terminalUrl());
          await webExpect(desktopPage.locator("#tKeys")).toBeAttached();
          await webExpect(desktopPage.locator("#tKeys")).toBeHidden();
          // The row is hidden here but still follows the session, so it says when the terminal can take keys.
          await webExpect(desktopPage.locator('#tKeys [data-key="esc"]')).toBeEnabled({ timeout: 15_000 });
          const shape = await rowShape(desktopPage);
          expect(shape.display).toBe("none");
          expect(shape.row.height).toBe(0);
          // The terminal itself still works: a key on the desktop keyboard reaches the session.
          await webExpect(desktopPage.locator(".xterm-helper-textarea")).toBeFocused();
          const before = (await typedInto(consoleBoxId, "console")).length;
          await desktopPage.keyboard.type("q");
          expect((await typedInto(consoleBoxId, "console")).slice(before)).toEqual([113]);
        } finally {
          await desktop.close();
        }
      },
      TIMEOUT_MS,
    );
  });
});
