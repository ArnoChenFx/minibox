/**
 * Declared templates, repository clones and image pulls on a real engine. A template is built from a pasted Dockerfile,
 * from a Git branch (a nested Dockerfile, rebuilt after a new commit, and kept when a rebuild fails), and from a
 * devcontainer.json whose containerEnv value stays literal. An image that is missing is pulled as a task. A box created
 * with a repository clones it into /workspace, from a public repository and from a private one whose token comes from
 * the secret store.
 *
 *   bun run test:docker
 *
 * The repositories are served by this file over HTTPS, on the Docker bridge gateway. The base image the clone runs in
 * trusts the file's self-signed certificate, so the only traffic that leaves the machine is the image pull, which needs
 * the registry. To run this file directly: MINIBOX_TEST_DOCKER=1 MINIBOX_TEST_PREFIX=mbit<id> bun test
 * tests/docker-declared-templates.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Docker from "dockerode";

import { type App, createApp } from "../src/app";
import { createDockerRuntime } from "../src/docker/runtime";
import type { HostCtx } from "../src/host/registry";
import type { Runtime } from "../src/runtime";
import { startServer } from "../src/server";
import * as boxes from "../src/services/boxes";
import { deleteTemplate } from "../src/services/templates";
import { silenceLogs, testConfig } from "./support/app";
import { call, finishedTask } from "./support/tokens";

const enabled = process.env.MINIBOX_TEST_DOCKER === "1";
const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const IMAGE = process.env.MINIBOX_TEST_IMAGE ?? "alpine:3.20";
const PREFIX_PATTERN = /^mbit[a-z0-9-]{3,40}$/;
const prefix = process.env.MINIBOX_TEST_PREFIX ?? `mbit${Date.now().toString(36)}`;
if (enabled && !PREFIX_PATTERN.test(prefix)) throw new Error(`MINIBOX_TEST_PREFIX must match ${PREFIX_PATTERN}`);
const GIT_BASE = `${prefix}-git-base:latest`;
const PULL_IMAGE = "hello-world:latest";
const PRIVATE_TOKEN = `mbtok${randomBytes(12).toString("hex")}`;
const LONG = 180_000;
const SETUP = 300_000;
const runtime: Runtime = createDockerRuntime(SOCKET);
const docker = new Docker({ socketPath: SOCKET });

const BASE_DOCKERFILE = `FROM ${IMAGE}
RUN apk add --no-cache git ca-certificates
COPY minibox-test-ca.crt /usr/local/share/ca-certificates/minibox-test-ca.crt
RUN update-ca-certificates
`;

const DEVCONTAINER = `{
  "name": "literal",
  "image": "${IMAGE}",
  "containerEnv": { "MB_LITERAL": "$HOME and \\\\ backslash" }
}
`;

const dockerfileFor = (marker: string) => `FROM ${IMAGE}\nRUN echo ${marker} > /marker\n`;
const refOf = (name: string) => `${prefix}-template:${name}`;

let scratch = "";
let repoRoot = "";
let work = "";
let gitBase = "";
let gitServer: { port: number; stop(closeActiveConnections?: boolean): void } | undefined;
let restoreLogs: () => void = () => {};
let app: App;
let host: HostCtx;
let server: ReturnType<typeof startServer>;
let base = "";
const madeBoxes: string[] = [];
const madeTemplates: string[] = [];

/** Runs a shell snippet in a container as `user` and returns what it printed, trimmed. */
async function run(containerId: string, user: string, script: string): Promise<string> {
  const session = await runtime.startExec(containerId, {
    cmd: ["sh", "-c", `${script}; echo MB_DONE`],
    env: [],
    workingDir: "/",
    user,
    tty: false,
  });
  session.stderr.resume();
  let text = "";
  session.stdout.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  try {
    const deadline = Date.now() + 60_000;
    while (!text.includes("MB_DONE")) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${script}`);
      await Bun.sleep(100);
    }
  } finally {
    session.stream.destroy();
  }
  return text.slice(0, text.indexOf("MB_DONE")).trim();
}

/** Creates a box over REST, optionally with a repository, and remembers it for cleanup. */
async function makeBox(
  name: string,
  template = IMAGE,
  repo?: Record<string, string>,
): Promise<{ boxId: string; containerId: string; cloneTask: string | undefined }> {
  const made = await call(base, "/api/boxes", {
    body: { name, template, cpus: 1, memoryMb: 256, ...(repo ? { repo } : {}) },
  });
  if (made.status !== 201) throw new Error(`create ${name}: ${made.status} ${JSON.stringify(made.json)}`);
  const boxId = made.json.box?.boxId ?? "";
  madeBoxes.push(boxId);
  return { boxId, containerId: (await boxes.getBox(host, boxId)).id, cloneTask: made.json.clone?.taskId };
}

/** Starts a template build over REST and waits for it to finish. */
async function buildTemplate(name: string, source: Record<string, unknown>) {
  madeTemplates.push(refOf(name));
  const started = await call(base, "/api/templates", { body: { name, source } });
  expect(started.status).toBe(202);
  return finishedTask(base, started.json.taskId ?? "");
}

async function rebuildTemplate(name: string) {
  const started = await call(base, `/api/templates/${encodeURIComponent(refOf(name))}/rebuild`, { method: "POST" });
  expect(started.status).toBe(202);
  return finishedTask(base, started.json.taskId ?? "");
}

async function imagePresent(ref: string): Promise<boolean> {
  return docker
    .getImage(ref)
    .inspect()
    .then(
      () => true,
      () => false,
    );
}

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=minibox-test", "-c", "user.email=test@minibox.invalid", ...args], {
    cwd,
    env: GIT_ENV,
    stdio: "ignore",
  });
}

function commitFiles(files: Record<string, string>, message: string): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), text);
  }
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", message);
}

/** Adds a commit to the feature branch of the app repository, as a push would. */
function advanceFeature(message: string, dockerfile: string): void {
  git(work, "checkout", "-q", "feature");
  commitFiles({ "services/api/Dockerfile": dockerfile }, message);
  git(work, "push", "-q", join(repoRoot, "app.git"), "feature");
  git(work, "checkout", "-q", "main");
}

function seedRepositories(): void {
  work = join(scratch, "work");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  commitFiles({ "README.md": "# app\n", "services/api/Dockerfile": dockerfileFor("from-main") }, "main");
  git(work, "checkout", "-q", "-b", "feature");
  commitFiles({ "services/api/Dockerfile": dockerfileFor("from-feature") }, "feature");
  git(work, "checkout", "-q", "main");
  git(work, "checkout", "-q", "-b", "devcontainer");
  commitFiles({ ".devcontainer/devcontainer.json": DEVCONTAINER }, "devcontainer");
  git(work, "checkout", "-q", "main");
  for (const name of ["app.git", "private.git"]) git(work, "init", "-q", "--bare", "-b", "main", join(repoRoot, name));
  git(work, "push", "-q", join(repoRoot, "app.git"), "main", "feature", "devcontainer");
  git(work, "push", "-q", join(repoRoot, "private.git"), "main");
}

async function gatewayAddress(): Promise<string> {
  const info = (await docker.getNetwork("bridge").inspect()) as unknown as {
    IPAM?: { Config?: { Gateway?: string }[] };
  };
  const gateway = info.IPAM?.Config?.[0]?.Gateway;
  if (!gateway) throw new Error("the default bridge network has no gateway address");
  return gateway;
}

function makeCertificate(dir: string, ip: string): void {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-days",
      "2",
      "-subj",
      "/CN=minibox-test",
      "-addext",
      `subjectAltName=IP:${ip}`,
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ],
    { stdio: "ignore" },
  );
}

/** A repository is served through git's own HTTP backend, which speaks the smart protocol a shallow clone needs. */
async function runBackend(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const body = new Uint8Array(await req.arrayBuffer());
  const proc = Bun.spawn(["git", "http-backend"], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: scratch,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_PROJECT_ROOT: repoRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      GIT_PROTOCOL: req.headers.get("git-protocol") ?? "",
      HTTP_CONTENT_ENCODING: req.headers.get("content-encoding") ?? "",
      REQUEST_METHOD: req.method,
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers.get("content-type") ?? "",
      CONTENT_LENGTH: String(body.byteLength),
    },
    stdin: body,
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = Buffer.from(await new Response(proc.stdout).arrayBuffer());
  await proc.exited;
  return cgiResponse(out);
}

/** Turns the CGI output of git http-backend (headers, a blank line, then the body) into a response. */
function cgiResponse(out: Buffer): Response {
  const crlf = out.indexOf("\r\n\r\n");
  const lf = out.indexOf("\n\n");
  const useCrlf = crlf !== -1 && (lf === -1 || crlf < lf);
  const end = useCrlf ? crlf : lf;
  if (end < 0) return new Response("malformed CGI output\n", { status: 500 });
  let status = 200;
  const headers = new Headers();
  for (const line of out.subarray(0, end).toString("utf8").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
    else headers.append(name, value);
  }
  return new Response(out.subarray(end + (useCrlf ? 4 : 2)), { status, headers });
}

const AUTH = `Basic ${Buffer.from(`x-access-token:${PRIVATE_TOKEN}`).toString("base64")}`;

/** The private repository asks for the token the way GitHub does, and refuses any other credential. */
function serveGit(req: Request): Promise<Response> | Response {
  const path = new URL(req.url).pathname;
  if (path.startsWith("/private.git/") && req.headers.get("authorization") !== AUTH) {
    return new Response("authentication required\n", {
      status: 401,
      headers: { "www-authenticate": 'Basic realm="minibox test"' },
    });
  }
  return runBackend(req);
}

beforeAll(async () => {
  if (!enabled) return;
  restoreLogs = silenceLogs();
  scratch = mkdtempSync(join(tmpdir(), "mb-declared-"));
  repoRoot = join(scratch, "repos");
  mkdirSync(repoRoot);
  const gateway = await gatewayAddress();
  makeCertificate(scratch, gateway);
  gitServer = Bun.serve({
    hostname: gateway,
    port: 0,
    tls: { cert: readFileSync(join(scratch, "cert.pem")), key: readFileSync(join(scratch, "key.pem")) },
    fetch: serveGit,
  });
  gitBase = `https://${gateway}:${gitServer.port}`;
  seedRepositories();

  const context = join(scratch, "base");
  mkdirSync(context);
  writeFileSync(join(context, "Dockerfile"), BASE_DOCKERFILE);
  copyFileSync(join(scratch, "cert.pem"), join(context, "minibox-test-ca.crt"));
  await runtime.buildImage({
    contextDir: context,
    dockerfile: "Dockerfile",
    src: ["Dockerfile", "minibox-test-ca.crt"],
    tag: GIT_BASE,
    labels: { [prefix]: "true" },
  });

  app = createApp(testConfig({ labelPrefix: prefix, dockerSocket: SOCKET, baseTemplateTag: GIT_BASE }), "0.0.0-test", {
    runtime,
    eventsPath: ":memory:",
  });
  host = app.hosts.get();
  server = startServer(app);
  base = `http://127.0.0.1:${server.port}`;
}, SETUP);

afterAll(async () => {
  if (!enabled) return;
  server?.stop(true);
  gitServer?.stop(true);
  app?.throttle.stop();
  app?.sessions.stop();
  app?.tokens.stop();
  app?.events.close();
  for (const boxId of madeBoxes) await boxes.deleteBox(host, boxId, true).catch(() => {});
  for (const ref of madeTemplates) await deleteTemplate(host, ref).catch(() => {});
  await docker
    .getImage(GIT_BASE)
    .remove({ force: true })
    .catch(() => {});
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  restoreLogs();
}, SETUP);

describe.skipIf(!enabled)("Declared templates, repository clones and image pulls on a real engine", () => {
  test(
    "a template built from a pasted Dockerfile is a template, and a box made from it has the file",
    async () => {
      const view = await buildTemplate("pasted", {
        kind: "dockerfile",
        text: `FROM ${IMAGE}\nRUN echo pasted > /marker\n`,
      });
      expect(view).toMatchObject({
        status: "succeeded",
        result: { template: { ref: refOf("pasted"), name: "pasted" } },
      });
      const image = await runtime.inspectImage(refOf("pasted"));
      expect(image.labels).toMatchObject({ [host.keys.template]: "true", [host.keys.templateName]: "pasted" });

      const made = await makeBox("pasted-box", refOf("pasted"));
      expect(await run(made.containerId, "root", "cat /marker")).toBe("pasted");
    },
    LONG,
  );

  test(
    "a template built from a Git branch uses the Dockerfile in the subdirectory of that branch",
    async () => {
      const view = await buildTemplate("from-git", {
        kind: "git",
        url: `${gitBase}/app.git`,
        branch: "feature",
        subdir: "services/api",
      });
      expect(view).toMatchObject({ status: "succeeded", result: { template: { ref: refOf("from-git") } } });

      const made = await makeBox("from-git-box", refOf("from-git"));
      expect(await run(made.containerId, "root", "cat /marker")).toBe("from-feature");

      const listed = await call(base, "/api/templates");
      expect(listed.json.templates).toContainEqual(
        expect.objectContaining({ ref: refOf("from-git"), buildKind: "git" }),
      );
    },
    LONG,
  );

  test(
    "a rebuild fetches the newest commit, and a failing rebuild keeps the image the template had",
    async () => {
      advanceFeature("second", dockerfileFor("second"));
      expect(await rebuildTemplate("from-git")).toMatchObject({ status: "succeeded" });
      const after = await makeBox("after-rebuild-box", refOf("from-git"));
      expect(await run(after.containerId, "root", "cat /marker")).toBe("second");

      advanceFeature("broken", `FROM ${IMAGE}\nRUN exit 3\n`);
      expect(await rebuildTemplate("from-git")).toMatchObject({ status: "failed" });
      const kept = await makeBox("after-failure-box", refOf("from-git"));
      expect(await run(kept.containerId, "root", "cat /marker")).toBe("second");
    },
    LONG,
  );

  test(
    "a devcontainer.json builds from its image, and a containerEnv value stays literal",
    async () => {
      const view = await buildTemplate("devcon", {
        kind: "devcontainer",
        url: `${gitBase}/app.git`,
        branch: "devcontainer",
      });
      expect(view).toMatchObject({ status: "succeeded" });

      const made = await makeBox("devcon-box", refOf("devcon"));
      expect(await run(made.containerId, "root", 'printf "%s" "$MB_LITERAL"')).toBe("$HOME and \\ backslash");
    },
    LONG,
  );

  test(
    "an image that is missing is pulled as a task, and a name the registry does not know fails it",
    async () => {
      await docker
        .getImage(PULL_IMAGE)
        .remove({ force: false })
        .catch(() => {});
      expect(await imagePresent(PULL_IMAGE)).toBe(false);

      const started = await call(base, "/api/images/pull", { body: { ref: PULL_IMAGE } });
      expect(started.status).toBe(202);
      expect(await finishedTask(base, started.json.taskId ?? "")).toMatchObject({
        status: "succeeded",
        result: { image: { ref: PULL_IMAGE } },
      });
      expect(await imagePresent(PULL_IMAGE)).toBe(true);

      const unknown = await call(base, "/api/images/pull", { body: { ref: `${prefix}-no-such-image:latest` } });
      expect(unknown.status).toBe(202);
      expect(await finishedTask(base, unknown.json.taskId ?? "")).toMatchObject({
        status: "failed",
        error: { key: "image_not_found" },
      });
    },
    LONG,
  );

  test(
    "a box created with a repository clones it into /workspace",
    async () => {
      const made = await makeBox("cloned-box", IMAGE, { url: `${gitBase}/app.git`, branch: "main" });
      expect(made.cloneTask).toBeTruthy();
      expect(await finishedTask(base, made.cloneTask ?? "")).toMatchObject({ status: "succeeded" });
      expect(await run(made.containerId, "root", "cat /workspace/README.md")).toBe("# app");
    },
    LONG,
  );

  test(
    "a private repository without its secret fails the clone, and the box is kept",
    async () => {
      const made = await makeBox("private-no-token", IMAGE, { url: `${gitBase}/private.git`, branch: "main" });
      expect(await finishedTask(base, made.cloneTask ?? "")).toMatchObject({
        status: "failed",
        error: { key: "clone_failed" },
      });
      expect(await boxes.getBox(host, made.boxId)).toBeTruthy();
    },
    LONG,
  );

  test(
    "a private repository is cloned with the token from the secret store, which no task or box record holds",
    async () => {
      const stored = await call(base, "/api/secrets/gh-token", { method: "PUT", body: { value: PRIVATE_TOKEN } });
      expect(stored.status).toBeLessThan(300);

      const made = await makeBox("private-token", IMAGE, {
        url: `${gitBase}/private.git`,
        branch: "main",
        secretRef: "gh-token",
      });
      const view = await finishedTask(base, made.cloneTask ?? "");
      expect(view).toMatchObject({ status: "succeeded" });
      expect(JSON.stringify(view)).not.toContain(PRIVATE_TOKEN);

      const record = await call(base, `/api/boxes/${made.boxId}`);
      expect(JSON.stringify(record.json)).not.toContain(PRIVATE_TOKEN);
      expect(await run(made.containerId, "root", "cat /workspace/README.md")).toBe("# app");
    },
    LONG,
  );
});
