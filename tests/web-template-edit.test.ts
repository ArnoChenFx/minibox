import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type Browser, type BrowserContext, chromium, expect as webExpect, type Page } from "@playwright/test";

import type { App } from "../src/app";
import { startServer } from "../src/server";
import { createDeclaredTemplate, readRecipe, editRecipe, templateAndRecipe } from "../src/services/template-builds";
import { initOf, readPorts } from "../web/js/lib/template-edit.js";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";

const executablePath = chromiumFor("The template edit test");

const TIMEOUT_MS = 30_000;
const VIEWPORT = { width: 1280, height: 800 };

const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const FROM_ALPINE = "FROM alpine:3.20\nRUN true\n";

/** One request the page made, kept so a test can say what the dialog sent and in which order. */
interface Sent {
  method: string;
  url: string;
  body: string;
}

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
    expect(initOf("", [8080])).toEqual({ postCreate: [], forwardPorts: [8080] });
  });
});

describe.skipIf(!executablePath)("editing a template from the Templates page (real browser)", () => {
  let app: App | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser;
  let context: BrowserContext | undefined;
  let page: Page;
  let consoleUrl = "";
  /** What the page has sent, in order, so a test can read the recipe-then-patch-then-reload sequence. */
  const sent: Sent[] = [];

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
    // An official template: its Dockerfile ships with MiniBox, so the dialog offers no source field for it.
    await createDeclaredTemplate(
      host,
      { name: "official-node", source: { kind: "official", name: "node" }, createdBy: "owner" },
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
    page.on("request", (request) => {
      if (!request.url().includes("/api/")) return;
      sent.push({ method: request.method(), url: request.url(), body: request.postData() ?? "" });
    });
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
  const lastPatch = () => sent.filter((request) => request.method === "PATCH").at(-1);
  const recipeRead = () => sent.findIndex((request) => request.method === "GET" && request.url.endsWith("/recipe"));
  const listRead = () =>
    sent.findIndex((request) => request.method === "GET" && /\/api\/templates(\?|$)/.test(request.url));

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
      // The dialog names the template it edits, and explains the fields the save below fills in.
      await webExpect(dialog()).toContainText("mbtest-template:tool");
      await webExpect(dialog()).toContainText("TCP ports a box created from the template opens");
      await webExpect(dialog()).toContainText("Runs once in each box created from the template");
      // The dialog says the image is kept until a rebuild, which is what the save below relies on.
      await webExpect(dialog()).toContainText("Saving changes the recipe only.");
      // Opening the dialog read the recipe first, so every field started with what the template has now.
      expect(recipeRead()).toBeGreaterThanOrEqual(0);
    },
    TIMEOUT_MS,
  );

  test(
    "saving patches the edited source and setup, reloads the list, and the card stays as it is until a rebuild",
    async () => {
      sent.length = 0;
      await dialog().locator("#teDockerfile").fill("FROM alpine:3.21\n");
      await dialog().locator("#tePorts").fill("3000, 8080");
      await dialog().getByRole("button", { name: "Save changes" }).click();

      await webExpect(dialog()).toHaveCount(0);
      await webExpect(page.locator("#toasts")).toContainText("Template updated");
      // The body carries the edited source and setup, and the page reloaded the list after the patch.
      const patched = sent.findIndex((request) => request.method === "PATCH");
      expect([patched >= 0, listRead() > patched]).toEqual([true, true]);
      expect(JSON.parse(lastPatch()?.body ?? "{}")).toMatchObject({
        source: { kind: "dockerfile", text: "FROM alpine:3.21\n" },
        init: { forwardPorts: [3000, 8080] },
      });

      await webExpect(card("tool")).toBeVisible();
      // The reload names the edited template, so the page scrolls its card into view instead of leaving it off screen.
      await webExpect(card("tool")).toHaveClass(/is-focus/);
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
    "in Chinese the dialog's own words are translated, not the English copied across",
    async () => {
      const chinese = await browser.newContext({ viewport: VIEWPORT, locale: "zh-CN" });
      try {
        const login = await chinese.request.post(`${consoleUrl}/api/auth/login`, {
          data: { key: TEST_KEY },
          headers: { origin: consoleUrl },
        });
        expect(login.status()).toBe(200);
        const zhPage = await chinese.newPage();
        await zhPage.goto(`${consoleUrl}/#/library/templates`);
        await webExpect(zhPage.locator(`#tpGrid [data-name="tool"]`)).toBeVisible();
        await zhPage.locator(`#tpGrid [data-name="tool"]`).getByRole("button", { name: "修改", exact: true }).click();
        const zhDialog = zhPage.getByRole("dialog");
        await webExpect(zhDialog).toBeVisible();
        await webExpect(zhDialog.getByRole("heading")).toContainText("修改「tool」");
        await webExpect(zhDialog).toContainText("保存只会修改构建记录。");
        await webExpect(zhDialog).not.toContainText("Saving changes the recipe only.");
        await webExpect(zhDialog.getByRole("button", { name: "保存修改" })).toBeVisible();
        // The port error is translated too, and it names the entry the operator typed.
        await zhDialog.locator("#tePorts").fill("db:5432");
        await zhDialog.getByRole("button", { name: "保存修改" }).click();
        await webExpect(zhDialog.locator("#teErr")).toContainText("「db:5432」不是 1 到 65535 之间的端口。");
      } finally {
        await chinese.close();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "an official template's dialog offers its setup and description only, and saving sends no source",
    async () => {
      const edit = card("official-node").getByRole("button", { name: "Edit", exact: true });
      await webExpect(edit).toBeVisible();
      await edit.click();
      await webExpect(dialog()).toBeVisible();
      // Its Dockerfile ships with MiniBox, so there is no field to edit and the dialog says why.
      await webExpect(dialog().locator("#teDockerfile")).toHaveCount(0);
      await webExpect(dialog()).toContainText("built from MiniBox's own Dockerfile");

      sent.length = 0;
      await dialog().locator("#tePorts").fill("8080");
      await dialog().getByRole("button", { name: "Save changes" }).click();
      await webExpect(dialog()).toHaveCount(0);

      const body = JSON.parse(lastPatch()?.body ?? "{}") as Record<string, unknown>;
      expect(body).not.toHaveProperty("source");
      expect(body.init).toEqual({ postCreate: [], forwardPorts: [8080] });
      const host = app?.hosts.get();
      if (!host) throw new Error("the test app has a host");
      expect(readRecipe(host, "official-node")?.source).toEqual({ kind: "official", name: "node" });
      expect(readRecipe(host, "official-node")?.init).toEqual({ forwardPorts: [8080] });
    },
    TIMEOUT_MS,
  );

  test(
    "while the save is in flight the button says it is saving and cannot be pressed again",
    async () => {
      // Hold the PATCH so the saving state can be read before the server answers.
      const held = Promise.withResolvers<void>();
      const settled = Promise.withResolvers<void>();
      await page.route("**/api/templates/*", async (route) => {
        if (route.request().method() !== "PATCH") return route.continue();
        await held.promise;
        await route.continue();
        settled.resolve();
      });
      try {
        await card("tool").getByRole("button", { name: "Edit", exact: true }).click();
        await webExpect(dialog()).toBeVisible();
        sent.length = 0;
        await dialog().locator("#tePorts").fill("9090");
        await dialog().getByRole("button", { name: "Save changes" }).click();

        const ok = dialog().locator("#teOk");
        await webExpect(ok).toHaveText("Saving…");
        await webExpect(ok).toBeDisabled();
        // A second press while the first is in flight sends nothing more.
        await ok.dispatchEvent("click");
        expect(sent.filter((request) => request.method === "PATCH")).toHaveLength(1);

        const response = page.waitForResponse(
          (reply) => reply.request().method() === "PATCH" && reply.url().includes("/api/templates/"),
        );
        held.resolve();
        await settled.promise;
        expect((await response).status()).toBe(200);
        await webExpect(dialog()).toHaveCount(0);
        const host = app?.hosts.get();
        if (!host) throw new Error("the test app has a host");
        expect(readRecipe(host, "tool")?.init).toEqual({ forwardPorts: [9090] });
      } finally {
        held.resolve();
        await page.unroute("**/api/templates/*");
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a recipe the server cannot answer says so and opens no dialog, so a field is never filled with nothing",
    async () => {
      await page.route("**/recipe", (route) => route.fulfill({ status: 500, body: "{}" }));
      try {
        await card("tool").getByRole("button", { name: "Edit", exact: true }).click();
        await webExpect(page.locator("#toasts")).toContainText("Couldn't edit template");
        await webExpect(dialog()).toHaveCount(0);
      } finally {
        await page.unroute("**/recipe");
      }
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
  test(
    "opening focus never steals a field the operator already chose",
    async () => {
      const active = await page.evaluate<string>(`(async () => {
      const { openDialog } = await import('/js/lib/ui.js');
      const dialog = openDialog({ title: 'Focus', body: '<input id="focusFirst"><input id="focusSecond">' });
      dialog.root.querySelector('#focusSecond').focus();
      await new Promise(resolve => setTimeout(resolve, 50));
      const active = document.activeElement.id;
      dialog.close();
      return active;
    })()`);
      expect(active).toBe("focusSecond");
    },
    TIMEOUT_MS,
  );
  test(
    "changing ports preserves a multiline argv that the one-line command field normalizes",
    async () => {
      const host = app?.hosts.get();
      if (!host) throw new Error("the test app has a host");
      const argv = ["printf", "%s", "first\nsecond", "", "$LITERAL"];
      const [declared] = await templateAndRecipe(host, "mbtest-template:tool");
      editRecipe(host, declared, { init: { postCreate: argv, forwardPorts: [] } });
      await page.reload();
      await card("tool").getByRole("button", { name: "Edit", exact: true }).click();
      await webExpect(dialog()).toBeVisible();
      await dialog().locator("#tePorts").fill("3030");
      const response = page.waitForResponse((reply) => reply.request().method() === "PATCH");
      await dialog().getByRole("button", { name: "Save changes" }).click();
      expect((await response).status()).toBe(200);
      await webExpect(dialog()).toHaveCount(0);
      expect(readRecipe(host, "tool")?.init).toEqual({ postCreate: argv, forwardPorts: [3030] });
    },
    TIMEOUT_MS,
  );
});
