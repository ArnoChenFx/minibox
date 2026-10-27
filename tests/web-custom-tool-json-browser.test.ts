import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type Browser, type BrowserContext, chromium, expect as webExpect, type Page } from "@playwright/test";

import type { App } from "../src/app";
import { startServer } from "../src/server";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";

const executablePath = chromiumFor("The tool JSON copy and paste test");

const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const TIMEOUT_MS = 30_000;
const VIEWPORT = { width: 1280, height: 900 };
/** The narrowest phone the console claims. */
const NARROW = { width: 320, height: 720 };

/** The catalog entry of `catalog/bun.json`, which a copy of the built-in row has to describe. */
const BUN = {
  id: "bun",
  name: "Bun",
  description: "Fast all-in-one JavaScript runtime, bundler and package manager, from the official bun npm package.",
  category: "languages",
  source: "npm",
  package: "bun",
  bin: "bun",
  needsRoot: false,
  estimatedMb: 85,
  install: "npm install -g --prefix {{prefix}} {{package_spec}}",
  upgrade: "npm install -g --prefix {{prefix}} {{package_spec}}",
  uninstall: "npm uninstall -g --prefix {{prefix}} {{package}}",
  detect: "command -v bun >/dev/null && bun --version 2>/dev/null",
};

/** What the browser holds in its clipboard, read back through the async API the copy itself uses. */
async function clipboardText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const view = globalThis as unknown as { navigator: { clipboard: { readText(): Promise<string> } } };
    return view.navigator.clipboard.readText();
  });
}

/** The form's values, as the dialog's inputs hold them. */
async function formValues(page: Page) {
  return page.evaluate(() => {
    interface El {
      value: string;
      checked: boolean;
      getAttribute(name: string): string | null;
    }
    const view = globalThis as unknown as {
      document: { querySelector(selector: string): El | null };
    };
    const read = (name: string): El => {
      const found = view.document.querySelector(`#ct-form [name="${name}"]`);
      if (!found) throw new Error(`no field ${name}`);
      return found;
    };
    const text = (name: string) => read(name).value;
    return {
      id: text("id"),
      idDisabled: read("id").getAttribute("disabled") !== null,
      name: text("name"),
      description: text("description"),
      category: text("category"),
      source: text("source"),
      package: text("package"),
      bin: text("bin"),
      requires: text("requires"),
      estimatedMb: text("estimatedMb"),
      needsRoot: read("needsRoot").checked,
      install: text("install"),
      upgrade: text("upgrade"),
      uninstall: text("uninstall"),
      stop: text("stop"),
      detect: text("detect"),
    };
  });
}

describe.skipIf(!executablePath)("a tool's JSON description (real browser)", () => {
  let app: App | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser;
  let context: BrowserContext | undefined;
  let page: Page;
  let consoleUrl = "";
  let boxHash = "";

  /** Opens the box's Tools section as a fresh render, and waits for the rows to be drawn. */
  async function openTools(): Promise<void> {
    // A load without a fragment is a real navigation, which closes any dialog a test left open.
    await page.goto(consoleUrl);
    await page.goto(`${consoleUrl}/#${boxHash}`);
    await webExpect(page.locator("#bdToolRows .spinner")).toHaveCount(0);
    await webExpect(page.locator('#bdToolRows [data-action="tool-copy-json"]').first()).toBeVisible();
  }

  const rowOf = (id: string) =>
    page.locator("#bdToolRows tr").filter({ has: page.locator(`td.mono:text-is("${id}")`) });

  beforeAll(async () => {
    const harness = createTestApp();
    app = harness.app;
    const host = app.hosts.get();
    harness.runtime.seedImage(app.cfg.baseTemplateTag, {
      [host.keys.template]: "true",
      [host.keys.templateName]: "base",
    });
    server = startServer(app);
    consoleUrl = `http://127.0.0.1:${server.port}`;

    const headers = { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}`, origin: consoleUrl };
    const created = await fetch(`${consoleUrl}/api/boxes`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "tools", cpus: 1, memoryMb: 512 }),
    });
    expect(created.status).toBe(201);
    const { box } = (await created.json()) as { box: { id: string } };
    boxHash = `/boxes/${encodeURIComponent(box.id)}/settings/tools`;

    browser = await chromium.launch({ executablePath: executablePath ?? undefined, args: ["--no-sandbox"] });
    context = await browser.newContext({ viewport: VIEWPORT });
    // The clipboard API needs a permission in Chromium, and the page copies through it when the context is secure.
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: consoleUrl });
    const login = await context.request.post(`${consoleUrl}/api/auth/login`, {
      data: { key: TEST_KEY },
      headers: { origin: consoleUrl },
    });
    expect(login.status()).toBe(200);
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
    "a built-in tool's copy button puts its catalog entry on the clipboard as valid JSON, with the entry's commands",
    async () => {
      await openTools();
      const row = rowOf("bun");
      await webExpect(row).toBeVisible();
      // A built-in row has no edit or delete action, only the copy button.
      await webExpect(row.locator('[data-action="tool-custom-edit"]')).toHaveCount(0);
      await webExpect(row.locator('[data-action="tool-custom-delete"]')).toHaveCount(0);
      await webExpect(row.locator('[data-action="tool-copy-json"]')).toHaveAttribute("aria-label", "Copy JSON");

      await row.locator('[data-action="tool-copy-json"]').click();
      await webExpect(page.locator("#toasts")).toContainText("JSON copied to the clipboard");
      const text = await clipboardText(page);
      // It parses, and it is the catalog entry: not the install status of this box.
      expect(JSON.parse(text)).toEqual(BUN);
      expect(text).not.toContain('"installed"');
      expect(text).not.toContain('"managed"');
      expect(text).not.toContain('"desiredVersion"');
      // The same shape a catalog/*.json file has: the fields in catalog order, two spaces of indent.
      expect(text).toBe(`${JSON.stringify(BUN, null, 2)}\n`);
    },
    TIMEOUT_MS,
  );

  test(
    "the new-tool dialog fills from a pasted description, and its id becomes <id>-copy because the catalog has that tool",
    async () => {
      await openTools();
      const text = await clipboardText(page);
      await page.locator("#bdToolCustomAdd").click();
      const dialog = page.locator(".overlay .dialog");
      await webExpect(dialog.locator("#ctPaste")).toBeVisible();
      // The paste box starts folded, so the form is what the dialog opens on.
      await webExpect(dialog.locator("#ctPasteBody")).toBeHidden();
      await dialog.locator("#ctPasteToggle").click();
      await webExpect(dialog.locator("#ctPasteBody")).toBeVisible();

      await dialog.locator("#ct-paste").fill(text);
      await dialog.locator("#ct-paste-apply").click();

      const values = await formValues(page);
      expect(values).toMatchObject({
        id: "bun-copy",
        name: BUN.name,
        description: BUN.description,
        category: BUN.category,
        source: BUN.source,
        package: BUN.package,
        bin: BUN.bin,
        requires: "",
        estimatedMb: "85",
        needsRoot: false,
        install: BUN.install,
        upgrade: BUN.upgrade,
        uninstall: BUN.uninstall,
        stop: "",
        detect: BUN.detect,
      });
      // The id is still the editable field of a new entry, and it is not a built-in id any more.
      expect(values.idDisabled).toBe(false);
      await webExpect(dialog.locator("#ct-builtin")).toBeHidden();
      await webExpect(dialog.locator("#ct-paste-error")).toHaveText("");
      await dialog.locator("[data-close]").first().click();
      await webExpect(dialog).toHaveCount(0);
    },
    TIMEOUT_MS,
  );

  test(
    "a bad description says what is wrong in the paste box, and leaves everything already typed in the form",
    async () => {
      await openTools();
      await page.locator("#bdToolCustomAdd").click();
      const dialog = page.locator(".overlay .dialog");
      await dialog.locator("#ctPasteToggle").click();
      await dialog.locator("#ct-name").fill("Typed by hand");
      await dialog.locator("#ct-package").fill("hand-written");
      await dialog.locator("#ct-bin").fill("hand");

      await dialog.locator("#ct-paste").fill("{not json");
      await dialog.locator("#ct-paste-apply").click();
      await webExpect(dialog.locator("#ct-paste-error")).toContainText("not valid JSON");
      // Nothing typed is cleared, and the paste box itself is still open with what was pasted.
      expect(await formValues(page)).toMatchObject({ name: "Typed by hand", package: "hand-written", bin: "hand" });
      await webExpect(dialog.locator("#ct-paste")).toHaveValue("{not json");

      // A field the form does not know is named too, rather than silently dropped.
      await dialog.locator("#ct-paste").fill(JSON.stringify({ ...BUN, instal: "typo" }));
      await dialog.locator("#ct-paste-apply").click();
      await webExpect(dialog.locator("#ct-paste-error")).toContainText("instal");
      expect(await formValues(page)).toMatchObject({ name: "Typed by hand" });
      await dialog.locator("[data-close]").first().click();
      await webExpect(dialog).toHaveCount(0);
    },
    TIMEOUT_MS,
  );

  test(
    "a custom tool's row copies too, and its copy is the entry tools.d holds",
    async () => {
      const headers = { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}`, origin: consoleUrl };
      const saved = await fetch(`${consoleUrl}/api/tools/custom/acme`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          name: "Acme CLI",
          description: "A tool the owner added.",
          category: "terminal",
          source: "npm",
          package: "acme",
          bin: "acme",
          install: "npm install -g --prefix {{prefix}} {{package_spec}}",
          upgrade: "npm install -g --prefix {{prefix}} {{package_spec}}",
          uninstall: "npm uninstall -g --prefix {{prefix}} {{package}}",
          detect: "command -v acme >/dev/null && acme --version 2>/dev/null",
        }),
      });
      expect(saved.status).toBe(200);

      await openTools();
      const row = rowOf("acme");
      await webExpect(row).toBeVisible();
      // A custom row keeps its own edit and delete actions beside the copy button.
      await webExpect(row.locator('[data-action="tool-custom-edit"]')).toBeVisible();
      await row.locator('[data-action="tool-copy-json"]').click();
      const copied = JSON.parse(await clipboardText(page));
      expect(copied).toMatchObject({ id: "acme", name: "Acme CLI", category: "terminal", package: "acme" });
      expect(Object.keys(copied)).not.toContain("overridesBuiltin");
      expect(Object.keys(copied)).not.toContain("installed");
    },
    TIMEOUT_MS,
  );

  test(
    "on a 320px phone a copy button is only its icon, so it adds no words to the row and the page never scrolls sideways",
    async () => {
      try {
        await page.setViewportSize(NARROW);
        await openTools();
        const layout = await page.evaluate(() => {
          interface El {
            getBoundingClientRect(): { width: number; right: number };
            getAttribute(name: string): string | null;
            textContent: string | null;
            style: { display: string };
            querySelector(selector: string): El | null;
          }
          const view = globalThis as unknown as {
            document: {
              documentElement: { scrollWidth: number; clientWidth: number };
              querySelector(selector: string): El | null;
              querySelectorAll(selector: string): unknown;
            };
            getComputedStyle(el: El): { position: string };
          };
          const root = view.document.documentElement;
          const found: El[] = [];
          for (const el of view.document.querySelectorAll(
            '#bdToolRows [data-action="tool-copy-json"]',
          ) as unknown as Iterable<El>) {
            found.push(el);
          }
          const table = view.document.querySelector("table.table") as El & { scrollWidth: number };
          const withButtons = table.scrollWidth;
          for (const el of found) el.style.display = "none";
          const withoutButtons = table.scrollWidth;
          for (const el of found) el.style.display = "";
          return {
            scrollWidth: root.scrollWidth,
            clientWidth: root.clientWidth,
            buttons: found.length,
            widths: found.map((el) => el.getBoundingClientRect().width),
            named: found.map((el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").trim() !== ""),
            labels: found.map((el) => {
              const label = el.querySelector(".tool-copy-label");
              return label ? view.getComputedStyle(label).position : "";
            }),
            // What the button adds to the widest row: the icon, not the words.
            added: withButtons - withoutButtons,
          };
        });
        expect(layout.buttons).toBeGreaterThan(0);
        // The page itself never scrolls sideways: the table scrolls inside its own card, as it already did.
        expect(layout.scrollWidth).toBe(layout.clientWidth);
        expect(layout.named.every(Boolean)).toBe(true);
        // Every button is an icon: 34px at most, with the words clipped to a screen-reader-only box.
        expect(layout.widths.every((width) => width <= 34)).toBe(true);
        expect(layout.labels.every((position) => position === "absolute")).toBe(true);
        // The words add nothing to the row: the table is no wider than one icon per row than it is without them.
        expect(layout.added).toBeLessThanOrEqual(40);
      } finally {
        await page.setViewportSize(VIEWPORT);
      }
    },
    TIMEOUT_MS,
  );
});
