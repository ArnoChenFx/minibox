import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type Browser, type BrowserContext, chromium, expect as webExpect, type Page } from "@playwright/test";

import type { App } from "../src/app";
import { CHECKPOINT_VERSION, type CheckpointRecord } from "../src/checkpoints/types";
import { startServer } from "../src/server";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";
import type { FakeRuntime } from "./support/fake-runtime";

const executablePath = chromiumFor("The remote-only checkpoint test");
const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const TIMEOUT_MS = 30_000;
const VIEWPORT = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

interface Rect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

const boxOf = (box: { x: number; y: number; width: number; height: number } | null): Rect | null =>
  box ? { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height } : null;

/** Whether two boxes share any area. Touching edges do not count. */
const intersects = (a: Rect, b: Rect): boolean =>
  a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;

/** A checkpoint record on the local host, with a copied mark, as one copied before the remote became the only one. */
async function seedCheckpoint(app: App, runtime: FakeRuntime, targetId: string): Promise<void> {
  const host = app.hosts.get();
  await runtime.createVolume("src", {});
  runtime.filesOf("src").set("notes.txt", { type: "file", content: Buffer.from("hello remote only") });
  const snapshotId = (await host.checkpointEngine.backup(host, "src", ["ck_remote"])).snapshotId;
  const now = new Date().toISOString();
  const record: CheckpointRecord = {
    version: CHECKPOINT_VERSION,
    id: host.checkpoints.allocateId(),
    hostId: host.host.id,
    boxId: null,
    boxName: "dev",
    label: "before remote only",
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
        bytes: 16,
      },
    ],
    system: null,
    trash: null,
    remoteSync: { [targetId]: now },
    createdAt: now,
    updatedAt: now,
  };
  host.checkpoints.write(record);
}

describe.skipIf(!executablePath)("a host whose checkpoints are kept only on the remote (real browser)", () => {
  let app: App | undefined;
  let runtime: FakeRuntime | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser;
  let context: BrowserContext | undefined;
  let page: Page;
  let consoleUrl = "";
  let s3Id = "";

  const row = () => page.locator('[data-host-remote="local"]');
  const dialog = () => page.getByRole("dialog");

  const scrollWidth = () =>
    page.evaluate(() => {
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

  beforeAll(async () => {
    const harness = createTestApp({ labelPrefix: "mbtest" });
    app = harness.app;
    runtime = harness.runtime;
    s3Id = app.targets.add("archive", {
      kind: "s3",
      path: "minibox",
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "archive",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "test-only-secret-key",
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
    "the dialog offers the mode, explains what only remote gives up, and saves it",
    async () => {
      await row().locator('[data-remote-set="local"]').click();
      await webExpect(dialog().locator(".form-stack")).toHaveCount(1);
      const mode = dialog().locator('select[name="mode"]');
      await webExpect(mode).toHaveValue("sync");
      await webExpect(dialog().locator("#stHostRemoteOnlyNotice")).toBeHidden();

      await mode.selectOption("only");
      const notice = dialog().locator("#stHostRemoteOnlyNotice");
      await webExpect(notice).toBeVisible();
      const noticeText = await notice.innerText();
      expect(noticeText).toContain("need a connection to the target");
      expect(noticeText).toContain("keeps no copy of the checkpoints");
      expect(noticeText).toContain("checkpoint-remote-local.key");
      expect(noticeText).toContain("Back it up");

      await dialog().locator('select[name="targetId"]').selectOption(s3Id);
      await dialog().locator("#stHostRemoteSave").click();
      await webExpect(dialog()).toHaveCount(0);
      await webExpect(row()).toContainText("Only remote");
      await webExpect(row().locator("[data-remote-sync]")).toHaveCount(0);
      await webExpect(row().locator("[data-remote-pending]")).toHaveText("—");
      await webExpect(row().locator("[data-remote-last]")).toHaveText("—");

      const reply = await context?.request.get(`${consoleUrl}/api/hosts/local/checkpoint-remote`);
      const body = (await reply?.json()) as { remote: { mode: string; targetId: string } };
      expect(body.remote).toMatchObject({ mode: "only", targetId: s3Id });
    },
    TIMEOUT_MS,
  );

  test(
    "with a checkpoint record the mode, target, folder and clear are off, and the reason says why",
    async () => {
      if (!app || !runtime) throw new Error("the app is not running");
      await seedCheckpoint(app, runtime, s3Id);
      await page.reload();
      await page.waitForSelector('#stHostRemote [data-host-remote="local"]');
      await webExpect(row()).toContainText("Only remote");
      await webExpect(row().locator("[data-remote-sync]")).toHaveCount(0);
      const clear = row().locator("[data-remote-clear]");
      await webExpect(clear).toBeDisabled();
      expect(await clear.getAttribute("title")).toContain("cannot be cleared");

      await row().locator("[data-remote-edit]").click();
      await webExpect(dialog()).toBeVisible();
      await webExpect(dialog().locator('select[name="mode"]')).toBeDisabled();
      await webExpect(dialog().locator('select[name="targetId"]')).toBeDisabled();
      await webExpect(dialog().locator('input[name="path"]')).toBeDisabled();
      await webExpect(dialog().locator("#stHostRemoteClear")).toBeDisabled();
      const records = dialog().locator("#stHostRemoteRecords");
      await webExpect(records).toBeVisible();
      expect(await records.innerText()).toContain("1 checkpoint records");
      await webExpect(dialog().locator("#stHostRemoteOnlyNotice")).toBeVisible();
      await dialog().getByRole("button", { name: "Cancel" }).click();
      await webExpect(dialog()).toHaveCount(0);
    },
    TIMEOUT_MS,
  );

  test(
    "a checkpoint row of a remote-only host carries no copied badge, even when its record names the target",
    async () => {
      await page.goto(`${consoleUrl}/#/storage/checkpoints`);
      await page.waitForSelector("#sckRows tr");
      const checkpointRow = page.locator("#sckRows tr", { hasText: "before remote only" });
      await webExpect(checkpointRow).toHaveCount(1);
      await webExpect(checkpointRow.locator(".badge-success")).toHaveCount(0);
      await webExpect(checkpointRow.locator(".badge", { hasText: "Remote" })).toHaveCount(0);
      await webExpect(checkpointRow.locator(".badge-accent", { hasText: "Volume" })).toHaveCount(1);
    },
    TIMEOUT_MS,
  );

  test(
    "the mode dialog and the only-remote notice fit a phone, with no horizontal scroll and no overlap",
    async () => {
      if (!app) throw new Error("the app is not running");
      await page.goto(`${consoleUrl}/#/settings/hosts`);
      await page.waitForSelector('#stHostRemote [data-host-remote="local"]');
      await page.setViewportSize(PHONE);
      await webExpect(row()).toBeVisible();
      const width = await scrollWidth();
      expect(width.scroll).toBeLessThanOrEqual(width.client);

      await row().locator("[data-remote-edit]").click();
      await webExpect(dialog()).toBeVisible();
      const formWidth = await scrollWidth();
      expect(formWidth.scroll).toBeLessThanOrEqual(formWidth.client);
      const blocks: (Rect | null)[] = [];
      for (const field of await dialog().locator(".form-stack > *").all()) {
        blocks.push(boxOf(await field.boundingBox()));
      }
      for (const [index, block] of blocks.entries()) {
        expect(block).not.toBeNull();
        if (!block) continue;
        expect(block.left).toBeGreaterThanOrEqual(0);
        expect(block.right).toBeLessThanOrEqual(formWidth.client + 1);
        const next = blocks[index + 1];
        if (next) expect(intersects(block, next)).toBe(false);
      }
      const notice = boxOf(await dialog().locator("#stHostRemoteOnlyNotice").boundingBox());
      expect(notice).not.toBeNull();
      if (notice) {
        expect(notice.left).toBeGreaterThanOrEqual(0);
        expect(notice.right).toBeLessThanOrEqual(formWidth.client + 1);
      }
      await dialog().getByRole("button", { name: "Cancel" }).click();
      await webExpect(dialog()).toHaveCount(0);
      await page.setViewportSize(VIEWPORT);
    },
    TIMEOUT_MS,
  );

  test(
    "a record only in the recycle bin still locks the mode and clear, and the dialog counts it",
    async () => {
      if (!app) throw new Error("the app is not running");
      const host = app.hosts.get();
      const record = host.checkpoints.list().find((checkpoint) => checkpoint.hostId === "local");
      if (!record) throw new Error("the seeded checkpoint is gone");
      const now = new Date().toISOString();
      host.checkpoints.write({
        ...record,
        trash: {
          kind: "box",
          sourceId: "bx_abcdefgh",
          sourceName: "deleted",
          deletedAt: now,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
        updatedAt: now,
      });
      // The page's checkpoint list leaves a recycle bin entry out, so only the read's count can lock the controls.
      await page.reload();
      await page.waitForSelector('#stHostRemote [data-host-remote="local"]');
      await webExpect(row()).toContainText("Only remote");
      await webExpect(row().locator("[data-remote-clear]")).toBeDisabled();

      await row().locator("[data-remote-edit]").click();
      await webExpect(dialog()).toBeVisible();
      await webExpect(dialog().locator('select[name="mode"]')).toBeDisabled();
      await webExpect(dialog().locator('select[name="targetId"]')).toBeDisabled();
      await webExpect(dialog().locator("#stHostRemoteRecords")).toContainText("1 checkpoint records");
      await webExpect(dialog().locator("#stHostRemoteClear")).toBeDisabled();
      await dialog().getByRole("button", { name: "Cancel" }).click();
      await webExpect(dialog()).toHaveCount(0);
    },
    TIMEOUT_MS,
  );
});
