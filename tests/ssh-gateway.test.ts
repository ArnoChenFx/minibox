import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Server } from "bun";
import type { Client, ClientChannel, ConnectConfig } from "ssh2";

import type { App } from "../src/app";
import { COOKIE_NAME } from "../src/auth";
import type { AuditEvent } from "../src/operations/executor";
import { RuntimeError } from "../src/runtime";
import { startServer } from "../src/server";
import { getBox, stopBox } from "../src/services/boxes";
import type { SocketData } from "../src/ws/socket";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";
import { fingerprintOf, openShell, openSsh, runCommand } from "./support/ssh";
import { call, mint } from "./support/tokens";

const AUTH = { authorization: `Bearer ${TEST_KEY}` };

let app: App;
let runtime: FakeRuntime;
let server: Server<SocketData>;
let base: string;
let port: number;
let audits: AuditEvent[];
let restoreLogs: () => void;
const opened: { close(): void }[] = [];

beforeEach(() => {
  restoreLogs = silenceLogs();
  audits = [];
  ({ app, runtime } = createTestApp({ labelPrefix: "mbtest" }, undefined, { audit: (event) => audits.push(event) }));
  runtime.seedImage(app.cfg.baseTemplateTag, { [app.hosts.get().keys.template]: "true" });
  server = startServer(app);
  port = server.port ?? 0;
  base = `http://127.0.0.1:${port}`;
});

afterEach(() => {
  for (const item of opened.splice(0)) item.close();
  app.sessions.stop();
  app.tokens.stop();
  app.throttle.stop();
  server.stop(true);
  restoreLogs();
});

const wsUrl = (path: string) => `ws://127.0.0.1:${port}${path}`;

async function waitFor(check: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
}

async function makeBox(name: string): Promise<{ id: string; boxId: string; name: string }> {
  const res = await call(base, "/api/boxes", { body: { name, cpus: 1, memoryMb: 256 } });
  expect(res.status).toBe(201);
  const box = res.json.box;
  if (!box) throw new Error("the box was not created");
  return box;
}

/** Opens the SSH WebSocket as `token` (the access key when omitted), as the ProxyCommand does. */
async function connectSsh(name: string, token = TEST_KEY, user = "dev", extra: Partial<ConnectConfig> = {}) {
  const connection = await openSsh(
    wsUrl(`/api/ssh/${encodeURIComponent(name)}`),
    { authorization: `Bearer ${token}` },
    { username: user, hostVerifier: () => true, ...extra },
  );
  opened.push({ close: () => connection.client.end() });
  return connection;
}

interface Attempt {
  readonly status: number;
  readonly body: string;
}

/** One upgrade request sent raw, so a test reads the refusal's status and body as a client would. */
function upgradeAttempt(path: string, headers: Record<string, string> = {}): Promise<Attempt> {
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
    let raw = "";
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open: (socket) => {
          socket.write(request);
        },
        data: (socket, chunk) => {
          raw += new TextDecoder().decode(chunk);
          const end = raw.indexOf("\r\n\r\n");
          if (end === -1) return;
          const head = raw.slice(0, end);
          const status = Number(head.split(" ")[1]);
          const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
          const body = raw.slice(end + 4);
          if (status === 101 || Buffer.byteLength(body) >= length) {
            socket.end();
            resolve({ status, body });
          }
        },
        error: (_socket, error) => reject(error),
        close: () => undefined,
      },
    }).catch(reject);
  });
}

const statusOf = async (path: string, headers?: Record<string, string>) => (await upgradeAttempt(path, headers)).status;

const errorKeyOf = (attempt: Attempt) => (JSON.parse(attempt.body) as { error: { key: string } }).error.key;

const detailOf = (event: AuditEvent): Record<string, unknown> => event.detail as Record<string, unknown>;

function refusals(type: string): AuditEvent[] {
  return audits.filter(
    (event) => event.op === "ssh.channel" && event.status === "denied" && detailOf(event).type === type,
  );
}

function forwardTo(client: Client, host: string, port: number): Promise<ClientChannel> {
  return new Promise((resolve, reject) =>
    client.forwardOut("127.0.0.1", 1, host, port, (error, stream) => (error ? reject(error) : resolve(stream))),
  );
}

describe("SSH handshake and scope", () => {
  test("the owner's access key runs an exec as dev and returns its output and status", async () => {
    const box = await makeBox("alpha");
    runtime.execScript = { stdout: "hello\n", stderr: "warn\n", code: 3 };
    const { client } = await connectSsh(box.name);
    const result = await runCommand(client, "echo hello");
    expect(result).toEqual({ stdout: "hello\n", stderr: "warn\n", code: 3 });
    const exec = runtime.execs.at(-1);
    expect(exec?.spec.user).toBe("dev");
    expect(exec?.spec.workingDir).toBe("/workspace");
    expect(exec?.spec.tty).toBe(false);
    expect(exec?.spec.cmd.at(-1)).toBe("echo hello");
    expect(audits.some((event) => event.op === "ssh.connect" && event.status === "ok")).toBe(true);
  });

  test("the box id works as the SSH user, and root and other names are refused and audited", async () => {
    const box = await makeBox("bravo");
    await connectSsh(box.name, TEST_KEY, box.boxId);
    await expect(connectSsh(box.name, TEST_KEY, "root")).rejects.toThrow();
    await expect(connectSsh(box.name, TEST_KEY, "ubuntu")).rejects.toThrow();
    const refusedUsers = audits
      .filter((event) => event.op === "ssh.connect" && event.status === "denied")
      .map((event) => detailOf(event).user);
    expect(refusedUsers).toEqual(["root", "ubuntu"]);
  });

  test("a missing or unknown credential is refused with 401 before any SSH byte is read", async () => {
    const box = await makeBox("charlie");
    expect(await statusOf(`/api/ssh/${box.name}`)).toBe(401);
    expect(await statusOf(`/api/ssh/${box.name}`, { authorization: "Bearer nope" })).toBe(401);
  });

  test("a browser session cannot open an SSH connection", async () => {
    const box = await makeBox("delta");
    const { token } = app.sessions.create({ userAgent: "test", ip: "127.0.0.1" });
    expect(await statusOf(`/api/ssh/${box.name}`, { cookie: `${COOKIE_NAME}=${token}` })).toBe(401);
  });

  test("a token without box:ssh is refused with 403 and the ssh_forbidden key", async () => {
    const box = await makeBox("echo");
    const sandbox = mint(app, { name: "sandbox", preset: "sandboxed-agent", boxes: { type: "all" } });
    const attempt = await upgradeAttempt(`/api/ssh/${box.name}`, { authorization: `Bearer ${sandbox.secret}` });
    expect(attempt.status).toBe(403);
    expect(errorKeyOf(attempt)).toBe("ssh_forbidden");
  });

  test("a token with box:ssh cannot open a box it cannot see", async () => {
    const box = await makeBox("foxtrot");
    const ops = mint(app, { name: "ops", scopes: ["box:ssh"] });
    expect(await statusOf(`/api/ssh/${box.name}`, { authorization: `Bearer ${ops.secret}` })).toBe(403);
    const all = mint(app, { name: "all", scopes: ["box:ssh"], boxes: { type: "all" } });
    expect(await statusOf(`/api/ssh/${box.name}`, { authorization: `Bearer ${all.secret}` })).toBe(101);
  });

  test("an unknown box is a 404 at the handshake", async () => {
    expect(await statusOf("/api/ssh/no-such-box", AUTH)).toBe(404);
  });

  test("a text frame closes the socket with 1003, since SSH bytes are binary", async () => {
    const box = await makeBox("golf");
    const ws = new WebSocket(wsUrl(`/api/ssh/${box.name}`), { headers: AUTH });
    opened.push({ close: () => ws.close() });
    const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener("close", resolve));
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    ws.send("not ssh");
    expect((await closed).code).toBe(1003);
  });

  test("the handshake proves the published host key", async () => {
    const box = await makeBox("hotel");
    let seen = "";
    await connectSsh(box.name, TEST_KEY, "dev", {
      hostVerifier: (key: Buffer) => {
        seen = fingerprintOf(key);
        return true;
      },
    });
    expect(seen).toBe(app.ssh.hostKeyView().fingerprint);
  });

  test("a plain GET of the SSH path runs the same checks without waking the box", async () => {
    const box = await makeBox("quebec");
    await stopBox(app.hosts.get(), box.boxId, "idle");
    const allowed = await fetch(`${base}/api/ssh/${box.name}`, { headers: AUTH });
    expect(allowed.status).toBe(204);
    expect((await getBox(app.hosts.get(), box.boxId)).running).toBe(false);
    const sandbox = mint(app, { name: "probe-sandbox", preset: "sandboxed-agent", boxes: { type: "all" } });
    const refused = await fetch(`${base}/api/ssh/${box.name}`, {
      headers: { authorization: `Bearer ${sandbox.secret}` },
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { key: string } }).error.key).toBe("ssh_forbidden");
  });

  test("a stopped box is started by the connection, and the wake is audited", async () => {
    const box = await makeBox("india");
    await stopBox(app.hosts.get(), box.boxId, "idle");
    expect((await getBox(app.hosts.get(), box.boxId)).running).toBe(false);
    await connectSsh(box.name);
    expect((await getBox(app.hosts.get(), box.boxId)).running).toBe(true);
    expect(audits.some((event) => event.op === "box.wake")).toBe(true);
  });
});

describe("SSH channels", () => {
  test("a shell gets a pty, passes window changes to the process, and ends with its exit status", async () => {
    const box = await makeBox("juliet");
    const { client } = await connectSsh(box.name);
    const stream = await openShell(client, true);
    const exec = runtime.execs.findLast((item) => item.spec.tty === true);
    expect(exec?.spec.user).toBe("dev");
    expect(exec?.spec.env).toContain("TERM=xterm-256color");
    let echoed = "";
    stream.on("data", (chunk: Buffer) => {
      echoed += chunk.toString("utf8");
    });
    stream.write("ls-typed\n");
    await waitFor(() => echoed.includes("ls-typed"), "the echoed input");
    stream.setWindow(30, 100, 0, 0);
    await waitFor(() => exec?.sizes.at(-1)?.cols === 100, "the window change");
    expect(exec?.sizes.at(-1)).toEqual({ cols: 100, rows: 30 });
    const exited = new Promise<number | null>((resolve) => stream.on("exit", (code: number | null) => resolve(code)));
    exec?.exit(0);
    expect(await exited).toBe(0);
  });

  test("a shell with no pty runs without a terminal", async () => {
    const box = await makeBox("kilo");
    const { client } = await connectSsh(box.name);
    await openShell(client, false);
    expect(runtime.execs.findLast((item) => item.spec.tty === true)).toBeUndefined();
    expect(runtime.execs.at(-1)?.spec.tty).toBe(false);
  });

  test("environment variables outside the allowlist never reach the box", async () => {
    const box = await makeBox("env-box");
    const { client } = await connectSsh(box.name);
    runtime.execScript = null;
    client.exec("true", { env: { LD_PRELOAD: "/tmp/evil.so", LANG: "en_US.UTF-8" } }, () => undefined);
    await waitFor(() => runtime.execs.length > 0, "the exec to start");
    const env = runtime.execs.at(-1)?.spec.env ?? [];
    expect(env).toContain("LANG=en_US.UTF-8");
    expect(env.some((entry) => entry.startsWith("LD_PRELOAD="))).toBe(false);
  });

  test("X11 forwarding is refused and audited, and the client sees the refusal", async () => {
    const box = await makeBox("xray");
    const { client } = await connectSsh(box.name);
    runtime.execScript = null;
    const outcome = await new Promise<Error | undefined>((resolve) =>
      client.exec("true", { x11: true }, (error) => resolve(error)),
    );
    expect(outcome).toBeInstanceOf(Error);
    expect(refusals("x11").length).toBe(1);
  });

  test("agent forwarding is refused and audited", async () => {
    const box = await makeBox("yankee");
    const { client } = await connectSsh(box.name, TEST_KEY, "dev", {
      agent: "/nonexistent-minibox-agent.sock",
      agentForward: true,
    });
    client.exec("true", () => undefined);
    await waitFor(() => refusals("auth-agent").length > 0, "the agent refusal");
  });

  test("the sftp subsystem runs the box's sftp-server as dev, and any other subsystem is refused", async () => {
    const box = await makeBox("lima");
    const { client } = await connectSsh(box.name);
    runtime.execScript = null;
    await new Promise<void>((resolve, reject) => client.subsys("sftp", (error) => (error ? reject(error) : resolve())));
    await waitFor(
      () => runtime.execs.some((item) => item.spec.cmd.join(" ").includes("sftp-server")),
      "the sftp-server exec",
    );
    const sftp = runtime.execs.find((item) => item.spec.cmd.join(" ").includes("sftp-server"));
    expect(sftp?.spec.user).toBe("dev");
    expect(sftp?.spec.tty).toBe(false);
    await expect(
      new Promise<void>((resolve, reject) => client.subsys("netconf", (error) => (error ? reject(error) : resolve()))),
    ).rejects.toThrow();
    expect(refusals("subsystem").length).toBe(1);
  });

  test("a local forward reaches the box's loopback through an in-box socat relay", async () => {
    const box = await makeBox("mike");
    const { client } = await connectSsh(box.name);
    runtime.execScript = null;
    const channel = await forwardTo(client, "127.0.0.1", 8080);
    const relay = runtime.execs.at(-1);
    expect(relay?.spec.cmd).toEqual(["socat", "-", "TCP4:127.0.0.1:8080"]);
    expect(relay?.spec.user).toBe("dev");
    const received = new Promise<string>((resolve) =>
      channel.once("data", (chunk: Buffer) => resolve(chunk.toString())),
    );
    relay?.print("pong");
    expect(await received).toBe("pong");
    channel.end();
  });

  test("a forward is refused without port:expose, to another host, or to an invalid port", async () => {
    const box = await makeBox("november");
    const shellOnly = mint(app, { name: "shell-only", scopes: ["box:ssh"], boxes: { type: "all" } });
    const { client: shell } = await connectSsh(box.name, shellOnly.secret);
    await expect(forwardTo(shell, "127.0.0.1", 8080)).rejects.toThrow();
    const { client: owner } = await connectSsh(box.name);
    await expect(forwardTo(owner, "db.internal", 5432)).rejects.toThrow();
    await expect(forwardTo(owner, "127.0.0.1", 70000)).rejects.toThrow();
    expect(refusals("forward").length).toBe(3);
  });

  test("remote forwards (-R) are refused and audited", async () => {
    const box = await makeBox("oscar");
    const { client } = await connectSsh(box.name);
    await expect(
      new Promise((resolve, reject) =>
        client.forwardIn("127.0.0.1", 9000, (error) => (error ? reject(error) : resolve(null))),
      ),
    ).rejects.toThrow();
    expect(refusals("tcpip-forward")).toHaveLength(1);
  });

  test("Unix socket forwards are refused and audited", async () => {
    const box = await makeBox("victor");
    const { client } = await connectSsh(box.name);
    await expect(
      new Promise((resolve, reject) =>
        client.openssh_forwardOutStreamLocal("/tmp/app.sock", (error, stream) =>
          error ? reject(error) : resolve(stream),
        ),
      ),
    ).rejects.toThrow();
    expect(refusals("direct-streamlocal@openssh.com")).toHaveLength(1);
  });

  test("a connection holds at most 16 channels", async () => {
    const box = await makeBox("papa");
    const { client } = await connectSsh(box.name);
    runtime.execScript = null;
    for (let i = 0; i < 16; i += 1) {
      await new Promise<void>((resolve, reject) =>
        client.exec("sleep 100", (error) => (error ? reject(error) : resolve())),
      );
    }
    await expect(
      new Promise((resolve, reject) => client.exec("sleep 100", (error) => (error ? reject(error) : resolve(null)))),
    ).rejects.toThrow();
  });

  test("a command that fails to start reports the reason on stderr and exits 1", async () => {
    const box = await makeBox("quebec");
    const { client } = await connectSsh(box.name);
    runtime.fail("startExec", new RuntimeError("engine", "boom", "the engine refused"));
    const result = await runCommand(client, "true");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("minibox: the engine refused");
  });
});

describe("SSH lifecycle", () => {
  test("a revoked token closes its connection with 1008", async () => {
    const box = await makeBox("romeo");
    const ops = mint(app, { name: "ops", scopes: ["box:ssh"], boxes: { type: "all" } });
    const ws = new WebSocket(wsUrl(`/api/ssh/${box.name}`), { headers: { authorization: `Bearer ${ops.secret}` } });
    opened.push({ close: () => ws.close() });
    const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener("close", resolve));
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    app.tokens.revoke(ops.id);
    expect((await closed).code).toBe(1008);
  });

  test("an open connection keeps its box awake until the client disconnects", async () => {
    const box = await makeBox("tango");
    expect(app.ssh.hasOpenConnection(box.boxId)).toBe(false);
    const { client } = await connectSsh(box.name);
    await waitFor(() => app.ssh.hasOpenConnection(box.boxId), "the connection to be counted");
    client.end();
    await waitFor(() => !app.ssh.hasOpenConnection(box.boxId), "the connection to leave the count");
  });

  test("ending the connection stops the processes it started and audits the disconnect", async () => {
    const box = await makeBox("sierra");
    const { client } = await connectSsh(box.name);
    runtime.execScript = null;
    client.exec("sleep 100", () => undefined);
    await waitFor(() => runtime.execs.length > 0, "the command to start");
    const sleeper = runtime.execs.at(-1);
    client.end();
    await waitFor(() => sleeper?.killed === true, "the sleeping command to be stopped");
    await waitFor(() => audits.some((event) => event.op === "ssh.disconnect"), "the disconnect audit");
  });

  test("typing counts as activity for the box, and repeated typing is throttled to one touch", async () => {
    const box = await makeBox("uniform");
    const { client } = await connectSsh(box.name);
    const stream = await openShell(client, true);
    let echoed = "";
    stream.on("data", (chunk: Buffer) => {
      echoed += chunk.toString("utf8");
    });
    app.pulse.clear(box.boxId);
    stream.write("a");
    await waitFor(() => echoed.includes("a"), "the first keystroke to be echoed");
    const first = app.pulse.lastAt(box.boxId);
    expect(first).not.toBeNull();
    stream.write("b");
    await waitFor(() => echoed.includes("b"), "the second keystroke to be echoed");
    expect(app.pulse.lastAt(box.boxId)).toBe(first);
  });

  test("at most 8 connections per box, then 429 with the ssh_box_limit key", async () => {
    const box = await makeBox("victor");
    for (let i = 0; i < 8; i += 1) {
      const ws = new WebSocket(wsUrl(`/api/ssh/${box.name}`), { headers: AUTH });
      opened.push({ close: () => ws.close() });
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error("refused")));
      });
    }
    const refused = await upgradeAttempt(`/api/ssh/${box.name}`, AUTH);
    expect(refused.status).toBe(429);
    expect(errorKeyOf(refused)).toBe("ssh_box_limit");
  });

  test("the host key route publishes the fingerprint and public key, never the private key", async () => {
    const reply = await call(base, "/api/ssh/host-key");
    expect(reply.status).toBe(200);
    expect(reply.json as unknown).toEqual({
      algorithm: "ssh-ed25519",
      fingerprint: app.ssh.hostKeyView().fingerprint,
      publicKey: expect.stringMatching(/^ssh-ed25519 [A-Za-z0-9+/=]+$/),
    });
    expect(JSON.stringify(reply.json)).not.toContain("PRIVATE KEY");
    const ops = mint(app, { name: "ops", scopes: ["box:ssh"] });
    expect((await call(base, "/api/ssh/host-key", { token: ops.secret })).status).toBe(200);
    const readonly = mint(app, { name: "ro", preset: "readonly" });
    expect((await call(base, "/api/ssh/host-key", { token: readonly.secret })).status).toBe(403);
  });
});
