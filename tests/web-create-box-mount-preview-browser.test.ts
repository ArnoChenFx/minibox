import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type Browser, type BrowserContext, chromium, expect as webExpect, type Page } from "@playwright/test";

import type { App } from "../src/app";
import { startServer } from "../src/server";
import en from "../web/js/i18n/en.js";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";

const executablePath = chromiumFor("The create box mount preview test");
const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const TIMEOUT_MS = 60_000;
const VIEWPORT = { width: 1280, height: 900 };

const english = (key: string, vars: Record<string, string | number> = {}): string =>
  (en[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ""));

interface BoxMount {
  volume: string;
  path: string;
  mode: string;
  role: string | null;
  volumeName: string | null;
}

interface BoxRow {
  boxId: string;
  name: string;
  mounts: BoxMount[];
}

/** One entry of the `mounts` a create sends: a volume that exists, or a role to create. */
interface SentMount {
  volume?: string;
  role?: string;
  path?: string;
}

interface VolumeRow {
  id: string;
  name: string;
  hostId: string;
  role: string | null;
  engineName: string;
}

describe.skipIf(!executablePath)("the create box dialog's preview volume names (real browser)", () => {
  let app: App | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser;
  let context: BrowserContext | undefined;
  let page: Page;
  let consoleUrl = "";
  let bearer: Record<string, string> = {};
  let labelPrefix = "";
  let hostId = "";
  /** The shared tools volume of this host, as the server names it. */
  const sharedToolsName = () => `${labelPrefix}-tools-${hostId}`;

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

  const createVolume = async (body: Record<string, unknown>): Promise<VolumeRow> =>
    (await rest<{ volume: VolumeRow }>("POST", "/api/volumes", { ...body, confirm: true })).volume;

  /** The host's one shared tools volume, made now when an earlier test has not made it yet. */
  const ensureSharedTools = async (): Promise<void> => {
    if ((await volumesOn(hostId)).some((volume) => volume.role === "tools")) return;
    await createVolume({ name: sharedToolsName(), role: "tools" });
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
    return box;
  };

  /** The text of every option of the first row's volume select, in order. */
  const optionTexts = async (box: ReturnType<typeof dialog>): Promise<string[]> =>
    box
      .locator("#cbMountRows [data-mount]")
      .first()
      .locator("[data-volume] option")
      .evaluateAll((options) =>
        options.map((option) => (option as unknown as { textContent: string }).textContent?.trim() ?? ""),
      );

  /** The text of the option each of the four rows shows as selected. */
  const rowOptionTexts = async (box: ReturnType<typeof dialog>): Promise<string[]> =>
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
    labelPrefix = app.cfg.labelPrefix;
    hostId = app.hosts.get().host.id;
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
    "the four role options show the names the create would make, say they are a preview, and follow the box name",
    async () => {
      const box = await openCustom("alpha");

      // The Volumes section says the names are a preview and that nothing is created before the create.
      await webExpect(box.locator("#cbVolPreviewNote")).toContainText(english("cb.volumesPreview"));
      await webExpect(box.locator("#cbVolPreviewNote")).toContainText(
        english("cb.previewCreate", { name: "alpha-workspace" }),
      );

      // The four rows show the predicted name of the role each one creates, and say it is a preview.
      expect(await rowOptionTexts(box)).toEqual([
        english("mount.roleWillCreate", { name: "alpha-workspace" }),
        english("mount.roleWillCreate", { name: "alpha-home" }),
        // This host has no shared tools volume yet, so the create makes one: `<prefix>-tools-<host>`.
        english("mount.roleWillCreate", { name: sharedToolsName() }),
        english("mount.roleWillCreate", { name: "alpha-cache" }),
      ]);
      // Every one of the four says it is only a preview: a bare name would read as a volume that already exists.
      for (const text of await rowOptionTexts(box)) expect(text).toContain("preview");
      expect(english("mount.roleWillCreate", { name: "alpha-workspace" })).toContain("preview");
      expect(english("cb.previewCreate", { name: "alpha-workspace" })).toContain("preview");

      // Every role option names a volume, so none of them reads as a bare role any more.
      const choices = await optionTexts(box);
      expect(choices).toContain(english("mount.roleWillCreate", { name: "alpha-home" }));
      expect(choices.some((choice) => choice === english("mount.roleSharedNone"))).toBe(false);

      // Typing a new box name renames every prediction, and each row keeps what it has picked.
      await box.locator("#cbName").fill("beta");
      await webExpect(box.locator("#cbMountRows [data-mount]").first().locator("[data-volume]")).toHaveValue(
        "role:workspace",
      );
      expect(await rowOptionTexts(box)).toEqual([
        english("mount.roleWillCreate", { name: "beta-workspace" }),
        english("mount.roleWillCreate", { name: "beta-home" }),
        english("mount.roleWillCreate", { name: sharedToolsName() }),
        english("mount.roleWillCreate", { name: "beta-cache" }),
      ]);
      await webExpect(box.locator("#cbVolPreviewNote")).toContainText(
        english("cb.previewCreate", { name: "beta-workspace" }),
      );
      await webExpect(box.locator("#cbVolPreviewNote")).not.toContainText("alpha-workspace");

      // A row that is removed is not created, so the preview stops naming it.
      await box.locator("#cbMountRows [data-mount]").nth(1).locator("[data-remove-mount]").click();
      await webExpect(box.locator("#cbMountRows [data-mount]")).toHaveCount(3);
      await webExpect(box.locator("#cbVolPreviewNote")).not.toContainText("beta-home");
    },
    TIMEOUT_MS,
  );

  test(
    "a row replaced by an existing volume is sent as that volume, and the create makes the volumes it previewed",
    async () => {
      // A volume that exists, to swap the workspace row for.
      const spare = await createVolume({ name: "spare" });
      expect(spare.hostId).toBe(hostId);

      const box = await openCustom("previewbox");

      // The request body the dialog sends, captured before the server sees it. The holder is an object, so the closure
      // below is allowed to fill it in.
      const captured: { sent: { mounts?: SentMount[] } | null } = { sent: null };
      await page.route("**/api/boxes", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        captured.sent = route.request().postDataJSON() as { mounts?: SentMount[] };
        await route.continue();
      });

      const workspaceRow = box.locator("#cbMountRows [data-mount]").first();
      await workspaceRow.locator("[data-volume]").selectOption(spare.id);
      await webExpect(workspaceRow.locator("[data-volume]")).toHaveValue(spare.id);
      // The row gives back its own path and mode, and the preview no longer names a workspace volume.
      await webExpect(workspaceRow.locator("[data-path]")).not.toHaveAttribute("readonly", "");
      await webExpect(box.locator("#cbVolPreviewNote")).not.toContainText("previewbox-workspace");
      await webExpect(box.locator("#cbVolPreviewNote")).toContainText(
        english("cb.previewCreate", { name: "previewbox-home" }),
      );

      await box.locator("#cbSubmit").click();
      await webExpect(box).toHaveCount(0);
      const created = await boxNamed("previewbox");

      // The workspace row is the volume that exists; the other three are roles the create made.
      const mounts = captured.sent?.mounts ?? [];
      expect(mounts).toHaveLength(4);
      expect(mounts.some((mount) => mount.role === "workspace")).toBe(false);
      expect(mounts.filter((mount) => mount.role).map((mount) => mount.role)).toEqual(["home", "tools", "cache"]);
      expect(mounts.find((mount) => mount.volume === spare.id)).toMatchObject({ path: "/workspace" });

      // The volumes on the host are the ones the dialog previewed: <box>-<role>, and one shared tools volume.
      const names = (await volumesOn(spare.hostId)).map((volume) => volume.name);
      expect(names).toContain("previewbox-home");
      expect(names).toContain("previewbox-cache");
      expect(names).not.toContain("previewbox-workspace");
      const tools = (await volumesOn(spare.hostId)).filter((volume) => volume.role === "tools");
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe(sharedToolsName());

      // The box mounts the volume the row named for the workspace, and the volumes it just made for the rest.
      const workspace = created.mounts.find((mount) => mount.path === "/workspace");
      expect(workspace?.role).toBeNull();
      expect(workspace?.volume).toBe(spare.engineName);
      expect(created.mounts.find((mount) => mount.role === "home")?.volumeName).toBe("previewbox-home");
      expect(created.mounts.find((mount) => mount.role === "cache")?.volumeName).toBe("previewbox-cache");
      expect(created.mounts.find((mount) => mount.role === "tools")?.volumeName).toBe(sharedToolsName());
    },
    TIMEOUT_MS,
  );

  test(
    "a name the host already uses is previewed as inexact, and the shared tools volume is shown as already there",
    async () => {
      // A name this host already uses, so the server's `freeName` adds a suffix the dialog cannot know.
      await createVolume({ name: "takenbox-home", role: "home" });
      await ensureSharedTools();

      const box = await openCustom("takenbox");
      await webExpect(box.locator("#cbVolPreviewNote")).toContainText(
        english("cb.previewCreateInexact", { name: "takenbox-home" }),
      );
      expect(english("cb.previewCreateInexact", { name: "takenbox-home" })).toContain("suffix");
      // A name nothing uses is still previewed plainly.
      await webExpect(box.locator("#cbVolPreviewNote")).toContainText(
        english("cb.previewCreate", { name: "takenbox-workspace" }),
      );

      // The host has its shared tools volume now, so the tools row mounts it and creates nothing.
      await webExpect(box.locator("#cbVolPreviewNote")).toContainText(
        english("cb.previewShared", { name: sharedToolsName() }),
      );
      expect(await rowOptionTexts(box)).toContain(english("mount.roleSharedExists", { name: sharedToolsName() }));
    },
    TIMEOUT_MS,
  );
});
