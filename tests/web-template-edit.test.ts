import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type Browser, type BrowserContext, chromium, expect as webExpect, type Page } from "@playwright/test";

import type { App } from "../src/app";
import { ROOT } from "../src/config";
import { startServer } from "../src/server";
import { createDeclaredTemplate, readRecipe } from "../src/services/template-builds";
import { initOf, readPorts } from "../web/js/lib/template-edit.js";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";

const executablePath = chromiumFor("The template edit test");

const TIMEOUT_MS = 30_000;
const VIEWPORT = { width: 1280, height: 800 };

const WEB = join(ROOT, "web");
const PAGE = readFileSync(join(WEB, "js", "pages", "templates.js"), "utf8");
const DIALOG = readFileSync(join(WEB, "js", "components", "edit-template.js"), "utf8");
const EN = readFileSync(join(WEB, "js", "i18n", "en.js"), "utf8");
const ZH = readFileSync(join(WEB, "js", "i18n", "zh-CN.js"), "utf8");
const EN_ERRORS = readFileSync(join(WEB, "js", "i18n", "en", "errors.js"), "utf8");
const ZH_ERRORS = readFileSync(join(WEB, "js", "i18n", "zh-CN", "errors.js"), "utf8");
const EN_BOXES = readFileSync(join(WEB, "js", "i18n", "en", "boxes.js"), "utf8");
const ZH_BOXES = readFileSync(join(WEB, "js", "i18n", "zh-CN", "boxes.js"), "utf8");

const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const FROM_ALPINE = "FROM alpine:3.20\nRUN true\n";

describe("the ports an edit asks for", () => {
  test("a comma or space separated list becomes the numbers it names", () => {
    expect(readPorts("3000, 8080")).toEqual({ ports: [3000, 8080] });
    expect(readPorts("3000 8080")).toEqual({ ports: [3000, 8080] });
    expect(readPorts("  ")).toEqual({ ports: [] });
    expect(readPorts("")).toEqual({ ports: [] });
  });

  test("an entry that is not a port names itself as the problem", () => {
    expect(readPorts("3000, db:5432")).toEqual({ problem: "db:5432" });
    expect(readPorts("0")).toEqual({ problem: "0" });
    expect(readPorts("65536")).toEqual({ problem: "65536" });
    expect(readPorts("1.5")).toEqual({ problem: "1.5" });
  });
});

describe("the setup an edit sends", () => {
  test("a command becomes the sh -c run the server stores, and the ports come along", () => {
    expect(initOf("npm install", [3000])).toEqual({
      postCreate: ["/bin/sh", "-c", "npm install"],
      forwardPorts: [3000],
    });
  });

  test("an empty command and no ports mean no setup, which is sent as null so a recipe drops the one it had", () => {
    expect(initOf("", [])).toBeNull();
    expect(initOf("   ", [])).toBeNull();
  });

  test("ports without a command still make a setup", () => {
    expect(initOf("", [8080])).toEqual({ forwardPorts: [8080] });
  });
});

describe("the edit action on the template card", () => {
  test("the page renders an edit button on a template that has a source, wired to the edit dialog", () => {
    expect(PAGE).toContain('data-action="edit"');
    expect(PAGE).toContain('import { openEditTemplate } from "../components/edit-template.js"');
    expect(PAGE).toContain("void openEditTemplate({ card, onEdited:");
    // A template with no source has nothing to edit, so its card shows no edit button.
    expect(PAGE).toContain('${tp.buildKind && !unbuilt ? `<button class="btn btn-sm" data-action="edit"');
  });

  test("the dialog reads the recipe first, then patches the template and reloads the page", () => {
    expect(DIALOG).toContain("/recipe`");
    expect(DIALOG).toContain('method: "PATCH"');
    expect(DIALOG).toContain("invalidateTemplates()");
    expect(PAGE).toContain("onEdited: (name) => load(name)");
  });

  test("the dialog says the image is kept until a rebuild, in both languages", () => {
    for (const [lang, source] of [
      ["en", EN],
      ["zh-CN", ZH],
    ] as const) {
      for (const key of [
        "tp.edit",
        "tp.editTitle",
        "tp.editDesc",
        "tp.editWhat",
        "tp.editConfirm",
        "tp.editing",
        "tp.edited",
        "tp.editFailed",
        "tp.editPorts",
        "tp.editPortsHelp",
        "tp.editPostCreateHelp",
        "tp.errPort",
        "tp.editOfficial",
      ]) {
        expect([lang, key, source.includes(`"${key}":`)]).toEqual([lang, key, true]);
      }
    }
    expect(EN).toContain("Saving changes the recipe only.");
    expect(ZH).toContain("保存只会修改构建记录。");
    // The activity feed and the error the server answers with are translated too.
    expect(EN_BOXES).toContain('"act.template.edit": "Edited template"');
    expect(ZH_BOXES).toContain('"act.template.edit": "修改模板"');
    expect(EN_ERRORS).toContain('"err.template_edit_empty":');
    expect(ZH_ERRORS).toContain('"err.template_edit_empty":');
  });
});

describe.skipIf(!executablePath)("editing a template from the Templates page (real browser)", () => {
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
    // A declared template with a recipe, so its Dockerfile can be edited, plus one saved from a box that has none.
    await createDeclaredTemplate(
      host,
      {
        name: "tool",
        description: "Build tools",
        source: { kind: "dockerfile", text: FROM_ALPINE },
        createdBy: "owner",
      },
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

  const card = (name: string) => page.locator(`#tpGrid [data-name="${name}"]`);
  const dialog = () => page.getByRole("dialog");

  test(
    "the Edit button opens a dialog with the Dockerfile, the description and the setup filled in",
    async () => {
      await webExpect(card("tool")).toBeVisible();
      await card("tool").getByRole("button", { name: "Edit", exact: true }).click();

      await webExpect(dialog()).toBeVisible();
      await webExpect(dialog().getByRole("heading")).toContainText("Edit “tool”");
      await webExpect(dialog().locator("#teDockerfile")).toHaveValue(FROM_ALPINE);
      await webExpect(dialog().locator("#teDesc")).toHaveValue("Build tools");
      await webExpect(dialog().locator("#tePorts")).toHaveValue("");
    },
    TIMEOUT_MS,
  );

  test(
    "saving changes the Dockerfile the template rebuilds from, and the card stays as it is until a rebuild",
    async () => {
      await dialog().locator("#teDockerfile").fill("FROM alpine:3.21\n");
      await dialog().locator("#tePorts").fill("3000, 8080");
      await dialog().getByRole("button", { name: "Save changes" }).click();

      await webExpect(dialog()).toHaveCount(0);
      await webExpect(card("tool")).toBeVisible();
      const host = app?.hosts.get();
      if (!host) throw new Error("the test app has a host");
      // The recipe is the edited one, and no build ran, so the card still says what it said before.
      const recipe = readRecipe(host, "tool");
      expect(recipe?.source).toEqual({ kind: "dockerfile", text: "FROM alpine:3.21\n" });
      expect(recipe?.init).toEqual({ forwardPorts: [3000, 8080] });
      await webExpect(card("tool")).toContainText("Build tools");
      await webExpect(card("tool").getByRole("button", { name: "Rebuild" })).toBeVisible();
    },
    TIMEOUT_MS,
  );

  test(
    "a port that is not a port keeps the dialog open and says which entry is wrong",
    async () => {
      // The save before this reloads the list, so the card is waited for rather than clicked while it redraws.
      const edit = card("tool").getByRole("button", { name: "Edit", exact: true });
      await webExpect(edit).toBeVisible();
      await edit.click();
      await webExpect(dialog()).toBeVisible();
      await dialog().locator("#tePorts").fill("db:5432");
      await dialog().getByRole("button", { name: "Save changes" }).click();

      await webExpect(dialog()).toBeVisible();
      await webExpect(dialog().locator("#teErr")).toContainText("db:5432");
      await dialog().getByRole("button", { name: "Cancel" }).click();
      await webExpect(dialog()).toHaveCount(0);
    },
    TIMEOUT_MS,
  );

  test(
    "the card of a template saved from a box has no Edit button, because it has no source to edit",
    async () => {
      await webExpect(card("base")).toBeVisible();
      await webExpect(card("base").getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    },
    TIMEOUT_MS,
  );
});
