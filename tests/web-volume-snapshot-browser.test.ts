import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type Browser, type BrowserContext, chromium, expect as webExpect, type Page } from "@playwright/test";

import type { App } from "../src/app";
import type { HostCtx } from "../src/host/registry";
import { startServer } from "../src/server";
import { createVolume } from "../src/services/volumes";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";

const executablePath = chromiumFor("The volume snapshot test");

const TIMEOUT_MS = 30_000;
const VIEWPORT = { width: 1280, height: 800 };

const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const row = (page: Page, name: string) => page.locator("#volRows tr", { hasText: name });
const dialog = (page: Page) => page.getByRole("dialog");

describe.skipIf(!executablePath)("snapshotting a volume from the storage page (real browser)", () => {
  let app: App | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser;
  let context: BrowserContext | undefined;
  let page: Page;
  let consoleUrl = "";
  let host: HostCtx;

  beforeAll(async () => {
    const harness = createTestApp();
    app = harness.app;
    host = app.hosts.get();
    const keys = host.keys;
    harness.runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
    harness.runtime.disk = { totalBytes: 100 * 1024 ** 3, freeBytes: 40 * 1024 ** 3 };
    server = startServer(app);
    consoleUrl = `http://127.0.0.1:${server.port}`;

    const headers = { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}`, origin: consoleUrl };
    const made = await fetch(`${consoleUrl}/api/boxes`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "alpha", cpus: 1, memoryMb: 512 }),
    });
    expect(made.status).toBe(201);

    // One independent volume no box mounts, one that a box mounts, and one the engine has lost.
    await createVolume(host, { name: "notes", role: null, createdBy: "owner" });
    const lost = await createVolume(host, { name: "lost-data", role: null, createdBy: "owner" });
    harness.runtime.volumes.delete(lost.engineName);
    await createVolume(host, { name: "cache-a", role: "cache", createdBy: "owner" });

    browser = await chromium.launch({ executablePath: executablePath ?? undefined, args: ["--no-sandbox"] });
    context = await browser.newContext({ viewport: VIEWPORT });
    const login = await context.request.post(`${consoleUrl}/api/auth/login`, {
      data: { key: TEST_KEY },
      headers: { origin: consoleUrl },
    });
    expect(login.status()).toBe(200);
    page = await context.newPage();
    await page.goto(`${consoleUrl}/#/storage/volumes`);
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
    "the snapshot button of a volume no box mounts is enabled and says the volume itself is snapshotted",
    async () => {
      const button = row(page, "notes").getByRole("button", { name: "Snapshot" });
      await webExpect(button).toBeEnabled();
      await webExpect(button).toHaveAttribute("title", "Snapshot");

      await button.click();
      await webExpect(dialog(page)).toContainText("Snapshot notes?");
      await webExpect(dialog(page)).toContainText(
        "Snapshots this volume on its own, as a checkpoint that holds it and no box.",
      );
      await webExpect(dialog(page)).not.toContainText("alpha");
      await dialog(page).getByRole("button", { name: "Cancel" }).click();
      await webExpect(dialog(page)).toHaveCount(0);
    },
    TIMEOUT_MS,
  );

  test(
    "confirming the snapshot creates a checkpoint that the Checkpoints tab groups under the volume",
    async () => {
      await row(page, "notes").getByRole("button", { name: "Snapshot" }).click();
      await dialog(page).locator("#cfm-ok").click();
      await webExpect(page.locator("#toasts")).toContainText("Checkpoint created");

      // The row now shows the snapshot it took, linked to the group the volume's snapshots form.
      const latest = row(page, "notes").locator(".vol-latest");
      await webExpect(latest).toBeVisible();
      await webExpect(latest).toHaveAttribute("href", "#/storage/checkpoints/volume%3Anotes");

      // The Checkpoints tab groups the record under the volume, and marks the group as a volume's rather than a box's.
      await page.goto(`${consoleUrl}/#/storage/checkpoints`);
      const group = page.locator("#sckRows .sck-group", { hasText: "notes" });
      await webExpect(group).toBeVisible();
      await webExpect(group).toContainText("Volume");
      await webExpect(group).not.toContainText("Box deleted");
      // The row says it is a volume snapshot, names the volume it holds, and offers no rollback.
      const checkpointRow = page.locator("#sckRows tr", { hasText: "Volume snapshot" });
      await webExpect(checkpointRow).toContainText("Volume “notes”");
      const rollback = checkpointRow.locator('button[data-action="ck-rollback"]');
      await webExpect(rollback).toBeDisabled();
      await webExpect(rollback).toHaveAttribute("title", /no box to roll back/);
      // Fork is off for the same reason, since the record holds no box settings to make a box from.
      await webExpect(checkpointRow.locator('button[data-action="ck-fork"]')).toBeDisabled();
    },
    TIMEOUT_MS,
  );

  test(
    "a cache volume's snapshot button is disabled and says why",
    async () => {
      await page.goto(`${consoleUrl}/#/storage/volumes`);
      const button = row(page, "cache-a").getByRole("button", { name: "Snapshot" });
      await webExpect(button).toBeDisabled();
      await webExpect(button).toHaveAttribute("title", "Snapshot: This volume is left out of checkpoints");
    },
    TIMEOUT_MS,
  );
});
