import { describe, expect, test } from "bun:test";
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { type Socket, connect } from "node:net";
import type { Readable, Writable } from "node:stream";

import type { Server } from "bun";

import { type App, createApp } from "../src/app";
import { COOKIE_NAME } from "../src/auth";
import type { Config } from "../src/config";
import { PreviewRelay } from "../src/preview/relay";
import type { ExecSession, ExecSpec } from "../src/runtime";
import { startServer } from "../src/server";
import { getBox, sleepBox } from "../src/services/boxes";
import type { SocketData } from "../src/ws/socket";
import { silenceLogs, TEST_KEY, testConfig } from "./support/app";
import { FakeRuntime } from "./support/fake-runtime";
import { FakeCheckpointEngine } from "./support/fake-snapshots";

const GIB = 1024 ** 3;
const EDGE_SOCKET = "/run/minibox-test/edge-docker.sock";

interface Bed {
  app: App;
  local: FakeRuntime;
  edge: FakeRuntime;
  server: Server<SocketData>;
  base: string;
  cookie: string;
  /** The relay processes that ran for the edge host, each with its argv. */
  relays: string[][];
  cleanups: (() => void)[];
  stop(): void;
}

/**
 * Spawns a command on this machine. The box's loopback is this machine's loopback, so the relay's `python3` runs here as
 * it would in the box, and reaches the test service on 127.0.0.1.
 */
function localExec(command: string, args: string[]): ExecSession {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessByStdio<
    Writable,
    Readable,
    Readable
  >;
  return {
    id: `local-${child.pid ?? 0}`,
    stream: child.stdin as unknown as ExecSession["stream"],
    stdout: child.stdout,
    stderr: child.stderr,
    resize: async () => {},
    inspect: async () => ({
      running: child.exitCode === null && child.signalCode === null,
      exitCode: child.exitCode,
      pid: child.pid ?? null,
    }),
    kill: async () => {
      child.kill("SIGKILL");
    },
  };
}

/** Routes the relay of the edge host's boxes to a local python3, and records each start. */
function relayOnLoopback(runtime: FakeRuntime, relays: string[][]): void {
  const fake = runtime.startExec.bind(runtime);
  runtime.startExec = async (containerId: string, spec: ExecSpec) => {
    if (spec.cmd[0] !== "python3") return fake(containerId, spec);
    relays.push(spec.cmd);
    return localExec("python3", spec.cmd.slice(1));
  };
}

async function signIn(base: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ key: TEST_KEY }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`)) ?? "";
  return decodeURIComponent(cookie.slice(COOKIE_NAME.length + 1).split(";")[0] ?? "");
}

/** A console on its own port, with a second Docker host named `edge` whose box has no address the console can reach. */
async function bed(overrides: Partial<Config> = {}): Promise<Bed> {
  const restoreLogs = silenceLogs();
  const local = new FakeRuntime();
  const edge = new FakeRuntime();
  edge.engine = { cpus: 2, memoryBytes: 4 * GIB };
  const app = createApp(testConfig({ labelPrefix: "mbtest", ...overrides }), "0.0.0-test", {
    runtime: local,
    connect: () => edge,
    checkpointEngine: new FakeCheckpointEngine(),
    eventsPath: ":memory:",
  });
  const keys = app.hosts.get().keys;
  for (const runtime of [local, edge]) {
    runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
  }
  const server = startServer(app);
  const base = `http://127.0.0.1:${server.port}`;
  const added = await fetch(`${base}/api/hosts`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}` },
    body: JSON.stringify({ id: "edge", endpoint: `unix://${EDGE_SOCKET}` }),
  });
  expect(added.status).toBe(201);
  const relays: string[][] = [];
  relayOnLoopback(edge, relays);
  const cookie = `${COOKIE_NAME}=${encodeURIComponent(await signIn(base))}`;
  const cleanups: (() => void)[] = [];
  return {
    app,
    local,
    edge,
    server,
    base,
    cookie,
    relays,
    cleanups,
    stop: () => {
      for (const cleanup of cleanups) cleanup();
      app.previewRelay.stop();
      app.hostAdmin.close();
      server.stop(true);
      app.throttle.stop();
      app.sessions.stop();
      app.tokens.stop();
      app.events.close();
      restoreLogs();
    },
  };
}

async function makeBox(on: Bed, name: string): Promise<{ id: string; boxId: string }> {
  const res = await fetch(`${on.base}/api/boxes`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TEST_KEY}` },
    body: JSON.stringify({ name, cpus: 1, memoryMb: 256, host: "edge", mounts: [] }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { box: { id: string; boxId: string } }).box;
}

/** A service on this machine's loopback, the way a box's app listens inside the box. */
function serviceOn(on: Bed, handler: (req: Request) => Response): number {
  const service = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return undefined;
      return handler(req);
    },
    websocket: {
      message(ws, message) {
        ws.send(`echo:${message}`);
      },
    },
  });
  on.cleanups.push(() => service.stop(true));
  return portOf(service);
}

/** A port nothing listens on. */
function closedPort(): number {
  const service = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = portOf(service);
  service.stop(true);
  return port;
}

function portOf(service: Server<unknown>): number {
  if (service.port === undefined) throw new Error("the test service has no port");
  return service.port;
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("the preview socket failed to open")));
  });
}

/** Sends a CONNECT to the relay's proxy and returns the status line and the socket, which stays open on a 200. */
function connectThrough(proxyUrl: string, target: string, token?: string): Promise<{ status: string; socket: Socket }> {
  const port = Number(new URL(proxyUrl).port);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let seen = "";
    socket.on("error", reject);
    socket.on("data", function onData(chunk: Buffer) {
      seen += chunk.toString("latin1");
      const end = seen.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      resolve({ status: seen.split("\r\n")[0] ?? "", socket });
    });
    const auth = token === undefined ? "" : `proxy-authorization: ${token}\r\n`;
    socket.write(`CONNECT ${target} HTTP/1.1\r\nhost: ${target}\r\n${auth}\r\n`);
  });
}

describe("a preview of a box on another host", () => {
  test("an HTTP preview reaches the service through a relay in the box, with no address for the box", async () => {
    const on = await bed();
    try {
      const port = serviceOn(
        on,
        (req) => new Response(`hello ${new URL(req.url).pathname} from ${req.headers.get("host")}`),
      );
      await makeBox(on, "remote-web");

      const res = await fetch(`${on.base}/box/remote-web/${port}/hello`, { headers: { cookie: on.cookie } });

      expect(res.status).toBe(200);
      expect(await res.text()).toBe(`hello /hello from 127.0.0.1:${port}`);
      expect(on.relays).toHaveLength(1);
      expect(on.relays[0]?.at(-1)).toBe(String(port));
    } finally {
      on.stop();
    }
  });

  test("a WebSocket preview carries frames through the relay, and holds the box until the socket closes", async () => {
    const on = await bed();
    try {
      const port = serviceOn(on, () => new Response("not a websocket", { status: 400 }));
      const box = await makeBox(on, "remote-socket");

      const socket = new WebSocket(`ws://127.0.0.1:${on.server.port}/box/remote-socket/${port}/chat`, {
        headers: { cookie: on.cookie },
      });
      await opened(socket);
      expect(on.app.pulse.isHeld(box.boxId)).toBe(true);

      const echoed = new Promise<unknown>((resolve) => socket.addEventListener("message", (e) => resolve(e.data)));
      // The upstream attaches after the socket opens, and a message that arrives before it is dropped, so resend.
      const poke = setInterval(() => socket.send("ping"), 20);
      try {
        expect(await echoed).toBe("echo:ping");
      } finally {
        clearInterval(poke);
      }
      expect(on.relays).toHaveLength(1);

      const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve()));
      socket.close();
      await closed;
      await waitFor(() => !on.app.pulse.isHeld(box.boxId), "the box to be released");
    } finally {
      on.stop();
    }
  });

  test("a WebSocket preview still goes through the relay's proxy when NO_PROXY lists the loopback", async () => {
    const on = await bed();
    const savedNoProxy = process.env.NO_PROXY;
    const savedNoProxyLower = process.env.no_proxy;
    try {
      process.env.NO_PROXY = "127.0.0.1,localhost";
      delete process.env.no_proxy;
      const port = serviceOn(on, () => new Response("not a websocket", { status: 400 }));
      await makeBox(on, "noproxy-socket");

      const socket = new WebSocket(`ws://127.0.0.1:${on.server.port}/box/noproxy-socket/${port}/chat`, {
        headers: { cookie: on.cookie },
      });
      const echoed = new Promise<unknown>((resolve) => socket.addEventListener("message", (e) => resolve(e.data)));
      const poke = setInterval(() => socket.send("ping"), 20);
      try {
        await opened(socket);
        expect(await echoed).toBe("echo:ping");
      } finally {
        clearInterval(poke);
        socket.close();
      }
      // The frames came back, so the socket went through the relay's proxy instead of dialling the loopback directly.
      expect(on.relays).toHaveLength(1);
    } finally {
      if (savedNoProxy === undefined) delete process.env.NO_PROXY;
      else process.env.NO_PROXY = savedNoProxy;
      if (savedNoProxyLower === undefined) delete process.env.no_proxy;
      else process.env.no_proxy = savedNoProxyLower;
      on.stop();
    }
  });

  test("a streaming response holds a remote box until the body has been read to the end", async () => {
    const on = await bed();
    try {
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const encoder = new TextEncoder();
      const port = serviceOn(
        on,
        () =>
          new Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(encoder.encode("first "));
                await gate;
                controller.enqueue(encoder.encode("second"));
                controller.close();
              },
            }),
            { headers: { "content-type": "text/plain" } },
          ),
      );
      const box = await makeBox(on, "remote-stream");

      const res = await fetch(`${on.base}/box/remote-stream/${port}/`, { headers: { cookie: on.cookie } });
      const reader = res.body?.getReader();
      if (!reader) throw new Error("the preview response has no body");
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("first ");
      expect(on.app.pulse.isHeld(box.boxId)).toBe(true);

      finish();
      let rest = "";
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        rest += new TextDecoder().decode(next.value);
      }
      expect(rest).toBe("second");
      await waitFor(() => !on.app.pulse.isHeld(box.boxId), "the box to be released");
    } finally {
      on.stop();
    }
  });

  test("a preview wakes a sleeping box on another host, and serves it", async () => {
    const on = await bed();
    try {
      const port = serviceOn(on, () => new Response("awake"));
      const box = await makeBox(on, "remote-sleepy");
      const host = on.app.hosts.get("edge");
      expect(await sleepBox(host, box.id, "idle")).toBe(true);
      const starts = on.edge.callsTo("startContainer").length;

      const res = await fetch(`${on.base}/box/remote-sleepy/${port}/`, { headers: { cookie: on.cookie } });

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("awake");
      expect(on.edge.callsTo("startContainer")).toHaveLength(starts + 1);
      expect(await getBox(host, box.id)).toMatchObject({ running: true, sleeping: false });
    } finally {
      on.stop();
    }
  });

  test("a service that is not listening in the box is a 502 that says why, and the box is released", async () => {
    const on = await bed();
    try {
      const port = closedPort();
      const box = await makeBox(on, "remote-closed");

      const res = await fetch(`${on.base}/box/remote-closed/${port}/`, { headers: { cookie: on.cookie } });

      expect(res.status).toBe(502);
      expect(await res.text()).toContain("Could not reach the service inside the box");
      await waitFor(() => !on.app.pulse.isHeld(box.boxId), "the box to be released");
    } finally {
      on.stop();
    }
  });

  test("a box whose engine has no python3 is a 502 that names the failure", async () => {
    const on = await bed();
    try {
      on.edge.startExec = async () => localExec("/bin/sh", ["-c", "echo 'sh: 1: python3: not found' >&2; exit 127"]);
      const port = serviceOn(on, () => new Response("unreachable"));
      await makeBox(on, "remote-nopy");

      const res = await fetch(`${on.base}/box/remote-nopy/${port}/`, { headers: { cookie: on.cookie } });

      expect(res.status).toBe(502);
      expect(await res.text()).toContain("python3: not found");
    } finally {
      on.stop();
    }
  });

  test("the launch route opens a remote box's preview with a redirect, not a 501", async () => {
    const on = await bed({ previewBaseDomain: "preview.test" });
    try {
      const box = await makeBox(on, "remote-launch");

      const res = await fetch(`${on.base}/api/boxes/${box.id}/ports/3000/preview`, {
        headers: { cookie: on.cookie },
        redirect: "manual",
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toMatch(/^https:\/\//);
    } finally {
      on.stop();
    }
  });

  test("a box on an agent host keeps its refusal, since an agent cannot exec the relay", async () => {
    const on = await bed({ previewBaseDomain: "preview.test" });
    try {
      const box = await makeBox(on, "agent-box");
      const edgeHost = on.app.hosts.get("edge");
      (edgeHost.host as { transport: string }).transport = "agent";

      const res = await fetch(`${on.base}/api/boxes/${box.id}/ports/3000/preview`, {
        headers: { cookie: on.cookie },
        redirect: "manual",
      });

      expect(res.status).toBe(501);
      expect(await res.json()).toMatchObject({ error: { key: "preview_agent_unsupported" } });
    } finally {
      on.stop();
    }
  });
});

describe("the relay's proxy", () => {
  test("a grant opens one connection to its own address, and cannot be spent twice", async () => {
    const on = await bed();
    const relay = new PreviewRelay();
    try {
      const port = serviceOn(on, () => new Response("from the box"));
      const box = await makeBox(on, "grant-box");
      const bridge = await relay.bridge(on.app.hosts.get("edge"), box, port);
      const target = `minibox-preview.invalid:${port}`;

      const unsigned = await connectThrough(bridge.proxyUrl, target);
      expect(unsigned.status).toBe("HTTP/1.1 407 Proxy Authentication Required");
      unsigned.socket.destroy();

      const wrong = await connectThrough(bridge.proxyUrl, `minibox-preview.invalid:${port + 1}`, bridge.grant());
      expect(wrong.status).toBe("HTTP/1.1 403 Forbidden");
      wrong.socket.destroy();

      const token = bridge.grant();
      const granted = await connectThrough(bridge.proxyUrl, target, token);
      expect(granted.status).toBe("HTTP/1.1 200 Connection Established");
      let body = "";
      granted.socket.on("data", (chunk: Buffer) => {
        body += chunk.toString("latin1");
      });
      granted.socket.write(`GET / HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\nconnection: close\r\n\r\n`);
      await waitFor(() => body.includes("from the box"), "the service's answer through the tunnel");
      granted.socket.destroy();

      const reused = await connectThrough(bridge.proxyUrl, target, token);
      expect(reused.status).toBe("HTTP/1.1 407 Proxy Authentication Required");
      reused.socket.destroy();
    } finally {
      relay.stop();
      on.stop();
    }
  });

  test("the HTTP socket answers through the relay, and stop removes it along with the proxy", async () => {
    const on = await bed();
    const relay = new PreviewRelay();
    try {
      const port = serviceOn(on, () => new Response("ok"));
      const box = await makeBox(on, "stop-box");
      const bridge = await relay.bridge(on.app.hosts.get("edge"), box, port);
      const res = await fetch(`http://127.0.0.1:${port}/`, { unix: bridge.httpSocket } as RequestInit);
      expect(await res.text()).toBe("ok");
      expect(existsSync(bridge.httpSocket)).toBe(true);

      relay.stop();

      expect(existsSync(bridge.httpSocket)).toBe(false);
      await expect(
        connectThrough(bridge.proxyUrl, `minibox-preview.invalid:${port}`, bridge.grant()),
      ).rejects.toThrow();
    } finally {
      relay.stop();
      on.stop();
    }
  });
});
