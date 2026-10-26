import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type Browser, type BrowserContext, chromium, expect as webExpect, type Page } from "@playwright/test";

import type { App } from "../src/app";
import { startServer } from "../src/server";
import en from "../web/js/i18n/en.js";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";

const executablePath = chromiumFor("The create box dialog test");
const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const TIMEOUT_MS = 30_000;
const VIEWPORT = { width: 1280, height: 900 };

const english = (key: string, vars: Record<string, string | number> = {}): string =>
  (en[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ""));

interface BoxRow {
  boxId: string;
  name: string;
  mounts: { volume: string; path: string; mode: string; role: string | null }[];
}

describe.skipIf(!executablePath)("the create box dialog's custom volumes (real browser)", () => {
  let app: App | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser;
  let context: BrowserContext | undefined;
  let page: Page;
  let consoleUrl = "";
  let bearer: Record<string, string> = {};

  async function rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${consoleUrl}${path}`, {
      method,
      headers: bearer,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} ${response.status} ${text}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  const boxNamed = async (name: string): Promise<BoxRow> => {
    const { boxes } = await rest<{ boxes: BoxRow[] }>("GET", "/api/boxes?stats=false");
    const box = boxes.find((item) => item.name === name);
    if (!box) throw new Error(`no box named ${name}`);
    return (await rest<{ box: BoxRow }>("GET", `/api/boxes/${encodeURIComponent(box.boxId)}`)).box;
  };

  const dialog = () => page.getByRole("dialog");

  beforeAll(async () => {
    const harness = createTestApp();
    app = harness.app;
    const keys = app.hosts.get().keys;
    harness.runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
    server = startServer(app);
    consoleUrl = `http://127.0.0.1:${server.port}`;
    bearer = { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}`, origin: consoleUrl };
    browser = await chromium.launch({ executablePath: executablePath ?? undefined, args: ["--no-sandbox"] });
    context = await browser.newContext({ viewport: VIEWPORT });
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
    "the custom mode offers the roles to create, and sends the rows as roles and volumes",
    async () => {
      await page.goto(`${consoleUrl}/#/boxes`);
      await page.locator('[data-action="create"]').first().click();
      const box = dialog();
      await webExpect(box).toBeVisible();

      await box.locator("#cbName").fill("rolebox");
      await box.locator("#cbVolumes .fold-toggle").click();
      await box.locator('#cbVolMode [data-vol-mode="custom"]').click();

      // The four rows the default mode creates are pre-seeded with the roles, in the default mode's order.
      const rows = box.locator("#cbMountRows [data-mount]");
      await webExpect(rows).toHaveCount(4);
      const volumes = await rows
        .locator("[data-volume]")
        .evaluateAll((selects) => selects.map((select) => (select as unknown as { value: string }).value));
      expect(volumes).toEqual(["role:workspace", "role:home", "role:tools", "role:cache"]);

      // The roles a row can pick are labelled, and the tools row is the shared tools volume of this host.
      const choices = await rows
        .first()
        .locator("[data-volume] option")
        .evaluateAll((options) =>
          options.map((option) => (option as unknown as { textContent: string }).textContent?.trim() ?? ""),
        );
      expect(choices).toContain(english("mount.roleCreate", { role: english("vol.roleWorkspace") }));
      await webExpect(
        rows
          .nth(2)
          .locator("[data-volume] option", {
            hasText: english("mount.roleCreate", { role: english("vol.roleTools") }),
          }),
      ).toHaveCount(1);

      // Removing the home row means that volume is not created, and the note names what MiniBox will create.
      await rows.nth(1).locator("[data-remove-mount]").click();
      await webExpect(rows).toHaveCount(3);
      await webExpect(box.locator("#cbMountsNote")).toContainText(
        english("cb.mountsCreated", {
          roles: [english("vol.roleWorkspace"), english("vol.roleTools"), english("vol.roleCache")].join(", "),
        }),
      );

      await box.locator("#cbSubmit").click();
      const created = await boxNamed("rolebox");
      expect(created.mounts.map((mount) => mount.path).toSorted()).toEqual([
        "/home/dev/.cache",
        "/opt/minibox/tools",
        "/workspace",
      ]);
      const roles = created.mounts.map((mount) => mount.role).toSorted();
      expect(roles).toEqual(["cache", "tools", "workspace"]);
      // The tools row mounted the shared tools volume, which this host did not have before the create made one.
      const tools = created.mounts.find((mount) => mount.role === "tools");
      expect(tools?.mode).toBe("ro");
      const { volumes: listed } = await rest<{ volumes: { id: string; name: string; role: string | null }[] }>(
        "GET",
        "/api/volumes",
      );
      expect(listed.filter((volume) => volume.role === "tools")).toHaveLength(1);
    },
    TIMEOUT_MS,
  );

  test(
    "a role row keeps its own path and mode, and picking a volume gives the row back its fields",
    async () => {
      await page.goto(`${consoleUrl}/#/boxes`);
      await page.locator('[data-action="create"]').first().click();
      const box = dialog();
      await webExpect(box).toBeVisible();
      await box.locator("#cbVolumes .fold-toggle").click();
      await box.locator('#cbVolMode [data-vol-mode="custom"]').click();

      const row = box.locator("#cbMountRows [data-mount]").first();
      await webExpect(row.locator("[data-path]")).toHaveValue("/workspace");
      await webExpect(row.locator("[data-path]")).toHaveAttribute("readonly", "");
      await webExpect(row.locator("[data-mode]")).toBeDisabled();

      // A volume that exists gives the row back a path and a mode it can change.
      const existing = box.locator("#cbMountRows [data-mount]").last();
      await existing.locator("[data-volume]").selectOption({ label: english("mount.choose") });
      await webExpect(existing.locator("[data-path]")).not.toHaveAttribute("readonly", "");
      await webExpect(existing.locator("[data-mode]")).toBeEnabled();
      await existing.locator("[data-path]").fill("/scratch");

      // A row with neither a volume nor a role is refused before the request is sent.
      await box.locator("#cbName").fill("emptymount");
      await box.locator("#cbSubmit").click();
      await webExpect(box.locator("#cbVolErr")).toHaveText(english("cb.mountVolumeRequired"));
    },
    TIMEOUT_MS,
  );
});
