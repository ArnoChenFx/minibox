import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type Browser, type BrowserContext, chromium, expect as webExpect, type Page } from "@playwright/test";

import type { App } from "../src/app";
import { startServer } from "../src/server";
import { createBox } from "../src/services/boxes";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";

const executablePath = chromiumFor("The terminal clipboard test");
const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const clipboard = (page: Page) => page.evaluate<string>("window.realClipboard.readText()");
const writeClipboard = (page: Page, text: string) =>
  page.evaluate(`window.realClipboard.writeText(${JSON.stringify(text)})`);
const screenText = (page: Page, text: string) =>
  page.evaluate(`new Promise(resolve => {
  window.testTerminal.write('\\x1b[2J\\x1b[H' + ${JSON.stringify(text)} + '\\x1b[?1000h\\x1b[?1006h', resolve);
})`);

/** Real pointer selection, with tmux-style mouse reporting active in xterm. */
async function selectByDrag(page: Page, text: string, modifier: "Shift" | "Alt" = "Shift") {
  await screenText(page, text);
  const screen = await page.locator(".xterm-screen").boundingBox();
  const size = await page.evaluate<{ cols: number; rows: number }>(
    "({cols: testTerminal.cols, rows: testTerminal.rows})",
  );
  if (!screen) throw new Error("the terminal screen is not visible");
  const cell = screen.width / size.cols;
  const y = screen.y + screen.height / size.rows / 2;
  await page.keyboard.down(modifier);
  await page.mouse.move(screen.x + cell / 4, y);
  await page.mouse.down();
  await page.mouse.move(screen.x + cell * (text.length + 0.25), y, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up(modifier);
  await webExpect.poll(() => page.evaluate<string>("testTerminal.getSelection()")).toBe(text);
}

describe.skipIf(!executablePath)("the terminal clipboard (real browser)", () => {
  let harness: ReturnType<typeof createTestApp>;
  let app: App;
  let server: ReturnType<typeof startServer>;
  let browser: Browser;
  let base = "";
  let box: Awaited<ReturnType<typeof createBox>>;
  let serial = 0;

  beforeAll(async () => {
    harness = createTestApp();
    app = harness.app;
    const host = app.hosts.get();
    harness.runtime.seedImage(app.cfg.baseTemplateTag, { [host.keys.template]: "true" });
    box = await createBox(host, { name: "clipboard", cpus: 1, memoryMb: 512 });
    server = startServer(app);
    base = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ executablePath: executablePath ?? undefined, args: ["--no-sandbox"] });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
    app?.throttle.stop();
    app?.sessions.stop();
    app?.tokens.stop();
    app?.terminals.shutdown();
    app?.events.close();
  });

  async function open(options: { mac?: boolean; phone?: boolean; second?: boolean } = {}) {
    const session = `clip${++serial}`;
    await app.terminals.start(app.hosts.get(), box, session, "ui");
    if (options.second) await app.terminals.start(app.hosts.get(), box, `${session}-other`, "ui");
    const context: BrowserContext = await browser.newContext({
      viewport: options.phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    await context.addInitScript(`
      ${options.mac ? 'Object.defineProperty(navigator, "platform", {value: "MacIntel"});' : ""}
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
      window.realClipboard = navigator.clipboard;
    `);
    const login = await context.request.post(`${base}/api/auth/login`, {
      data: { key: TEST_KEY },
      headers: { origin: base },
    });
    expect(login.status()).toBe(200);
    const page = await context.newPage();
    await page.goto(`${base}/#/boxes/${box.boxId}/terminal/${session}`);
    await webExpect(page.locator("#tPaste")).toBeEnabled();
    return { context, page, session };
  }

  const typed = (name: string) => harness.runtime.tmux.paneText(box.id, name) ?? "";

  test("Shift-drag and the right-click menu copy real selected text; wheel reporting still reaches tmux", async () => {
    const { context, page, session } = await open();
    try {
      await selectByDrag(page, "copy-from-terminal");
      await page.locator(".xterm-screen").click({ button: "right" });
      const menu = page.getByRole("menu", { name: "Terminal clipboard" });
      await webExpect(menu).toBeVisible();
      await menu.getByRole("menuitem", { name: "Copy", exact: true }).click();
      expect(await clipboard(page)).toBe("copy-from-terminal");
      expect(typed(session)).toBe("");
      await page.locator(".xterm-screen").hover();
      await page.mouse.wheel(0, -120);
      await webExpect.poll(() => typed(session)).toContain("[<64;");
    } finally {
      await context.close();
    }
  }, 30_000);

  test("Ctrl+C and Ctrl+Shift+C copy a selection, while Ctrl+C without one still interrupts", async () => {
    const { context, page, session } = await open();
    try {
      await selectByDrag(page, "shortcut-copy");
      await page.keyboard.press("Control+c");
      expect(await clipboard(page)).toBe("shortcut-copy");
      await page.keyboard.press("Control+Shift+c");
      expect(await clipboard(page)).toBe("shortcut-copy");
      expect(typed(session)).toBe("");
      await page.evaluate("testTerminal.clearSelection(); testTerminal.focus()");
      await page.keyboard.press("Control+c");
      await webExpect.poll(() => typed(session)).toBe("\x03");
    } finally {
      await context.close();
    }
  }, 30_000);

  test("native Ctrl+V and Ctrl+Shift+V work without Clipboard API access and preserve bracketed paste", async () => {
    const { context, page, session } = await open();
    try {
      await writeClipboard(page, "echo one\necho two");
      await page.evaluate(`Object.defineProperty(navigator, 'clipboard', {value: undefined, configurable: true});
        testTerminal.write('\\x1b[?2004h');`);
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.press("Control+v");
      await webExpect.poll(() => typed(session)).toBe("\x1b[200~echo one\necho two\x1b[201~");
      await writeClipboard(page, "more");
      await page.keyboard.press("Control+Shift+v");
      await webExpect.poll(() => typed(session)).toContain("\x1b[200~more\x1b[201~");
    } finally {
      await context.close();
    }
  }, 30_000);

  test("right-click Paste reads the clipboard once and sends it through xterm", async () => {
    const { context, page, session } = await open();
    try {
      await writeClipboard(page, "right-click-paste");
      await page.locator(".xterm-screen").click({ button: "right" });
      await page.getByRole("menuitem", { name: "Paste", exact: true }).click();
      await webExpect.poll(() => typed(session)).toBe("right-click-paste");
      await webExpect(page.locator(".xterm-helper-textarea")).toBeFocused();
    } finally {
      await context.close();
    }
  }, 30_000);

  test("unavailable or denied clipboard access offers a multiline paste field; copying falls back too", async () => {
    const { context, page, session } = await open();
    try {
      await selectByDrag(page, "copy-on-http");
      await page.evaluate("Object.defineProperty(navigator, 'clipboard', {value: undefined, configurable: true})");
      await page.locator("#tCopy").click();
      expect(await clipboard(page)).toBe("copy-on-http");
      await page.locator("#tPaste").click();
      await webExpect(page.locator("#tPasteText")).toBeVisible();
      await page.locator("#tPasteText").fill("  first\nsecond\n");
      await page.locator("#tPasteConfirm").click();
      await webExpect.poll(() => typed(session)).toBe("  first\nsecond\n");
      await page.evaluate(`Object.defineProperty(navigator, 'clipboard', {value: {
        readText: () => Promise.reject(new Error('NotAllowedError'))
      }, configurable: true})`);
      await page.locator("#tPaste").click();
      await webExpect(page.locator("#tPasteText")).toBeVisible();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(typed(session)).toBe("  first\nsecond\n");
    } finally {
      await context.close();
    }
  }, 30_000);

  test("a clipboard read that finishes after switching sessions never pastes into either session", async () => {
    const { context, page, session } = await open({ second: true });
    try {
      await page.evaluate(
        "navigator.clipboard.readText = () => new Promise(resolve => window.finishClipboardRead = resolve)",
      );
      await page.locator("#tPaste").click();
      await page.locator(`[data-session="${session}-other"]`).click();
      await webExpect(page.locator(`[data-session="${session}-other"]`)).toHaveAttribute("aria-pressed", "true");
      await page.evaluate("window.finishClipboardRead('stale-input')");
      await webExpect(page.locator("#tPaste")).toBeEnabled();
      expect(typed(session)).toBe("");
      expect(typed(`${session}-other`)).toBe("");
    } finally {
      await context.close();
    }
  }, 30_000);

  test("read-only sessions still copy but cannot paste; the menu fits on a phone and is removed on navigation", async () => {
    const { context, page, session } = await open({ phone: true });
    try {
      await page.locator('[data-control="release"]').click();
      await webExpect(page.locator("#tPaste")).toBeDisabled();
      await selectByDrag(page, "read-only-copy");
      await page.locator("#tCopy").click();
      expect(await clipboard(page)).toBe("read-only-copy");
      await page.locator(".xterm-screen").click({ button: "right", position: { x: 300, y: 100 } });
      const menu = page.getByRole("menu", { name: "Terminal clipboard" });
      await webExpect(menu.getByRole("menuitem", { name: "Paste", exact: true })).toBeDisabled();
      const rect = await menu.boundingBox();
      expect(rect && rect.x + rect.width <= 390).toBeTruthy();
      expect(await page.evaluate<boolean>("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
      await page.keyboard.press("Escape");
      await webExpect(menu).toBeHidden();
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.press("Control+v");
      expect(typed(session)).toBe("");
      await page.goto(`${base}/#/overview`);
      await webExpect(page.locator(".term-clipboard-menu")).toHaveCount(0);
    } finally {
      await context.close();
    }
  }, 30_000);

  test("Mac Option-drag selects and Command+C copies without sending a control key", async () => {
    const { context, page, session } = await open({ mac: true });
    try {
      await selectByDrag(page, "mac-copy", "Alt");
      await page.keyboard.press("Meta+c");
      expect(await clipboard(page)).toBe("mac-copy");
      expect(typed(session)).toBe("");
      await webExpect(page.locator("#tClipboardHint")).toContainText("Option");
    } finally {
      await context.close();
    }
  }, 30_000);
});
