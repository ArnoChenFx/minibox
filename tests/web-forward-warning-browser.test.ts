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

interface Rect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** Whether two boxes share any area. Touching edges do not count. */
const intersects = (a: Rect, b: Rect): boolean =>
  a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;

const DROPPED_POLICY = { forwarding: false, cause: "policy" as const, detail: "iptables FORWARD policy is DROP" };
const DROPPED_RULE = {
  forwarding: false,
  cause: "rule" as const,
  detail: "iptables drops traffic from br- by a rule of its own",
};
const DROPPED_UNREACHABLE = {
  forwarding: false,
  cause: "unreachable" as const,
  detail: "iptables FORWARD policy is DROP, and a RETURN or -g in FORWARD leaves br- to it",
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
    verdict: typeof DROPPED_POLICY | typeof DROPPED_RULE | typeof DROPPED_UNREACHABLE | typeof UNCLEAR,
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

  test("a drop behind a goto offers no button, and says a rule at the end would never be reached", async () => {
    await openWith(DROPPED_UNREACHABLE);
    expect(await row().locator("[data-repair]").count()).toBe(0);
    expect(await row().innerText()).toContain("never be reached");
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

  test.each([1280, 390, 320])(
    "at %i px the reason of the drop is on the page in full, not behind a hover, and overlaps nothing",
    async (width) => {
      await openWith(DROPPED_UNREACHABLE, width);
      const found = await page.evaluate(() => {
        // The page's DOM types are not in this project's tsconfig, so the shapes this script needs are declared here.
        interface Box {
          left: number;
          right: number;
          top: number;
          bottom: number;
          height: number;
        }
        interface Element {
          querySelector(selector: string): Element | null;
          getBoundingClientRect(): Box;
          scrollWidth: number;
          clientWidth: number;
        }
        interface Document extends Element {
          documentElement: Element;
        }
        const scope = globalThis as unknown as {
          document: Document;
          getComputedStyle: (el: Element) => { whiteSpace: string; textOverflow: string; lineHeight: string };
        };
        const rowEl = scope.document.querySelector("[data-attn='host.forward_blocked']");
        const noteEl = rowEl ? rowEl.querySelector(".watch-note") : null;
        if (!rowEl || !noteEl) return null;
        const rect = (el: Element | null): Box | null => {
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, height: b.height };
        };
        const style = scope.getComputedStyle(noteEl);
        const sentenceEl = rowEl.querySelector(".watch-text");
        return {
          row: rect(rowEl),
          note: rect(noteEl),
          sentenceWhiteSpace: sentenceEl ? scope.getComputedStyle(sentenceEl).whiteSpace : "",
          sentenceScroll: sentenceEl ? sentenceEl.scrollWidth : 0,
          sentenceClient: sentenceEl ? sentenceEl.clientWidth : 0,
          text: rect(rowEl.querySelector(".watch-cmd")),
          actions: rect(rowEl.querySelector(".watch-actions")),
          time: rect(rowEl.querySelector(".time")),
          whiteSpace: style.whiteSpace,
          textOverflow: style.textOverflow,
          lineHeight: Number.parseFloat(style.lineHeight) || 0,
          noteScroll: noteEl.scrollWidth,
          noteClient: noteEl.clientWidth,
          scroll: scope.document.documentElement.scrollWidth,
          client: scope.document.documentElement.clientWidth,
        };
      });
      expect(found).not.toBeNull();
      const seen = found as NonNullable<typeof found>;
      const [row, note, text, actions, time] = [seen.row, seen.note, seen.text, seen.actions, seen.time] as [
        Rect,
        Rect,
        Rect,
        Rect,
        Rect,
      ];
      expect(await page.locator("[data-attn='host.forward_blocked'] .watch-note").isVisible()).toBe(true);
      // The line wraps and is not cut: nothing hides its overflow, and nothing in it is wider than its box.
      expect(seen.whiteSpace).toBe("normal");
      expect(seen.textOverflow).not.toBe("ellipsis");
      expect(seen.noteScroll).toBeLessThanOrEqual(seen.noteClient + 1);
      // It is long, so it takes more than one line at any of these widths, and the row grows to hold it.
      expect((note.bottom - note.top) / seen.lineHeight).toBeGreaterThan(1.5);
      expect(note.left).toBeGreaterThanOrEqual(row.left - 1);
      expect(note.right).toBeLessThanOrEqual(row.right + 1);
      expect(note.bottom).toBeLessThanOrEqual(row.bottom + 1);
      // And it overlaps none of the row's other parts, and the page gains no sideways scroll from it.
      for (const other of [text, actions, time]) expect(intersects(note, other)).toBe(false);
      expect(seen.scroll).toBeLessThanOrEqual(seen.client + 1);
      // The row's own sentence is one line cut at the edge on a wide screen, where the title has a hover to show it, and
      // wraps on a phone, which has none: nothing in it is hidden there.
      if (width <= 640) {
        expect(seen.sentenceWhiteSpace).toBe("normal");
        expect(seen.sentenceScroll).toBeLessThanOrEqual(seen.sentenceClient + 1);
      } else {
        expect(seen.sentenceWhiteSpace).toBe("nowrap");
      }
      // The reading order: on a phone the row says what it says, then why, then offers its buttons; on a wide screen the
      // buttons are on the first line and the reason is under all of it.
      expect(note.top).toBeGreaterThanOrEqual(text.bottom - 1);
      if (width <= 640) expect(actions.top).toBeGreaterThanOrEqual(note.bottom - 1);
      else expect(note.top).toBeGreaterThanOrEqual(actions.bottom - 1);
    },
  );

  test("the reason is said in Chinese too, in full, on a phone", async () => {
    await openWith(DROPPED_UNREACHABLE, 390, "zh-CN");
    const note = page.locator("[data-attn='host.forward_blocked'] .watch-note");
    expect(await note.isVisible()).toBe(true);
    expect(await note.innerText()).toContain("永远走不到");
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
