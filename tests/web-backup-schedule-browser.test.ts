import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type Browser, chromium, expect as webExpect, type Page } from "@playwright/test";

import type { App } from "../src/app";
import { ruleOf } from "../src/checkpoints/schedule";
import { startServer } from "../src/server";
import { setBackupSchedule } from "../src/services/backup-schedule";
import en from "../web/js/i18n/en.js";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";

const executablePath = chromiumFor("The backup schedule card test");
const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const TIMEOUT_MS = 30_000;
const VIEWPORT = { width: 1280, height: 800 };
const ZONE = "Asia/Tokyo";

/** The English text of a dictionary key, which a locator looks for. */
const english = (key: string): string => en[key] ?? key;

/** One MiniBox with its own server, so a test can have a passphrase on the server or none. */
interface Instance {
  readonly app: App;
  readonly server: ReturnType<typeof startServer>;
  readonly base: string;
}

function boot(passphrase: string | null | undefined): Instance {
  const { app } = createTestApp(passphrase === undefined ? {} : { backupPassphrase: passphrase });
  const server = startServer(app);
  return { app, server, base: `http://127.0.0.1:${server.port}` };
}

function stop(instance: Instance): void {
  instance.server.stop(true);
  instance.app.throttle.stop();
  instance.app.sessions.stop();
  instance.app.tokens.stop();
  instance.app.events.close();
}

const scheduleOf = async (instance: Instance) =>
  (await (
    await fetch(`${instance.base}/api/backups/schedule`, { headers: { authorization: `Bearer ${TEST_KEY}` } })
  ).json()) as { schedule: { mode: string; everyHours: number | null } | null; passphraseSet: boolean };

describe.skipIf(!executablePath)("the backup schedule card (real browser)", () => {
  let browser: Browser;
  const instances: Instance[] = [];

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: executablePath ?? undefined, args: ["--no-sandbox"] });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    for (const instance of instances.splice(0)) stop(instance);
  });

  /** A signed-in page on the Backups settings, in a browser whose zone is `ZONE`, and the requests it sends. */
  async function backupsPage(
    instance: Instance,
  ): Promise<{ page: Page; requests: string[]; close: () => Promise<void> }> {
    const context = await browser.newContext({ viewport: VIEWPORT, timezoneId: ZONE, locale: "en-US" });
    const login = await context.request.post(`${instance.base}/api/auth/login`, {
      data: { key: TEST_KEY },
      headers: { origin: instance.base },
    });
    expect(login.status()).toBe(200);
    const page = await context.newPage();
    const requests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/backups/schedule") requests.push(`${request.method()} ${url.pathname}`);
    });
    await page.goto(`${instance.base}/#/settings/backups`);
    return { page, requests, close: () => context.close() };
  }

  test(
    "a schedule is set from the card, shown with its zone, kept by the server, and turned off again",
    async () => {
      const instance = boot(undefined);
      instances.push(instance);
      const { page, requests, close } = await backupsPage(instance);
      try {
        const setButton = page.locator('[data-action="st-backup-schedule"]');
        await webExpect(setButton).toBeEnabled();
        await webExpect(page.locator("#stBackups")).toContainText(english("st.backupScheduleOffHelp"));
        // A server that has its passphrase says nothing about one.
        await webExpect(page.locator("#stBackups .callout")).toHaveCount(0);
        expect(await scheduleOf(instance)).toMatchObject({ schedule: null, passphraseSet: true });

        await setButton.click();
        await page.locator("#stBackupHours").fill("6");
        await page.locator("#stBackupOk").click();

        // The toast names the zone the next run is read in, which is the browser's.
        const toast = page.locator("#toasts .toast").filter({ hasText: english("st.backupScheduleSaved") });
        await webExpect(toast).toContainText(english("ck.nextRun"));
        await webExpect(toast).toContainText(ZONE);
        await webExpect(page.locator("#stBackups")).toContainText("Every 6 hours");
        expect(await scheduleOf(instance)).toMatchObject({ schedule: { mode: "interval", everyHours: 6 } });

        await page.locator('[data-action="st-backup-schedule-off"]').click();
        await webExpect(
          page.locator("#toasts .toast").filter({ hasText: english("st.backupScheduleOffDone") }),
        ).toBeVisible();
        await webExpect(page.locator("#stBackups")).toContainText(english("st.backupScheduleOffHelp"));
        expect(await scheduleOf(instance)).toMatchObject({ schedule: null });
        // The card read the schedule, wrote it once and removed it once: nothing it sent was a surprise.
        expect(requests.filter((request) => request.startsWith("PUT"))).toEqual(["PUT /api/backups/schedule"]);
        expect(requests.filter((request) => request.startsWith("DELETE"))).toEqual(["DELETE /api/backups/schedule"]);
      } finally {
        await close();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a server with no passphrase says so up front, and the card cannot set a schedule it would refuse",
    async () => {
      const instance = boot(null);
      instances.push(instance);
      const { page, requests, close } = await backupsPage(instance);
      try {
        await webExpect(page.locator("#stBackups .callout")).toContainText(english("st.backupNeedsPassphrase"));
        const setButton = page.locator('[data-action="st-backup-schedule"]');
        await webExpect(setButton).toBeDisabled();
        await webExpect(setButton).toHaveAttribute("title", english("st.backupNeedsPassphrase"));
        // Nothing is asked of the server that would answer 409: only the read that told the card.
        await setButton.click({ force: true });
        await webExpect(page.locator(".dialog")).toHaveCount(0);
        expect(requests).toEqual(["GET /api/backups/schedule"]);
        expect(await scheduleOf(instance)).toMatchObject({ schedule: null, passphraseSet: false });
      } finally {
        await close();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a schedule saved before the passphrase went missing can be turned off but not changed",
    async () => {
      const instance = boot(null);
      instances.push(instance);
      const rule = ruleOf({ everyHours: 6 });
      if (!rule) throw new Error("not a rule");
      setBackupSchedule(instance.app.backupSchedule, rule, "owner", new Date());
      const { page, close } = await backupsPage(instance);
      try {
        await webExpect(page.locator("#stBackups .callout")).toContainText(english("st.backupLostPassphrase"));
        await webExpect(page.locator('[data-action="st-backup-schedule"]')).toBeDisabled();
        const off = page.locator('[data-action="st-backup-schedule-off"]');
        await webExpect(off).toBeEnabled();
        await off.click();
        await webExpect(page.locator("#stBackups")).toContainText(english("st.backupScheduleOffHelp"));
        expect(await scheduleOf(instance)).toMatchObject({ schedule: null });
      } finally {
        await close();
      }
    },
    TIMEOUT_MS,
  );
});
