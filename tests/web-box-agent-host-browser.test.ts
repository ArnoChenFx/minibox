import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  type Browser,
  type BrowserContext,
  chromium,
  expect as webExpect,
  type Page,
  type Route,
} from "@playwright/test";

import type { App } from "../src/app";
import { startServer } from "../src/server";
import en from "../web/js/i18n/en.js";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { chromiumFor } from "./support/chromium";

const executablePath = chromiumFor("The agent-host Box page test");
const restoreLogs = silenceLogs();
afterAll(restoreLogs);

const TIMEOUT_MS = 30_000;
const VIEWPORT = { width: 1280, height: 800 };

/** The English text of a dictionary key, which a locator looks for. */
const english = (key: string): string => en[key] ?? key;

interface BoxRow {
  id: string;
  boxId: string;
  name: string;
}

/** A host as `/api/hosts` lists it, narrowed to the fields the console decides with. */
interface HostRow {
  id: string;
  name: string;
  transport: string;
}

/** Answers `GET /api/hosts` with `hosts`, keeping the response's own headers and status. */
const hostsAs = (hosts: HostRow[]) => async (route: Route) => {
  const response = await route.fetch();
  const body = (await response.json()) as { hosts: HostRow[] };
  const [local] = body.hosts;
  if (!local) throw new Error("the console listed no host");
  await route.fulfill({
    response,
    json: { ...body, hosts: [{ ...local, transport: "local" }, ...hosts] },
  });
};

/** Every request the page made whose path matches, collected so a test can prove a request was never sent. */
function watch(page: Page): string[] {
  const paths: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) paths.push(url.pathname);
  });
  return paths;
}

const boxUrl = (base: string, box: BoxRow, tab: string) => `${base}/#/boxes/${encodeURIComponent(box.id)}/${tab}`;

describe.skipIf(!executablePath)("a Box on an agent host (real browser)", () => {
  let app: App | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let browser: Browser;
  let base = "";
  let bearer: Record<string, string> = {};
  let box: BoxRow;

  async function signedIn(options = {}): Promise<BrowserContext> {
    const context = await browser.newContext({ viewport: VIEWPORT, ...options });
    expect(
      (
        await context.request.post(`${base}/api/auth/login`, {
          data: { key: TEST_KEY },
          headers: { origin: base },
        })
      ).status(),
    ).toBe(200);
    return context;
  }

  beforeAll(async () => {
    const harness = createTestApp();
    app = harness.app;
    const keys = app.hosts.get().keys;
    harness.runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
    server = startServer(app);
    base = `http://127.0.0.1:${server.port}`;
    bearer = { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}`, origin: base };

    const created = await fetch(`${base}/api/boxes`, {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ name: "edgebox", cpus: 1, memoryMb: 512 }),
    });
    expect(created.status).toBe(201);
    box = ((await created.json()) as { box: BoxRow }).box;

    browser = await chromium.launch({ executablePath: executablePath ?? undefined, args: ["--no-sandbox"] });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
    app?.throttle.stop();
    app?.sessions.stop();
    app?.tokens.stop();
    app?.events.close();
  });

  test(
    "the Files and Ports tabs explain themselves instead of sending a request that must fail",
    async () => {
      const context = await signedIn();
      try {
        const page = await context.newPage();
        const requests = watch(page);
        await page.route("**/api/hosts", hostsAs([{ id: "edge", name: "Edge lab", transport: "agent" }]));

        // The box names no host, so it sits on the local host; the console's own host list is what says it is an agent.
        await page.route("**/api/boxes/*", async (route) => {
          const request = route.request();
          if (request.method() !== "GET" || new URL(request.url()).pathname.endsWith("/stats")) return route.fallback();
          const response = await route.fetch();
          const body = (await response.json()) as { box: Record<string, unknown> };
          await route.fulfill({ response, json: { ...body, box: { ...body.box, hostId: "edge" } } });
        });

        await page.goto(boxUrl(base, box, "files"));
        const filesBody = page.locator("#tabBody");
        await webExpect(filesBody).toContainText(english("bd.agentFilesTitle"));
        await webExpect(filesBody).toContainText("agent host runs boxes only");
        // The tab stays in the strip, so the console does not look like it lost the feature.
        await webExpect(page.locator("#view [role='tab']", { hasText: english("bd.tabFiles") })).toHaveCount(1);
        await webExpect(page.locator("#tabBody .fb")).toHaveCount(0);

        await page.goto(boxUrl(base, box, "ports"));
        await webExpect(page.locator("#tabBody")).toContainText(english("bd.agentPortsTitle"));
        await webExpect(page.locator("#tabBody")).toContainText("Reach the service on the machine itself");

        // The requests the two tabs never sent: neither the file listing nor the port scan, both of which answer 501.
        const sent = requests.filter((path) => path.includes("/files") || /^\/api\/boxes\/[^/]+(\/ports)?$/.test(path));
        expect(requests.some((path) => path.includes("/api/boxes/") && path.endsWith("/ports"))).toBe(false);
        expect(requests.some((path) => path.includes("/files"))).toBe(false);
        expect(sent.every((path) => /^\/api\/boxes\/[^/]+$/.test(path))).toBe(true);

        // The error strip an unsupported call would have drawn is not there either.
        await webExpect(page.locator("#tabBody .empty-icon")).toHaveCount(1);
        await webExpect(page.locator("#toasts .toast.error")).toHaveCount(0);
      } finally {
        await context.close();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "the checkpoint button in the head is disabled and says why, and the settings card says the same",
    async () => {
      const context = await signedIn();
      try {
        const page = await context.newPage();
        const requests = watch(page);
        await page.route("**/api/hosts", hostsAs([{ id: "edge", name: "Edge lab", transport: "agent" }]));
        await page.route("**/api/boxes/*", async (route) => {
          const request = route.request();
          if (request.method() !== "GET" || new URL(request.url()).pathname.endsWith("/stats")) return route.fallback();
          const response = await route.fetch();
          const body = (await response.json()) as { box: Record<string, unknown> };
          await route.fulfill({ response, json: { ...body, box: { ...body.box, hostId: "edge" } } });
        });

        await page.goto(boxUrl(base, box, "overview"));
        const checkpoint = page.locator(".detail-head [data-action='checkpoint']");
        await webExpect(checkpoint).toBeDisabled();
        await webExpect(checkpoint).toHaveAttribute("title", english("bd.agentCheckpoints"));
        await webExpect(checkpoint).toHaveAttribute("title", /agent host cannot take checkpoints/);

        await page.goto(boxUrl(base, box, "settings/checkpoints"));
        const panel = page.locator("#bsPanel");
        await webExpect(panel.locator("[data-action='ck-take']")).toBeDisabled();
        await webExpect(panel.locator("[data-action='ck-take']")).toHaveAttribute(
          "title",
          english("bd.agentCheckpoints"),
        );
        await webExpect(panel.locator(".callout.warn")).toContainText(english("bd.agentCheckpoints"));

        // The take is never attempted: no checkpoint request is sent, so no 501 comes back as a toast.
        expect(requests.filter((path) => path.endsWith("/checkpoints") && path.startsWith("/api/boxes/"))).toEqual([]);
        await webExpect(page.locator("#toasts .toast.error")).toHaveCount(0);
      } finally {
        await context.close();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "the same entries come back once the host is not an agent",
    async () => {
      const context = await signedIn();
      try {
        const page = await context.newPage();
        const requests = watch(page);
        await page.route("**/api/hosts", hostsAs([{ id: "edge", name: "Edge lab", transport: "unix" }]));
        await page.route("**/api/boxes/*", async (route) => {
          const request = route.request();
          if (request.method() !== "GET" || new URL(request.url()).pathname.endsWith("/stats")) return route.fallback();
          const response = await route.fetch();
          const body = (await response.json()) as { box: Record<string, unknown> };
          await route.fulfill({ response, json: { ...body, box: { ...body.box, hostId: "edge" } } });
        });

        await page.goto(boxUrl(base, box, "overview"));
        const checkpoint = page.locator(".detail-head [data-action='checkpoint']");
        await webExpect(checkpoint).toBeEnabled();
        await webExpect(checkpoint).not.toHaveAttribute("title", english("bd.agentCheckpoints"));

        // The Files tab asks for its listing again, which a host with an engine answers.
        await page.goto(boxUrl(base, box, "files"));
        await webExpect(page.locator("#tabBody .fb")).toHaveCount(1);
        await webExpect(page.locator("#tabBody")).not.toContainText(english("bd.agentFilesTitle"));
        await webExpect.poll(() => requests.some((path) => path.includes("/files"))).toBe(true);

        await page.goto(boxUrl(base, box, "ports"));
        await webExpect(page.locator("#tabBody")).not.toContainText(english("bd.agentPortsTitle"));
        await webExpect.poll(() => requests.some((path) => path.endsWith("/ports"))).toBe(true);

        await page.goto(boxUrl(base, box, "settings/checkpoints"));
        await webExpect(page.locator("#bsPanel [data-action='ck-take']")).toBeEnabled();
        await webExpect(page.locator("#bsPanel .callout.warn")).toHaveCount(0);
      } finally {
        await context.close();
      }
    },
    TIMEOUT_MS,
  );
});
