import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type Browser, type BrowserContext, chromium, expect as webExpect, type Page } from "@playwright/test";

import type { App } from "../src/app";
import { ROOT } from "../src/config";
import { startServer } from "../src/server";
import { createDeclaredTemplate } from "../src/services/template-builds";
import { duplicateName, takenNames } from "../web/js/lib/duplicate-name.js";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";

const executablePath = chromiumFor("The template duplicate test");

const TIMEOUT_MS = 30_000;
const VIEWPORT = { width: 1280, height: 800 };

const WEB = join(ROOT, "web");
const EN = readFileSync(join(WEB, "js", "i18n", "en.js"), "utf8");
const ZH = readFileSync(join(WEB, "js", "i18n", "zh-CN.js"), "utf8");
const EN_BOXES = readFileSync(join(WEB, "js", "i18n", "en", "boxes.js"), "utf8");
const ZH_BOXES = readFileSync(join(WEB, "js", "i18n", "zh-CN", "boxes.js"), "utf8");

const restoreLogs = silenceLogs();
afterAll(restoreLogs);

describe("the name a duplicate is prefilled with", () => {
  test("is <name>-copy when that is free", () => {
    expect(duplicateName("tool")).toBe("tool-copy");
    expect(duplicateName("tool", takenNames([{ name: "base" }]))).toBe("tool-copy");
  });

  test("moves on to -copy-2, then -copy-3, when the shorter names are taken", () => {
    expect(duplicateName("tool", new Set(["tool-copy"]))).toBe("tool-copy-2");
    expect(duplicateName("tool", new Set(["tool-copy", "tool-copy-2"]))).toBe("tool-copy-3");
  });

  test("stays within the 63 characters a template name allows", () => {
    const long = "a".repeat(63);
    const name = duplicateName(long);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.endsWith("-copy")).toBe(true);
    const next = duplicateName(long, new Set([name]));
    expect(next.length).toBeLessThanOrEqual(63);
    expect(next).not.toBe(name);
  });

  test("drops a trailing separator so the copy's name stays valid", () => {
    expect(duplicateName("tool.")).toBe("tool-copy");
    expect(duplicateName("tool--")).toBe("tool-copy");
  });

  test("takenNames names every card's template, whichever host holds it", () => {
    expect([...takenNames([{ name: "a" }, { name: "b" }, { name: "a" }])]).toEqual(["a", "b"]);
    expect(takenNames([]).size).toBe(0);
  });
});

describe("the duplicate action on the template card", () => {
  test("the dialog says the build source and the description are copied, in both languages", () => {
    for (const [lang, source] of [
      ["en", EN],
      ["zh-CN", ZH],
    ] as const) {
      for (const key of [
        "tp.duplicate",
        "tp.duplicateTitle",
        "tp.duplicateDesc",
        "tp.duplicateDescImage",
        "tp.duplicateWhat",
        "tp.duplicateWhatImage",
        "tp.duplicateWhatOfficial",
        "tp.duplicateHereLocal",
        "tp.duplicateConfirm",
        "tp.duplicating",
        "tp.duplicated",
        "tp.duplicatedDraft",
        "tp.duplicateFailed",
      ])
        expect([lang, key, source.includes(`"${key}":`)]).toEqual([lang, key, true]);
    }
    expect(EN).toContain('"tp.duplicate": "Duplicate"');
    expect(EN).toContain('"tp.duplicateConfirm": "Duplicate template"');
    expect(ZH).toContain('"tp.duplicate": "复制"');
    expect(ZH).toContain('"tp.duplicateConfirm": "复制模板"');
    // The old wording, which copied an image, and its "build it first" reason are gone.
    expect(EN).not.toContain("tp.duplicateUnbuilt");
    expect(ZH).not.toContain("tp.duplicateUnbuilt");
    // The activity feed and the task panel name the new operation too.
    expect(EN_BOXES).toContain('"act.template.duplicate": "Duplicated template"');
    expect(ZH_BOXES).toContain('"act.template.duplicate": "复制模板"');
    // An activity record an earlier version wrote still reads, under the name it was recorded with.
    expect(EN_BOXES).toContain('"act.template.fork": "Duplicated template"');
    expect(ZH_BOXES).toContain('"act.template.fork": "复制模板"');
  });
});

describe.skipIf(!executablePath)("duplicating a template from the Templates page (real browser)", () => {
  let app: App | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser;
  let context: BrowserContext | undefined;
  let page: Page;
  let consoleUrl = "";

  beforeAll(async () => {
    const harness = createTestApp();
    app = harness.app;
    const host = app.hosts.get();
    harness.runtime.seedImage(app.cfg.baseTemplateTag, {
      [host.keys.template]: "true",
      [host.keys.templateName]: "base",
    });
    // A declared template with a recipe, so a duplicate copies one and can be built, plus the copy the name clashes with.
    await createDeclaredTemplate(
      host,
      {
        name: "tool",
        description: "Build tools",
        source: { kind: "dockerfile", text: "FROM alpine:3.20\n" },
        createdBy: "owner",
      },
      {},
    );
    await createDeclaredTemplate(
      host,
      { name: "tool-copy", source: { kind: "dockerfile", text: "FROM alpine:3.20\n" }, createdBy: "owner" },
      {},
    );
    server = startServer(app);
    consoleUrl = `http://127.0.0.1:${server.port}`;

    browser = await chromium.launch({ executablePath: executablePath ?? undefined, args: ["--no-sandbox"] });
    context = await browser.newContext({ viewport: VIEWPORT });
    const login = await context.request.post(`${consoleUrl}/api/auth/login`, {
      data: { key: TEST_KEY },
      headers: { origin: consoleUrl },
    });
    expect(login.status()).toBe(200);
    page = await context.newPage();
    await page.goto(`${consoleUrl}/#/library/templates`);
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

  // A card is a direct child of the grid: an unbuilt one also holds a Build button that carries the template name.
  const card = (name: string) => page.locator(`#tpGrid > [data-name="${name}"]`);
  const dialog = () => page.getByRole("dialog");

  test(
    "the library opens with every template listed, past the five a collapsed list shows, and the toggle collapses it",
    async () => {
      // base, tool, tool-copy and the four official templates: seven cards.
      await webExpect(page.locator("#tpGrid > [data-name]")).toHaveCount(7);
      const toggle = page.locator("#tpMore .list-toggle");
      await webExpect(toggle).toHaveAttribute("aria-expanded", "true");
      await toggle.click();
      await webExpect(page.locator("#tpGrid > [data-name]")).toHaveCount(5);
      await page.locator("#tpMore .list-toggle").click();
      await webExpect(page.locator("#tpGrid > [data-name]")).toHaveCount(7);
    },
    TIMEOUT_MS,
  );

  test(
    "the Duplicate button opens a dialog with the copy's name and the source description filled in",
    async () => {
      await webExpect(card("tool")).toBeVisible();
      await card("tool").getByRole("button", { name: "Duplicate", exact: true }).click();

      await webExpect(dialog()).toBeVisible();
      await webExpect(dialog().getByRole("heading")).toContainText("Duplicate “tool”");
      // `tool-copy` is taken, so the prefilled name moves on to `tool-copy-2`.
      await webExpect(dialog().locator("#tfName")).toHaveValue("tool-copy-2");
      await webExpect(dialog().locator("#tfDesc")).toHaveValue("Build tools");
      await webExpect(dialog()).toContainText("keeps the build source");
      // Nothing is copied from an image, so the dialog does not promise an image anymore.
      await webExpect(dialog()).not.toContainText("copy the image");
    },
    TIMEOUT_MS,
  );

  test(
    "confirming duplicates the template, and the new card is a draft with no size or creation time",
    async () => {
      await dialog().locator("#tfDesc").fill("Build tools, ours");
      await dialog().getByRole("button", { name: "Duplicate template" }).click();

      await webExpect(card("tool-copy-2")).toBeVisible();
      await webExpect(dialog()).toHaveCount(0);
      await webExpect(card("tool-copy-2")).toContainText("Build tools, ours");
      // A copy of a build source is a draft: it is not built, so it has no size and no creation time.
      await webExpect(card("tool-copy-2")).toContainText("Not built");
      await webExpect(card("tool-copy-2")).toContainText("Size—Created—");
      await webExpect(card("tool-copy-2").getByRole("button", { name: "Build", exact: true })).toBeVisible();
      await webExpect(card("tool-copy-2").getByRole("button", { name: "Edit", exact: true })).toBeVisible();
      await webExpect(card("tool-copy-2").getByRole("button", { name: "Delete template" })).toBeVisible();
      await webExpect(card("tool-copy-2").getByRole("button", { name: "Duplicate", exact: true })).toHaveCount(0);
      // The source card is unchanged.
      await webExpect(card("tool")).toContainText("Build tools");
      await webExpect(card("tool")).toContainText("Built from Dockerfile");
    },
    TIMEOUT_MS,
  );

  test(
    "a name that is taken keeps the dialog open and says so under the name",
    async () => {
      await card("tool").getByRole("button", { name: "Duplicate", exact: true }).click();
      await dialog().locator("#tfName").fill("tool-copy");
      await dialog().getByRole("button", { name: "Duplicate template" }).click();

      await webExpect(dialog()).toBeVisible();
      await webExpect(dialog().locator("#tfNameErr")).toContainText("already exists");
      await dialog().getByRole("button", { name: "Cancel" }).click();
      await webExpect(dialog()).toHaveCount(0);
    },
    TIMEOUT_MS,
  );

  test(
    "an official template no host holds can be duplicated too, into a draft from the Dockerfile that ships",
    async () => {
      // Nothing built `node` in this cluster, so its card is one no host holds, and its Duplicate button is live.
      const unbuilt = card("node");
      await webExpect(unbuilt).toBeVisible();
      const duplicate = unbuilt.getByRole("button", { name: "Duplicate", exact: true });
      await webExpect(duplicate).toBeVisible();
      await webExpect(duplicate).toBeEnabled();
      await duplicate.click();

      await webExpect(dialog()).toBeVisible();
      await webExpect(dialog().getByRole("heading")).toContainText("Duplicate “node”");
      await webExpect(dialog()).toContainText("has not built this official template");
      await dialog().locator("#tfName").fill("node-mine");
      await dialog().getByRole("button", { name: "Duplicate template" }).click();

      await webExpect(card("node-mine")).toBeVisible();
      await webExpect(card("node-mine")).toContainText("Not built");
      await webExpect(card("node-mine")).toContainText("Size—Created—");
      await webExpect(card("node-mine").getByRole("button", { name: "Build", exact: true })).toBeVisible();
      await webExpect(card("node-mine").getByRole("button", { name: "Edit", exact: true })).toBeVisible();
      await webExpect(card("node-mine").getByRole("button", { name: "Delete template" })).toBeVisible();
      await webExpect(card("node-mine").getByRole("button", { name: "Duplicate", exact: true })).toHaveCount(0);
      // The official card itself is still not built anywhere.
      await webExpect(card("node")).toContainText("Not built");
    },
    TIMEOUT_MS,
  );

  test(
    "the copy of the built-in base template is a draft that can be edited and built like any custom template",
    async () => {
      await card("base").getByRole("button", { name: "Duplicate", exact: true }).click();
      await dialog().locator("#tfName").fill("base-copy");
      await dialog().getByRole("button", { name: "Duplicate template" }).click();

      await webExpect(card("base-copy")).toBeVisible();
      await webExpect(dialog()).toHaveCount(0);
      await webExpect(card("base-copy")).toContainText("Not built");
      await webExpect(card("base-copy").getByRole("button", { name: "Edit", exact: true })).toBeVisible();
      await webExpect(card("base-copy").getByRole("button", { name: "Build", exact: true })).toBeVisible();
      // The base template is built by MiniBox, so it keeps no Edit button.
      await webExpect(card("base").getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    },
    TIMEOUT_MS,
  );
});
