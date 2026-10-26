import { describe, expect, test } from "bun:test";
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { type Socket, connect } from "node:net";
import type { Readable, Writable } from "node:stream";

import type { Server } from "bun";

import { type App, createApp } from "../src/app";
import { COOKIE_NAME } from "../src/auth";
import type { Config } from "../src/config";
import { setLogSink } from "../src/lib/logger";
import { PreviewRelay } from "../src/preview/relay";
import { RELAY_PATHS } from "../src/preview/relay-binary";
import type { ExecSession, ExecSpec } from "../src/runtime";
import { startServer } from "../src/server";
import { getBox, sleepBox } from "../src/services/boxes";
import type { SocketData } from "../src/ws/socket";
import { silenceLogs, TEST_KEY, testConfig } from "./support/app";
import { FakeRuntime } from "./support/fake-runtime";
import { FakeCheckpointEngine } from "./support/fake-snapshots";
import { relayCommand } from "./support/relay";

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
  /** The debug lines that reported which relay implementation a box's preview traffic used. */
  relayLines: string[];
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
    const head = spec.cmd[0] ?? "";
    if (head !== "python3" && !RELAY_PATHS.includes(head)) return fake(containerId, spec);
    return relayCommand(spec.cmd, relays);
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
  // Only the relay's own selection lines are kept, so the sink does not hold the rest of a test's debug output.
  const relayLines: string[] = [];
  const restoreSink = setLogSink((_level, line) => {
    if (line.includes('"preview.relay_selected"')) relayLines.push(line);
  });
  const cookie = `${COOKIE_NAME}=${encodeURIComponent(await signIn(base))}`;
  const cleanups: (() => void)[] = [restoreSink];
  return {
    app,
    local,
    edge,
    server,
    base,
    cookie,
    relays,
    relayLines,
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

describe("static relay placement and fallback", () => {
  test("two engines using the same template tag receive their own image architecture", async () => {
    for (const [arch, machine] of [
      ["x86_64", 62],
      ["aarch64", 183],
    ] as const) {
      const on = await bed({ baseTemplateTag: "review-shared-architecture:base" });
      try {
        for (const image of on.edge.images.values()) image.arch = arch;
        const port = serviceOn(on, () => new Response("ok"));
        const box = await makeBox(on, "architecture");
        const res = await fetch(`${on.base}/box/architecture/${port}/`, { headers: { cookie: on.cookie } });
        expect(res.status).toBe(200);
        await res.text();
        expect(on.edge.containerFile(box.id, RELAY_PATHS[0] ?? "")?.data.readUInt16LE(18)).toBe(machine);
      } finally {
        on.stop();
      }
    }
  });

  test("a running box uses its image ID even after the template tag changes", async () => {
    const on = await bed({ baseTemplateTag: "review-mutable-tag:base" });
    try {
      const port = serviceOn(on, () => new Response("ok"));
      const box = await makeBox(on, "tag-changed");
      const inspect = on.edge.inspectImage.bind(on.edge);
      on.edge.inspectImage = async (ref) => {
        const details = await inspect(ref);
        return ref === on.app.cfg.baseTemplateTag ? { ...details, arch: "aarch64" } : details;
      };
      // Legacy specs must also inspect the running container's image ID, not the mutable tag.
      const spec = on.app.hosts.get("edge").specs.read(box.boxId);
      if (!spec) throw new Error("box spec missing");
      on.app.hosts.get("edge").specs.write({ ...spec, template: { ...spec.template, digest: null } });
      const res = await fetch(`${on.base}/box/tag-changed/${port}/`, { headers: { cookie: on.cookie } });
      expect(res.status).toBe(200);
      await res.text();
      expect(on.edge.containerFile(box.id, RELAY_PATHS[0] ?? "")?.data.readUInt16LE(18)).toBe(62);
      expect(on.edge.callsTo("inspectImage").at(-1)?.args[0]).toBe(spec.template.digest);
    } finally {
      on.stop();
    }
  });

  test("a binary child that cannot execute falls back and later connections skip it", async () => {
    const on = await bed();
    try {
      const normal = on.edge.startExec.bind(on.edge);
      let scripts = 0;
      let binaries = 0;
      on.edge.startExec = async (id, spec) => {
        if (RELAY_PATHS.includes(spec.cmd[0] ?? "")) {
          binaries += 1;
          return localExec("/bin/sh", ["-c", "echo 'relay: Permission denied' >&2; exit 126"]);
        }
        if (spec.cmd[0] === "python3") scripts += 1;
        return normal(id, spec);
      };
      const port = serviceOn(on, () => new Response("ok", { headers: { connection: "close" } }));
      await makeBox(on, "fallback");
      for (let call = 0; call < 2; call += 1) {
        const res = await fetch(`${on.base}/box/fallback/${port}/`, { headers: { cookie: on.cookie } });
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("ok");
      }
      expect(binaries).toBe(2);
      expect(scripts).toBe(2);
    } finally {
      on.stop();
    }
  });

  test("a missing cached binary is placed again before falling back", async () => {
    const on = await bed();
    try {
      const normal = on.edge.startExec.bind(on.edge);
      let binaries = 0;
      let scripts = 0;
      on.edge.startExec = async (id, spec) => {
        if (RELAY_PATHS.includes(spec.cmd[0] ?? "")) {
          binaries += 1;
          if (binaries === 2) return localExec("/bin/sh", ["-c", "echo 'relay: not found' >&2; exit 127"]);
        }
        if (spec.cmd[0] === "python3") scripts += 1;
        return normal(id, spec);
      };
      const port = serviceOn(on, () => new Response("ok", { headers: { connection: "close" } }));
      await makeBox(on, "replace-missing");
      for (let call = 0; call < 2; call += 1) {
        const res = await fetch(`${on.base}/box/replace-missing/${port}/`, { headers: { cookie: on.cookie } });
        expect(res.status).toBe(200);
        await res.text();
      }
      expect(binaries).toBe(3);
      expect(scripts).toBe(0);
      expect(on.edge.callsTo("writeContainerFile")).toHaveLength(2);
    } finally {
      on.stop();
    }
  });

  test("a valid upstream refusal does not reinstall the binary or try python3", async () => {
    const on = await bed();
    try {
      await makeBox(on, "upstream-refused");
      const port = closedPort();
      const res = await fetch(`${on.base}/box/upstream-refused/${port}/`, { headers: { cookie: on.cookie } });
      expect(res.status).toBe(502);
      expect(await res.text()).toContain("refused");
      expect(on.relays).toHaveLength(1);
      expect(RELAY_PATHS.includes(on.relays[0]?.[0] ?? "")).toBe(true);
      expect(on.edge.callsTo("writeContainerFile")).toHaveLength(1);
    } finally {
      on.stop();
    }
  });

  test("parallel first connections share one placement", async () => {
    const on = await bed();
    try {
      const normal = on.edge.writeContainerFile.bind(on.edge);
      on.edge.writeContainerFile = async (...args) => {
        await Bun.sleep(50);
        return normal(...args);
      };
      const port = serviceOn(on, () => new Response("ok"));
      await makeBox(on, "parallel");
      await Promise.all(
        [1, 2, 3].map(async (n) => {
          const res = await fetch(`${on.base}/box/parallel/${port}/${n}`, { headers: { cookie: on.cookie } });
          expect(res.status).toBe(200);
          expect(await res.text()).toBe("ok");
        }),
      );
      expect(on.edge.callsTo("writeContainerFile")).toHaveLength(1);
      expect(on.relays).toHaveLength(3);
    } finally {
      on.stop();
    }
  });

  test("the binary relay is reported once per container, and later connections stay silent", async () => {
    const on = await bed();
    try {
      const port = serviceOn(on, () => new Response("ok", { headers: { connection: "close" } }));
      const box = await makeBox(on, "binary-logged");

      for (let call = 0; call < 3; call += 1) {
        const res = await fetch(`${on.base}/box/binary-logged/${port}/`, { headers: { cookie: on.cookie } });
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("ok");
      }

      // All three connections ran the placed binary, and only the first one said so.
      expect(on.relays).toHaveLength(3);
      expect(RELAY_PATHS.includes(on.relays[0]?.[0] ?? "")).toBe(true);
      const lines = on.relayLines.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        level: "debug",
        msg: "preview.relay_selected",
        port,
        relay: "binary",
        host: "edge",
      });
      expect(lines[0]?.box).toBe(box.boxId);
    } finally {
      on.stop();
    }
  });

  test("a binary that fails and falls back to python3 reports the fallback once", async () => {
    const on = await bed();
    try {
      const normal = on.edge.startExec.bind(on.edge);
      on.edge.startExec = async (id, spec) => {
        if (RELAY_PATHS.includes(spec.cmd[0] ?? "")) {
          on.relays.push(spec.cmd);
          return localExec("/bin/sh", ["-c", "echo 'relay: Permission denied' >&2; exit 126"]);
        }
        return normal(id, spec);
      };
      const port = serviceOn(on, () => new Response("ok", { headers: { connection: "close" } }));
      await makeBox(on, "python-logged");

      for (let call = 0; call < 2; call += 1) {
        const res = await fetch(`${on.base}/box/python-logged/${port}/`, { headers: { cookie: on.cookie } });
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("ok");
      }

      // Two binaries were tried, then the second connection ran the script; the fallback is said once.
      expect(on.relays.filter((cmd) => RELAY_PATHS.includes(cmd[0] ?? ""))).toHaveLength(2);
      expect(on.relays.filter((cmd) => cmd[0] === "python3")).toHaveLength(2);
      const lines = on.relayLines.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        level: "debug",
        msg: "preview.relay_selected",
        port,
        relay: "python3",
        host: "edge",
      });
      expect(lines[0]?.box).toBeTruthy();
    } finally {
      on.stop();
    }
  });

  test("a binary relay that cannot reach the port is still reported as the binary", async () => {
    const on = await bed();
    try {
      const port = closedPort();
      await makeBox(on, "binary-refused");

      for (let call = 0; call < 2; call += 1) {
        const res = await fetch(`${on.base}/box/binary-refused/${port}/`, { headers: { cookie: on.cookie } });
        expect(res.status).toBe(502);
        await res.text();
      }

      // The binary answered `err`, so it is what the traffic used, and the refusal does not turn into a fallback.
      expect(on.relays.every((cmd) => RELAY_PATHS.includes(cmd[0] ?? ""))).toBe(true);
      const lines = on.relayLines.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ level: "debug", msg: "preview.relay_selected", port, relay: "binary" });
    } finally {
      on.stop();
    }
  });
});

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
      on.edge.writeContainerFile = async (_id, path) => {
        throw new Error(`cp: cannot create regular file '${path}': No such file or directory`);
      };
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
