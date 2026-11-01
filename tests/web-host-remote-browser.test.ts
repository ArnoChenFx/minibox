import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type Browser, type BrowserContext, chromium, expect as webExpect, type Page } from "@playwright/test";

import type { App } from "../src/app";
import { CHECKPOINT_VERSION, type CheckpointRecord } from "../src/checkpoints/types";
import { startServer } from "../src/server";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";
import type { FakeRuntime } from "./support/fake-runtime";

const executablePath = chromiumFor("The host remote checkpoint test");
const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const TIMEOUT_MS = 30_000;
const VIEWPORT = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

/** A checkpoint record with one snapshot the fake engine holds, so a copy to the remote has something to send. */
async function seedCheckpoint(app: App, runtime: FakeRuntime): Promise<void> {
  const host = app.hosts.get();
  await runtime.createVolume("src", {});
  runtime.filesOf("src").set("notes.txt", { type: "file", content: Buffer.from("hello remote") });
  const snapshotId = (await host.checkpointEngine.backup(host, "src", ["ck_remote"])).snapshotId;
  const now = new Date().toISOString();
  const record: CheckpointRecord = {
    version: CHECKPOINT_VERSION,
    id: host.checkpoints.allocateId(),
    hostId: host.host.id,
    boxId: null,
    boxName: "dev",
    label: "before remote",
    reason: "",
    createdBy: "owner",
    pinned: false,
    auto: false,
    consistency: "live",
    specRevision: null,
    spec: null,
    data: [
      {
        volumeId: "vol_abcdefgh1234",
        path: "/workspace",
        mode: "rw",
        role: "workspace",
        ownership: "owned",
        owner: { uid: 1000, gid: 1000 },
        snapshotId,
        bytes: 12,
      },
    ],
    system: null,
    trash: null,
    createdAt: now,
    updatedAt: now,
  };
  host.checkpoints.write(record);
}

interface Rect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** Whether two boxes share any area. Touching edges do not count. */
const intersects = (a: Rect, b: Rect): boolean =>
  a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;

/** The box a Playwright locator reports, in the same terms as `Rect`. */
function boxOf(box: { x: number; y: number; width: number; height: number } | null): Rect | null {
  return box ? { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height } : null;
}

describe.skipIf(!executablePath)("the host page's remote checkpoint repository (real browser)", () => {
  let app: App | undefined;
  let runtime: FakeRuntime | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser;
  let context: BrowserContext | undefined;
  let page: Page;
  let consoleUrl = "";
  let s3Id = "";
  let sftpId = "";
  let webdavId = "";

  const row = () => page.locator('[data-host-remote="local"]');
  const dialog = () => page.getByRole("dialog");

  beforeAll(async () => {
    const harness = createTestApp({ labelPrefix: "mbtest" });
    app = harness.app;
    runtime = harness.runtime;
    await seedCheckpoint(app, runtime);
    s3Id = app.targets.add("archive", {
      kind: "s3",
      path: "minibox",
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "archive",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "test-only-secret-key",
    }).id;
    sftpId = app.targets.add("nas", {
      kind: "sftp",
      path: "minibox",
      host: "nas.example.com",
      port: 22,
      user: "backup",
      privateKey: "not a real key",
      hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    }).id;
    webdavId = app.targets.add("cloud", {
      kind: "webdav",
      path: "",
      url: "https://dav.example.com/files",
      user: "owner",
      password: "app-password",
    }).id;
    server = startServer(app);
    consoleUrl = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ executablePath: executablePath ?? undefined, args: ["--no-sandbox"] });
    context = await browser.newContext({ viewport: VIEWPORT, locale: "en-US" });
    const login = await context.request.post(`${consoleUrl}/api/auth/login`, {
      data: { key: TEST_KEY },
      headers: { origin: consoleUrl },
    });
    expect(login.status()).toBe(200);
    page = await context.newPage();
    await page.goto(`${consoleUrl}/#/settings/hosts`);
    await page.waitForSelector('#stHostRemote [data-host-remote="local"]');
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
    "the card starts unset, and the dialog offers the S3 and SFTP targets but not the WebDAV one",
    async () => {
      await webExpect(row()).toContainText("Not set");
      await row().locator('[data-remote-set="local"]').click();
      await webExpect(dialog().locator(".form-stack")).toHaveCount(1);
      const values = await dialog()
        .locator('select[name="targetId"] option')
        .evaluateAll((options) => options.map((option) => (option as unknown as { value: string }).value).toSorted());
      expect(values).toEqual([s3Id, sftpId].toSorted());
      expect(values).not.toContain(webdavId);

      await dialog().locator('select[name="targetId"]').selectOption(s3Id);
      await dialog().locator('input[name="path"]').fill("backups");
      await dialog().locator("#stHostRemoteSave").click();
      await webExpect(dialog()).toHaveCount(0);
      await webExpect(row()).toContainText("archive");
      await webExpect(row()).toContainText("S3");
      await webExpect(row()).toContainText("backups/local");
      await webExpect(row()).toContainText("Never synced");
      await webExpect(row().locator("[data-remote-pending]")).toHaveText("1");

      const reply = await context?.request.get(`${consoleUrl}/api/hosts/local/checkpoint-remote`);
      const body = (await reply?.json()) as {
        remote: { targetId: string; failures: number; lastFailure: unknown };
      };
      expect(body.remote).toMatchObject({ targetId: s3Id, failures: 0, lastFailure: null });
    },
    TIMEOUT_MS,
  );

  test(
    "the status row and the config form fit a phone, with no horizontal scroll and no overlap",
    async () => {
      await page.setViewportSize(PHONE);
      await webExpect(row()).toBeVisible();
      const width = await page.evaluate(() => {
        interface Sized {
          scrollWidth: number;
          clientWidth: number;
        }
        interface Doc {
          documentElement: Sized;
        }
        const doc = (globalThis as unknown as { document: Doc }).document;
        return { scroll: doc.documentElement.scrollWidth, client: doc.documentElement.clientWidth };
      });
      expect(width.scroll).toBeLessThanOrEqual(width.client);
      // The column headers are gone on a phone, so the two values name themselves.
      const labels = await page.evaluate(() => {
        interface El {
          getBoundingClientRect(): unknown;
        }
        interface W {
          document: { querySelector(selector: string): El | null };
          getComputedStyle(element: El, pseudo: string): { content: string };
        }
        const w = globalThis as unknown as W;
        const content = (selector: string) => {
          const element = w.document.querySelector(selector);
          return element ? w.getComputedStyle(element, "::before").content : null;
        };
        return [content("[data-remote-last]"), content("[data-remote-pending]")];
      });
      expect(labels).toEqual(['"Last sync"', '"Pending"']);
      const card = boxOf(await page.locator("#stHostRemote").boundingBox());
      expect(card).not.toBeNull();
      if (card) {
        expect(card.left).toBeGreaterThanOrEqual(0);
        expect(card.right).toBeLessThanOrEqual(width.client + 1);
      }

      await row().locator("[data-remote-edit]").click();
      await webExpect(dialog()).toBeVisible();
      await webExpect(dialog().locator('input[name="path"]')).toHaveValue("backups");
      const formWidth = await page.evaluate(() => {
        interface Sized {
          scrollWidth: number;
          clientWidth: number;
        }
        interface Doc {
          documentElement: Sized;
        }
        const doc = (globalThis as unknown as { document: Doc }).document;
        return { scroll: doc.documentElement.scrollWidth, client: doc.documentElement.clientWidth };
      });
      expect(formWidth.scroll).toBeLessThanOrEqual(formWidth.client);
      const form = boxOf(await dialog().locator(".form-stack").boundingBox());
      expect(form).not.toBeNull();
      if (form) {
        expect(form.left).toBeGreaterThanOrEqual(0);
        expect(form.right).toBeLessThanOrEqual(formWidth.client + 1);
      }
      const fields: (Rect | null)[] = [];
      for (const field of await dialog().locator(".form-stack .field").all()) {
        fields.push(boxOf(await field.boundingBox()));
      }
      for (const [index, field] of fields.entries()) {
        expect(field).not.toBeNull();
        if (!field) continue;
        expect(field.left).toBeGreaterThanOrEqual(0);
        expect(field.right).toBeLessThanOrEqual(formWidth.client + 1);
        const next = fields[index + 1];
        if (next) expect(intersects(field, next)).toBe(false);
      }
      await dialog().getByRole("button", { name: "Cancel" }).click();
      await webExpect(dialog()).toHaveCount(0);
      await page.setViewportSize(VIEWPORT);
    },
    TIMEOUT_MS,
  );

  test(
    "Sync now copies the pending checkpoint and the row shows the new state",
    async () => {
      await row().locator("[data-remote-sync]").click();
      await webExpect(page.locator("#taskDrawer")).toBeVisible();
      await webExpect(row().locator("[data-remote-pending]")).toHaveText("0", { timeout: TIMEOUT_MS });
      await webExpect(row().locator("[data-remote-last]")).not.toContainText("Never synced");
      await page.locator("#taskDrawer .task-head [data-close]").click();
      await webExpect(page.locator("#taskDrawer")).toBeHidden();

      const reply = await context?.request.get(`${consoleUrl}/api/hosts/local/checkpoint-remote`);
      const body = (await reply?.json()) as { remote: { lastSyncAt: string | null; failures: number } };
      expect(body.remote.lastSyncAt).toBeString();
      expect(body.remote.failures).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "Clear removes the remote and the row says it is not set",
    async () => {
      await row().locator("[data-remote-clear]").click();
      await webExpect(page.locator("#cfm-ok")).toBeVisible();
      await page.locator("#cfm-ok").click();
      await webExpect(row()).toContainText("Not set");
      await webExpect(row().locator("[data-remote-pending]")).toHaveText("—");

      const reply = await context?.request.get(`${consoleUrl}/api/hosts/local/checkpoint-remote`);
      expect(await reply?.json()).toMatchObject({ remote: null });
    },
    TIMEOUT_MS,
  );
});
