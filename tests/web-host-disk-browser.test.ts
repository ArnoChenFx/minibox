import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type Browser, type BrowserContext, chromium, expect as webExpect } from "@playwright/test";

import { silenceLogs, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";
import { type Harness, startHarness } from "./support/tokens";

const executablePath = chromiumFor("The host disk list test");
const restoreLogs = silenceLogs();
afterAll(restoreLogs);

describe.skipIf(!executablePath)("host disk readings across list toggles (real browser)", () => {
  let harness: Harness;
  let browser: Browser;

  beforeAll(async () => {
    harness = startHarness();
    for (let n = 1; n <= 5; n += 1) {
      await harness.app.hostAdmin.add({ id: `remote${n}`, endpoint: `unix:///run/test-host-${n}.sock` });
    }
    browser = await chromium.launch({ executablePath: executablePath ?? undefined, args: ["--no-sandbox"] });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    harness?.app.hostAdmin.close();
    harness?.stop();
  });

  async function signedIn(): Promise<BrowserContext> {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    expect(
      (
        await context.request.post(`${harness.base}/api/auth/login`, {
          data: { key: TEST_KEY },
          headers: { origin: harness.base },
        })
      ).status(),
    ).toBe(200);
    return context;
  }

  for (const pending of [false, true]) {
    test(`toggling ${pending ? "before" : "after"} disk reads finish preserves readings and fetches each host once`, async () => {
      const context = await signedIn();
      const gate = Promise.withResolvers<void>();
      const counts = new Map<string, number>();
      try {
        const page = await context.newPage();
        await page.route("**/api/hosts/*/disk", async (route) => {
          const path = new URL(route.request().url()).pathname;
          counts.set(path, (counts.get(path) ?? 0) + 1);
          if (pending) await gate.promise;
          await route.continue();
        });
        await page.goto(`${harness.base}/#/settings/hosts`);
        await webExpect.poll(() => counts.size).toBe(5);
        if (!pending) await webExpect(page.locator('[data-disk-host="local"]')).toContainText("reclaimable");
        const toggle = page.locator('#stHosts [data-toggle="hosts"]');
        await toggle.click();
        await webExpect(page.locator("[data-disk-host]")).toHaveCount(6);
        await webExpect.poll(() => counts.size).toBe(6);
        await toggle.click();
        await webExpect(page.locator("[data-disk-host]")).toHaveCount(5);
        await toggle.click();
        gate.resolve();
        for (const id of ["local", "remote5"]) {
          await webExpect(page.locator(`[data-disk-host="${id}"]`)).toContainText("reclaimable");
        }
        expect([...counts.values()]).toEqual([1, 1, 1, 1, 1, 1]);
      } finally {
        gate.resolve();
        await context.close();
      }
    }, 30_000);
  }
});
