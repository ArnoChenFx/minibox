import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { Browser, BrowserContext, Page } from "@playwright/test";
import { chromium } from "@playwright/test";

import type { App } from "../src/app";
import { startServer } from "../src/server";
import { createTestApp, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";
import type { FakeRuntime } from "./support/fake-runtime";

/**
 * The overview's forward warning, in a real browser: the button that offers the repair appears only when the reading
 * says a chain fell off its end, and the confirm dialog fits a phone.
 *
 * The two other cases are the ones a screenshot cannot catch: a long documentation URL inside the confirm dialog must
 * wrap rather than be cut off at 390 px, and the English warning title must not be pushed onto the timestamp.
 */

const executablePath = chromiumFor("The forward warning browser test");

const DROPPED_POLICY = { forwarding: false, cause: "policy" as const, detail: "iptables FORWARD policy is DROP" };
const DROPPED_RULE = {
  forwarding: false,
  cause: "rule" as const,
  detail: "iptables drops traffic from br- by a rule of its own",
};
const UNCLEAR = { forwarding: false, cause: null, detail: "iptables: a rule MiniBox does not read may accept br-" };

describe.skipIf(!executablePath)("the forward warning on the overview (real browser)", () => {
  let app: App | undefined;
  let runtime: FakeRuntime | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser;
  let context: BrowserContext | undefined;
  let page: Page;
  let consoleUrl = "";

  beforeAll(async () => {
    const harness = createTestApp({ labelPrefix: "mbtest" });
    app = harness.app;
    runtime = harness.runtime;
    const keys = app.hosts.get().keys;
    harness.runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
    server = startServer(app);
    consoleUrl = `http://127.0.0.1:${server.port}`;
    // A proxy-only box is what makes the host worth reading at all.
    await fetch(`${consoleUrl}/api/boxes`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}`, origin: consoleUrl },
      body: JSON.stringify({
        name: "gated",
        cpus: 1,
        memoryMb: 256,
        egress: { mode: "proxy-only", domains: ["example.com"] },
      }),
    });
    browser = await chromium.launch({ executablePath: executablePath ?? undefined, args: ["--no-sandbox"] });
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

  /** Signs in, sets what the check would answer, runs a pass, and opens the overview at `width`. */
  async function openWith(
    verdict: typeof DROPPED_POLICY | typeof DROPPED_RULE | typeof UNCLEAR,
    width = 1280,
    locale = "en",
  ): Promise<{ wide: boolean }> {
    await context?.close();
    context = await browser.newContext({ viewport: { width, height: 900 }, locale });
    const login = await context.request.post(`${consoleUrl}/api/auth/login`, {
      data: { key: TEST_KEY },
      headers: { origin: consoleUrl },
    });
    expect(login.status()).toBe(200);
    page = await context.newPage();
    if (runtime) runtime.forwardVerdict = verdict;
    await app?.egressForward.tick();
    // Going to the address the page is already on is a fragment navigation, which renders nothing.
    await page.goto(`${consoleUrl}/#/boxes`);
    await page.goto(`${consoleUrl}/#/overview`);
    await page.waitForSelector("[data-attn='host.forward_blocked']");
    return { wide: width > 640 };
  }

  const row = () => page.locator("[data-attn='host.forward_blocked']");

  test("a policy drop offers the button, and the confirm dialog names the host and the bridge", async () => {
    await openWith(DROPPED_POLICY);
    const button = row().locator("[data-repair]");
    expect(await button.count()).toBe(1);
    await button.click();
    await page.waitForSelector("#cfm-ok");
    const dialog = page.locator(".dialog, .modal").last();
    const text = await dialog.innerText();
    expect(text).toContain("MiniBox will add its own chain on");
    // The wording the review objected to: what is added is a chain, its rules and one jump, not "one rule", and the
    // jump goes at the end of FORWARD, never the top.
    expect(text).not.toContain("one rule");
    expect(text).not.toContain("jumped to from the top");
    expect(text).toContain("end of FORWARD");
    expect(text).toContain("wherever they are going");
  });

  test("a drop a rule of the host's own makes offers no button, and says so in its own words", async () => {
    await openWith(DROPPED_RULE);
    expect(await row().locator("[data-repair]").count()).toBe(0);
    expect(await row().innerText()).toContain("on purpose");
  });

  test("an unclear reading offers no button either", async () => {
    await openWith(UNCLEAR);
    expect(await row().locator("[data-repair]").count()).toBe(0);
    expect(await row().innerText()).toContain("cannot read");
  });

  test("at 390 px the confirm dialog's documentation URL wraps instead of being cut off", async () => {
    await openWith(DROPPED_POLICY, 390);
    await row().locator("[data-repair]").click();
    await page.waitForSelector("#cfm-ok");
    const box = await page.evaluate(() => {
      // The page's DOM types are not in this project's tsconfig, so the shapes this script needs are declared here.
      interface Box {
        left: number;
        right: number;
        height: number;
      }
      interface Element {
        querySelector(selector: string): Element | null;
        getBoundingClientRect(): Box;
      }
      interface Document extends Element {
        documentElement: Element & { scrollWidth: number; clientWidth: number };
      }
      const doc = (globalThis as unknown as { document: Document }).document;
      const style = (globalThis as unknown as { getComputedStyle: (el: Element) => { lineHeight: string } })
        .getComputedStyle;
      const dialog = doc.querySelector("dialog[open], .modal, .dialog");
      if (!dialog) return null;
      const callout = dialog.querySelector(".callout");
      const span = callout ? callout.querySelector("span") : null;
      if (!span) return null;
      const bounds = dialog.getBoundingClientRect();
      const url = span.getBoundingClientRect();
      return {
        dialogLeft: bounds.left,
        dialogRight: bounds.right,
        urlLeft: url.left,
        urlRight: url.right,
        // The rendered height tells a wrapped line from a single clipped one.
        urlHeight: url.height,
        lineHeight: Number.parseFloat(style(span).lineHeight) || 0,
        scrollWidth: doc.documentElement.scrollWidth,
        clientWidth: doc.documentElement.clientWidth,
      };
    });
    expect(box).not.toBeNull();
    const seen = box as NonNullable<typeof box>;
    // The URL stays inside the dialog, and the page does not gain a sideways scrollbar from it.
    expect(seen.urlLeft).toBeGreaterThanOrEqual(seen.dialogLeft - 1);
    expect(seen.urlRight).toBeLessThanOrEqual(seen.dialogRight + 1);
    expect(seen.scrollWidth).toBeLessThanOrEqual(seen.clientWidth + 1);
    // A single clipped line would be one line tall; wrapping makes it taller.
    expect(seen.urlHeight).toBeGreaterThan(seen.lineHeight * 1.5);
  });

  test("at 320 px the row keeps its reading order, with nothing overlapping and no sideways scroll", async () => {
    // Measured rather than eyeballed: a screenshot cannot show that two boxes end before the next begins.
    await openWith(DROPPED_POLICY, 320, "en-US");
    const boxes = await page.evaluate(() => {
      // Same as above: this project's tsconfig has no DOM library, so the elements are described here.
      interface Box {
        left: number;
        right: number;
        top: number;
        bottom: number;
      }
      interface Element {
        querySelector(selector: string): Element | null;
        getBoundingClientRect(): Box;
      }
      interface Document extends Element {
        documentElement: Element & { scrollWidth: number; clientWidth: number };
      }
      const doc = (globalThis as unknown as { document: Document }).document;
      const rowEl = doc.querySelector("[data-attn='host.forward_blocked']");
      if (!rowEl) return null;
      const rect = (selector: string): Box | null => {
        const found = rowEl.querySelector(selector);
        if (!found) return null;
        const b = found.getBoundingClientRect();
        return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
      };
      return {
        label: rect("strong"),
        subject: rect(".watch-actor"),
        time: rect(".time"),
        scroll: doc.documentElement.scrollWidth,
        client: doc.documentElement.clientWidth,
      };
    });
    expect(boxes).not.toBeNull();
    const seen = boxes as NonNullable<typeof boxes>;
    const label = seen.label as NonNullable<typeof seen.label>;
    const subject = seen.subject as NonNullable<typeof seen.subject>;
    const time = seen.time as NonNullable<typeof seen.time>;
    // Each box ends before the next one starts, and all three stay inside the window.
    expect(label.right).toBeLessThanOrEqual(subject.left + 1);
    expect(subject.right).toBeLessThanOrEqual(time.left + 1);
    expect(time.right).toBeLessThanOrEqual(320);
    expect(seen.scroll).toBeLessThanOrEqual(seen.client + 1);
  });
});
