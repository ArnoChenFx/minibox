import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type Browser, type BrowserContext, chromium, expect as webExpect, type Page } from "@playwright/test";

import type { App } from "../src/app";
import { startServer } from "../src/server";
import en from "../web/js/i18n/en.js";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";

const executablePath = chromiumFor("The create box pool picker test");
const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const TIMEOUT_MS = 60_000;
const VIEWPORT = { width: 1280, height: 900 };

const english = (key: string, vars: Record<string, string | number> = {}): string =>
  (en[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ""));

interface BoxRow {
  boxId: string;
  name: string;
  mounts: { volume: string; path: string; mode: string; role: string | null; pool: string | null }[];
}

interface VolumeRow {
  id: string;
  name: string;
  hostId: string;
  pool: string;
  role: string | null;
  engineName: string;
}

/** One entry of the `mounts` a create sends: a volume that exists, or a role to create, with the pool it picked. */
interface SentMount {
  volume?: string;
  role?: string;
  pool?: string;
  path?: string;
}

describe.skipIf(!executablePath)("the create box dialog's storage pool picker (real browser)", () => {
  let app: App | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser;
  let context: BrowserContext | undefined;
  let page: Page;
  let consoleUrl = "";
  let bearer: Record<string, string> = {};
  let labelPrefix = "";
  let hostId = "";

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

  const volumesOn = async (id: string): Promise<VolumeRow[]> => {
    const { volumes } = await rest<{ volumes: VolumeRow[] }>("GET", "/api/volumes");
    return volumes.filter((volume) => volume.hostId === id);
  };

  const dialog = () => page.getByRole("dialog");

  /** Opens the create dialog in Customize mode, with the box name already filled in. */
  const openCustom = async (name: string): Promise<ReturnType<typeof dialog>> => {
    // A dialog left open by a failed test would swallow the click that opens the next one.
    await page
      .getByRole("dialog")
      .locator("[data-close]")
      .first()
      .click({ timeout: 2_000 })
      .catch(() => {});
    await page.goto(`${consoleUrl}/#/boxes`);
    await page.locator('[data-action="create"]').first().click();
    const box = dialog();
    await webExpect(box).toBeVisible();
    await box.locator("#cbName").fill(name);
    await box.locator("#cbVolumes .fold-toggle").click();
    await box.locator('#cbVolMode [data-vol-mode="custom"]').click();
    await webExpect(box.locator("#cbMountRows [data-mount]")).toHaveCount(4);
    // The pool list is read beside the dialog, so wait for the row controls to appear before reading them.
    await webExpect(box.locator("#cbMountRows [data-mount]").first().locator("[data-pool]")).toBeAttached();
    return box;
  };

  /** The text of the option each row's pool control shows as selected. */
  const rowPoolTexts = async (box: ReturnType<typeof dialog>): Promise<string[]> =>
    box.locator("#cbMountRows [data-mount]").evaluateAll((rows) =>
      rows.map((row) => {
        const select = row.querySelector("[data-pool]") as unknown as {
          selectedOptions: { textContent: string }[];
        } | null;
        return select?.selectedOptions[0]?.textContent?.trim() ?? "";
      }),
    );

  /** The text of every option of the first row's pool control, in order. */
  const poolOptions = async (box: ReturnType<typeof dialog>): Promise<string[]> =>
    box
      .locator("#cbMountRows [data-mount]")
      .first()
      .locator("[data-pool] option")
      .evaluateAll((options) =>
        options.map((option) => (option as unknown as { textContent: string }).textContent?.trim() ?? ""),
      );

  /** The text of the option each row's volume control shows as selected. */
  const rowVolumeTexts = async (box: ReturnType<typeof dialog>): Promise<string[]> =>
    box.locator("#cbMountRows [data-mount] [data-volume]").evaluateAll((nodes) =>
      nodes.map((node) => {
        const select = node as unknown as { selectedOptions: { textContent: string }[] };
        return select.selectedOptions[0]?.textContent?.trim() ?? "";
      }),
    );

  beforeAll(async () => {
    const harness = createTestApp();
    app = harness.app;
    const keys = app.hosts.get().keys;
    harness.runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
    // A path pool needs its marker present and its helpers to succeed; the fake engine answers both.
    harness.runtime.helperHandler = () => ({ exitCode: 0, logs: "" });
    labelPrefix = app.cfg.labelPrefix;
    hostId = app.hosts.get().host.id;
    server = startServer(app);
    consoleUrl = `http://127.0.0.1:${server.port}`;
    bearer = { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}`, origin: consoleUrl };
    // A second pool, so a role has somewhere to go besides the local one.
    await rest("PUT", "/api/pools", {
      pools: [
        { name: "local", backend: "local", default: true },
        { name: "disk", backend: "path", root: "/mnt/disk", marker: ".minibox-mounted" },
      ],
      confirm: true,
    });
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
    "every role row offers the host's pools, and its rule's pool is what it shows until one is picked",
    async () => {
      const box = await openCustom("alpha");

      // The pool control lists every pool the host has, then "use the rule" for a row that has not picked one.
      expect(await poolOptions(box)).toEqual(["local", "disk", english("mount.poolRule")]);
      // The rule's pool is not a pick: each row starts on the rule, so the server's own default applies.
      expect(await rowPoolTexts(box)).toEqual([
        english("mount.poolRule"),
        english("mount.poolRule"),
        english("mount.poolRule"),
        english("mount.poolRule"),
      ]);
      // The rule puts workspace, home and tools on the default pool and cache on the local one, and the dialog's
      // prediction is the same name the server would give it there.
      await webExpect(box.locator("#cbVolPreviewNote")).toContainText(
        english("cb.previewCreate", { name: "alpha-workspace" }),
      );
      expect(await rowVolumeTexts(box)).toEqual([
        english("mount.roleWillCreate", { name: "alpha-workspace" }),
        english("mount.roleWillCreate", { name: "alpha-home" }),
        english("mount.roleWillCreate", { name: `${labelPrefix}-tools-${hostId}` }),
        english("mount.roleWillCreate", { name: "alpha-cache" }),
      ]);
    },
    TIMEOUT_MS,
  );

  test(
    "picking a pool names that pool in the preview, and the create makes the volume there",
    async () => {
      const box = await openCustom("poolbox");

      // Capture the request body before the server sees it, so the pick is read from what the dialog sends.
      const captured: { sent: { mounts?: SentMount[] } | null } = { sent: null };
      await page.route("**/api/boxes", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        captured.sent = route.request().postDataJSON() as { mounts?: SentMount[] };
        await route.continue();
      });

      const workspace = box.locator("#cbMountRows [data-mount]").first();
      await workspace.locator("[data-pool]").selectOption("disk");
      await webExpect(workspace.locator("[data-pool]")).toHaveValue("disk");

      // The preview says the volume goes to the pool that was picked, and keeps naming the same volume.
      await webExpect(box.locator("#cbVolPreviewNote")).toContainText(
        english("cb.previewCreatePool", { name: "poolbox-workspace", pool: "disk" }),
      );
      // The rows that were not touched still say nothing about a pool, so only the pick is visible.
      await webExpect(box.locator("#cbVolPreviewNote")).not.toContainText(
        english("cb.previewCreatePool", { name: "poolbox-home", pool: "disk" }),
      );

      await box.locator("#cbSubmit").click();
      await webExpect(box).toHaveCount(0);
      const created = await boxNamed("poolbox");

      // The row was sent as a role with its pool, and the other three as plain roles.
      const mounts = captured.sent?.mounts ?? [];
      expect(mounts).toContainEqual({ role: "workspace", pool: "disk" });
      expect(mounts.filter((mount) => mount.role && mount.role !== "workspace").every((mount) => !mount.pool)).toBe(
        true,
      );

      // The volume the box mounts for its workspace is on the pool that was picked, and the others follow their rules.
      const volumes = await volumesOn(hostId);
      const workspaceVolume = volumes.find((volume) => volume.name === "poolbox-workspace");
      expect(workspaceVolume?.pool).toBe("disk");
      expect(volumes.find((volume) => volume.name === "poolbox-home")?.pool).toBe("local");
      expect(volumes.find((volume) => volume.name === "poolbox-cache")?.pool).toBe("local");
      const mounted = created.mounts.find((mount) => mount.path === "/workspace");
      expect(mounted?.pool).toBe("disk");
      expect(mounted?.volume).toBe(workspaceVolume?.engineName ?? "");
      // The box's own page names the pool too, so the pick is visible after the create.
      expect(created.mounts.find((mount) => mount.role === "cache")?.pool).toBe("local");
      await page.unroute("**/api/boxes");
    },
    TIMEOUT_MS,
  );

  test(
    "picking a pool for tools mounts that pool's shared tools volume, and creates it there when it has none",
    async () => {
      const box = await openCustom("toolsbox");
      const tools = box.locator("#cbMountRows [data-mount]").nth(2);
      // This host has one shared tools volume, on the local pool, and the disk pool has none.
      await tools.locator("[data-pool]").selectOption("disk");
      await webExpect(tools.locator("[data-volume]")).toHaveValue("role:tools");
      // The tools row now says it makes a shared volume, because the disk pool has none of its own.
      await webExpect(box.locator("#cbVolPreviewNote")).toContainText(
        english("cb.previewCreatePool", { name: `${labelPrefix}-tools-${hostId}`, pool: "disk" }),
      );
      await box.locator("#cbSubmit").click();
      await webExpect(box).toHaveCount(0);
      await boxNamed("toolsbox");

      const volumes = await volumesOn(hostId);
      const toolsVolumes = volumes.filter((volume) => volume.role === "tools");
      // The shared tools volume is one per pool, so the pick made a second one rather than reusing the local one.
      expect(toolsVolumes.map((volume) => volume.pool).toSorted()).toEqual(["disk", "local"]);
      const created = await boxNamed("toolsbox");
      expect(created.mounts.find((mount) => mount.role === "tools")?.pool).toBe("disk");
    },
    TIMEOUT_MS,
  );

  test(
    "a row that mounts a volume that exists has no pool control, and gets one back when it creates a role again",
    async () => {
      // A volume that exists, to swap the workspace row for.
      const spare = (await rest<{ volume: VolumeRow }>("POST", "/api/volumes", { name: "spare", confirm: true }))
        .volume;
      const box = await openCustom("rowbox");
      const row = box.locator("#cbMountRows [data-mount]").first();
      await row.locator("[data-volume]").selectOption(spare.id);
      await webExpect(row.locator("[data-volume]")).toHaveValue(spare.id);
      // The volume is already on a pool of its own, so the row cannot pick another one for it.
      await webExpect(row.locator("[data-pool]")).toHaveCount(0);
      // And the preview stops naming a workspace volume, because this row creates none.
      await webExpect(box.locator("#cbVolPreviewNote")).not.toContainText("rowbox-workspace");

      // Picking a role again gives the row its pool control back, on the rule.
      await row.locator("[data-volume]").selectOption("role:workspace");
      await webExpect(row.locator("[data-pool]")).toHaveCount(1);
      await webExpect(row.locator("[data-pool]")).toHaveValue("");
      await webExpect(box.locator("#cbVolPreviewNote")).toContainText(
        english("cb.previewCreate", { name: "rowbox-workspace" }),
      );
      await box.locator("[data-close]").first().click();
      await webExpect(box).toHaveCount(0);
    },
    TIMEOUT_MS,
  );

  test(
    "the pool control fits the row at every width, and a long pool name does not push the page sideways",
    async () => {
      const box = await openCustom("widthbox");
      const overflow = () =>
        page.evaluate(() => {
          const doc = globalThis as unknown as {
            document: { documentElement: { scrollWidth: number } };
            innerWidth: number;
          };
          return doc.document.documentElement.scrollWidth - doc.innerWidth;
        });
      /** The labels the row's controls are too narrow to show in full, with what each needs and what it got. */
      const clipped = () =>
        page.evaluate(() => {
          const doc = globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<unknown> } };
          const labels = Array.from(
            doc.document.querySelectorAll("#cbMountRows [data-mount] .dropdown-current"),
          ) as unknown as Array<{ scrollWidth: number; clientWidth: number; textContent: string | null }>;
          return labels
            .filter((label) => label.scrollWidth > label.clientWidth + 1)
            .map((label) => ({
              text: (label.textContent ?? "").trim(),
              needs: label.scrollWidth,
              got: label.clientWidth,
            }));
        });

      expect(await overflow()).toBe(0);
      expect(await clipped()).toEqual([]);
      for (const width of [1100, 900, 700, 640, 561, 560, 390, 320]) {
        await page.setViewportSize({ width, height: VIEWPORT.height });
        await page.waitForTimeout(120);
        expect(await overflow()).toBe(0);
        expect(await clipped()).toEqual([]);
      }
      await page.setViewportSize(VIEWPORT);
      await box.locator("[data-close]").first().click();
      await webExpect(box).toHaveCount(0);
    },
    TIMEOUT_MS,
  );
});
