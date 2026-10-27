import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type Browser, type BrowserContext, chromium, expect as webExpect, type Page } from "@playwright/test";

import type { App } from "../src/app";
import type { HostCtx } from "../src/host/registry";
import { startServer } from "../src/server";
import { createVolume, savePools } from "../src/services/volumes";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";

const executablePath = chromiumFor("The storage pool edit test");

const TIMEOUT_MS = 30_000;
const VIEWPORT = { width: 1280, height: 800 };

const restoreLogs = silenceLogs();
afterAll(restoreLogs);

/** A pool as `GET /api/pools` returns it, in the fields this test reads back. */
interface StoredPool {
  name: string;
  backend: string;
  server: string | null;
  export: string | null;
  options: string[];
  default: boolean;
}

/** The save's confirmation opens over the edit form, so the two are told apart by their titles. */
const editDialog = (page: Page, name: string) => page.getByRole("dialog", { name: `Edit the storage pool ${name}` });
const previewDialog = (page: Page) => page.getByRole("dialog", { name: "Save these storage pools?" });
const poolRow = (page: Page, name: string) => page.locator(".pool-table tr", { hasText: name });

/** An NFS pool the page can edit, and the local pool the server always keeps. */
const POOLS = [
  { name: "local", backend: "local" as const, default: false },
  {
    name: "nas",
    backend: "nfs" as const,
    server: "192.168.1.10",
    export: "/volume1/minibox",
    options: ["nfsvers=4.1", "hard"],
    default: true,
  },
];

describe.skipIf(!executablePath)("editing a storage pool from the storage page (real browser)", () => {
  let app: App | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser;
  let context: BrowserContext | undefined;
  let page: Page;
  let consoleUrl = "";
  let host: HostCtx;

  /** The pools over the API, as a client that reloads the page would read them. */
  async function poolsNow() {
    const response = await fetch(`${consoleUrl}/api/pools`, {
      headers: { authorization: `Bearer ${TEST_KEY}`, origin: consoleUrl },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { pools: StoredPool[] };
    return body.pools.map((pool) => ({
      name: pool.name,
      backend: pool.backend,
      server: pool.server,
      export: pool.export,
      options: pool.options,
      default: pool.default,
    }));
  }

  beforeAll(async () => {
    const harness = createTestApp();
    app = harness.app;
    host = app.hosts.get();
    harness.runtime.seedImage(app.cfg.baseTemplateTag, {
      [host.keys.template]: "true",
      [host.keys.templateName]: "base",
    });
    await savePools(host, POOLS, undefined);
    // A volume on the NFS pool: it is why the server refuses a rename, and what the help text warns about.
    await createVolume(host, { name: "notes", pool: "nas", role: null, createdBy: "owner" });

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
    await page.goto(`${consoleUrl}/#/storage/volumes`);
    // The pools card folds; its rows are there once it is opened.
    await page.locator("#volPoolsToggle").click();
    await webExpect(poolRow(page, "nas")).toBeVisible();
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
    "the row has an Edit button beside Remove, and the local pool has neither",
    async () => {
      await webExpect(poolRow(page, "nas").getByRole("button", { name: "Edit" })).toBeVisible();
      await webExpect(poolRow(page, "nas").getByRole("button", { name: "Remove" })).toBeVisible();
      await webExpect(poolRow(page, "local").getByRole("button", { name: "Edit" })).toHaveCount(0);
      await webExpect(poolRow(page, "local").getByRole("button", { name: "Remove" })).toHaveCount(0);
    },
    TIMEOUT_MS,
  );

  test(
    "the dialog opens with the pool's values, and says a rename may be refused and existing volumes keep their mount parameters",
    async () => {
      await poolRow(page, "nas").getByRole("button", { name: "Edit" }).click();
      const edit = editDialog(page, "nas");
      await webExpect(edit.locator("#p-name")).toHaveValue("nas");
      await webExpect(edit.locator("#p-server")).toHaveValue("192.168.1.10");
      await webExpect(edit.locator("#p-export")).toHaveValue("/volume1/minibox");
      await webExpect(edit.locator("#p-options")).toHaveValue("nfsvers=4.1, hard");
      await webExpect(edit.locator("#p-default")).toBeChecked();
      await webExpect(edit.locator("#p-backend")).toHaveValue("nfs");
      await webExpect(edit.locator("#p-backend")).toHaveAttribute("readonly", "");
      await webExpect(edit.locator("#p-rename-help")).toContainText("pool_in_use");
      await webExpect(edit.locator("#p-mounts-help")).toContainText("does not change volumes that already exist");
      await edit.getByRole("button", { name: "Cancel" }).click();
      await webExpect(page.getByRole("dialog")).toHaveCount(0);
    },
    TIMEOUT_MS,
  );

  test(
    "changing the export confirms the preview, saves, and the pool and its health reload with the new value",
    async () => {
      await poolRow(page, "nas").getByRole("button", { name: "Edit" }).click();
      await editDialog(page, "nas").locator("#p-export").fill("/volume1/data");
      await editDialog(page, "nas").locator("#vol-ok").click();

      // The save is previewed first, over the form: the server changes nothing until the confirmation.
      const preview = previewDialog(page);
      await webExpect(preview).toBeVisible();
      await webExpect(preview).toContainText("Pool nas changes:");
      await webExpect(preview).toContainText("nfs · 192.168.1.10:/volume1/minibox · nfsvers=4.1,hard");
      await webExpect(preview).toContainText("nfs · 192.168.1.10:/volume1/data · nfsvers=4.1,hard");
      expect((await poolsNow()).find((pool) => pool.name === "nas")?.export).toBe("/volume1/minibox");

      await preview.locator("#cfm-ok").click();
      await webExpect(page.getByRole("dialog")).toHaveCount(0);
      await webExpect(page.locator(".toast", { hasText: "Pools saved" })).toBeVisible();

      const saved = (await poolsNow()).find((pool) => pool.name === "nas");
      expect(saved?.export).toBe("/volume1/data");
      expect(saved?.server).toBe("192.168.1.10");
      expect(saved?.options).toEqual(["nfsvers=4.1", "hard"]);

      // Reopening the dialog shows the value that was persisted, not the one the page started with.
      await poolRow(page, "nas").getByRole("button", { name: "Edit" }).click();
      await webExpect(editDialog(page, "nas").locator("#p-export")).toHaveValue("/volume1/data");
      await editDialog(page, "nas").getByRole("button", { name: "Cancel" }).click();
    },
    TIMEOUT_MS,
  );

  test(
    "renaming a pool that still has volumes is refused by the server, and the dialog says why in words",
    async () => {
      await poolRow(page, "nas").getByRole("button", { name: "Edit" }).click();
      await editDialog(page, "nas").locator("#p-name").fill("nas-2");
      await editDialog(page, "nas").locator("#vol-ok").click();

      // The server checks the names before it offers a preview, so the refusal comes at once, and lands in the form
      // rather than in a toast that hides it.
      const edit = editDialog(page, "nas");
      await webExpect(edit.locator("#p-error")).toHaveText(
        "Pool nas still has volumes, so it cannot be removed, renamed or change backend.",
      );
      // The form is still open, with the name field focused so it can be corrected.
      await webExpect(edit.locator("#p-name")).toBeFocused();
      await webExpect(previewDialog(page)).toHaveCount(0);

      // Nothing was saved: the pool still has its old name and its old export.
      const pools = await poolsNow();
      expect(pools.map((pool) => pool.name).toSorted()).toEqual(["local", "nas"]);
      expect(pools.find((pool) => pool.name === "nas")?.export).toBe("/volume1/data");

      await editDialog(page, "nas").getByRole("button", { name: "Cancel" }).click();
      await webExpect(poolRow(page, "nas").getByRole("button", { name: "Edit" })).toBeVisible();
    },
    TIMEOUT_MS,
  );

  test(
    "a field the form refuses is reported in the dialog, and the save is not sent",
    async () => {
      await poolRow(page, "nas").getByRole("button", { name: "Edit" }).click();
      const edit = editDialog(page, "nas");
      await edit.locator("#p-server").fill("");
      await edit.locator("#vol-ok").click();
      await webExpect(edit.locator("#p-error")).toHaveText("NFS pool nas needs a server and an absolute export path.");
      await webExpect(edit.locator("#p-server")).toBeFocused();
      // No preview came up, so nothing was sent to the server.
      await webExpect(previewDialog(page)).toHaveCount(0);
      await edit.getByRole("button", { name: "Cancel" }).click();
    },
    TIMEOUT_MS,
  );
});
