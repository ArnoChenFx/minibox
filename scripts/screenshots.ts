/**
 * Captures the console screenshots that the README, the project homepage and the docs use.
 *
 *   bun run screenshots
 *
 * Starts a throwaway MiniBox server with its own data directory, a free port, the label prefix `minibox-demo` and the
 * network `minibox-demo-boxes`, seeds it with fixed demo content, and captures each screen in light and dark, en and
 * zh-CN into dist/screenshots. The published subset is copied to docs/screenshots. The run then removes the containers,
 * template and snapshot images, volumes and network it created, and its data directory.
 *
 * Not run in CI. Needs a Docker engine at DOCKER_SOCKET (default /var/run/docker.sock) and a Chromium: run
 * `bunx playwright install chromium` once, or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to an installed Chrome.
 */
import { randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser, type Locator, type Page } from "@playwright/test";

const ROOT = join(import.meta.dir, "..");
const CAPTURE_DIR = join(ROOT, "dist", "screenshots");
const PUBLISH_DIR = join(ROOT, "docs", "screenshots");
const PREFIX = "minibox-demo";
const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const DEMO_HOSTNAME = "workstation";
const TIME_ZONE = "Asia/Shanghai";
const VIEWPORT = { width: 1440, height: 900 };
const SESSION = "main";
const NOTIFY_CHANNEL = "ops-webhook";

const LANGUAGES = [
  { code: "en", locale: "en-US" },
  { code: "zh-CN", locale: "zh-CN" },
] as const;
const THEMES = ["light", "dark"] as const;

const SCREENS = [
  "overview",
  "boxes",
  "box-terminal",
  "box-activity",
  "box-checkpoints",
  "box-files",
  "volumes",
  "templates",
  "tools",
  "settings-hosts",
  "settings-tokens",
  "settings-secrets",
  "settings-notifications",
  "create-box",
] as const;
type Screen = (typeof SCREENS)[number];

/** The captures copied to docs/screenshots, in both themes and both languages. */
const PUBLISHED: readonly Screen[] = ["overview", "boxes", "box-terminal"];

type Json = Record<string, unknown>;
type Api = <T = Json>(method: string, path: string, body?: unknown) => Promise<T>;

interface Demo {
  api: string;
  web: string;
  sync: string;
}

interface Context {
  base: string;
  demo: Demo;
}

const API_FILES: Record<string, string> = {
  "/workspace/api/package.json": [
    "{",
    '  "name": "api",',
    '  "version": "0.4.0",',
    '  "private": true,',
    '  "type": "module",',
    '  "scripts": {',
    '    "start": "node src/server.mjs",',
    '    "test": "node --test"',
    "  }",
    "}",
    "",
  ].join("\n"),
  "/workspace/api/README.md": "# api\n\nJSON API that the web preview calls.\n",
  "/workspace/api/.gitignore": "node_modules/\n.env\n",
  "/workspace/api/src/server.mjs": [
    'import { createServer } from "node:http";',
    'import { health } from "./routes/health.mjs";',
    "",
    "const port = Number(process.env.PORT ?? 3000);",
    "",
    "createServer((req, res) => {",
    '  if (req.url === "/health") return health(req, res);',
    "  res.writeHead(404).end();",
    '}).listen(port, () => console.log("api listening on " + port));',
    "",
  ].join("\n"),
  "/workspace/api/src/routes/health.mjs": [
    "export function health(_req, res) {",
    '  res.writeHead(200, { "content-type": "application/json" });',
    "  res.end(JSON.stringify({ ok: true }));",
    "}",
    "",
  ].join("\n"),
  "/workspace/api/test/health.test.mjs": [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { health } from "../src/routes/health.mjs";',
    "",
    'test("health answers ok", () => {',
    '  let body = "";',
    "  health({}, { writeHead() {}, end(text) { body = text; } });",
    "  assert.deepEqual(JSON.parse(body), { ok: true });",
    "});",
    "",
  ].join("\n"),
};

/** Uncommitted work in progress, written after the baseline checkpoint. */
const API_CHANGES: Record<string, string> = {
  "/workspace/api/src/routes/health.mjs": [
    "export function health(_req, res) {",
    '  res.writeHead(200, { "content-type": "application/json" });',
    '  res.end(JSON.stringify({ ok: true, version: "0.4.0" }));',
    "}",
    "",
  ].join("\n"),
  "/workspace/api/src/routes/metrics.mjs": [
    "export function metrics(_req, res) {",
    "  const { rss, heapUsed } = process.memoryUsage();",
    '  res.writeHead(200, { "content-type": "application/json" });',
    "  res.end(JSON.stringify({ rss, heapUsed }));",
    "}",
    "",
  ].join("\n"),
  "/workspace/api/test/health.test.mjs": [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { health } from "../src/routes/health.mjs";',
    "",
    'test("health answers ok", () => {',
    '  let body = "";',
    "  health({}, { writeHead() {}, end(text) { body = text; } });",
    '  assert.deepEqual(JSON.parse(body), { ok: true, version: "0.4.0" });',
    "});",
    "",
  ].join("\n"),
};

const WEB_FILES: Record<string, string> = {
  "/workspace/web/index.html": [
    "<!doctype html>",
    '<html lang="en">',
    '  <head><meta charset="utf-8" /><title>Preview</title></head>',
    "  <body><h1>Preview</h1><p>Hello from a MiniBox preview.</p></body>",
    "</html>",
    "",
  ].join("\n"),
};

const PYTHON_LAB_DOCKERFILE = [
  "FROM python:3.13-slim-bookworm",
  "RUN useradd --create-home --uid 1000 dev && mkdir -p /workspace && chown dev:dev /workspace",
  "ENV PYTHONUNBUFFERED=1",
  "WORKDIR /workspace",
  "",
].join("\n");

const lines = (text: string) => text.split("\n").filter((line) => line.length > 0);

async function docker(args: string[]): Promise<string> {
  const proc = Bun.spawn(["docker", "-H", `unix://${SOCKET}`, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`docker ${args.join(" ")} failed: ${err.trim()}`);
  return out;
}

/** The resources this run can have created: labelled with the prefix, or named with it. */
async function ownResources() {
  const byLabel = async (command: string[], labels: string[]) =>
    (await Promise.all(labels.map((label) => docker([...command, "--filter", `label=${label}`, "-q"])))).flatMap(lines);
  const namedWithPrefix = (table: string, column: number) =>
    lines(table)
      .map((line) => line.split("\t"))
      .filter((cells) => (cells[column] ?? "").startsWith(`${PREFIX}-`))
      .map((cells) => cells[0] ?? "");

  const containers = [
    ...(await byLabel(["ps", "-a"], [PREFIX])),
    ...namedWithPrefix(await docker(["ps", "-a", "--format", "{{.ID}}\t{{.Names}}"]), 1),
  ];
  const images = [
    ...(await byLabel(["images"], [`${PREFIX}.template`, `${PREFIX}.snapshot`, PREFIX])),
    ...namedWithPrefix(await docker(["images", "--format", "{{.ID}}\t{{.Repository}}"]), 1),
  ];
  const volumes = [
    ...(await byLabel(["volume", "ls"], [`${PREFIX}.volume`, `${PREFIX}.checkpoint`, `${PREFIX}.internal`])),
    ...lines(await docker(["volume", "ls", "--format", "{{.Name}}"])).filter((name) => name.startsWith(`${PREFIX}-`)),
  ];
  const networks = lines(await docker(["network", "ls", "--format", "{{.Name}}"])).filter((name) =>
    name.startsWith(`${PREFIX}-`),
  );
  return {
    containers: [...new Set(containers)],
    images: [...new Set(images)],
    volumes: [...new Set(volumes)],
    networks: [...new Set(networks)],
  };
}

/** Removes what this run made. Containers go first, so that images and volumes are no longer in use. */
async function sweep(): Promise<void> {
  const found = await ownResources();
  if (found.containers.length > 0) await docker(["rm", "-f", ...found.containers]);
  if (found.images.length > 0) await docker(["rmi", "-f", ...found.images]);
  if (found.volumes.length > 0) await docker(["volume", "rm", ...found.volumes]);
  for (const network of found.networks) await docker(["network", "rm", network]);

  const left = await ownResources();
  const remaining = [...left.containers, ...left.images, ...left.volumes, ...left.networks];
  if (remaining.length > 0) throw new Error(`demo resources are still present: ${remaining.join(" ")}`);
  console.log(
    `[screenshots] removed ${found.containers.length} containers, ${found.images.length} images, ${found.volumes.length} volumes and ${found.networks.length} networks`,
  );
}

function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("could not find a free port");
  return port;
}

function apiClient(base: string, key: string): Api {
  return async <T = Json>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}: ${text.slice(0, 500)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  };
}

async function waitForServer(base: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const healthy = await fetch(`${base}/api/health`).then(
      (response) => response.ok,
      () => false,
    );
    if (healthy) return;
    await Bun.sleep(300);
  }
  throw new Error("the demo server did not become healthy");
}

async function waitForTask(api: Api, taskId: string): Promise<void> {
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    const task = await api<{ status: string; error?: unknown }>("GET", `/api/tasks/${taskId}`);
    if (task.status === "succeeded") return;
    if (task.status !== "running") {
      throw new Error(`task ${taskId} ended as ${task.status}: ${JSON.stringify(task.error ?? null)}`);
    }
    await Bun.sleep(1000);
  }
  throw new Error(`task ${taskId} did not finish in time`);
}

async function runTask(api: Api, path: string, body?: unknown): Promise<void> {
  const { taskId } = await api<{ taskId: string }>("POST", path, body);
  await waitForTask(api, taskId);
}

async function exec(api: Api, box: string, argv: string[], stdin?: string): Promise<void> {
  const result = await api<{ exitCode: number | null; stderr: string }>("POST", `/api/boxes/${box}/exec`, {
    argv,
    ...(stdin === undefined ? {} : { stdin }),
  });
  if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} exited ${result.exitCode}: ${result.stderr.trim()}`);
}

async function writeFiles(api: Api, box: string, files: Record<string, string>): Promise<void> {
  for (const [path, contents] of Object.entries(files)) {
    await exec(api, box, ["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", path], contents);
  }
}

async function typeIntoSession(api: Api, box: string, text: string, settleMs: number): Promise<void> {
  await api("POST", `/api/boxes/${box}/sessions/${SESSION}/input`, { text: `${text}\n` });
  await Bun.sleep(settleMs);
}

async function createBox(api: Api, body: Json): Promise<string> {
  const { box } = await api<{ box: { id: string } }>("POST", "/api/boxes", body);
  return box.id;
}

/** Fixed demo content: three boxes, secrets, tokens, a volume, templates, checkpoints, a schedule and a terminal. */
async function seed(api: Api, receiverUrl: string): Promise<Demo> {
  console.log("[screenshots] building the base template; the first build takes a few minutes");
  await runTask(api, "/api/templates/base/build");

  await api("PUT", "/api/secrets/OPENAI_API_KEY", { value: "sk-demo-not-a-real-key" });
  await api("PUT", "/api/secrets/GITHUB_TOKEN", { value: "ghp_demo_not_a_real_token" });
  await api("POST", "/api/volumes", { name: "datasets", pool: "local", confirm: true });

  const apiBox = await createBox(api, {
    name: "api-service",
    cpus: 1,
    memoryMb: 2048,
    profile: "standard",
    env: [
      { name: "NODE_ENV", value: "development" },
      { name: "OPENAI_API_KEY", secretRef: "OPENAI_API_KEY" },
    ],
  });
  const web = await createBox(api, { name: "web-preview", cpus: 1, memoryMb: 1024, profile: "standard" });
  const sync = await createBox(api, { name: "data-sync", cpus: 1, memoryMb: 1024, profile: "standard" });
  await api("POST", `/api/boxes/${sync}/stop`);

  await writeFiles(api, apiBox, API_FILES);
  await exec(api, apiBox, [
    "sh",
    "-c",
    'cd /workspace/api && git init -q -b main && git add -A && git -c user.name=dev -c user.email=dev@api-service.local commit -qm "Scaffold the API"',
  ]);
  await runTask(api, `/api/boxes/${apiBox}/checkpoints`, { label: "baseline", pinned: true });

  await writeFiles(api, apiBox, API_CHANGES);
  await runTask(api, `/api/boxes/${apiBox}/checkpoints`, { label: "metrics-wip" });
  await writeFiles(api, web, WEB_FILES);

  await api("POST", `/api/boxes/${apiBox}/sessions`, { name: SESSION });
  await typeIntoSession(api, apiBox, "export PS1='dev@api-service:\\w\\$ '; clear", 800);
  await typeIntoSession(api, apiBox, "cd /workspace/api", 300);
  await typeIntoSession(api, apiBox, "git status --short", 800);
  await typeIntoSession(api, apiBox, "npm test", 4000);

  await api("PUT", `/api/boxes/${apiBox}/checkpoint-schedule`, { at: "02:30", timezone: TIME_ZONE });

  for (const [name, preset] of [
    ["review-agent", "sandboxed-agent"],
    ["codex-nightly", "operator"],
    ["dashboard-readonly", "readonly"],
  ]) {
    await api("POST", "/api/tokens", { name, preset });
  }

  await seedNotifications(api, receiverUrl);

  await runTask(api, "/api/templates", {
    name: "python-lab",
    description: "Debian 12 · Python 3.13",
    source: { kind: "dockerfile", text: PYTHON_LAB_DOCKERFILE },
  });
  await runTask(api, `/api/boxes/${web}/template`, { name: "node-api", description: "Node.js 26 API starter" });

  return { api: apiBox, web, sync };
}

/** Two channels, and one successful test send so the deliveries list has a row. The receiver is local to this run. */
async function seedNotifications(api: Api, receiverUrl: string): Promise<void> {
  await api("PUT", `/api/notify/channels/${NOTIFY_CHANNEL}`, {
    id: NOTIFY_CHANNEL,
    type: "webhook",
    name: "Ops webhook",
    enabled: true,
    events: ["box.oom", "exec.failed", "checkpoint.failed", "host.offline"],
    url: receiverUrl,
  });
  await api("PUT", "/api/notify/channels/phone-ntfy", {
    id: "phone-ntfy",
    type: "ntfy",
    name: "Phone",
    enabled: true,
    events: ["box.oom", "host.offline"],
    topic: "minibox-demo-alerts",
  });
  const test = await api<{ ok: boolean; error: string | null }>("POST", `/api/notify/channels/${NOTIFY_CHANNEL}/test`);
  if (!test.ok) throw new Error(`the test notification failed: ${test.error ?? "unknown error"}`);
}

/** A local webhook receiver that accepts every notice. The demo server may post to it because NOTIFY_ALLOW_PRIVATE is set. */
function startReceiver(): { url: string; stop: () => void } {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 204 }) });
  if (server.port === undefined) throw new Error("the notification receiver has no port");
  return { url: `http://127.0.0.1:${server.port}/hook`, stop: () => server.stop(true) };
}

function startServer(dataDir: string, port: number, key: string, version: string, logPath: string) {
  const log = openSync(logPath, "w");
  const proc = Bun.spawn([process.execPath, join(ROOT, "src", "server.ts")], {
    cwd: dataDir,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? dataDir,
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      LANG: "C.UTF-8",
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      ACCESS_KEY: key,
      LABEL_PREFIX: PREFIX,
      DOCKER_SOCKET: SOCKET,
      BOX_IDLE_TIMEOUT_SEC: "0",
      LOG_LEVEL: "info",
      NOTIFY_ALLOW_PRIVATE: "1",
      MINIBOX_VERSION: version,
    },
    stdout: log,
    stderr: log,
  });
  return { proc, closeLog: () => closeSync(log) };
}

async function stopServer(proc: { kill(signal?: number): void; exited: Promise<number> }): Promise<void> {
  proc.kill(15);
  const exitedInTime = await Promise.race([proc.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
  if (!exitedInTime) proc.kill(9);
  await proc.exited;
}

async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox"],
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(
      `could not start Chromium (${reason}). Run "bunx playwright install chromium" or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.`,
      { cause: error },
    );
  }
}

const exactText = (page: Page, value: string): Locator => page.getByText(value, { exact: true }).first();

async function openRoute(page: Page, ctx: Context, route: string, ready: Locator): Promise<void> {
  await page.goto(`${ctx.base}/#${route}`);
  await ready.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(800);
}

type Capture = (page: Page, ctx: Context, out: string) => Promise<void>;

const CAPTURES: Record<Screen, Capture> = {
  overview: async (page, ctx, out) => {
    await openRoute(page, ctx, "/overview", exactText(page, "web-preview"));
    await page.waitForTimeout(1500);
    await page.screenshot({ path: out });
  },
  boxes: async (page, ctx, out) => {
    await openRoute(page, ctx, "/boxes", exactText(page, "data-sync"));
    await page.screenshot({ path: out });
  },
  "box-terminal": async (page, ctx, out) => {
    await openRoute(page, ctx, `/boxes/${ctx.demo.api}/terminal`, page.locator("#tSessions .session-chip").first());
    await page.waitForTimeout(2500);
    await page.screenshot({ path: out });
  },
  "box-activity": async (page, ctx, out) => {
    await openRoute(page, ctx, `/boxes/${ctx.demo.api}/activity`, page.locator(".tabs"));
    await page.waitForTimeout(1000);
    await page.screenshot({ path: out });
  },
  "box-checkpoints": async (page, ctx, out) => {
    await openRoute(page, ctx, `/boxes/${ctx.demo.api}/checkpoints`, exactText(page, "baseline"));
    await page.screenshot({ path: out });
  },
  "box-files": async (page, ctx, out) => {
    await openRoute(page, ctx, `/boxes/${ctx.demo.api}/files`, exactText(page, "api"));
    await exactText(page, "api").click();
    await exactText(page, "package.json").waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: out });
  },
  volumes: async (page, ctx, out) => {
    await openRoute(page, ctx, "/volumes", exactText(page, "datasets"));
    await page.screenshot({ path: out });
  },
  templates: async (page, ctx, out) => {
    await openRoute(page, ctx, "/templates", exactText(page, "node-api"));
    await page.screenshot({ path: out });
  },
  tools: async (page, ctx, out) => {
    await openRoute(page, ctx, `/boxes/${ctx.demo.api}/tools`, exactText(page, "Claude Code"));
    await page.screenshot({ path: out });
  },
  "settings-hosts": async (page, ctx, out) => {
    await openRoute(page, ctx, "/settings", page.locator("#stHosts"));
    await page.locator("#stHosts").screenshot({ path: out });
  },
  "settings-tokens": async (page, ctx, out) => {
    await openRoute(page, ctx, "/settings", exactText(page, "review-agent"));
    await page.locator("#stTokens").screenshot({ path: out });
  },
  "settings-secrets": async (page, ctx, out) => {
    await openRoute(page, ctx, "/settings", exactText(page, "OPENAI_API_KEY"));
    await page.locator("#stSecrets").screenshot({ path: out });
  },
  "settings-notifications": async (page, ctx, out) => {
    await openRoute(page, ctx, "/settings", exactText(page, "Ops webhook"));
    await page.locator("#stNotify").screenshot({ path: out });
  },
  "create-box": async (page, ctx, out) => {
    await openRoute(page, ctx, "/boxes", exactText(page, "data-sync"));
    await page.locator('[data-action="create"]').first().click();
    await page.locator("#cbName").fill("research-agent");
    await page.waitForTimeout(500);
    await page.screenshot({ path: out });
  },
};

/**
 * Runs in each page before the console loads: the language and the theme, and the host name. The REST reply is renamed by
 * a route; the live stream is renamed here, because its `host` frames carry the name too.
 */
function pageScript(language: string, theme: string): string {
  const from = JSON.stringify(`"hostname":${JSON.stringify(hostname())}`);
  const to = JSON.stringify(`"hostname":${JSON.stringify(DEMO_HOSTNAME)}`);
  return `
    localStorage.setItem("minibox.lang", ${JSON.stringify(language)});
    localStorage.setItem("minibox.theme", ${JSON.stringify(theme)});
    const addEventListener = EventSource.prototype.addEventListener;
    EventSource.prototype.addEventListener = function (type, listener, options) {
      if (type !== "host") return addEventListener.call(this, type, listener, options);
      const renamed = (message) => listener({ data: message.data.split(${from}).join(${to}) });
      return addEventListener.call(this, type, renamed, options);
    };
  `;
}

async function captureAll(base: string, key: string, demo: Demo): Promise<void> {
  const browser = await launchBrowser();
  const errors: string[] = [];
  try {
    for (const language of LANGUAGES) {
      const dir = join(CAPTURE_DIR, language.code);
      await mkdir(dir, { recursive: true });
      for (const theme of THEMES) {
        const context = await browser.newContext({
          viewport: VIEWPORT,
          deviceScaleFactor: 2,
          locale: language.locale,
          timezoneId: TIME_ZONE,
          colorScheme: theme,
        });
        await context.addInitScript({ content: pageScript(language.code, theme) });
        await context.route(/\/api\/host\/metrics(\?.*)?$/, async (route) => {
          const response = await route.fetch();
          const body = (await response.json()) as Json;
          await route.fulfill({ response, json: { ...body, hostname: DEMO_HOSTNAME } });
        });
        const login = await context.request.post(`${base}/api/auth/login`, { data: { key } });
        if (!login.ok()) throw new Error(`login failed with ${login.status()}`);

        for (const screen of SCREENS) {
          const page = await context.newPage();
          page.on("pageerror", (error) => errors.push(`${language.code} ${theme} ${screen}: ${error.message}`));
          await CAPTURES[screen](page, { base, demo }, join(dir, `${screen}-${theme}.png`));
          await page.close();
          console.log(`[screenshots] ${language.code} ${theme} ${screen}`);
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  if (errors.length > 0) throw new Error(`the console raised errors:\n${errors.join("\n")}`);
}

async function publish(): Promise<void> {
  await rm(PUBLISH_DIR, { recursive: true, force: true });
  for (const language of LANGUAGES) {
    const target = join(PUBLISH_DIR, language.code);
    await mkdir(target, { recursive: true });
    for (const screen of PUBLISHED) {
      for (const theme of THEMES) {
        const file = `${screen}-${theme}.png`;
        await cp(join(CAPTURE_DIR, language.code, file), join(target, file));
      }
    }
  }
  console.log(`[screenshots] published ${PUBLISHED.join(", ")} to docs/screenshots`);
}

async function main(): Promise<void> {
  await rm(CAPTURE_DIR, { recursive: true, force: true });
  await mkdir(CAPTURE_DIR, { recursive: true });
  await sweep();

  const { version } = (await Bun.file(join(ROOT, "package.json")).json()) as { version: string };
  const dataDir = await mkdtemp(join(tmpdir(), "minibox-screenshots-"));
  const key = randomBytes(24).toString("base64url");
  const port = freePort();
  const base = `http://127.0.0.1:${port}`;
  const receiver = startReceiver();
  const server = startServer(dataDir, port, key, version, join(CAPTURE_DIR, "server.log"));
  try {
    await waitForServer(base);
    const demo = await seed(apiClient(base, key), receiver.url);
    await captureAll(base, key, demo);
    await publish();
  } finally {
    await stopServer(server.proc);
    server.closeLog();
    receiver.stop();
    try {
      await sweep();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(`[screenshots] ${error instanceof Error ? error.message : String(error)}`);
  console.error(`[screenshots] server log: ${join(CAPTURE_DIR, "server.log")}`);
  process.exitCode = 1;
}
