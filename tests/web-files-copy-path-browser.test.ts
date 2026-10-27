import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type Browser, type BrowserContext, chromium, expect as webExpect, type Page } from "@playwright/test";

import type { App } from "../src/app";
import { startServer } from "../src/server";
import { listVolumes } from "../src/services/volumes";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";

const executablePath = chromiumFor("The copy path test");
const restoreLogs = silenceLogs();
afterAll(restoreLogs);

/** What the browser holds in its clipboard, read back through the async API the copy itself uses. */
async function clipboardText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const view = globalThis as unknown as { navigator: { clipboard: { readText(): Promise<string> } } };
    return view.navigator.clipboard.readText();
  });
}

const file = (text: string) => ({
  type: "file" as const,
  content: Buffer.from(text),
  mode: 0o644,
  uid: 1000,
  gid: 1000,
});
const dir = () => ({ type: "dir" as const, mode: 0o755, uid: 1000, gid: 1000 });

describe.skipIf(!executablePath)("copying a file's absolute path (real browser)", () => {
  let app: App | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser;
  let context: BrowserContext;
  let url = "";
  let page: Page;

  beforeAll(async () => {
    const harness = createTestApp();
    app = harness.app;
    const host = app.hosts.get();
    harness.runtime.seedImage(app.cfg.baseTemplateTag, {
      [host.keys.template]: "true",
      [host.keys.templateName]: "base",
    });
    server = startServer(app);
    url = `http://127.0.0.1:${server.port}`;
    const made = await fetch(`${url}/api/boxes`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}`, origin: url },
      body: JSON.stringify({ name: "copier", cpus: 1, memoryMb: 512 }),
    });
    expect(made.status).toBe(201);
    const boxId = ((await made.json()) as { box: { id: string } }).box.id;
    const volume = (await listVolumes(host)).find((entry) => entry.name === "copier-workspace");
    if (!volume) throw new Error("the new box has no workspace volume");
    const files = harness.runtime.filesOf(volume.engineName);
    files.set("README.md", file("# hi\n"));
    files.set("src", dir());
    files.set("src/main.ts", file("export {};\n"));
    url = `${url}/#/boxes/${boxId}/files`;

    browser = await chromium.launch({ executablePath: executablePath ?? undefined, args: ["--no-sandbox"] });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    // The clipboard API needs a permission in Chromium, and the page copies through it when the context is secure.
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: url.split("/#/")[0] ?? url });
    expect(
      (
        await context.request.post(`${url.split("/#/")[0]}/api/auth/login`, {
          data: { key: TEST_KEY },
          headers: { origin: url },
        })
      ).status(),
    ).toBe(200);
    page = await context.newPage();
    await page.goto(url);
    await page.waitForSelector("#fbBody .fb-name", { timeout: 15_000 });
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

  test("a file's copy button puts the path the box sees on the clipboard", async () => {
    const row = page.locator("#fbBody tr", { hasText: "README.md" }).first();
    await row.locator('[data-fb="copy-path"]').click();
    await webExpect(page.locator("#toasts")).toContainText("Path copied");
    expect(await clipboardText(page)).toBe("/workspace/README.md");
  });

  test("a folder and a file inside it copy their own absolute path, not the folder's", async () => {
    const folder = page.locator("#fbBody tr", { hasText: "src" }).first();
    await folder.locator('[data-fb="copy-path"]').click();
    await webExpect.poll(() => clipboardText(page)).toBe("/workspace/src");

    await page.locator("#fbBody [data-fb='open'][data-path='src']").click();
    await webExpect(page.locator("#fbCrumbs")).toContainText("src");
    const inner = page.locator("#fbBody tr", { hasText: "main.ts" }).first();
    await inner.locator('[data-fb="copy-path"]').click();
    await webExpect.poll(() => clipboardText(page)).toBe("/workspace/src/main.ts");
  });

  test("the copy button is its icon alone, and five actions stay inside a phone's width", async () => {
    const button = page.locator("#fbBody [data-fb='copy-path']").first();
    // The words are the tooltip and the accessible name, never a label in the row.
    await webExpect(button).toHaveAttribute("title", "Copy path");
    await webExpect(button).toHaveAttribute("aria-label", "Copy path");
    expect(((await button.textContent()) ?? "").trim()).toBe("");

    for (const width of [640, 480, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(120);
      const measured = await page.evaluate(() => {
        const doc = globalThis as unknown as {
          document: { querySelectorAll(s: string): ArrayLike<unknown>; documentElement: { scrollWidth: number } };
          innerWidth: number;
        };
        const buttons = Array.from(doc.document.querySelectorAll("#fbBody .fb-actions .icon-btn")) as unknown as Array<{
          getBoundingClientRect(): { width: number; height: number; left: number; right: number };
        }>;
        const cells = Array.from(doc.document.querySelectorAll("#fbBody .fb-col-actions")) as unknown as Array<{
          getBoundingClientRect(): { left: number; right: number };
        }>;
        const sized = buttons.map((node) => node.getBoundingClientRect());
        // Two buttons of one row that share an edge would sit on top of each other.
        const overlaps = sized.filter((box, index) =>
          sized.slice(index + 1).some((other) => box.left < other.left && box.right > other.left + 1),
        ).length;
        return {
          overflow: doc.document.documentElement.scrollWidth - doc.innerWidth,
          widths: [...new Set(sized.map((box) => Math.round(box.width)))],
          overlaps,
          outside: cells.filter((cell) => {
            const box = cell.getBoundingClientRect();
            return box.right > doc.innerWidth + 1 || box.left < -1;
          }).length,
        };
      });
      expect({ width, ...measured }).toEqual({ width, overflow: 0, widths: [28], overlaps: 0, outside: 0 });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  }, 60_000);
});
