/**
 * Terminal sessions against a real engine: tmux inside a box, the terminal WebSocket, the takeover lock, the heartbeat,
 * and the container events the Activity tab reads.
 *
 *   bun run test:docker
 *
 * That script (scripts/docker-integration.ts) picks the label prefix and sweeps what the run left behind. To run this
 * file directly: MINIBOX_TEST_DOCKER=1 MINIBOX_TEST_PREFIX=mbit<id> bun test tests/docker-sessions.test.ts
 *
 * Boxes run the image built from tests/fixtures/tmux: bash, tmux and a dev user on uid 1000, as templates/base has.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Server, Socket } from "bun";
import Docker from "dockerode";

import { type App, createApp } from "../src/app";
import { COOKIE_NAME } from "../src/auth";
import type { BoxProfile } from "../src/box-profile";
import { createDockerRuntime } from "../src/docker/runtime";
import type { AuditNote, Source } from "../src/events/types";
import type { HostCtx } from "../src/host/registry";
import { OWNER } from "../src/operations/types";
import type { Runtime } from "../src/runtime";
import { startServer } from "../src/server";
import { type Box, createBox, startBox, stopBox } from "../src/services/boxes";
import { ContainerWatch } from "../src/services/container-watch";
import { TerminalService, VIEWER_ATTACHES_MAX } from "../src/services/terminals";
import type { TerminalData } from "../src/ws/terminal";
import { rejectionOf, TEST_KEY, testConfig } from "./support/app";

const enabled = process.env.MINIBOX_TEST_DOCKER === "1";
const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const PREFIX_PATTERN = /^mbit[a-z0-9-]{3,40}$/;
const prefix = process.env.MINIBOX_TEST_PREFIX ?? `mbit${Date.now().toString(36)}`;
if (enabled && !PREFIX_PATTERN.test(prefix)) throw new Error(`MINIBOX_TEST_PREFIX must match ${PREFIX_PATTERN}`);
const FIXTURE = `${prefix}-tmux:fixture`;
/** An image with neither tmux nor a dev user, as a box from before the base template has. */
const BARE_IMAGE = process.env.MINIBOX_TEST_IMAGE ?? "alpine:3.20";
const owned = { [prefix]: "true" };
const LONG = 90_000;
/** The heartbeat closes a silent socket after the server's idle timeout, which is 30 seconds. */
const HEARTBEAT = 120_000;
const runtime: Runtime = createDockerRuntime(SOCKET);
const docker = new Docker({ socketPath: SOCKET });

let app: App;
let host: HostCtx;
let server: Server<TerminalData>;
let base: string;

beforeAll(async () => {
  if (!enabled) return;
  const cfg = testConfig({
    labelPrefix: prefix,
    dockerSocket: SOCKET,
    baseTemplateTag: `${prefix}-template:base`,
    dataDir: mkdtempSync(join(tmpdir(), "minibox-sessions-test-")),
  });
  app = createApp(cfg, "0.0.0-test", { runtime, eventsPath: ":memory:" });
  host = app.hosts.get();
  await runtime.buildImage({
    contextDir: join(import.meta.dir, "fixtures", "tmux"),
    dockerfile: "Dockerfile",
    tag: FIXTURE,
    labels: owned,
  });
  server = startServer(app);
  base = `http://127.0.0.1:${server.port}`;
}, 300_000);

afterAll(async () => {
  if (!enabled) return;
  server?.stop(true);
  app?.sessions.stop();
  for (const c of await runtime.listContainers({ labels: owned })) {
    await runtime.removeContainer(c.id, { force: true }).catch(() => {});
  }
  for (const img of await runtime.listImages({ labels: owned })) {
    await runtime.removeImage(img.id, { force: true }).catch(() => {});
  }
  const { Volumes } = await docker.listVolumes({ filters: { label: [`${prefix}=true`] } });
  for (const volume of Volumes ?? [])
    await docker
      .getVolume(volume.Name)
      .remove()
      .catch(() => {});
  if (host)
    await docker
      .getNetwork(host.security.network)
      .remove()
      .catch(() => {});
});

async function waitFor(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

async function newBox(name: string, profile?: BoxProfile): Promise<Box> {
  return createBox(host, { name, image: FIXTURE, cpus: 0.5, memoryMb: 128, profile });
}

/** Runs a shell snippet in the box as dev and returns what it printed. The exec is finished before this returns. */
async function shell(id: string, script: string): Promise<string> {
  const exec = await runtime.startExec(id, {
    cmd: ["sh", "-c", `${script}; echo MB_DONE`],
    env: ["TERM=dumb"],
    workingDir: "/",
    user: "dev",
  });
  let text = "";
  exec.stream.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  try {
    await waitFor(() => text.includes("MB_DONE"), "the command output");
    await waitFor(async () => !(await exec.inspect()).running, "the command to end");
  } finally {
    exec.stream.destroy();
  }
  return text.slice(0, text.indexOf("MB_DONE")).replace(/\r/g, "").trim();
}

/** Whether the pane holds `text` now. Reads the pane with tmux itself, so it does not move any session cursor. */
async function paneHas(box: Box, name: string, text: string): Promise<boolean> {
  const count = await shell(box.id, `tmux -u capture-pane -p -t '=${name}:' | grep -c -F -- '${text}' || true`);
  return Number(count) > 0;
}

/** Execs the engine still runs in the box. A finished exec leaves the container's list, so this is the leftover count. */
async function runningExecs(box: Box): Promise<number> {
  return ((await docker.getContainer(box.id).inspect()).ExecIDs ?? []).length;
}

/** tmux attach clients alive in the box. Each one is a terminal; the tmux server is not counted. */
async function attachedClients(box: Box): Promise<number> {
  return Number(await shell(box.id, "ps -o args | grep -c '[t]mux: client' || true"));
}

/** The flags tmux reports for each client attached to the session, such as read-only or ignore-size. */
async function clientFlags(box: Box, name: string): Promise<string[]> {
  return (await shell(box.id, `tmux -u list-clients -F '#{client_flags}' -t '=${name}'`)).split("\n").filter(Boolean);
}

async function signIn(): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ key: TEST_KEY }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`)) ?? "";
  return decodeURIComponent(cookie.slice(COOKIE_NAME.length + 1).split(";")[0] ?? "");
}

/** A console tab on one session: what the browser sends and what it is told, as the page sees it. */
class Console {
  readonly ws: WebSocket;
  readonly closed: Promise<CloseEvent>;
  readonly opened: Promise<void>;
  private screen = "";
  private readonly received: Record<string, unknown>[] = [];

  constructor(path: string, headers: Record<string, string>) {
    this.ws = new WebSocket(`ws://127.0.0.1:${server.port}${path}`, { headers });
    this.ws.binaryType = "arraybuffer";
    this.ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") this.received.push(JSON.parse(event.data) as Record<string, unknown>);
      else this.screen += new TextDecoder().decode(event.data as ArrayBuffer);
    });
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", () => reject(new Error("websocket failed before opening")));
    });
    this.closed = new Promise((resolve) => this.ws.addEventListener("close", resolve));
  }

  output(): string {
    return this.screen;
  }

  frames(type: string): Record<string, unknown>[] {
    return this.received.filter((frame) => frame.type === type);
  }

  state(): Record<string, unknown> | undefined {
    return this.frames("state").at(-1);
  }

  type(text: string): void {
    this.ws.send(new TextEncoder().encode(text));
  }

  control(message: { type: string }): void {
    this.ws.send(JSON.stringify(message));
  }
}

function consoleOn(box: Box, name: string, cookie: string): Console {
  return new Console(`/api/boxes/${box.id}/terminal?session=${name}`, {
    cookie: `${COOKIE_NAME}=${cookie}`,
    origin: base,
  });
}

interface RawTerminal {
  readonly socket: Socket<undefined>;
  readonly closed: Promise<void>;
}

/**
 * A terminal socket opened by hand over TCP, so the test decides what the client does: it can stop answering pings,
 * or drop the connection without a close frame. Frames after the upgrade are not read.
 */
function rawTerminal(path: string, headers: Record<string, string>): Promise<RawTerminal> {
  const port = server.port;
  if (port === undefined) throw new Error("server is not listening");
  const request = [
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    "Connection: Upgrade",
    "Upgrade: websocket",
    "Sec-WebSocket-Version: 13",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "",
    "",
  ].join("\r\n");
  return new Promise((resolve, reject) => {
    const { promise: closed, resolve: markClosed } = Promise.withResolvers<void>();
    let head = "";
    let upgraded = false;
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          socket.write(request);
        },
        data(socket, chunk) {
          if (upgraded) return;
          head += new TextDecoder().decode(chunk);
          if (!head.includes("\r\n\r\n")) return;
          upgraded = true;
          if (head.startsWith("HTTP/1.1 101")) resolve({ socket, closed });
          else reject(new Error(head.split("\r\n")[0]));
        },
        error(_socket, error) {
          reject(error);
        },
        close() {
          markClosed();
        },
      },
    }).catch(reject);
  });
}

describe.skipIf(!enabled)("terminal sessions against a real engine", () => {
  test(
    "a session keeps running when its terminal goes, and the next terminal is shown its screen",
    async () => {
      const box = await newBox("refresh");
      expect(await app.terminals.start(host, box, "work", "ui")).toMatchObject({ created: true, woke: false });

      const first = await app.terminals.attach(host, box, "work", { source: "ui", principal: OWNER });
      expect(first.view()).toMatchObject({ controller: "human", canType: true });
      expect(first.write("echo kept-$((20+1))-running\n")).toBe(true);
      await waitFor(() => paneHas(box, "work", "kept-21-running"), "the typed command to run");
      await first.close();

      await waitFor(async () => (await runningExecs(box)) === 0, "the terminal's exec to end");
      expect(await attachedClients(box)).toBe(0);
      await waitFor(
        async () => (await app.terminals.list(host, box)).some((s) => s.name === "work" && s.attached === 0),
        "the session to show no terminal attached",
      );

      const second = await app.terminals.attach(host, box, "work", { source: "ui", principal: OWNER });
      let shown = "";
      second.exec.stream.on("data", (chunk: Buffer) => {
        shown += chunk.toString("utf8");
      });
      await waitFor(() => shown.includes("kept-21-running"), "the screen a new terminal is given");
      await second.close();

      expect(await shell(box.id, "tmux -u show-options -sv escape-time")).toBe("10");
      const recorded = app.events.list({ box: "refresh" }, { limit: 100 }).events;
      expect(recorded.map((event) => event.op)).toEqual(expect.arrayContaining(["terminal.open", "terminal.close"]));
      expect(JSON.stringify(recorded)).not.toContain("20+1");
    },
    LONG,
  );

  test(
    "a box from an image without tmux or a dev user is refused with the image error",
    async () => {
      const bare = await createBox(host, { name: "bare", image: BARE_IMAGE, cpus: 0.5, memoryMb: 128 });
      expect(await rejectionOf(app.terminals.start(host, bare, "work", "ui"))).toMatchObject({
        status: 409,
        code: "conflict",
        key: "session_image_unsupported",
      });
    },
    LONG,
  );

  test(
    "a browser that reloads reconnects to the same session and sees its screen",
    async () => {
      const cookie = await signIn();
      const box = await newBox("browser");
      await app.terminals.start(host, box, "web", "ui");

      const tab = consoleOn(box, "web", cookie);
      await tab.opened;
      await waitFor(() => tab.state()?.canType === true, "the console to be told it can type");
      tab.type("echo from-the-browser-$((1+2))\n");
      await waitFor(() => paneHas(box, "web", "from-the-browser-3"), "the typed line to run");
      tab.ws.close(1000, "reload");
      await tab.closed;
      await waitFor(async () => (await runningExecs(box)) === 0, "the closed tab's exec to end");

      const reloaded = consoleOn(box, "web", cookie);
      await reloaded.opened;
      await waitFor(() => reloaded.output().includes("from-the-browser-3"), "the screen after the reload");
      expect(reloaded.state()).toMatchObject({ name: "web", controller: "human", canType: true });
      reloaded.ws.close(1000, "done");
      await reloaded.closed;
    },
    LONG,
  );

  test(
    "the console opens an agent session read-only, and a takeover refuses the agent until the person hands it back",
    async () => {
      const cookie = await signIn();
      const box = await newBox("lock");
      await app.terminals.start(host, box, "agent-run", "rest");

      const tab = consoleOn(box, "agent-run", cookie);
      await tab.opened;
      await waitFor(() => tab.state() !== undefined, "the first state frame");
      expect(tab.state()).toMatchObject({ controller: "agent", canType: false, canTakeOver: true, idleReturnSec: 300 });

      tab.type("typed-while-read-only");
      await waitFor(() => tab.frames("error").length === 1, "the refusal");
      expect(tab.frames("error")[0]).toMatchObject({ error: { key: "terminal_read_only" } });
      expect(await paneHas(box, "agent-run", "typed-while-read-only")).toBe(false);

      tab.control({ type: "takeover" });
      await waitFor(() => tab.state()?.controller === "human", "the takeover");
      tab.type("echo human-$((5+5))\n");
      await waitFor(() => paneHas(box, "agent-run", "human-10"), "the human's line to run");

      const refused = await rejectionOf(app.terminals.send(host, box, "agent-run", { text: "echo agent\n" }));
      expect(refused).toMatchObject({ status: 409, code: "taken_over", retryable: true });
      expect(await app.terminals.read(host, box, "agent-run", { lines: 50 })).toMatchObject({ controller: "human" });
      expect(await paneHas(box, "agent-run", "echo agent")).toBe(false);

      tab.control({ type: "release" });
      await waitFor(() => tab.state()?.controller === "agent", "the hand back");
      const agentLine = "echo agent-$((7*6))\n";
      expect(await app.terminals.send(host, box, "agent-run", { text: agentLine })).toEqual({
        keys: 0,
        bytes: Buffer.byteLength(agentLine),
      });
      await waitFor(() => paneHas(box, "agent-run", "agent-42"), "the agent's line to run");
      tab.ws.close(1000, "done");
      await tab.closed;
    },
    LONG,
  );

  test(
    "an agent cannot close a session during a takeover, the session survives it, and the console can close it",
    async () => {
      const cookie = await signIn();
      const box = await newBox("guard");
      await app.terminals.start(host, box, "guarded", "rest");

      const tab = consoleOn(box, "guarded", cookie);
      await tab.opened;
      await waitFor(() => tab.state() !== undefined, "the first state frame");
      tab.control({ type: "takeover" });
      await waitFor(() => tab.state()?.controller === "human", "the takeover");

      expect(await rejectionOf(app.terminals.close(host, box, "guarded", "rest"))).toMatchObject({
        status: 409,
        code: "taken_over",
      });
      const refused = await fetch(`${base}/api/boxes/${box.id}/sessions/guarded`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${TEST_KEY}` },
      });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: { code: "taken_over", retryable: true } });
      expect(await app.terminals.list(host, box)).toEqual([
        expect.objectContaining({ name: "guarded", controller: "human" }),
      ]);

      const closed = await fetch(`${base}/api/boxes/${box.id}/sessions/guarded`, {
        method: "DELETE",
        headers: { cookie: `${COOKIE_NAME}=${cookie}`, origin: base },
      });
      expect(closed.status).toBe(200);
      expect(await app.terminals.list(host, box)).toEqual([]);
      await tab.closed;
    },
    LONG,
  );

  test(
    "a person's hold survives an agent rewriting the session's origin mark inside the box",
    async () => {
      const box = await newBox("mark");
      await app.terminals.start(host, box, "held", "ui");
      await shell(box.id, "tmux -u set-option -t '=held:' @minibox-origin agent");
      expect(await shell(box.id, "tmux -u display-message -p -t '=held:' '#{@minibox-origin}'")).toBe("agent");

      expect(await app.terminals.read(host, box, "held", { lines: 5 })).toMatchObject({ controller: "human" });
      expect(await rejectionOf(app.terminals.send(host, box, "held", { text: "echo x\n" }))).toMatchObject({
        status: 409,
        code: "taken_over",
      });
    },
    LONG,
  );

  test(
    "a bearer terminal is read-only: it can watch the session and is refused any input",
    async () => {
      const box = await newBox("bearer");
      await app.terminals.start(host, box, "shared", "rest");
      const client = new Console(`/api/boxes/${box.id}/terminal?session=shared`, {
        authorization: `Bearer ${TEST_KEY}`,
      });
      await client.opened;
      await waitFor(() => client.state() !== undefined, "the first state frame");
      expect(client.state()).toMatchObject({ controller: "agent", canType: false, canTakeOver: false });

      client.type("nothing-typed");
      await waitFor(() => client.frames("error").length === 1, "the refusal");
      expect(client.frames("error")[0]).toMatchObject({ error: { key: "terminal_read_only" } });
      expect(await paneHas(box, "shared", "nothing-typed")).toBe(false);
      client.ws.close(1000, "done");
      await client.closed;
    },
    LONG,
  );

  test(
    "a bearer terminal is a read-only tmux client that ignores size, so input written past the service never reaches the pane",
    async () => {
      const box = await newBox("readonly");
      await app.terminals.start(host, box, "shared", "ui");

      const bearer = await app.terminals.attach(host, box, "shared", { source: "rest", principal: OWNER });
      await waitFor(
        async () => (await clientFlags(box, "shared")).some((flags) => flags.includes("read-only")),
        "the read-only client",
      );
      expect(await clientFlags(box, "shared")).toEqual(
        expect.arrayContaining([expect.stringContaining("read-only"), expect.stringContaining("ignore-size")]),
      );

      bearer.exec.stream.write("bypass-attempt\n");
      const human = await app.terminals.attach(host, box, "shared", { source: "ui", principal: OWNER });
      expect(human.write("positive-control\n")).toBe(true);
      await waitFor(() => paneHas(box, "shared", "positive-control"), "the control line to run");
      expect(await paneHas(box, "shared", "bypass-attempt")).toBe(false);

      await bearer.close();
      await human.close();
    },
    LONG,
  );

  test(
    "bearer viewers cannot fill a session: with their share full, the console still attaches, takes over and types",
    async () => {
      const cookie = await signIn();
      const box = await newBox("crowd");
      await app.terminals.start(host, box, "shared", "rest");
      const viewers: Console[] = [];
      for (let i = 0; i < VIEWER_ATTACHES_MAX; i++) {
        const viewer = new Console(`/api/boxes/${box.id}/terminal?session=shared`, {
          authorization: `Bearer ${TEST_KEY}`,
        });
        viewers.push(viewer);
        await viewer.opened;
        await waitFor(() => viewer.state() !== undefined, "a viewer's first state frame");
      }

      const refused = new Console(`/api/boxes/${box.id}/terminal?session=shared`, {
        authorization: `Bearer ${TEST_KEY}`,
      });
      await refused.opened;
      await waitFor(() => refused.frames("error").length === 1, "the refused viewer");
      expect(refused.frames("error")[0]).toMatchObject({
        error: { code: "too_many_requests", key: "session_viewer_attach_limit" },
      });
      await refused.closed;

      const tab = consoleOn(box, "shared", cookie);
      await tab.opened;
      await waitFor(() => tab.state() !== undefined, "the console's first state frame");
      expect(tab.state()).toMatchObject({ controller: "agent", canTakeOver: true, canType: false });
      tab.control({ type: "takeover" });
      await waitFor(() => tab.state()?.controller === "human", "the console's takeover");
      tab.type("echo console-$((3+4))\n");
      await waitFor(() => paneHas(box, "shared", "console-7"), "the console's line to run");
      expect(await attachedClients(box)).toBe(VIEWER_ATTACHES_MAX + 1);

      tab.ws.close(1000, "done");
      for (const viewer of viewers) viewer.ws.close(1000, "done");
      await Promise.all([tab.closed, ...viewers.map((viewer) => viewer.closed)]);
    },
    LONG,
  );

  test(
    "a takeover the person leaves goes back to the agent after the idle time, and the return is recorded",
    async () => {
      const notes: { source: Source; note: AuditNote }[] = [];
      const terminals = new TerminalService({
        record: (_hostId, source, _principal, note) => {
          notes.push({ source, note });
        },
        takeoverIdleMs: 1_000,
      });
      const box = await newBox("idle");
      await terminals.start(host, box, "idle-run", "rest");
      const viewer = await terminals.attach(host, box, "idle-run", { source: "ui", principal: OWNER });
      expect(terminals.takeOver(viewer)).toBe(true);
      expect(viewer.write("x")).toBe(true);

      await waitFor(
        async () => (await terminals.read(host, box, "idle-run", { lines: 5 })).controller === "agent",
        "the idle return",
        8_000,
      );
      expect(notes.find((r) => r.note.op === "session.release")).toMatchObject({
        source: "system",
        note: { status: "ok", detail: { session: "idle-run", by: "idle" } },
      });
      await viewer.close();
      terminals.shutdown();
    },
    LONG,
  );

  test(
    "closing a session ends its attached terminal, and nothing is left running in the box",
    async () => {
      const box = await newBox("kill");
      await app.terminals.start(host, box, "doomed", "ui");
      const terminal = await app.terminals.attach(host, box, "doomed", { source: "ui", principal: OWNER });
      expect(await runningExecs(box)).toBe(1);

      await app.terminals.close(host, box, "doomed", "ui");
      await waitFor(async () => !(await terminal.exec.inspect()).running, "the attach to end");
      expect(await runningExecs(box)).toBe(0);
      expect(await app.terminals.list(host, box)).toEqual([]);
      await terminal.close();
    },
    LONG,
  );

  test(
    "a terminal whose client stops answering is closed by the heartbeat, and its attach is killed",
    async () => {
      const cookie = await signIn();
      const box = await newBox("silent");
      await app.terminals.start(host, box, "quiet", "ui");
      const silent = await rawTerminal(`/api/boxes/${box.id}/terminal?session=quiet`, {
        cookie: `${COOKIE_NAME}=${cookie}`,
        origin: base,
      });
      await waitFor(async () => (await attachedClients(box)) === 1, "the attach process");

      await silent.closed;
      await waitFor(async () => (await runningExecs(box)) === 0, "the attach to be killed after the heartbeat");
      expect(await attachedClients(box)).toBe(0);
      expect(await app.terminals.list(host, box)).toEqual([expect.objectContaining({ name: "quiet" })]);
    },
    HEARTBEAT,
  );

  test(
    "a terminal that drops without a close frame leaves no attach process behind, and the session lives on",
    async () => {
      const cookie = await signIn();
      const box = await newBox("dropped");
      await app.terminals.start(host, box, "abrupt", "ui");
      const dropped = await rawTerminal(`/api/boxes/${box.id}/terminal?session=abrupt`, {
        cookie: `${COOKIE_NAME}=${cookie}`,
        origin: base,
      });
      await waitFor(async () => (await attachedClients(box)) === 1, "the attach process");

      dropped.socket.terminate();
      await dropped.closed;
      await waitFor(async () => (await runningExecs(box)) === 0, "the attach to be killed");
      expect(await attachedClients(box)).toBe(0);
      expect(await app.terminals.list(host, box)).toEqual([expect.objectContaining({ name: "abrupt" })]);
    },
    LONG,
  );

  test(
    "in a strict box the session and its terminal run as dev, never as root",
    async () => {
      const box = await newBox("strict", "strict");
      expect(box.profile).toBe("strict");
      await app.terminals.start(host, box, "locked", "rest");
      await app.terminals.send(host, box, "locked", { text: "id -un\n" });
      await waitFor(() => paneHas(box, "locked", "dev"), "the session to report its user");

      expect(await shell(box.id, "ps -o user,args | grep '[{]tmux: server' | awk '{print $1}' | sort -u")).toBe("dev");
      const terminal = await app.terminals.attach(host, box, "locked", { source: "ui", principal: OWNER });
      await waitFor(async () => (await attachedClients(box)) === 1, "the attach process");
      expect(await shell(box.id, "ps -o user,args | grep '[t]mux: client' | awk '{print $1}' | sort -u")).toBe("dev");
      await terminal.close();
    },
    LONG,
  );

  test(
    "session_read returns the screen, and since returns only what was written after its cursor",
    async () => {
      const box = await newBox("reader");
      await app.terminals.start(host, box, "log", "rest");
      await app.terminals.send(host, box, "log", { text: "echo line-$((1+1))\n" });
      await waitFor(() => paneHas(box, "log", "line-2"), "the first line to run");
      const before = await app.terminals.read(host, box, "log", { lines: 500 });

      await app.terminals.send(host, box, "log", { text: "echo line-$((2+2))\n" });
      await waitFor(() => paneHas(box, "log", "line-4"), "the second line to run");
      const after = await app.terminals.read(host, box, "log", { lines: 500, since: before.cursor });
      expect(after.reset).toBe(false);
      expect(after.lines.join("\n")).toContain("line-4");
      expect(after.lines.join("\n")).not.toContain("line-2");
    },
    LONG,
  );

  test(
    "starting and stopping a box is recorded from the engine's events for the Activity tab",
    async () => {
      const box = await newBox("events");
      const seen: string[] = [];
      const watch = new ContainerWatch(app.hosts, (_hostId, _source, _principal, note) => {
        seen.push(`${note.op} ${note.target?.name ?? ""}`);
      });
      watch.start();
      try {
        await Bun.sleep(300);
        for (
          let i = 0;
          i < 10 && !(seen.includes("container.stop events") && seen.includes("container.start events"));
          i++
        ) {
          await stopBox(host, box.boxId);
          await startBox(host, box.boxId);
          await Bun.sleep(200);
        }
      } finally {
        watch.stop();
      }
      expect(seen).toEqual(expect.arrayContaining(["container.stop events", "container.start events"]));
    },
    LONG,
  );
});
