import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type Browser, chromium } from "@playwright/test";

import type { App } from "../src/app";
import { startServer } from "../src/server";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";

const executablePath = chromiumFor("The dialog spacing test");
const restoreLogs = silenceLogs();
afterAll(restoreLogs);

describe.skipIf(!executablePath)("dialog form spacing (real browser)", () => {
  let app: App | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser;
  let url = "";

  beforeAll(async () => {
    app = createTestApp().app;
    server = startServer(app);
    url = `http://127.0.0.1:${server.port}`;
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

  for (const [locale, width] of [
    ["zh-CN", 1280],
    ["en", 390],
  ] as const) {
    test(`the add-host dialog keeps the method selector apart from the form it reveals (${locale}, ${width}px)`, async () => {
      const context = await browser.newContext({ locale, viewport: { width, height: 900 } });
      expect((await context.request.post(`${url}/api/auth/login`, { data: { key: TEST_KEY } })).status()).toBe(200);
      const page = await context.newPage();
      await page.goto(`${url}/#/settings/hosts`);
      await page.waitForSelector("#stHostAdd");
      await page.click("#stHostAdd");
      await page.waitForSelector('[data-method-panel="agent"]:not([hidden])');
      // The dialog opens with a small scale animation, so the gaps are read with a little slack.
      const gaps = (await page.evaluate(`(async () => {
        const box = (selector) => document.querySelector(selector).getBoundingClientRect();
        const segmented = box(".dialog-body > .segmented");
        const panel = box(".dialog-body > [data-method-panel='agent']");
        const field = box(".dialog-body > [data-method-panel='agent'] .field");
        // The reference is the gap between two blocks of the same dialog that were already apart: the form's own fields.
        document.querySelector("[data-method='endpoint']").click();
        await new Promise((resolve) => setTimeout(resolve, 60));
        const form = document.querySelector("[data-method-panel='endpoint'] #stHostForm");
        const blocks = form.querySelectorAll(":scope > .grid, :scope > .field:not([hidden])");
        return {
          segmentedToPanel: panel.top - segmented.bottom,
          panelToField: field.top - panel.top,
          stackGap: blocks[1].getBoundingClientRect().top - blocks[0].getBoundingClientRect().bottom,
        };
      })()`)) as Record<"segmentedToPanel" | "panelToField" | "stackGap", number>;
      // The method selector and the form it reveals are two blocks, one dialog gap apart: the 16px the form's own fields
      // keep, not the 4px hint gap under a row of choices.
      expect(gaps.segmentedToPanel).toBeGreaterThan(0);
      expect(Math.abs(gaps.segmentedToPanel - gaps.stackGap)).toBeLessThanOrEqual(2);
      // The panel adds no spacing of its own, so the form starts where the panel does.
      expect(gaps.panelToField).toBe(0);
      await context.close();
    }, 30_000);

    test(`the create-checkpoint form keeps its hint, checkbox and footer apart (${locale}, ${width}px)`, async () => {
      const context = await browser.newContext({ locale, viewport: { width, height: 900 } });
      expect((await context.request.post(`${url}/api/auth/login`, { data: { key: TEST_KEY } })).status()).toBe(200);
      const page = await context.newPage();
      await page.goto(`${url}/#/settings/tokens`);
      await page.waitForSelector("#stTokenCreate");
      // The dialog opens with a small scale animation, so the gaps are read with a little slack.
      const gaps = (await page.evaluate(`(async () => {
        const ui = await import("/js/lib/ui.js");
        const ck = await import("/js/components/checkpoints.js");
        ui.openDialog({ title: "t", body: ck.takeFormHtml({ name: "acc" }), footer: '<button class="btn">x</button>' });
        const box = (selector) => document.querySelector(selector).getBoundingClientRect();
        const checkbox = box(".dialog-body > .checkbox");
        const checkboxInput = box(".dialog-body > .checkbox input");
        const labelLine = box(".dialog-body > .checkbox > span");
        const seg = box(".dialog-body .segmented");
        const hint = box(".dialog-body .segmented + .help");
        const description = box(".dialog-body > .checkbox .help");
        return {
          segToHint: hint.top - seg.bottom,
          hintToCheckbox: checkbox.top - hint.bottom,
          checkboxToFoot: box(".dialog-foot").top - checkbox.bottom,
          inputInsideLabelLine: checkboxInput.top >= labelLine.top && checkboxInput.bottom <= labelLine.top + 24,
          descriptionBelowTitle: description.top - labelLine.top,
        };
      })()`)) as Record<"segToHint" | "hintToCheckbox" | "checkboxToFoot" | "descriptionBelowTitle", number> & {
        inputInsideLabelLine: boolean;
      };
      expect(gaps.segToHint).toBeGreaterThanOrEqual(4);
      expect(gaps.hintToCheckbox).toBeGreaterThanOrEqual(14);
      expect(gaps.checkboxToFoot).toBeGreaterThanOrEqual(14);
      expect(gaps.inputInsideLabelLine).toBe(true);
      expect(gaps.descriptionBelowTitle).toBeGreaterThan(16);
      await context.close();
    }, 30_000);
  }
});
