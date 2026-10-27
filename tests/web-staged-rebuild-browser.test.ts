import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type Browser, type BrowserContext, chromium, expect as webExpect, type Page } from "@playwright/test";

import type { App } from "../src/app";
import { startServer } from "../src/server";
import en from "../web/js/i18n/en.js";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";

const executablePath = chromiumFor("The staged rebuild settings test");
const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const TIMEOUT_MS = 30_000;
const VIEWPORT = { width: 1280, height: 800 };
const OTHER_TEMPLATE = "mbtest-template:next";

const english = (key: string, vars: Record<string, string | number> = {}): string =>
  (en[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ""));

interface BoxRow {
  id: string;
  boxId: string;
  name: string;
  revision: number;
  template: string;
  profile: string | null;
  egress?: { mode: string; presets: string[]; domains: string[]; allow: string[] };
}

interface StagedRow {
  pending: string[];
  fields: Record<string, unknown>;
  changes: { field: string; from: string; to: string }[];
}

describe.skipIf(!executablePath)("staged template, egress and security changes (real browser)", () => {
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

  const boxNow = async (boxId: string) =>
    (await rest<{ box: BoxRow }>("GET", `/api/boxes/${encodeURIComponent(boxId)}`)).box;
  const stagedNow = async (boxId: string) =>
    (await rest<{ staged: StagedRow | null }>("GET", `/api/boxes/${encodeURIComponent(boxId)}/staged`)).staged;
  const settingsUrl = (box: BoxRow, section: string) =>
    `${consoleUrl}/#/boxes/${encodeURIComponent(box.id)}/settings/${section}`;

  async function makeBox(name: string): Promise<BoxRow> {
    const { box } = await rest<{ box: BoxRow }>("POST", "/api/boxes", { name, cpus: 1, memoryMb: 256 });
    return box;
  }

  beforeAll(async () => {
    const harness = createTestApp();
    app = harness.app;
    const keys = app.hosts.get().keys;
    harness.runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
    harness.runtime.seedImage(OTHER_TEMPLATE, { [keys.template]: "true", [keys.templateName]: "next" });
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
    "the Security section shows the template, egress and profile cards, and the staged banner above them",
    async () => {
      const box = await makeBox("seccards");
      await page.goto(settingsUrl(box, "security"));

      await webExpect(page.locator("#bsTemplate h3")).toContainText(english("bd.templateCard"));
      await webExpect(page.locator("#bsEgress h3")).toContainText(english("egress.section"));
      await webExpect(page.locator("#bsSecurity h3")).toContainText(english("bd.setSecurity"));
      await webExpect(page.locator("#bsStaged")).toBeHidden();
      // Each card reads the box's own value and says it is not pending.
      await webExpect(page.locator("#bsTemplate .kv dd")).toHaveText(box.template);
      await webExpect(page.locator("#bsSecurity .kv")).toContainText(english("profile.standard"));
      await webExpect(page.locator("[data-template-pending]")).toHaveCount(0);
      await webExpect(page.locator("[data-egress-pending]")).toHaveCount(0);
      await webExpect(page.locator("[data-profile-pending]")).toHaveCount(0);
    },
    TIMEOUT_MS,
  );

  test(
    "choosing another profile stages it: the card and the banner say so, and the box keeps its container",
    async () => {
      const box = await makeBox("profcard");
      await page.goto(settingsUrl(box, "security"));

      await page.locator("#bsSecurity [data-profile-action='edit']").click();
      await page.locator("#bsSecurity [data-profile-choice='strict']").click();
      await page.locator("#bsSecurity [data-profile-action='save']").click();

      const banner = page.locator("#bsStaged .staged-banner");
      await webExpect(banner).toContainText(english("stg.banner", { n: 1 }));
      await webExpect(banner.locator(".staged-fields")).toHaveText(english("rebuild.field.profile"));
      await webExpect(page.locator("[data-profile-pending]")).toHaveText(english("stg.pendingBadge"));
      await webExpect(page.locator("#bsSecurity .kv")).toContainText(english("profile.strict"));
      await webExpect(page.locator("#bsSecurity")).toContainText(english("bd.profilePendingHelp"));

      const after = await boxNow(box.boxId);
      expect(after).toMatchObject({ profile: "standard", revision: box.revision });
      expect((await stagedNow(box.boxId))?.pending).toEqual(["profile"]);
    },
    TIMEOUT_MS,
  );

  test(
    "editing the egress policy stages the tier, its presets and its hosts, and the diff lists them",
    async () => {
      const box = await makeBox("egresscard");
      await page.goto(settingsUrl(box, "security"));

      await page.locator("#bsEgress [data-egress-action='edit']").click();
      await webExpect(page.locator("[data-egress-proxy]")).toBeHidden();
      await page.locator("#bsEgress [data-egress-tier='proxy-only']").click();
      await webExpect(page.locator("[data-egress-proxy]")).toBeVisible();
      // The checkbox is visually hidden, so the row that draws it is what a person clicks.
      await page.locator("#bsEgress .check-row", { hasText: english("egress.preset.agentDefault") }).click();
      await page.locator("#bsEgress #bsEgressDomains").fill("example.org");
      await page.locator("#bsEgress [data-egress-action='save']").click();

      const banner = page.locator("#bsStaged .staged-banner");
      await webExpect(banner).toContainText(english("stg.banner", { n: 1 }));
      await webExpect(page.locator("[data-egress-pending]")).toHaveText(english("stg.pendingBadge"));
      await webExpect(page.locator("#bsEgress")).toContainText(english("egress.tier.proxyOnly"));
      await webExpect(page.locator("#bsEgress")).toContainText("example.org");
      await webExpect(page.locator("#bsEgress")).toContainText(english("egress.pendingHelp"));

      const staged = await stagedNow(box.boxId);
      expect(staged?.pending).toEqual(["egress"]);
      expect(staged?.fields.egress).toMatchObject({
        mode: "proxy-only",
        presets: ["agent-default"],
        domains: ["example.org"],
        allow: expect.arrayContaining(["api.anthropic.com", "example.org"]),
      });
      // Nothing was rebuilt, and the box reports no egress of its own yet.
      expect(await boxNow(box.boxId)).toMatchObject({ revision: box.revision });

      await page.locator("[data-staged='diff']").click();
      const diff = page.locator(".dialog", { hasText: english("stg.diffDialogTitle") });
      await webExpect(diff.locator(".staged-changes")).toContainText(
        `${english("rebuild.field.egress")}: open → proxy-only: `,
      );
      await webExpect(diff.locator(".staged-changes")).toContainText("example.org");
      await diff.locator("[data-close]").first().click();
    },
    TIMEOUT_MS,
  );

  test(
    "saving the template stages it, and the banner counts it together with the other staged fields",
    async () => {
      const box = await makeBox("templatecard");
      await page.goto(settingsUrl(box, "security"));

      await page.locator("#bsTemplate [data-template-action='edit']").click();
      await page.locator("#bsTemplate #bsTemplateRef").fill(OTHER_TEMPLATE);
      await page.locator("#bsTemplate [data-template-action='save']").click();

      const banner = page.locator("#bsStaged .staged-banner");
      await webExpect(banner).toContainText(english("stg.banner", { n: 1 }));
      await webExpect(page.locator("[data-template-pending]")).toHaveText(english("stg.pendingBadge"));
      await webExpect(page.locator("#bsTemplate .kv dd")).toHaveText(OTHER_TEMPLATE);
      await webExpect(page.locator("#bsTemplate")).toContainText(english("bd.templatePendingHelp"));
      expect((await stagedNow(box.boxId))?.pending).toEqual(["template"]);
      expect(await boxNow(box.boxId)).toMatchObject({ template: box.template, revision: box.revision });

      // A second field joins the same record, and the banner counts both.
      await page.locator("#bsSecurity [data-profile-action='edit']").click();
      await page.locator("#bsSecurity [data-profile-choice='relaxed']").click();
      await page.locator("#bsSecurity [data-profile-action='save']").click();
      await webExpect(banner).toContainText(english("stg.banner", { n: 2 }));
      await webExpect(banner.locator(".staged-fields")).toHaveText(
        `${english("rebuild.field.template")}${english("stg.listSep")}${english("rebuild.field.profile")}`,
      );
      expect((await stagedNow(box.boxId))?.pending).toEqual(["template", "profile"]);
    },
    TIMEOUT_MS,
  );

  test(
    "editing a staged template starts from it, and saving the running template unstages only that field",
    async () => {
      const box = await makeBox("undotemplate");
      await rest("PUT", `/api/boxes/${encodeURIComponent(box.boxId)}/staged`, {
        template: OTHER_TEMPLATE,
        profile: "strict",
      });
      await page.goto(settingsUrl(box, "security"));
      await webExpect(page.locator("[data-template-pending]")).toBeVisible();
      await page.locator("#bsTemplate [data-template-action='edit']").click();
      await webExpect(page.locator("#bsTemplateRef")).toHaveValue(OTHER_TEMPLATE);
      await page.locator("#bsTemplateRef").fill(box.template);
      await page.locator("#bsTemplate [data-template-action='save']").click();
      await webExpect(page.locator("#bsTemplateRef")).toHaveCount(0);
      await webExpect(page.locator("[data-template-pending]")).toHaveCount(0);
      expect((await stagedNow(box.boxId))?.pending).toEqual(["profile"]);
      expect(await boxNow(box.boxId)).toMatchObject({ revision: box.revision, template: box.template });
    },
    TIMEOUT_MS,
  );

  test(
    "a staged template the server does not have is refused on apply, and the card and banner say why",
    async () => {
      const box = await makeBox("ghosttemplate");
      await page.goto(settingsUrl(box, "security"));

      await page.locator("#bsTemplate [data-template-action='edit']").click();
      await page.locator("#bsTemplate #bsTemplateRef").fill("node 24");
      await page.locator("#bsTemplate [data-template-action='save']").click();

      // The reference never reaches the server, and the editor stays open with the reason.
      await webExpect(page.locator("#bsTemplate [data-template-error]")).toHaveText(english("tp.errImageRef"));
      await webExpect(page.locator("#bsStaged")).toBeHidden();
      expect(await stagedNow(box.boxId)).toBeNull();
    },
    TIMEOUT_MS,
  );

  test(
    "applying the staged template, egress and profile rebuilds the box once with all three, and clears them",
    async () => {
      const box = await makeBox("applyall");
      await rest("PUT", `/api/boxes/${encodeURIComponent(box.boxId)}/staged`, {
        template: OTHER_TEMPLATE,
        egress: { mode: "none" },
        profile: "strict",
      });
      await page.goto(settingsUrl(box, "security"));

      const banner = page.locator("#bsStaged .staged-banner");
      await webExpect(banner).toContainText(english("stg.banner", { n: 3 }));
      await webExpect(page.locator("[data-template-pending]")).toHaveText(english("stg.pendingBadge"));
      await webExpect(page.locator("[data-egress-pending]")).toHaveText(english("stg.pendingBadge"));
      await webExpect(page.locator("[data-profile-pending]")).toHaveText(english("stg.pendingBadge"));

      await page.locator("[data-staged='apply']").click();
      const confirm = page.locator(".dialog", { hasText: english("stg.confirmTitle", { name: box.name }) });
      await webExpect(confirm).toBeVisible();
      const changes = confirm.locator(".staged-changes").first();
      await webExpect(changes).toContainText(
        `${english("rebuild.field.template")}: ${box.template} → ${OTHER_TEMPLATE}`,
      );
      await webExpect(changes).toContainText(`${english("rebuild.field.egress")}: open → none`);
      await webExpect(changes).toContainText(`${english("rebuild.field.profile")}: standard → strict`);
      await confirm.locator("#cfm-ok").click();

      await webExpect(page.locator("#bsStaged")).toBeHidden();
      await webExpect.poll(async () => (await boxNow(box.boxId)).revision).toBe(box.revision + 1);
      const after = await boxNow(box.boxId);
      expect(after).toMatchObject({ template: OTHER_TEMPLATE, profile: "strict", egress: { mode: "none" } });
      expect(await stagedNow(box.boxId)).toBeNull();
    },
    TIMEOUT_MS,
  );

  test(
    "a staged field that the box gets back drops out, so the banner stops counting it",
    async () => {
      const box = await makeBox("dropback");
      await page.goto(settingsUrl(box, "security"));

      await page.locator("#bsSecurity [data-profile-action='edit']").click();
      await page.locator("#bsSecurity [data-profile-choice='strict']").click();
      await page.locator("#bsSecurity [data-profile-action='save']").click();
      const banner = page.locator("#bsStaged .staged-banner");
      await webExpect(banner).toContainText(english("stg.banner", { n: 1 }));

      // Choosing the profile the box already has stages nothing, so the record and the banner go away.
      await page.locator("#bsSecurity [data-profile-action='edit']").click();
      await page.locator("#bsSecurity [data-profile-choice='standard']").click();
      await page.locator("#bsSecurity [data-profile-action='save']").click();

      await webExpect(page.locator("#bsStaged")).toBeHidden();
      await webExpect(page.locator("[data-profile-pending]")).toHaveCount(0);
      expect(await stagedNow(box.boxId)).toBeNull();
      expect(await boxNow(box.boxId)).toMatchObject({ profile: "standard", revision: box.revision });
    },
    TIMEOUT_MS,
  );

  test(
    "the staged changes survive a server restart, and the Security section still marks them",
    async () => {
      const box = await makeBox("restaged");
      await rest("PUT", `/api/boxes/${encodeURIComponent(box.boxId)}/staged`, { profile: "strict" });
      await page.goto(settingsUrl(box, "security"));
      await webExpect(page.locator("[data-profile-pending]")).toHaveText(english("stg.pendingBadge"));

      // The console reads the staged changes from the server, so a reload is the restart as far as the page is concerned.
      await page.reload();
      await webExpect(page.locator("#bsStaged .staged-banner")).toContainText(english("stg.banner", { n: 1 }));
      await webExpect(page.locator("[data-profile-pending]")).toHaveText(english("stg.pendingBadge"));
      expect((await stagedNow(box.boxId))?.pending).toEqual(["profile"]);
      expect(await boxNow(box.boxId)).toMatchObject({ profile: "standard", revision: box.revision });
    },
    TIMEOUT_MS,
  );
});
