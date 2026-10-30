import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type Browser, type BrowserContext, chromium, expect as webExpect, type Page } from "@playwright/test";

import type { App } from "../src/app";
import { ROOT } from "../src/config";
import { startServer } from "../src/server";
import { createDeclaredTemplate } from "../src/services/template-builds";
import { forkName, takenNames } from "../web/js/lib/fork-name.js";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";

const executablePath = chromiumFor("The template fork test");

const TIMEOUT_MS = 30_000;
const VIEWPORT = { width: 1280, height: 800 };

const WEB = join(ROOT, "web");
const EN = readFileSync(join(WEB, "js", "i18n", "en.js"), "utf8");
const ZH = readFileSync(join(WEB, "js", "i18n", "zh-CN.js"), "utf8");
const EN_BOXES = readFileSync(join(WEB, "js", "i18n", "en", "boxes.js"), "utf8");
const ZH_BOXES = readFileSync(join(WEB, "js", "i18n", "zh-CN", "boxes.js"), "utf8");

const restoreLogs = silenceLogs();
afterAll(restoreLogs);

describe("the name a fork is prefilled with", () => {
  test("is <name>-copy when that is free", () => {
    expect(forkName("tool")).toBe("tool-copy");
    expect(forkName("tool", takenNames([{ name: "base" }]))).toBe("tool-copy");
  });

  test("moves on to -copy-2, then -copy-3, when the shorter names are taken", () => {
    expect(forkName("tool", new Set(["tool-copy"]))).toBe("tool-copy-2");
    expect(forkName("tool", new Set(["tool-copy", "tool-copy-2"]))).toBe("tool-copy-3");
  });

  test("stays within the 63 characters a template name allows", () => {
    const long = "a".repeat(63);
    const name = forkName(long);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.endsWith("-copy")).toBe(true);
    const next = forkName(long, new Set([name]));
    expect(next.length).toBeLessThanOrEqual(63);
    expect(next).not.toBe(name);
  });

  test("drops a trailing separator so the copy's name stays valid", () => {
    expect(forkName("tool.")).toBe("tool-copy");
    expect(forkName("tool--")).toBe("tool-copy");
  });

  test("takenNames names every card's template, whichever host holds it", () => {
    expect([...takenNames([{ name: "a" }, { name: "b" }, { name: "a" }])]).toEqual(["a", "b"]);
    expect(takenNames([]).size).toBe(0);
  });
});

describe("the fork action on the template card", () => {
  test("the dialog says the build source is copied and the copy can be rebuilt, in both languages", () => {
    for (const [lang, source] of [
      ["en", EN],
      ["zh-CN", ZH],
    ] as const) {
      for (const key of [
        "tp.fork",
        "tp.forkTitle",
        "tp.forkDesc",
        "tp.forkWhat",
        "tp.forkConfirm",
        "tp.forking",
        "tp.forked",
        "tp.forkFailed",
      ])
        expect([lang, key, source.includes(`"${key}":`)]).toEqual([lang, key, true]);
    }
    expect(EN).toContain("A template saved from a box has no build source, so its copy cannot be rebuilt.");
    expect(ZH).toContain("从 Box 保存的模板没有构建来源，因此它的副本不能重新构建。");
    // The activity feed and the task panel name the new operation too.
    expect(EN_BOXES).toContain('"act.template.fork": "Forked template"');
    expect(ZH_BOXES).toContain('"act.template.fork": "派生模板"');
  });
});

describe.skipIf(!executablePath)("forking a template from the Templates page (real browser)", () => {
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
    // A declared template with a recipe, so the fork copies one and can be rebuilt, plus the copy the name clashes with.
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
    "the Fork button opens a dialog with the copy's name and the source description filled in",
    async () => {
      await webExpect(card("tool")).toBeVisible();
      await card("tool").getByRole("button", { name: "Fork", exact: true }).click();

      await webExpect(dialog()).toBeVisible();
      await webExpect(dialog().getByRole("heading")).toContainText("Fork “tool”");
      // `tool-copy` is taken, so the prefilled name moves on to `tool-copy-2`.
      await webExpect(dialog().locator("#tfName")).toHaveValue("tool-copy-2");
      await webExpect(dialog().locator("#tfDesc")).toHaveValue("Build tools");
      await webExpect(dialog()).toContainText("keeps the build source");
    },
    TIMEOUT_MS,
  );

  test(
    "confirming forks the template and the new card appears, with a description the dialog was given",
    async () => {
      await dialog().locator("#tfDesc").fill("Build tools, ours");
      await dialog().getByRole("button", { name: "Fork template" }).click();

      await webExpect(card("tool-copy-2")).toBeVisible();
      await webExpect(dialog()).toHaveCount(0);
      await webExpect(card("tool-copy-2")).toContainText("Build tools, ours");
      await webExpect(card("tool-copy-2")).toContainText("Built from Dockerfile");
      // The source card is unchanged.
      await webExpect(card("tool")).toContainText("Build tools");
    },
    TIMEOUT_MS,
  );

  test(
    "a name that is taken keeps the dialog open and says so under the name",
    async () => {
      await card("tool").getByRole("button", { name: "Fork", exact: true }).click();
      await dialog().locator("#tfName").fill("tool-copy");
      await dialog().getByRole("button", { name: "Fork template" }).click();

      await webExpect(dialog()).toBeVisible();
      await webExpect(dialog().locator("#tfNameErr")).toContainText("already exists");
      await dialog().getByRole("button", { name: "Cancel" }).click();
      await webExpect(dialog()).toHaveCount(0);
    },
    TIMEOUT_MS,
  );

  test(
    "the forked template can be rebuilt from its card, which a template saved from a box cannot",
    async () => {
      await webExpect(card("tool-copy-2").getByRole("button", { name: "Rebuild" })).toBeVisible();
    },
    TIMEOUT_MS,
  );

  test(
    "an official template no host holds shows the Fork button off, and forcing a click opens nothing",
    async () => {
      // Nothing built `node` in this cluster, so its card is one no host holds.
      const unbuilt = card("node");
      await webExpect(unbuilt).toBeVisible();
      const fork = unbuilt.getByRole("button", { name: "Fork", exact: true });
      await webExpect(fork).toBeVisible();
      await webExpect(fork).toBeDisabled();
      await webExpect(fork).toHaveAttribute("title", /Build it first/);

      await fork.click({ force: true });
      await webExpect(dialog()).toHaveCount(0);
    },
    TIMEOUT_MS,
  );

  test(
    "the copy of the built-in base template can be edited and rebuilt like any custom template",
    async () => {
      await card("base").getByRole("button", { name: "Fork", exact: true }).click();
      await dialog().locator("#tfName").fill("base-copy");
      await dialog().getByRole("button", { name: "Fork template" }).click();

      await webExpect(card("base-copy")).toBeVisible();
      await webExpect(dialog()).toHaveCount(0);
      await webExpect(card("base-copy")).toContainText("Built from Dockerfile");
      await webExpect(card("base-copy").getByRole("button", { name: "Edit", exact: true })).toBeVisible();
      await webExpect(card("base-copy").getByRole("button", { name: "Rebuild" })).toBeVisible();
      // The base template is built by MiniBox, so it keeps neither button.
      await webExpect(card("base").getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    },
    TIMEOUT_MS,
  );
});
