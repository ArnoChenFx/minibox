import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  chromium,
  expect as webExpect,
  type Locator,
  type Page,
} from "@playwright/test";

import type { App } from "../src/app";
import { ulid } from "../src/events/ulid";
import { startServer } from "../src/server";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";
import type { FakeRuntime } from "./support/fake-runtime";
import { call, mint } from "./support/tokens";

const executablePath = chromiumFor("The console navigation test");
const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const TIMEOUT_MS = 30_000;
const VIEWPORT = { width: 1280, height: 800 };

/** Matches the address a page ends on as a whole, so an extra segment or a query cannot pass by accident. */
const at = (hash: string) => (url: URL) => url.hash === hash;

const tab = (page: Page, label: string): Locator => page.locator("#view [role='tab']", { hasText: label });

/** The label of the tab that has focus, as the strip holds it. The page's globals are not in this project's tsconfig. */
const focusedTab = (page: Page): Promise<string | null> =>
  page.evaluate(() => {
    const active = (
      globalThis as unknown as {
        document: { activeElement: { getAttribute(name: string): string | null; textContent: string | null } | null };
      }
    ).document.activeElement;
    return active && active.getAttribute("role") === "tab" ? (active.textContent?.trim() ?? null) : null;
  });

const currentEntry = (page: Page): Locator => page.locator(".sidebar [aria-current='page']");

describe.skipIf(!executablePath)("the console's top navigation (real browser)", () => {
  let app: App | undefined;
  let runtime: FakeRuntime | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser;
  let context: BrowserContext | undefined;
  let page: Page;
  let consoleUrl = "";
  let alpha = "";
  let beta = "";

  async function signedIn(options: BrowserContextOptions = {}): Promise<BrowserContext> {
    const fresh = await browser.newContext(options);
    const login = await fresh.request.post(`${consoleUrl}/api/auth/login`, {
      data: { key: TEST_KEY },
      headers: { origin: consoleUrl },
    });
    expect(login.status()).toBe(200);
    return fresh;
  }

  /** Opens `hash` as a fresh render. Going to the address the page is on is a fragment navigation, which renders nothing. */
  async function openFresh(hash: string): Promise<void> {
    await page.goto(`${consoleUrl}/#/boxes`);
    await page.goto(`${consoleUrl}/${hash}`);
  }
  const openOverview = () => openFresh("#/overview");

  beforeAll(async () => {
    const harness = createTestApp();
    app = harness.app;
    runtime = harness.runtime;
    const keys = app.hosts.get().keys;
    harness.runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
    server = startServer(app);
    consoleUrl = `http://127.0.0.1:${server.port}`;

    const headers = { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}`, origin: consoleUrl };
    const ids: string[] = [];
    for (const name of ["alpha", "beta"]) {
      const response = await fetch(`${consoleUrl}/api/boxes`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name, cpus: 1, memoryMb: 512 }),
      });
      expect(response.status).toBe(201);
      ids.push(((await response.json()) as { box: { boxId: string } }).box.boxId);
    }
    [alpha = "", beta = ""] = ids;

    browser = await chromium.launch({ executablePath: executablePath ?? undefined, args: ["--no-sandbox"] });
    context = await signedIn({ viewport: VIEWPORT });
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

  describe("the sidebar", () => {
    test(
      "lists the six entries in order, each with its own address",
      async () => {
        await page.goto(`${consoleUrl}/#/overview`);
        const entries = await page.locator(".sidebar .nav > a").all();
        const navs = await Promise.all(entries.map((entry) => entry.getAttribute("data-nav")));
        const hrefs = await Promise.all(entries.map((entry) => entry.getAttribute("href")));
        expect(navs).toEqual(["overview", "boxes", "storage", "library", "activity", "settings"]);
        expect(hrefs).toEqual([
          "#/overview",
          "#/boxes",
          "#/storage/volumes",
          "#/library/templates",
          "#/activity",
          "#/settings",
        ]);
        await webExpect(page.locator('.sidebar a[href="#/settings"]')).toHaveCount(1);
      },
      TIMEOUT_MS,
    );

    test(
      "names the entries in English",
      async () => {
        await page.goto(`${consoleUrl}/#/overview`);
        await webExpect(page.locator(".sidebar .nav > a > span[data-i18n]")).toHaveText([
          "Overview",
          "Boxes",
          "Storage",
          "Library",
          "Activity",
          "Settings",
        ]);
      },
      TIMEOUT_MS,
    );

    test(
      "each entry opens its page, and only that entry is marked as the current page",
      async () => {
        for (const [nav, heading] of [
          ["overview", "Overview"],
          ["boxes", "Boxes"],
          ["storage", "Storage"],
          ["library", "Library"],
          ["settings", "Settings"],
        ] as const) {
          await page.locator(`.sidebar a[data-nav="${nav}"]`).click();
          await webExpect(page.locator("#view h1").first()).toHaveText(heading);
          await webExpect(currentEntry(page)).toHaveCount(1);
          await webExpect(currentEntry(page)).toHaveAttribute("data-nav", nav);
        }
      },
      TIMEOUT_MS,
    );

    test(
      "a box address opens that box, and Boxes stays the current entry",
      async () => {
        await page.goto(`${consoleUrl}/#/boxes/${alpha}`);
        await webExpect(page.locator("#view h1").first()).toContainText("alpha");
        await webExpect(currentEntry(page)).toHaveAttribute("data-nav", "boxes");
      },
      TIMEOUT_MS,
    );

    test(
      "Activity opens the activity log, its own page, and Activity is the current entry",
      async () => {
        await page.goto(`${consoleUrl}/#/overview`);
        await page.locator('.sidebar a[data-nav="activity"]').click();
        await webExpect(page).toHaveURL(at("#/activity"));
        await webExpect(page.locator("#view h1").first()).toHaveText("Activity");
        await webExpect(page.locator("#ovRecentCard")).toHaveCount(0);
        await webExpect(page.locator(".actv-table")).toBeVisible();
        await webExpect(page.locator("#actvRows tr", { hasText: "alpha" }).first()).toBeVisible();
        await webExpect(currentEntry(page)).toHaveAttribute("data-nav", "activity");
      },
      TIMEOUT_MS,
    );

    test(
      "the activity log's operation filter keeps only that family of operations",
      async () => {
        await openFresh("#/activity");
        const rows = page.locator("#actvRows tr");
        await webExpect(rows.first()).toBeVisible();
        await page.locator("#actvCategory + .dropdown-trigger").click();
        await page.locator('#dd-menu [role="option"]', { hasText: "Boxes" }).click();
        await webExpect(page.locator("#actvCategory")).toHaveValue("box");
        await webExpect(rows).toHaveCount(2);
        await webExpect(rows.filter({ hasText: "Box created" })).toHaveCount(2);
        await webExpect(page.locator("#actvPage")).toContainText("Page 1");
        await webExpect(page.locator("#actvPrev")).toBeDisabled();
      },
      TIMEOUT_MS,
    );

    test(
      "About is the version link at the foot of the sidebar, and it opens the About page",
      async () => {
        await page.goto(`${consoleUrl}/#/overview`);
        const footer = page.locator(".sidebar a.sidebar-foot");
        await webExpect(footer).toHaveAttribute("href", "#/about");
        await footer.click();
        await webExpect(page).toHaveURL(at("#/about"));
        await webExpect(page.locator("#view h1").first()).toHaveText("About");
        await webExpect(currentEntry(page)).toHaveAttribute("data-nav", "about");
      },
      TIMEOUT_MS,
    );
  });

  describe("the Storage section", () => {
    test(
      "opens on Volumes, which has no box picker",
      async () => {
        await page.goto(`${consoleUrl}/#/storage`);
        await webExpect(page).toHaveURL(at("#/storage/volumes"));
        await webExpect(tab(page, "Volumes")).toHaveAttribute("aria-selected", "true");
        await webExpect(tab(page, "Checkpoints")).toHaveAttribute("aria-selected", "false");
        await webExpect(page.locator("#volRows")).toContainText("alpha");
        await webExpect(page.locator("#boxPick")).toHaveCount(0);
        await webExpect(page.locator("#view [role='tabpanel']")).toHaveAttribute(
          "aria-labelledby",
          (await tab(page, "Volumes").getAttribute("id")) ?? "",
        );
      },
      TIMEOUT_MS,
    );

    test(
      "Checkpoints lists every box, and a box in the address narrows it to that box",
      async () => {
        await tab(page, "Checkpoints").click();
        await webExpect(page).toHaveURL(at("#/storage/checkpoints"));
        await webExpect(tab(page, "Checkpoints")).toHaveAttribute("aria-selected", "true");
        await webExpect(page.locator("#sckRows")).toContainText("alpha");
        await webExpect(page.locator("#sckRows")).toContainText("beta");
        await webExpect(page.locator(".sck-filter")).toHaveCount(0);

        await page.goto(`${consoleUrl}/#/storage/checkpoints/${beta}`);
        await webExpect(page.locator(".sck-filter")).toContainText("Showing only beta.");
        await webExpect(page.locator("#sckRows")).toContainText("beta");
        await webExpect(page.locator("#sckRows")).not.toContainText("alpha");

        await page.locator(".sck-filter a", { hasText: "Show every box" }).click();
        await webExpect(page).toHaveURL(at("#/storage/checkpoints"));
        await webExpect(page.locator("#sckRows")).toContainText("alpha");
        await webExpect(page.locator(".sck-filter")).toHaveCount(0);
      },
      TIMEOUT_MS,
    );

    test(
      "the tab and the box it narrows to survive a reload",
      async () => {
        await page.goto(`${consoleUrl}/#/storage/checkpoints/${alpha}`);
        await webExpect(page.locator(".sck-filter")).toContainText("Showing only alpha.");
        await page.reload();
        await webExpect(page).toHaveURL(at(`#/storage/checkpoints/${alpha}`));
        await webExpect(tab(page, "Checkpoints")).toHaveAttribute("aria-selected", "true");
        await webExpect(page.locator(".sck-filter")).toContainText("Showing only alpha.");
        await webExpect(page.locator("#sckRows")).not.toContainText("beta");
      },
      TIMEOUT_MS,
    );

    test(
      "Volumes drops the box from the address",
      async () => {
        await tab(page, "Volumes").click();
        await webExpect(page).toHaveURL(at("#/storage/volumes"));
        await webExpect(tab(page, "Volumes")).toHaveAttribute("aria-selected", "true");
        await webExpect(page.locator("#boxPick")).toHaveCount(0);
      },
      TIMEOUT_MS,
    );

    test(
      "the Recycle bin opens from Storage, and Storage stays the current entry",
      async () => {
        await page.locator('#view a[href="#/trash"]').click();
        await webExpect(page).toHaveURL(at("#/trash"));
        await webExpect(page.locator("#view h1").first()).toHaveText("Recycle bin");
        await webExpect(currentEntry(page)).toHaveAttribute("data-nav", "storage");
      },
      TIMEOUT_MS,
    );
  });

  describe("the Library section", () => {
    test(
      "opens on Templates, which lists the base template",
      async () => {
        await page.goto(`${consoleUrl}/#/library`);
        await webExpect(page).toHaveURL(at("#/library/templates"));
        await webExpect(tab(page, "Templates")).toHaveAttribute("aria-selected", "true");
        await webExpect(page.locator('#tpGrid [data-name="base"]')).toBeVisible();
      },
      TIMEOUT_MS,
    );

    test(
      "Tool catalog puts the box it lists into the address, and lists that box's tools",
      async () => {
        await tab(page, "Tool catalog").click();
        await webExpect(page.locator("#boxPick")).toBeVisible();
        const box = await page.locator("#boxPick").inputValue();
        await webExpect(page).toHaveURL(at(`#/library/tools/${box}`));
        await webExpect(tab(page, "Tool catalog")).toHaveAttribute("aria-selected", "true");
        await webExpect(page.locator("#bdToolRows .spinner")).toHaveCount(0);
        await webExpect(page.locator("#bdToolRows").getByText("Claude Code", { exact: true }).first()).toBeVisible();
      },
      TIMEOUT_MS,
    );

    test(
      "still lists the templates the hosts hold when the official catalog cannot be read",
      async () => {
        const noCatalog = await signedIn({ viewport: VIEWPORT });
        try {
          await noCatalog.route("**/api/templates/official", (route) =>
            route.fulfill({ status: 500, json: { error: { code: "internal", message: "catalog unavailable" } } }),
          );
          const tpPage = await noCatalog.newPage();
          await tpPage.goto(`${consoleUrl}/#/library/templates`);
          await webExpect(tpPage.locator('#tpGrid [data-name="base"]')).toBeVisible();
        } finally {
          await noCatalog.close();
        }
      },
      TIMEOUT_MS,
    );

    test(
      "a template address opens Library on Templates, with that template in focus",
      async () => {
        await page.goto(`${consoleUrl}/#/templates/base`);
        await webExpect(page).toHaveURL(at("#/library/templates/base"));
        await webExpect(tab(page, "Templates")).toHaveAttribute("aria-selected", "true");
        await webExpect(page.locator('#tpGrid [data-name="base"]')).toHaveClass(/is-focus/);
      },
      TIMEOUT_MS,
    );
  });

  describe("the tab strips and the keyboard", () => {
    test(
      "the arrow keys move focus within Storage's strip, wrap at either end, and Home and End jump",
      async () => {
        await page.goto(`${consoleUrl}/#/storage/volumes`);
        await webExpect(page.locator("#view [role='tablist']")).toHaveCount(1);
        await tab(page, "Volumes").focus();
        expect(await focusedTab(page)).toBe("Volumes");
        // Moving focus does not open the tab: the address stays where it was.
        await page.keyboard.press("ArrowRight");
        expect(await focusedTab(page)).toBe("Checkpoints");
        await webExpect(page).toHaveURL(at("#/storage/volumes"));
        await page.keyboard.press("ArrowRight");
        expect(await focusedTab(page)).toBe("Volumes");
        await page.keyboard.press("ArrowLeft");
        expect(await focusedTab(page)).toBe("Checkpoints");
        await page.keyboard.press("End");
        expect(await focusedTab(page)).toBe("Checkpoints");
        await page.keyboard.press("Home");
        expect(await focusedTab(page)).toBe("Volumes");
        // A key the strip does not handle leaves focus where it was.
        await page.keyboard.press("ArrowDown");
        expect(await focusedTab(page)).toBe("Volumes");
        await webExpect(page).toHaveURL(at("#/storage/volumes"));
      },
      TIMEOUT_MS,
    );

    test(
      "Enter opens the tab the arrow keys reached, so the keyboard alone switches tabs",
      async () => {
        await page.goto(`${consoleUrl}/#/storage/volumes`);
        await tab(page, "Volumes").focus();
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("Enter");
        await webExpect(page).toHaveURL(at("#/storage/checkpoints"));
        await webExpect(tab(page, "Checkpoints")).toHaveAttribute("aria-selected", "true");
        await webExpect(page.locator("#sckRows")).toContainText("alpha");
      },
      TIMEOUT_MS,
    );

    test(
      "a click still opens a tab, and Library's strip answers the same keys",
      async () => {
        await page.goto(`${consoleUrl}/#/library/templates`);
        await tab(page, "Templates").click();
        await webExpect(page).toHaveURL(at("#/library/templates"));
        await tab(page, "Templates").focus();
        await page.keyboard.press("ArrowRight");
        expect(await focusedTab(page)).toBe("Tool catalog");
        await webExpect(page).toHaveURL(at("#/library/templates"));
        await page.keyboard.press("Enter");
        await webExpect(page).toHaveURL(/#\/library\/tools\/bx_/);
        await webExpect(tab(page, "Tool catalog")).toHaveAttribute("aria-selected", "true");
      },
      TIMEOUT_MS,
    );

    test(
      "on a phone the focused tab is scrolled into view, so the arrow keys reach a tab off the strip's edge",
      async () => {
        const phone = await signedIn({ viewport: { width: 390, height: 844 } });
        try {
          const phonePage = await phone.newPage();
          await phonePage.goto(`${consoleUrl}/#/storage/volumes`);
          await phonePage.locator("#view [role='tab']", { hasText: "Volumes" }).focus();
          await phonePage.keyboard.press("ArrowRight");
          await phonePage.keyboard.press("ArrowLeft");
          const shown = await phonePage.evaluate(() => {
            interface Node {
              textContent: string | null;
              getBoundingClientRect(): { left: number; right: number };
            }
            const view = globalThis as unknown as {
              document: { activeElement: Node; querySelector(selector: string): Node | null };
            };
            const active = view.document.activeElement;
            const strip = view.document.querySelector("#view [role='tablist']")!;
            const tabBox = active.getBoundingClientRect();
            const stripBox = strip.getBoundingClientRect();
            return {
              label: active.textContent?.trim() ?? "",
              inside: tabBox.left >= stripBox.left - 1 && tabBox.right <= stripBox.right + 1,
            };
          });
          expect(shown).toEqual({ label: "Volumes", inside: true });
        } finally {
          await phone.close();
        }
      },
      TIMEOUT_MS,
    );
  });

  describe("addresses that moved", () => {
    test(
      "Volumes, Templates and Snapshots open the pages that replaced them",
      async () => {
        for (const [from, to, nav] of [
          ["#/volumes", "#/storage/volumes", "storage"],
          ["#/templates", "#/library/templates", "library"],
          ["#/snapshots", "#/library/templates", "library"],
        ] as const) {
          await page.goto(`${consoleUrl}/${from}`);
          await webExpect(page).toHaveURL(at(to));
          await webExpect(currentEntry(page)).toHaveAttribute("data-nav", nav);
        }
      },
      TIMEOUT_MS,
    );

    test(
      "a settings category address opens that category, and Settings is the current entry",
      async () => {
        await page.goto(`${consoleUrl}/#/settings/secrets`);
        await webExpect(page).toHaveURL(at("#/settings/secrets"));
        await webExpect(page.locator(".settings-nav [aria-current='page']")).toHaveAttribute(
          "href",
          "#/settings/secrets",
        );
        await webExpect(currentEntry(page)).toHaveAttribute("data-nav", "settings");
      },
      TIMEOUT_MS,
    );

    test(
      "an address that never had a page opens the overview",
      async () => {
        await page.goto(`${consoleUrl}/#/nowhere`);
        await webExpect(page).toHaveURL(at("#/overview"));
        await webExpect(currentEntry(page)).toHaveAttribute("data-nav", "overview");
      },
      TIMEOUT_MS,
    );
  });

  describe("the host filter", () => {
    test(
      "stays hidden while the control plane has one host",
      async () => {
        await page.goto(`${consoleUrl}/#/overview`);
        await webExpect(page.locator("#hostFilter option")).toHaveCount(2);
        await webExpect(page.locator("#hostFilter")).toBeHidden();
      },
      TIMEOUT_MS,
    );

    test(
      "appears in the top bar once the control plane holds two hosts",
      async () => {
        const twoHosts = await signedIn({ viewport: VIEWPORT });
        try {
          await twoHosts.route("**/api/hosts", async (route) => {
            const response = await route.fetch();
            const body = (await response.json()) as { hosts: Record<string, unknown>[] };
            const [local = {}] = body.hosts;
            await route.fulfill({
              response,
              json: { ...body, hosts: [...body.hosts, { ...local, id: "lab", name: "Lab" }] },
            });
          });
          const hostsPage = await twoHosts.newPage();
          await hostsPage.goto(`${consoleUrl}/#/overview`);
          await webExpect(hostsPage.locator("#hostFilter option")).toHaveCount(3);
          await webExpect(hostsPage.locator("#hostFilter")).toBeVisible();
        } finally {
          await twoHosts.close();
        }
      },
      TIMEOUT_MS,
    );

    test(
      "a hosts file that repeats a name still lists both, each with its id so no two options read alike",
      async () => {
        const duplicated = await signedIn({ viewport: VIEWPORT });
        try {
          // A hosts file written before a name had to be unique: MiniBox loads it, and the console must not draw two hosts
          // of one name as one option.
          await duplicated.route("**/api/hosts", async (route) => {
            const response = await route.fetch();
            const body = (await response.json()) as { hosts: Record<string, unknown>[] };
            const [local = {}] = body.hosts;
            const twin = { ...local, id: "lab", name: "Local", transport: "unix", endpoint: "unix:///run/lab.sock" };
            await route.fulfill({ response, json: { ...body, hosts: [...body.hosts, twin] } });
          });
          const hostsPage = await duplicated.newPage();
          await hostsPage.goto(`${consoleUrl}/#/overview`);
          const options = hostsPage.locator("#hostFilter option");
          await webExpect(options).toHaveCount(3);
          const texts = await options.allTextContents();
          expect(texts).toEqual(["All hosts", "Local · local", "Local · lab"]);
        } finally {
          await duplicated.close();
        }
      },
      TIMEOUT_MS,
    );

    test(
      "removing one of two hosts of one name asks about it by its label, so the operator knows which one goes",
      async () => {
        const duplicated = await signedIn({ viewport: VIEWPORT });
        try {
          await duplicated.route("**/api/hosts", async (route) => {
            if (route.request().method() !== "GET") return route.continue();
            const response = await route.fetch();
            const body = (await response.json()) as { hosts: Record<string, unknown>[] };
            const [local = {}] = body.hosts;
            const twin = { ...local, id: "lab", name: "Local", transport: "unix", endpoint: "unix:///run/lab.sock" };
            await route.fulfill({ response, json: { ...body, hosts: [...body.hosts, twin] } });
          });
          const hostsPage = await duplicated.newPage();
          await hostsPage.goto(`${consoleUrl}/#/settings/hosts`);
          const remove = hostsPage.locator('[data-remove-host="lab"]');
          await webExpect(remove).toHaveAttribute("data-host-name", "Local · lab");
          await remove.click();
          await webExpect(hostsPage.locator("#cfm-ok")).toBeVisible();
          await webExpect(hostsPage.getByText("Local · lab", { exact: false }).last()).toBeVisible();
        } finally {
          await duplicated.close();
        }
      },
      TIMEOUT_MS,
    );
  });

  describe("the hosts table's width", () => {
    test(
      "an agent host's remove button fits without scrolling the table sideways, from a desktop to a phone",
      async () => {
        for (const lang of ["en", "zh-CN"]) {
          const wide = await signedIn({ viewport: VIEWPORT });
          try {
            await wide.addInitScript((value) => localStorage.setItem("minibox.lang", value), lang);
            await wide.route("**/api/hosts", async (route) => {
              if (route.request().method() !== "GET") return route.continue();
              const response = await route.fetch();
              const body = (await response.json()) as { hosts: Record<string, unknown>[] };
              const [local = {}] = body.hosts;
              const agent = {
                ...local,
                id: "gpu-box",
                name: "GPU",
                transport: "agent",
                endpoint: "agent://gpu-box",
                agent: {
                  connected: true,
                  revoked: false,
                  version: "0.4.0",
                  protocol: 1,
                  lastSeenAt: new Date().toISOString(),
                },
              };
              await route.fulfill({ response, json: { ...body, hosts: [...body.hosts, agent] } });
            });
            const hostsPage = await wide.newPage();
            await hostsPage.goto(`${consoleUrl}/#/settings/hosts`);
            await webExpect(hostsPage.locator('[data-remove-host="gpu-box"]')).toBeVisible();
            for (const width of [1280, 1100, 1024, 900, 768, 600, 390]) {
              await hostsPage.setViewportSize({ width, height: 800 });
              const overflow = await hostsPage
                .locator("#stHosts .table-wrap")
                .evaluate((wrap) => wrap.scrollWidth - wrap.clientWidth);
              expect({ lang, width, overflow }).toEqual({ lang, width, overflow: 0 });
            }
          } finally {
            await wide.close();
          }
        }
      },
      TIMEOUT_MS * 2,
    );
  });

  describe("removing an agent host", () => {
    test(
      "offers only Remove, and its confirm says the agent is cut off and its idle container is left to docker rm -f",
      async () => {
        const said = {
          en: [
            "disconnected at once and cannot reconnect",
            "deletes no container on the machine",
            "only volumes it deletes are MiniBox's own shared tools volumes",
            "nothing is removed and you can try again",
            "docker rm -f",
          ],
          "zh-CN": [
            "立即断开，且无法再次连接",
            "不会删除机器上的任何容器",
            "共享工具卷",
            "什么都不会移除",
            "docker rm -f",
          ],
        };
        for (const [lang, phrases] of Object.entries(said)) {
          const context = await signedIn({ viewport: VIEWPORT });
          try {
            await context.addInitScript((value) => localStorage.setItem("minibox.lang", value), lang);
            await withAgentHost(context, false);
            const hostsPage = await context.newPage();
            await hostsPage.goto(`${consoleUrl}/#/settings/hosts`);
            const remove = hostsPage.locator('[data-remove-host="gpu-box"]');
            await webExpect(remove).toBeVisible();
            const actions = remove.locator("xpath=..");
            await webExpect(actions.locator("button")).toHaveCount(1);
            await webExpect(hostsPage.locator("[data-revoke-host]")).toHaveCount(0);
            await remove.click();
            const dialog = hostsPage.getByRole("dialog");
            for (const phrase of phrases) await webExpect(dialog).toContainText(phrase);
            await dialog.locator("[data-close]").last().click();
            await webExpect(dialog).toHaveCount(0);
          } finally {
            await context.close();
          }
        }
      },
      TIMEOUT_MS * 2,
    );

    test(
      "a host whose agent was already revoked is marked revoked and is removed with one DELETE",
      async () => {
        const context = await signedIn({ viewport: VIEWPORT });
        try {
          await withAgentHost(context, true);
          const deleted: string[] = [];
          await context.route("**/api/hosts/gpu-box", async (route) => {
            if (route.request().method() !== "DELETE") return route.continue();
            deleted.push(new URL(route.request().url()).pathname);
            await route.fulfill({ json: { host: { id: "gpu-box", name: "GPU" } } });
          });
          const hostsPage = await context.newPage();
          await hostsPage.goto(`${consoleUrl}/#/settings/hosts`);
          const remove = hostsPage.locator('[data-remove-host="gpu-box"]');
          const row = hostsPage.locator("#stHosts tbody tr", { has: remove });
          await webExpect(row.locator(".agent-meta .badge-danger")).toHaveText("Revoked");
          await remove.click();
          await webExpect(hostsPage.getByRole("dialog")).toContainText("cannot reconnect");
          await hostsPage.locator("#cfm-ok").click();
          await webExpect.poll(() => deleted).toEqual(["/api/hosts/gpu-box"]);
        } finally {
          await context.close();
        }
      },
      TIMEOUT_MS,
    );
  });

  describe("the engine storage line on the hosts settings card", () => {
    test(
      "lists the four classes with their totals and reclaimable bytes",
      async () => {
        await page.goto(`${consoleUrl}/#/settings/hosts`);
        const local = page.locator('#stHosts tbody tr.host-disk-row td[data-disk-host="local"]');
        // The reading is filled in after the table is drawn, so the line arrives once the API answers.
        await webExpect(local.locator(".host-disk-class")).toHaveCount(4);
        await webExpect(local.locator(".host-disk-label")).toContainText([
          "Images",
          "Containers",
          "Volumes",
          "Build cache",
        ]);
        await webExpect(local).toContainText("reclaimable");
      },
      TIMEOUT_MS,
    );

    test(
      "a host the console cannot read says why, and its own row still draws",
      async () => {
        const offline = await signedIn({ viewport: VIEWPORT });
        try {
          await offline.route("**/api/hosts/local/disk", (route) =>
            route.fulfill({
              contentType: "application/json",
              json: {
                id: "local",
                status: "online",
                checkedAt: new Date().toISOString(),
                supported: false,
                reason: "agent_host",
                detail: null,
                breakdown: null,
              },
            }),
          );
          const hostsPage = await offline.newPage();
          await hostsPage.goto(`${consoleUrl}/#/settings/hosts`);
          const note = hostsPage.locator('#stHosts [data-disk-host="local"] .host-disk-note');
          await webExpect(note).toContainText("No reading on an agent host");
          // The host's own row is still there, with its status badge.
          await webExpect(hostsPage.locator("#stHosts tbody tr").first()).toContainText("local");
        } finally {
          await offline.close();
        }
      },
      TIMEOUT_MS,
    );
  });

  describe("the Chinese console", () => {
    test(
      "names the entries 概览, Box, 存储, 库, 活动 and 设置",
      async () => {
        const zh = await signedIn({ locale: "zh-CN", viewport: VIEWPORT });
        try {
          const zhPage = await zh.newPage();
          await zhPage.goto(`${consoleUrl}/#/overview`);
          await webExpect(zhPage.locator(".sidebar .nav > a > span[data-i18n]")).toHaveText([
            "概览",
            "Box",
            "存储",
            "库",
            "活动",
            "设置",
          ]);
        } finally {
          await zh.close();
        }
      },
      TIMEOUT_MS,
    );
  });

  describe("the overview's watch lists and the box list's indicator", () => {
    const boxes = { delta: "", echo: "", foxtrot: "", golf: "" };
    let agent = { id: "", secret: "" };
    let previousScript: FakeRuntime["execScript"] = null;

    const agentCall = (path: string, body: Record<string, unknown>) =>
      call(consoleUrl, path, { token: agent.secret, body });

    async function agentBox(name: string): Promise<string> {
      const created = await agentCall("/api/boxes", { name, cpus: 1, memoryMb: 512 });
      expect(created.status).toBe(201);
      if (!created.json.box) throw new Error(`the box ${name} was not created`);
      return created.json.box.id;
    }

    async function agentRuns(boxId: string, cmd: string, output: string): Promise<void> {
      const started = await agentCall(`/api/boxes/${boxId}/exec`, { cmd, background: true });
      expect(started.status).toBe(200);
      runtime?.execs.at(-1)?.print(output);
    }

    async function agentOpens(boxId: string, name: string): Promise<void> {
      const opened = await agentCall(`/api/boxes/${boxId}/sessions`, { name });
      expect(opened.status).toBeLessThan(300);
    }

    beforeAll(async () => {
      if (!app || !runtime) throw new Error("the console did not start");
      previousScript = runtime.execScript;
      runtime.execScript = null;
      agent = mint(app, { name: "builder", preset: "sandboxed-agent" });

      boxes.echo = await agentBox("echo");
      await agentRuns(boxes.echo, "tail -f app.log", "one\ntwo\n");
      boxes.foxtrot = await agentBox("foxtrot");
      await agentRuns(boxes.foxtrot, "make watch", "built in 2.1s\n");
      boxes.golf = await agentBox("golf");
      await agentRuns(boxes.golf, "sleep 600", "");
      boxes.delta = await agentBox("delta");
      await agentOpens(boxes.delta, "logs");
      await agentOpens(boxes.delta, "work");
      await agentRuns(boxes.delta, "npm run dev", "compiling\nready in 1.2s\nlistening on 3000\n");
      app.events.append({
        id: ulid(Date.now()),
        ts: Date.now(),
        durationMs: 0,
        status: "ok",
        op: "container.oom",
        kind: "write",
        principal: { type: "owner", id: "owner", name: "owner" },
        source: "system",
        hostId: "local",
        summary: "container.oom",
        target: { kind: "box", id: boxes.delta, name: "delta" },
      });
    }, 60_000);

    afterAll(() => {
      if (runtime) runtime.execScript = previousScript;
    });

    test(
      "a long list shows three rows, and its toggle shows the rest and collapses again",
      async () => {
        await openOverview();
        const rows = page.locator("#ovProgress .watch-row");
        const toggle = page.locator("#ovProgress .list-toggle");
        await webExpect(rows).toHaveCount(3);
        await webExpect(toggle).toHaveText("Show all (4)");
        await toggle.click();
        await webExpect(rows).toHaveCount(4);
        await webExpect(toggle).toHaveText("Show less");
        await toggle.click();
        await webExpect(rows).toHaveCount(3);
      },
      TIMEOUT_MS,
    );

    test(
      "the overview's box list shows five rows and its toggle shows the rest, and its recent activity is a short summary that links to the log",
      async () => {
        await openOverview();
        const boxRows = page.locator("#ovBoxes .activity li");
        const boxToggle = page.locator("#ovBoxes .list-toggle");
        await webExpect(boxRows).toHaveCount(5);
        await webExpect(boxToggle).toHaveText(/^Show all \(\d+\)$/);
        await boxToggle.click();
        await webExpect(boxToggle).toHaveText("Show less");
        expect(await boxRows.count()).toBeGreaterThan(5);
        await boxToggle.click();
        await webExpect(boxRows).toHaveCount(5);

        await webExpect(page.locator("#ovActivity .activity li")).toHaveCount(6);
        await webExpect(page.locator("#ovActivity .list-toggle")).toHaveCount(0);
        const viewAll = page.locator('#ovRecentCard a[href="#/activity"]');
        await webExpect(viewAll).toHaveText("View all");
        await viewAll.click();
        await webExpect(page).toHaveURL(at("#/activity"));
        await webExpect(page.locator(".actv-table")).toBeVisible();
      },
      TIMEOUT_MS,
    );

    test(
      "a row names who acted, the command and the session it used, and its last lines open on request",
      async () => {
        await openOverview();
        await page.locator("#ovProgress .list-toggle").click();
        const row = page.locator("#ovProgress .watch-row", { hasText: "delta" });
        await webExpect(row.locator(".watch-name")).toHaveText("delta");
        await webExpect(row.getByText("Token builder")).toBeVisible();
        await webExpect(row.getByText("Running", { exact: true })).toBeVisible();
        await webExpect(row.locator(".watch-code")).toHaveText("npm run dev");
        const more = row.locator(".watch-more");
        await webExpect(more).toHaveAttribute("aria-expanded", "false");
        await webExpect(row.locator(".watch-output")).toBeHidden();
        await more.click();
        await webExpect(more).toHaveAttribute("aria-expanded", "true");
        await webExpect(row.locator(".watch-output")).toBeVisible();
        await webExpect(row.locator(".watch-output span")).toHaveText([
          "compiling",
          "ready in 1.2s",
          "listening on 3000",
        ]);
        await webExpect(row.locator(".watch-meta .tag")).toHaveText("Session work");
      },
      TIMEOUT_MS,
    );

    test(
      "Observe and Take over point at the session the agent used, and a row without one observes the box's activity",
      async () => {
        await openOverview();
        await page.locator("#ovProgress .list-toggle").click();
        const delta = page.locator("#ovProgress .watch-row", { hasText: "delta" });
        await webExpect(delta.getByRole("link", { name: "Observe" })).toHaveAttribute(
          "href",
          `#/boxes/${boxes.delta}/terminal/work`,
        );
        await webExpect(delta.getByRole("link", { name: "Take over" })).toHaveAttribute(
          "href",
          `#/boxes/${boxes.delta}/terminal/work`,
        );
        const echo = page.locator("#ovProgress .watch-row", { hasText: "echo" });
        await webExpect(echo.getByRole("link", { name: "Observe" })).toHaveAttribute(
          "href",
          `#/boxes/${boxes.echo}/activity`,
        );
        await webExpect(echo.getByRole("link", { name: "Take over" })).toHaveCount(0);
      },
      TIMEOUT_MS,
    );

    test(
      "Observe opens the session read-only, with its chip pressed and the agent still driving",
      async () => {
        await openOverview();
        await page.locator("#ovProgress .list-toggle").click();
        await page
          .locator("#ovProgress .watch-row", { hasText: "delta" })
          .getByRole("link", { name: "Observe" })
          .click();
        await webExpect(page).toHaveURL(at(`#/boxes/${boxes.delta}/terminal/work`));
        await webExpect(page.locator('.session-chip[data-session="work"]')).toHaveAttribute("aria-pressed", "true");
        await webExpect(page.locator('.session-chip[data-session="logs"]')).toHaveAttribute("aria-pressed", "false");
        await webExpect(page.locator("#tControl")).toContainText("Agent is driving");
        await webExpect(page.locator('#tControl [data-control="takeover"]')).toBeVisible();
      },
      TIMEOUT_MS,
    );

    test(
      "Take over gives this page the keyboard, and Return to agent gives it back",
      async () => {
        await openFresh(`#/boxes/${boxes.delta}/terminal/work`);
        const takeOver = page.locator('#tControl [data-control="takeover"]');
        await webExpect(takeOver).toBeVisible();
        await takeOver.click();
        await webExpect(page.locator("#tControl")).toContainText("You are driving");
        await page.locator('#tControl [data-control="release"]').click();
        await webExpect(page.locator("#tControl")).toContainText("Agent is driving");
        await webExpect(takeOver).toBeVisible();
      },
      TIMEOUT_MS,
    );

    test(
      "picking another session moves the address to it, and a reload opens that session",
      async () => {
        await openFresh(`#/boxes/${boxes.delta}/terminal/work`);
        await webExpect(page.locator('.session-chip[data-session="work"]')).toHaveAttribute("aria-pressed", "true");
        await page.locator('.session-chip[data-session="logs"]').click();
        await webExpect(page).toHaveURL(at(`#/boxes/${boxes.delta}/terminal/logs`));
        await webExpect(page.locator('.session-chip[data-session="logs"]')).toHaveAttribute("aria-pressed", "true");
        await webExpect(page.locator('.session-chip[data-session="work"]')).toHaveAttribute("aria-pressed", "false");
        await page.reload();
        await webExpect(page).toHaveURL(at(`#/boxes/${boxes.delta}/terminal/logs`));
        await webExpect(page.locator('.session-chip[data-session="logs"]')).toHaveAttribute("aria-pressed", "true");
      },
      TIMEOUT_MS,
    );

    test(
      "a row with no session opens the box's activity, which shows the commands it ran",
      async () => {
        await openOverview();
        await page.locator("#ovProgress .list-toggle").click();
        await page
          .locator("#ovProgress .watch-row", { hasText: "echo" })
          .getByRole("link", { name: "Observe" })
          .click();
        await webExpect(page).toHaveURL(at(`#/boxes/${boxes.echo}/activity`));
        await webExpect(tab(page, "Activity")).toHaveAttribute("aria-selected", "true");
      },
      TIMEOUT_MS,
    );

    test(
      "the attention list names the box that ran out of memory, and View opens its activity",
      async () => {
        await openOverview();
        const row = page.locator("#ovAttention .watch-row", { hasText: "delta" });
        await webExpect(row.locator("strong")).toHaveText("Out of memory");
        await webExpect(row.getByText("The box ran out of memory")).toBeVisible();
        await row.getByRole("link", { name: "View" }).click();
        await webExpect(page).toHaveURL(at(`#/boxes/${boxes.delta}/activity`));
        await webExpect(tab(page, "Activity")).toHaveAttribute("aria-selected", "true");
      },
      TIMEOUT_MS,
    );

    test(
      "the Boxes list marks the boxes an agent is working on, and no others",
      async () => {
        await page.goto(`${consoleUrl}/#/boxes`);
        await webExpect(page.locator("[data-activity]:not([hidden])")).toHaveCount(4);
        await webExpect(page.locator(`[data-activity="${boxes.delta}"]`)).toContainText("Agent active");
        await webExpect(page.locator("tr", { hasText: "alpha" }).locator("[data-activity]")).toBeHidden();
      },
      TIMEOUT_MS,
    );

    test(
      "the overview and the Boxes list name their parts in Chinese",
      async () => {
        const zh = await signedIn({ locale: "zh-CN", viewport: VIEWPORT });
        try {
          const zhPage = await zh.newPage();
          await zhPage.goto(`${consoleUrl}/#/overview`);
          await webExpect(zhPage.locator("#ovProgressTitle")).toHaveText("正在进行");
          await webExpect(zhPage.locator("#ovAttentionTitle")).toHaveText("需要关注");
          await webExpect(zhPage.locator("#ovAttention")).toContainText("内存耗尽");
          await zhPage.locator("#ovProgress .list-toggle").click();
          const row = zhPage.locator("#ovProgress .watch-row", { hasText: "delta" });
          await webExpect(row.getByRole("link", { name: "观察" })).toBeVisible();
          await webExpect(row.getByRole("link", { name: "接管" })).toBeVisible();
          await zhPage.goto(`${consoleUrl}/#/boxes`);
          await webExpect(zhPage.locator(`[data-activity="${boxes.delta}"]`)).toContainText("Agent 活动中");
        } finally {
          await zh.close();
        }
      },
      TIMEOUT_MS,
    );
  });
});

/** Serves the real host list with one agent host added, so the console draws an agent row. */
async function withAgentHost(context: BrowserContext, revoked: boolean): Promise<void> {
  await context.route("**/api/hosts", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = (await response.json()) as { hosts: Record<string, unknown>[] };
    const [local = {}] = body.hosts;
    const agent = {
      ...local,
      id: "gpu-box",
      name: "GPU",
      transport: "agent",
      endpoint: "agent://gpu-box",
      status: revoked ? "offline" : "online",
      boxes: 0,
      agent: { connected: !revoked, revoked, version: "0.4.0", protocol: 1, lastSeenAt: new Date().toISOString() },
    };
    await route.fulfill({ response, json: { ...body, hosts: [...body.hosts, agent] } });
  });
}
