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

const executablePath = chromiumFor("The new-session dialog test");
const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const TIMEOUT_MS = 30_000;
const VIEWPORT = { width: 1280, height: 800 };

/** The session the terminal on screen shows, as the address names it. */
function currentSession(target: Page): string {
  const match = /\/terminal(?:\/([^/]+))?$/.exec(new URL(target.url()).hash);
  return decodeURIComponent(match?.[1] ?? "");
}

/** The value the dialog opens with, before anyone types: a name in the field, and no error under it. */
async function offeredName(target: Page): Promise<string> {
  await target.locator("#tNew").click({ timeout: 3000 });
  const input = target.locator("#pd-input");
  await webExpect(input).toBeVisible();
  await webExpect(target.locator("#pd-err")).toHaveText("");
  return input.inputValue();
}

/** A box the tests drive, named by its stable id for the API and by its container id for the console's addresses. */
interface TestBox {
  boxId: string;
  ref: string;
}

/**
 * The New session dialog, in a real browser: the field opens with a name already in it, a name the box already holds is
 * refused inside the dialog, and pressing OK twice makes two sessions with two different names. Every test drives a box
 * of its own, so the names one test creates never decide what the next one is offered.
 *
 * The unit tests next to this one (`web-session-name.test.ts`) pin the naming rule and the checks; this one proves the
 * dialog and the panel use them.
 */
describe.skipIf(!executablePath)("the new-session dialog (real browser)", () => {
  let app: App | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let consoleUrl = "";
  let runtime: ReturnType<typeof createTestApp>["runtime"];
  let made = 0;

  /** The tmux sessions the box really holds, which is what the fake runtime keeps for it. */
  function sessionNames(box: TestBox): string[] {
    if (!app) throw new Error("the test server is not running");
    const containerId = app.hosts.get().specs.read(box.boxId)?.containerId ?? "";
    return runtime.tmux.sessionNames(containerId);
  }

  /** A box of this test's own, created through the API as the console does. */
  async function makeBox(): Promise<TestBox> {
    if (!app) throw new Error("the test server is not running");
    made += 1;
    const { boxId, id } = await boxes.createBox(app.hosts.get(), {
      name: `dialog-${made}`,
      cpus: 1,
      memoryMb: 512,
      createdBy: "owner",
    });
    return { boxId, ref: id };
  }

  async function signedIn(options: BrowserContextOptions = {}): Promise<BrowserContext> {
    const fresh = await browser!.newContext(options);
    const login = await fresh.request.post(`${consoleUrl}/api/auth/login`, {
      data: { key: TEST_KEY },
      headers: { origin: consoleUrl },
    });
    expect(login.status()).toBe(200);
    return fresh;
  }

  /**
   * Opens the terminal tab of `box` and waits for the socket saying a person may type. The tab creates the box's own
   * `console` session the first time it opens, which is the name the box's first session always has.
   */
  async function openTerminal(target: Page, box: TestBox): Promise<void> {
    await target.goto(`${consoleUrl}/#/boxes/${box.ref}/terminal`);
    await webExpect(target.locator("#tNew")).toBeVisible();
    await webExpect(target.locator("#tStatus")).toHaveClass(/on/, { timeout: 15_000 });
  }

  beforeAll(async () => {
    const created = createTestApp();
    app = created.app;
    runtime = created.runtime;
    const host = app.hosts.get();
    runtime.seedImage(app.cfg.baseTemplateTag, {
      [host.keys.template]: "true",
      [host.keys.templateName]: "base",
    });
    server = startServer(app);
    consoleUrl = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ executablePath: executablePath ?? undefined, args: ["--no-sandbox"] });
    context = await signedIn({ viewport: VIEWPORT });
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
    "the field opens with a name already in it, and OK creates that session and opens it",
    async () => {
      const box = await makeBox();
      const page = await context!.newPage();
      try {
        await openTerminal(page, box);
        // The box's first terminal opened its own console session, so the dialog suggests the next name in the series.
        expect(currentSession(page)).toBe("console");
        expect(await offeredName(page)).toBe("console-2");
        // A name, not a placeholder: the field's own value can be submitted without typing anything.
        await webExpect(page.locator("#pd-input")).toHaveAttribute("placeholder", "");
        await page.locator("#pd-ok").click();

        const chip = page.locator(".session-chip[data-session='console-2']");
        await webExpect(chip).toHaveAttribute("title", "Created by you");
        await webExpect(chip).toHaveAttribute("aria-pressed", "true");
        expect(currentSession(page)).toBe("console-2");
        expect(sessionNames(box)).toEqual(["console", "console-2"]);
      } finally {
        await page.close();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "opening it again offers a different name, and Enter alone creates the session",
    async () => {
      const box = await makeBox();
      const page = await context!.newPage();
      try {
        await openTerminal(page, box);
        expect(await offeredName(page)).toBe("console-2");
        await page.locator("#pd-input").press("Enter");
        await webExpect(page.locator(".session-chip[data-session='console-2']")).toHaveAttribute(
          "aria-pressed",
          "true",
        );

        // The second opening offers the next name, not the one just taken.
        const second = await offeredName(page);
        expect(second).toBe("console-3");
        await page.locator("#pd-input").press("Enter");
        await webExpect(page.locator(".session-chip[data-session='console-3']")).toHaveAttribute(
          "aria-pressed",
          "true",
        );
        expect(currentSession(page)).toBe("console-3");

        // The two openings made two sessions with two different names.
        const names = sessionNames(box);
        expect(names).toEqual(["console", "console-2", "console-3"]);
        expect(new Set(names).size).toBe(names.length);
      } finally {
        await page.close();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a name the box already holds is refused inside the dialog, and nothing is created",
    async () => {
      const box = await makeBox();
      const page = await context!.newPage();
      try {
        // The box's own console session, made when its terminal first opens.
        await openTerminal(page, box);
        await webExpect(page.locator(".session-chip[data-session='console']")).toBeVisible();
        // A session another client started, which the list the dialog checks against holds too once the page is reopened.
        await app!.terminals.start(app!.hosts.get(), await boxes.getBox(app!.hosts.get(), box.boxId), "build", "rest");
        await openTerminal(page, box);
        await webExpect(page.locator(".session-chip[data-session='build']")).toBeVisible();
        const before = sessionNames(box);
        expect(before.toSorted()).toEqual(["build", "console"]);
        await page.locator("#tNew").click();
        await page.locator("#pd-input").fill("console");
        // The error is drawn under the field as it is typed, before the button is pressed.
        await webExpect(page.locator("#pd-err")).toHaveText(
          "This box already has a session named “console”. Choose another name.",
        );
        await webExpect(page.locator("#pd-input")).toHaveClass(/invalid/);
        // Pressing OK leaves the dialog open on the same error, so the mistake is never sent.
        await page.locator("#pd-ok").click();
        await webExpect(page.locator("#pd-input")).toBeVisible();
        await webExpect(page.locator("#pd-err")).toContainText("already has a session named");
        expect(sessionNames(box)).toEqual(before);

        // A session an agent started is taken too, and so is the same name in another case.
        await page.locator("#pd-input").fill("build");
        await webExpect(page.locator("#pd-err")).toHaveText(
          "This box already has a session named “build”. Choose another name.",
        );
        await page.locator("#pd-input").fill("Console");
        await webExpect(page.locator("#pd-err")).toContainText("already has a session named “Console”");

        // Cancelling creates nothing either.
        await page.locator(".dialog-head [data-close]").click();
        await webExpect(page.locator("#pd-input")).toBeHidden();
        expect(sessionNames(box)).toEqual(before);
      } finally {
        await page.close();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a name the server would refuse, and an empty field, are refused in the dialog too",
    async () => {
      const box = await makeBox();
      const page = await context!.newPage();
      try {
        await openTerminal(page, box);
        const before = sessionNames(box);
        await page.locator("#tNew").click();
        await page.locator("#pd-input").fill("bad name!");
        await webExpect(page.locator("#pd-err")).toHaveText(
          "Start with a letter or digit. Use only letters, digits, - and _, up to 32 characters in all.",
        );
        await page.locator("#pd-ok").click();
        await webExpect(page.locator("#pd-input")).toBeVisible();
        // Clearing the field is refused rather than sent as an empty name.
        await page.locator("#pd-input").fill("");
        await webExpect(page.locator("#pd-err")).toHaveText("Enter a session name, or keep the one already filled in.");
        await page.locator("#pd-ok").click();
        await webExpect(page.locator("#pd-input")).toBeVisible();
        expect(sessionNames(box)).toEqual(before);

        // Typing a name the box does not have clears the error, and the same OK now works.
        await page.locator("#pd-input").fill("typed-by-hand");
        await webExpect(page.locator("#pd-err")).toHaveText("");
        await page.locator("#pd-ok").click();
        await webExpect(page.locator(".session-chip[data-session='typed-by-hand']")).toHaveAttribute(
          "aria-pressed",
          "true",
        );
        expect(sessionNames(box)).toContain("typed-by-hand");
      } finally {
        await page.close();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "the dialog is in Chinese on a zh-CN browser, with the name filled in and the taken error translated",
    async () => {
      const box = await makeBox();
      const zh = await signedIn({ locale: "zh-CN", viewport: VIEWPORT });
      try {
        const zhPage = await zh.newPage();
        await openTerminal(zhPage, box);
        await zhPage.locator("#tNew").click();
        await webExpect(zhPage.locator("#pd-input")).toHaveValue("console-2");
        await zhPage.locator("#pd-input").fill("console");
        await webExpect(zhPage.locator("#pd-err")).toHaveText("此 Box 已有名为“console”的会话，请换一个名称。");
        await zhPage.locator("#pd-input").fill("");
        await webExpect(zhPage.locator("#pd-err")).toHaveText("请输入会话名称，或保留已经填好的名称。");
        await zhPage.locator(".dialog-head [data-close]").click();
      } finally {
        await zh.close();
      }
    },
    TIMEOUT_MS,
  );
});
