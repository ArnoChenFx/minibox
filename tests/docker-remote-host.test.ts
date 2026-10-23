/**
 * Template copies, checkpoint copies and port previews across two real engines. Both engines are throwaway
 * `docker:dind` containers on the classic image store. The console's own host is the first, and the second is added as
 * a host of its own over its Unix socket, so every request to it takes the path a remote host takes. The test does not
 * depend on the store the runner's own engine uses: that engine only starts the two containers.
 *
 * The test builds a template on each engine, copies one across by hand and on a box create, saves a template from a box
 * on the second engine, and serves an HTTP service and a WebSocket from that box through the relay. A checkpoint of a
 * box on the local engine is copied to the second engine, forks there with the files it took, and survives the delete
 * of its origin.
 *
 *   bun run test:docker
 *
 * That script (scripts/docker-integration.ts) picks the label prefix, pulls the two images this file needs, and sweeps
 * what the run left behind. To run this file directly, pull `docker:dind` and `python:3.12-alpine` first, then:
 * MINIBOX_TEST_DOCKER=1 MINIBOX_TEST_PREFIX=mbit<id> bun test tests/docker-remote-host.test.ts
 *
 * A copy keeps an image's id only between classic-store engines. A copy that touches a containerd-store engine gets a
 * new id, and the copy refuses it, so both engines here are on the classic store.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Server } from "bun";
import Docker from "dockerode";

import { type App, createApp } from "../src/app";
import { COOKIE_NAME } from "../src/auth";
import { RESTIC_IMAGE } from "../src/checkpoints/restic";
import { createDockerRuntime } from "../src/docker/runtime";
import type { HostCtx } from "../src/host/registry";
import { labelKeys } from "../src/labels";
import type { Runtime } from "../src/runtime";
import { startServer } from "../src/server";
import { getBox } from "../src/services/boxes";
import type { SocketData } from "../src/ws/socket";
import { rejectionOf, silenceLogs, TEST_KEY, testConfig } from "./support/app";
import { call, finishedTask, refused } from "./support/tokens";

const enabled = process.env.MINIBOX_TEST_DOCKER === "1";
const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const PREFIX_PATTERN = /^mbit[a-z0-9-]{3,40}$/;
const prefix = process.env.MINIBOX_TEST_PREFIX ?? `mbit${Date.now().toString(36)}`;
if (enabled && !PREFIX_PATTERN.test(prefix)) throw new Error(`MINIBOX_TEST_PREFIX must match ${PREFIX_PATTERN}`);
const LONG = 180_000;
const ENGINE_IMAGE = "docker:dind";
const BASE_IMAGE = "python:3.12-alpine";
const SERVICE_PORT = 8080;
const keys = labelKeys(prefix);
const templateRef = (name: string) => `${prefix}-template:${name}`;
const REMOTE_TEMPLATE = templateRef("pyremote");
const LOCAL_TEMPLATE = templateRef("pylocal");
const AUTO_TEMPLATE = templateRef("pyauto");
const SAVED_TEMPLATE = templateRef("saved-remote");
const BASE_TEMPLATE = templateRef("base");
const runnerDocker = new Docker({ socketPath: SOCKET });

/**
 * The service a box runs: HTTP for any path, and an echo for WebSocket frames. It uses the standard library only, as the
 * box has nothing else.
 */
const SERVICE = String.raw`import base64, hashlib, struct, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def read_frame(rfile):
    head = rfile.read(2)
    if len(head) < 2:
        return None
    opcode, length = head[0] & 0x0F, head[1] & 0x7F
    if length == 126:
        length = struct.unpack(">H", rfile.read(2))[0]
    elif length == 127:
        length = struct.unpack(">Q", rfile.read(8))[0]
    mask = rfile.read(4) if head[1] & 0x80 else b""
    payload = rfile.read(length)
    if mask:
        payload = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
    return opcode, payload


def send_frame(wfile, opcode, payload):
    if len(payload) < 126:
        head = bytes([0x80 | opcode, len(payload)])
    elif len(payload) < 65536:
        head = bytes([0x80 | opcode, 126]) + struct.pack(">H", len(payload))
    else:
        head = bytes([0x80 | opcode, 127]) + struct.pack(">Q", len(payload))
    wfile.write(head + payload)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        pass

    def do_GET(self):
        if self.headers.get("Upgrade", "").lower() == "websocket":
            accept = base64.b64encode(hashlib.sha1(self.headers["Sec-WebSocket-Key"].encode() + GUID).digest())
            self.send_response_only(101, "Switching Protocols")
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept.decode())
            self.end_headers()
            self.close_connection = True
            while (frame := read_frame(self.rfile)) is not None:
                opcode, payload = frame
                if opcode == 0x8:
                    send_frame(self.wfile, 0x8, b"")
                    return
                if opcode in (0x1, 0x2):
                    send_frame(self.wfile, opcode, b"echo:" + payload)
            return
        body = f"hello {self.path} from {self.headers.get('Host', '')}".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
`;

interface BoxJson {
  id: string;
  boxId: string;
  name: string;
  hostId: string;
  running: boolean;
}

interface CreatedBox {
  box: BoxJson;
  sync?: { taskId: string };
}

interface TemplateJson {
  ref: string;
  hostId: string;
}

interface CheckpointJson {
  id: string;
  hostId: string;
  boxName: string | null;
}

/** One engine this file started: the socket it serves, and a client for it. */
interface Engine {
  readonly socket: string;
  readonly docker: Docker;
  readonly runtime: Runtime;
}

/** Every engine container and directory this file made, so afterAll removes them even when a start failed part way. */
const started: { id: string; dir: string }[] = [];
let app: App;
let server: Server<SocketData>;
let base: string;
let cookie: string;
let restoreLogs: (() => void) | undefined;
let localRuntime: Runtime;
let labRuntime: Runtime;
let labDocker: Docker;
let labHost: HostCtx;
let web: BoxJson;
let copied: { source: string; origin: string; copy: string } | null = null;

/** The Dockerfile a test template is built from. It is FROM the image both engines pull, and names where it was built. */
function dockerfile(builtOn: string): string {
  return [
    `FROM ${BASE_IMAGE}`,
    'LABEL minibox.template.uid="1000" minibox.template.gid="1000"',
    `ENV MB_BUILT_ON=${builtOn}`,
    "RUN addgroup -g 1000 dev && adduser -D -u 1000 -G dev dev && mkdir -p /workspace && chown dev:dev /workspace",
    "USER dev",
    "WORKDIR /workspace",
    'CMD ["sleep", "infinity"]',
    "",
  ].join("\n");
}

/**
 * Builds the base template on `runtime` from the same small Dockerfile as the others. The bundled base takes minutes to
 * build, and a fork needs only an image labelled as the base, which it sets volume owners with.
 */
async function seedBase(runtime: Runtime): Promise<void> {
  const contextDir = mkdtempSync(join(tmpdir(), `${prefix}-base-`));
  try {
    writeFileSync(join(contextDir, "Dockerfile"), dockerfile("local"));
    await runtime.buildImage({
      contextDir,
      dockerfile: "Dockerfile",
      tag: BASE_TEMPLATE,
      labels: { [keys.template]: "true", [keys.templateName]: "base" },
    });
  } finally {
    rmSync(contextDir, { recursive: true, force: true });
  }
}

/** Polls `check` until it returns a value other than null, and fails once `timeoutMs` has passed. */
async function until<T>(check: () => Promise<T | null>, what: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(200);
  }
}

/** Runs the docker CLI against the runner's daemon, where the engine containers live. */
async function cli(args: string[]): Promise<void> {
  const proc = Bun.spawn(["docker", "-H", `unix://${SOCKET}`, ...args], { stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`docker ${args.join(" ")} failed: ${stderr.trim()}`);
}

async function signIn(origin: string): Promise<string> {
  const res = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ key: TEST_KEY }),
  });
  expect(res.status).toBe(200);
  const set = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`)) ?? "";
  return decodeURIComponent(set.slice(COOKIE_NAME.length + 1).split(";")[0] ?? "");
}

/**
 * Starts one engine: a privileged `docker:dind` on the classic store, whose socket is the only thing shared with this
 * process. The engine makes its socket for root, so the socket is opened to this process once it appears.
 */
async function startEngine(role: string): Promise<Engine> {
  const name = `${prefix}-${role}-engine`;
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  const socket = join(dir, "docker.sock");
  const created = await runnerDocker.createContainer({
    name,
    Image: ENGINE_IMAGE,
    Env: ["DOCKER_TLS_CERTDIR="],
    Cmd: [
      "--host",
      "unix:///run/mb/docker.sock",
      "--feature",
      "containerd-snapshotter=false",
      "--storage-driver=overlay2",
    ],
    Labels: { [prefix]: "engine" },
    HostConfig: { Privileged: true, Binds: [`${dir}:/run/mb`] },
  });
  started.push({ id: created.id, dir });
  await runnerDocker.getContainer(created.id).start();
  await until(async () => (existsSync(socket) ? true : null), `the ${role} engine's socket`, 60_000);
  await cli(["exec", name, "chmod", "666", "/run/mb/docker.sock"]);
  const docker = new Docker({ socketPath: socket });
  await until(
    () =>
      docker.ping().then(
        () => true,
        () => null,
      ),
    `the ${role} engine to answer`,
    120_000,
  );
  const runtime = createDockerRuntime(socket);
  await runtime.pullImage(BASE_IMAGE);
  return { socket, docker, runtime };
}

beforeAll(async () => {
  if (!enabled) return;
  restoreLogs = silenceLogs();
  const local = await startEngine("local");
  const lab = await startEngine("lab");
  localRuntime = local.runtime;
  labRuntime = lab.runtime;
  labDocker = lab.docker;
  await Promise.all([localRuntime.pullImage(RESTIC_IMAGE), labRuntime.pullImage(RESTIC_IMAGE)]);
  await seedBase(localRuntime);
  app = createApp(testConfig({ labelPrefix: prefix, dockerSocket: local.socket }), "0.0.0-test", {
    runtime: localRuntime,
    eventsPath: ":memory:",
  });
  server = startServer(app);
  base = `http://127.0.0.1:${server.port}`;
  cookie = `${COOKIE_NAME}=${encodeURIComponent(await signIn(base))}`;
  const added = await call(base, "/api/hosts", { body: { id: "lab", name: "Lab", endpoint: `unix://${lab.socket}` } });
  expect(added.status).toBe(201);
  labHost = app.hosts.get("lab");
}, LONG);

afterAll(async () => {
  if (!enabled) return;
  app?.previewRelay.stop();
  app?.hostAdmin.close();
  app?.throttle.stop();
  app?.sessions.stop();
  app?.tokens.stop();
  app?.events.close();
  server?.stop(true);
  for (const engine of started) {
    await runnerDocker
      .getContainer(engine.id)
      .remove({ force: true, v: true })
      .catch(() => {});
    rmSync(engine.dir, { recursive: true, force: true });
  }
  restoreLogs?.();
}, LONG);

/** The hosts that hold `template`, sorted, as the template list reports them. */
async function holdersOf(template: string): Promise<string[]> {
  const listed = (await call(base, "/api/templates")).json as unknown as { templates: TemplateJson[] };
  return listed.templates
    .filter((item) => item.ref === template)
    .map((item) => item.hostId)
    .toSorted();
}

/** The second engine's containers for a box of this run, found by the labels MiniBox writes at create. */
function containersNamed(name: string) {
  return labDocker.listContainers({
    all: true,
    filters: { label: [`${keys.box}=true`, `${keys.name}=${name}`] },
  });
}

async function createBox(name: string, template: string): Promise<CreatedBox> {
  const made = await call(base, "/api/boxes", {
    body: { name, template, host: "lab", cpus: 0.5, memoryMb: 128, mounts: [] },
  });
  expect(made.status).toBe(201);
  return made.json as unknown as CreatedBox;
}

/** Starts SERVICE in the box as `dev`, the way the box's own app would run. The process lives until the box stops. */
async function startService(boxId: string): Promise<void> {
  const { id } = await getBox(labHost, boxId);
  const session = await labRuntime.startExec(id, {
    cmd: ["python3", "-c", SERVICE, String(SERVICE_PORT)],
    env: [],
    workingDir: "/",
    user: "dev",
    tty: false,
  });
  session.stdout.resume();
  session.stderr.resume();
}

async function preview(path: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}${path}`, { headers: { cookie } });
  return { status: res.status, text: await res.text() };
}

/** The checkpoint a finished task returned. A task that ended without one fails with how it ended. */
function checkpointFrom(task: { status: string; result?: unknown }): CheckpointJson {
  const checkpoint = (task.result as { checkpoint?: CheckpointJson } | undefined)?.checkpoint;
  if (!checkpoint) throw new Error(`the task ended as ${task.status} and returned no checkpoint`);
  return checkpoint;
}

/** Runs a shell snippet as the box's user on `host`, and returns what it printed, trimmed. */
async function shellIn(host: HostCtx, boxId: string, script: string): Promise<string> {
  const { id } = await getBox(host, boxId);
  const exec = await host.runtime.startExec(id, {
    cmd: ["sh", "-c", `${script}; echo MB_DONE`],
    env: ["TERM=dumb"],
    workingDir: "/",
  });
  let text = "";
  exec.stream.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  try {
    await until(async () => (text.includes("MB_DONE") ? true : null), "the command's output", 30_000);
  } finally {
    exec.stream.destroy();
  }
  return text.slice(0, text.indexOf("MB_DONE")).replace(/\r/g, "").trim();
}

function copiedState(): NonNullable<typeof copied> {
  if (!copied) throw new Error("the copy test did not run");
  return copied;
}

describe.skipIf(!enabled)("a second engine over a Unix socket, against a real engine", () => {
  test(
    "a template built on the second engine is an image only that engine holds",
    async () => {
      const built = await call(base, "/api/templates", {
        body: { name: "pyremote", host: "lab", source: { kind: "dockerfile", text: dockerfile("lab") } },
      });
      expect(built.status).toBe(202);
      expect(await finishedTask(base, built.json.taskId ?? "")).toMatchObject({
        status: "succeeded",
        result: { template: { ref: REMOTE_TEMPLATE, name: "pyremote" } },
      });

      expect(await labRuntime.inspectImage(REMOTE_TEMPLATE)).toMatchObject({
        labels: { [keys.template]: "true", [keys.templateName]: "pyremote" },
      });
      expect(await rejectionOf(localRuntime.inspectImage(REMOTE_TEMPLATE))).toMatchObject({ kind: "not_found" });
      expect(await holdersOf(REMOTE_TEMPLATE)).toEqual(["lab"]);
    },
    LONG,
  );

  test(
    "a template built here is copied to the second engine on request, and keeps its image id",
    async () => {
      const built = await call(base, "/api/templates", {
        body: { name: "pylocal", source: { kind: "dockerfile", text: dockerfile("local") } },
      });
      expect(built.status).toBe(202);
      expect(await finishedTask(base, built.json.taskId ?? "")).toMatchObject({ status: "succeeded" });
      const localId = (await localRuntime.inspectImage(LOCAL_TEMPLATE)).id;

      const path = `/api/templates/${encodeURIComponent(LOCAL_TEMPLATE)}/sync`;
      const copied = await call(base, path, { body: { host: "lab" } });
      expect(copied.status).toBe(202);
      expect(await finishedTask(base, copied.json.taskId ?? "")).toMatchObject({
        status: "succeeded",
        result: { ref: LOCAL_TEMPLATE, host: "lab", sent: true },
      });
      expect((await labRuntime.inspectImage(LOCAL_TEMPLATE)).id).toBe(localId);
      expect(await holdersOf(LOCAL_TEMPLATE)).toEqual(["lab", "local"]);

      const again = await call(base, path, { body: { host: "lab" } });
      expect(await finishedTask(base, again.json.taskId ?? "")).toMatchObject({
        status: "succeeded",
        result: { host: "lab", sent: false },
      });
    },
    LONG,
  );

  test(
    "a box created on the second engine copies a template it lacks there first, and the create reports the copy",
    async () => {
      const built = await call(base, "/api/templates", {
        body: { name: "pyauto", source: { kind: "dockerfile", text: dockerfile("auto") } },
      });
      expect(built.status).toBe(202);
      expect(await finishedTask(base, built.json.taskId ?? "")).toMatchObject({ status: "succeeded" });
      const localId = (await localRuntime.inspectImage(AUTO_TEMPLATE)).id;

      const made = await createBox("auto-box", AUTO_TEMPLATE);
      expect(made.box).toMatchObject({ name: "auto-box", hostId: "lab", running: true });
      expect(made.sync).toBeDefined();
      expect(await finishedTask(base, made.sync?.taskId ?? "")).toMatchObject({
        status: "succeeded",
        result: { ref: AUTO_TEMPLATE, host: "lab", sent: true },
      });
      expect((await labRuntime.inspectImage(AUTO_TEMPLATE)).id).toBe(localId);
      expect(await containersNamed("auto-box")).toMatchObject([{ State: "running" }]);
      expect(await holdersOf(AUTO_TEMPLATE)).toEqual(["lab", "local"]);

      const held = await createBox("held-box", LOCAL_TEMPLATE);
      expect(held.box).toMatchObject({ name: "held-box", hostId: "lab", running: true });
      expect(held).not.toHaveProperty("sync");
    },
    LONG,
  );

  test(
    "an HTTP preview of a box on the second engine reaches its service through the relay, with no 501",
    async () => {
      const made = await createBox("remote-web", REMOTE_TEMPLATE);
      web = made.box;
      expect(web).toMatchObject({ hostId: "lab", running: true });
      await startService(web.boxId);

      const answer = await until(
        async () => {
          const reply = await preview(`/box/remote-web/${SERVICE_PORT}/hello`);
          return reply.status === 502 ? null : reply;
        },
        "the service to answer through the relay",
        60_000,
      );

      expect(answer).toEqual({ status: 200, text: `hello /hello from 127.0.0.1:${SERVICE_PORT}` });
    },
    LONG,
  );

  test(
    "a WebSocket preview of that box carries frames both ways, and holds the box while the socket is open",
    async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/box/remote-web/${SERVICE_PORT}/chat`, {
        headers: { cookie },
      });
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve());
        socket.addEventListener("error", () => reject(new Error("the preview socket failed to open")));
      });
      expect(app.pulse.isHeld(web.boxId)).toBe(true);

      const seen: unknown[] = [];
      socket.addEventListener("message", (event) => seen.push(event.data));
      // The upstream attaches after the socket opens, and a message that arrives before it is dropped, so resend.
      const poke = setInterval(() => socket.send("ping"), 20);
      try {
        await until(async () => (seen.includes("echo:ping") ? true : null), "the first echo", 30_000);
      } finally {
        clearInterval(poke);
      }
      const long = "z".repeat(70_000);
      socket.send(long);
      await until(async () => (seen.includes(`echo:${long}`) ? true : null), "the echo of a long frame", 30_000);

      const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }));
      socket.close();
      await closed;
      await until(async () => (app.pulse.isHeld(web.boxId) ? null : true), "the box to be released", 5_000);
    },
    LONG,
  );

  test(
    "a template saved from that box is kept on the second engine",
    async () => {
      const saved = await call(base, `/api/boxes/${web.boxId}/template`, {
        body: { name: "saved-remote", description: "saved on the second engine" },
      });
      expect(saved.status).toBe(202);
      expect(await finishedTask(base, saved.json.taskId ?? "")).toMatchObject({
        status: "succeeded",
        result: { template: { ref: SAVED_TEMPLATE, name: "saved-remote" } },
      });

      expect(await labRuntime.inspectImage(SAVED_TEMPLATE)).toMatchObject({
        labels: { [keys.template]: "true" },
      });
      expect(await rejectionOf(localRuntime.inspectImage(SAVED_TEMPLATE))).toMatchObject({ kind: "not_found" });
      expect(await holdersOf(SAVED_TEMPLATE)).toEqual(["lab"]);
    },
    LONG,
  );

  test(
    "a checkpoint of a box on the local engine copies to the second engine, and forks there with the files it took",
    async () => {
      const made = await call(base, "/api/boxes", {
        body: { name: "copy-src", template: LOCAL_TEMPLATE, cpus: 0.5, memoryMb: 128 },
      });
      expect(made.status).toBe(201);
      const source = (made.json as unknown as CreatedBox).box;
      expect(source).toMatchObject({ name: "copy-src", hostId: "local", running: true });
      await shellIn(
        app.hosts.get(),
        source.boxId,
        "mkdir -p /workspace/src && echo kept > /workspace/notes.txt && echo 'export const answer = 42' > /workspace/src/answer.ts",
      );

      const taken = await call(base, `/api/boxes/${source.boxId}/checkpoints`, { body: {} });
      expect(taken.status).toBe(202);
      const origin = checkpointFrom(await finishedTask(base, taken.json.taskId ?? ""));

      expect(await holdersOf(BASE_TEMPLATE)).toEqual(["local"]);
      const copying = await call(base, `/api/checkpoints/${origin.id}/copy`, { body: { host: "lab" } });
      expect(copying.status).toBe(202);
      const copyTask = await finishedTask(base, copying.json.taskId ?? "");
      expect(copyTask).toMatchObject({ status: "succeeded" });
      expect(await holdersOf(BASE_TEMPLATE)).toEqual(["lab", "local"]);
      const copy = checkpointFrom(copyTask);
      expect(copy).toMatchObject({ hostId: "lab", boxName: "copy-src" });
      expect(copy.id).not.toBe(origin.id);
      expect((copyTask as { output?: string }).output).toContain("Restoring copy-src on lab");
      copied = { source: source.boxId, origin: origin.id, copy: copy.id };

      const forking = await call(base, `/api/checkpoints/${copy.id}/fork`, {
        body: { name: "copy-fork", cpus: 0.5, memoryMb: 128 },
      });
      expect(forking.status).toBe(202);
      const forkTask = await finishedTask(base, forking.json.taskId ?? "");
      expect(forkTask).toMatchObject({ status: "succeeded" });
      const fork = (forkTask.result as { box: BoxJson }).box;
      expect(fork).toMatchObject({ name: "copy-fork", hostId: "lab", running: true });
      expect(await shellIn(labHost, fork.boxId, "cat /workspace/notes.txt /workspace/src/answer.ts")).toBe(
        "kept\nexport const answer = 42",
      );
    },
    LONG,
  );

  test(
    "the origin stays whole, a copy back or a second copy is refused, and deleting the origin leaves the copy forkable",
    async () => {
      const { source, origin, copy } = copiedState();
      expect(await shellIn(app.hosts.get(), source, "cat /workspace/notes.txt")).toBe("kept");
      expect((await call(base, `/api/checkpoints/${origin}`)).json).toMatchObject({ checkpoint: { hostId: "local" } });

      const back = await call(base, `/api/checkpoints/${copy}/copy`, { body: { host: "local" } });
      expect(back.status).toBe(202);
      expect(await finishedTask(base, back.json.taskId ?? "")).toMatchObject({
        status: "failed",
        error: { key: "checkpoint_copy_exists" },
      });

      const again = await call(base, `/api/checkpoints/${origin}/copy`, { body: { host: "lab" } });
      expect(refused(again)).toEqual({ status: 409, key: "checkpoint_copy_exists" });

      const deleted = await call(base, `/api/checkpoints/${origin}`, { method: "DELETE" });
      expect(deleted.status).toBe(202);
      expect(await finishedTask(base, deleted.json.taskId ?? "")).toMatchObject({ status: "succeeded" });

      const forking = await call(base, `/api/checkpoints/${copy}/fork`, {
        body: { name: "after-delete", cpus: 0.5, memoryMb: 128 },
      });
      expect(forking.status).toBe(202);
      const forkTask = await finishedTask(base, forking.json.taskId ?? "");
      expect(forkTask).toMatchObject({ status: "succeeded" });
      const fork = (forkTask.result as { box: BoxJson }).box;
      expect(await shellIn(labHost, fork.boxId, "cat /workspace/notes.txt")).toBe("kept");
    },
    LONG,
  );
});
