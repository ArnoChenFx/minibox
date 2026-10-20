import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Server } from "bun";

import type { App } from "../src/app";
import { COOKIE_NAME } from "../src/auth";
import { RuntimeError } from "../src/runtime";
import { startServer } from "../src/server";
import { parseControl, type TerminalData } from "../src/ws/terminal";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

const AUTH = { authorization: `Bearer ${TEST_KEY}` };
const sessionCookie = (token: string) => ({ cookie: `${COOKIE_NAME}=${token}` });
const UPGRADE = {
  connection: "Upgrade",
  upgrade: "websocket",
  "sec-websocket-version": "13",
  "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
};

let app: App;
let runtime: FakeRuntime;
let server: Server<TerminalData>;
let base: string;
let restoreLogs: () => void;

beforeEach(() => {
  restoreLogs = silenceLogs();
  ({ app, runtime } = createTestApp({ labelPrefix: "mbtest" }));
  runtime.seedImage(app.cfg.baseTemplateTag, { [app.hosts.get().keys.template]: "true" });
  server = startServer(app);
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  app.sessions.stop();
  server.stop(true);
  restoreLogs();
});

/** A browser session that is live now and ends `endsInMs` from now, so expiry can be reached within a test. */
function signedInSession(endsInMs = app.cfg.sessionTtlMs): { token: string; id: string } {
  const { token, session } = app.sessions.create(
    { userAgent: "test", ip: "127.0.0.1" },
    Date.now() + endsInMs - app.cfg.sessionTtlMs,
  );
  return { token, id: session.id };
}

async function createBox(name: string): Promise<string> {
  const res = await fetch(`${base}/api/boxes`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ name, cpus: 1, memoryMb: 256 }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { box: { id: string } }).box.id;
}

function connect(
  path: string,
  headers: Record<string, string> = AUTH,
): {
  opened: Promise<void>;
  closed: Promise<CloseEvent>;
  ws: WebSocket;
  output: () => string;
} {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}${path}`, { headers });
  ws.binaryType = "arraybuffer";
  let text = "";
  ws.addEventListener("message", (event) => {
    text += typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("websocket failed before opening")));
  });
  const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener("close", resolve));
  return { opened, closed, ws, output: () => text };
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

describe("terminal upgrade is refused before any exec starts", () => {
  test("without the access key", async () => {
    const id = await createBox("alpha");
    const res = await fetch(`${base}/api/boxes/${id}/terminal`, { headers: UPGRADE });
    expect(res.status).toBe(401);
    expect(runtime.callsTo("startExec")).toHaveLength(0);
  });

  test("for a stopped box, with 409 and a translation key", async () => {
    const id = await createBox("alpha");
    await fetch(`${base}/api/boxes/${id}/stop`, { method: "POST", headers: AUTH });

    const res = await fetch(`${base}/api/boxes/${id}/terminal`, { headers: { ...UPGRADE, ...AUTH } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "conflict", key: "terminal_not_running" } });
    expect(runtime.callsTo("startExec")).toHaveLength(0);
  });

  test("for a container that is not a MiniBox box", async () => {
    const id = runtime.seedContainer({ image: app.cfg.baseTemplateTag, name: "plain", running: true });
    const res = await fetch(`${base}/api/boxes/${id}/terminal`, { headers: { ...UPGRADE, ...AUTH } });
    expect(res.status).toBe(404);
    expect(runtime.callsTo("startExec")).toHaveLength(0);
  });

  test("for a box whose container was created but never started", async () => {
    const keys = app.hosts.get().keys;
    const id = runtime.seedContainer({
      image: app.cfg.baseTemplateTag,
      name: "mbtest-fresh",
      labels: { [keys.box]: "true", [keys.name]: "fresh" },
      running: false,
    });
    const res = await fetch(`${base}/api/boxes/${id}/terminal`, { headers: { ...UPGRADE, ...AUTH } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "conflict", key: "terminal_not_running" } });
    expect(runtime.callsTo("startExec")).toHaveLength(0);
  });
});

describe("terminal authentication and origin", () => {
  test("a wrong Bearer key is refused with 401 before any exec starts", async () => {
    const id = await createBox("alpha");
    const res = await fetch(`${base}/api/boxes/${id}/terminal`, {
      headers: { ...UPGRADE, authorization: `Bearer ${"x".repeat(TEST_KEY.length)}` },
    });
    expect(res.status).toBe(401);
    expect(runtime.callsTo("startExec")).toHaveLength(0);
  });

  test("a wrong session cookie is refused with 401 before any exec starts", async () => {
    const id = await createBox("alpha");
    const res = await fetch(`${base}/api/boxes/${id}/terminal`, {
      headers: { ...UPGRADE, cookie: `${COOKIE_NAME}=${"x".repeat(TEST_KEY.length)}` },
    });
    expect(res.status).toBe(401);
    expect(runtime.callsTo("startExec")).toHaveLength(0);
  });

  test("the session cookie from the console opens a terminal without a Bearer key", async () => {
    const id = await createBox("alpha");
    const term = connect(`/api/boxes/${id}/terminal`, { cookie: `${COOKIE_NAME}=${TEST_KEY}` });
    await term.opened;
    await waitFor(() => term.output().includes("$ "), "the shell prompt");
    expect(runtime.callsTo("startExec")).toHaveLength(1);
    term.ws.close(1000, "done");
    await term.closed;
  });

  test("a same-origin browser upgrade with valid credentials is accepted", async () => {
    const id = await createBox("alpha");
    const term = connect(`/api/boxes/${id}/terminal`, { ...AUTH, origin: base });
    await term.opened;
    await waitFor(() => term.output().includes("$ "), "the shell prompt");
    term.ws.close(1000, "done");
    await term.closed;
  });

  test.each([
    ["a foreign Origin", { origin: "https://evil.example" }],
    ["a cross-site Fetch Metadata header", { "sec-fetch-site": "cross-site" }],
  ])("%s is refused with 403 even with valid credentials and the session cookie", async (_name, site) => {
    const id = await createBox("alpha");
    const res = await fetch(`${base}/api/boxes/${id}/terminal`, {
      headers: { ...UPGRADE, ...AUTH, cookie: `${COOKIE_NAME}=${TEST_KEY}`, ...site },
    });
    expect(res.status).toBe(403);
    expect(runtime.callsTo("startExec")).toHaveLength(0);
  });
});

describe("parseControl", () => {
  test("reads resize frames and clamps them to the terminal limits", () => {
    expect(parseControl('{"type":"resize","cols":80,"rows":24}')).toEqual({ type: "resize", cols: 80, rows: 24 });
    expect(parseControl('{"type":"resize","cols":9999,"rows":1}')).toEqual({ type: "resize", cols: 500, rows: 5 });
    expect(parseControl('{"type":"resize","cols":-4,"rows":999}')).toEqual({ type: "resize", cols: 10, rows: 200 });
  });

  test.each([
    ["plain keystrokes", "ls -la\r"],
    ["a lone brace", "{"],
    ["a brace-led line that is not JSON", "{a,b}"],
    ["JSON that is not an object", "null"],
    ["a JSON array holding a frame", '[{"type":"resize","cols":80,"rows":24}]'],
    ["an unknown control type", '{"type":"ping","cols":80,"rows":24}'],
    ["a frame missing a dimension", '{"type":"resize","cols":80}'],
    ["dimensions sent as strings", '{"type":"resize","cols":"80","rows":"24"}'],
    ["fractional dimensions", '{"type":"resize","cols":80.5,"rows":24}'],
  ])("treats %s as stdin", (_name, data) => {
    expect(parseControl(data)).toBeNull();
  });
});

describe("terminal session", () => {
  test("bridges input and output, forwards resize, and closes with 1000 when the shell exits", async () => {
    const id = await createBox("alpha");
    const term = connect(`/api/boxes/${id}/terminal`);
    await term.opened;
    await waitFor(() => term.output().includes("$ "), "the shell prompt");

    const exec = runtime.execs[0];
    if (!exec) throw new Error("no exec was started");
    expect(exec).toMatchObject({ containerId: id });
    expect(exec.spec).toEqual({
      cmd: ["/bin/sh", "-c", "command -v bash >/dev/null && exec bash -l || exec sh -l"],
      env: ["TERM=xterm-256color", "LANG=C.UTF-8"],
      workingDir: "/workspace",
    });

    term.ws.send("echo hi\n");
    await waitFor(() => term.output().includes("echo hi\n"), "echoed input");

    term.ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await waitFor(() => exec.sizes.length === 1, "the resize");
    expect(exec.sizes).toEqual([{ cols: 120, rows: 40 }]);

    exec.exit(0);
    const close = await term.closed;
    expect(close.code).toBe(1000);
    expect(close.reason).toBe("session ended");
  });

  test("resize frames are clamped to the terminal limits", async () => {
    const id = await createBox("alpha");
    const term = connect(`/api/boxes/${id}/terminal`);
    await term.opened;
    await waitFor(() => term.output().includes("$ "), "the shell prompt");
    const exec = runtime.execs[0];
    if (!exec) throw new Error("no exec was started");

    term.ws.send(JSON.stringify({ type: "resize", cols: 9999, rows: 1 }));
    await waitFor(() => exec.sizes.length === 1, "the resize");
    expect(exec.sizes).toEqual([{ cols: 500, rows: 5 }]);
    term.ws.close(1000, "done");
    await term.closed;
  });

  test("control frames are consumed by the server and never reach the shell", async () => {
    const id = await createBox("alpha");
    const term = connect(`/api/boxes/${id}/terminal`);
    await term.opened;
    await waitFor(() => term.output().includes("$ "), "the shell prompt");
    const exec = runtime.execs[0];
    if (!exec) throw new Error("no exec was started");

    term.ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    term.ws.send("pwd\n");
    await waitFor(() => term.output().includes("pwd\n"), "echoed input");
    expect(exec.sizes).toEqual([{ cols: 100, rows: 30 }]);
    expect(term.output()).not.toContain('"type"');
    term.ws.close(1000, "done");
    await term.closed;
  });

  test("an exec start failure is written to the terminal and closes with 1011", async () => {
    const id = await createBox("alpha");
    runtime.fail("startExec", new RuntimeError("engine", "exec refused", "exec refused"));

    const term = connect(`/api/boxes/${id}/terminal`);
    await term.opened;
    const close = await term.closed;
    expect(close.code).toBe(1011);
    expect(term.output()).toContain("Failed to start terminal: exec refused");
  });
});

describe("terminal with a browser session", () => {
  test("a session cookie opens a shell, and signing out closes it with 1008", async () => {
    const id = await createBox("alpha");
    const { token } = signedInSession();
    const term = connect(`/api/boxes/${id}/terminal`, sessionCookie(token));
    await term.opened;
    await waitFor(() => term.output().includes("$ "), "the shell prompt");
    const exec = runtime.execs[0];
    if (!exec) throw new Error("no exec was started");

    const logout = await fetch(`${base}/api/auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json", ...sessionCookie(token) },
      body: "{}",
    });
    expect(logout.status).toBe(200);
    const close = await term.closed;
    expect(close.code).toBe(1008);
    expect(close.reason).toBe("signed out");
    await waitFor(() => exec.stream.destroyed, "the shell stream to close");
  });

  test("a session that was signed out cannot open a terminal", async () => {
    const id = await createBox("alpha");
    const { token, id: sessionId } = signedInSession();
    expect(app.sessions.revoke(sessionId, "test")).toBe(true);

    const res = await fetch(`${base}/api/boxes/${id}/terminal`, { headers: { ...UPGRADE, ...sessionCookie(token) } });
    expect(res.status).toBe(401);
    expect(runtime.callsTo("startExec")).toHaveLength(0);
  });

  test("a terminal closes with 1008 once its session expires and the store sweeps", async () => {
    const id = await createBox("alpha");
    const { token } = signedInSession(500);
    const term = connect(`/api/boxes/${id}/terminal`, sessionCookie(token));
    await term.opened;
    await waitFor(() => term.output().includes("$ "), "the shell prompt");

    await Bun.sleep(600);
    app.sessions.sweep();
    const close = await term.closed;
    expect(close.code).toBe(1008);
    expect(close.reason).toBe("signed out");
  });

  test("typing in a terminal counts as use of its session", async () => {
    const id = await createBox("alpha");
    const { token, id: sessionId } = signedInSession();
    const term = connect(`/api/boxes/${id}/terminal`, sessionCookie(token));
    await term.opened;
    await waitFor(() => term.output().includes("$ "), "the shell prompt");
    const before = app.sessions.list().find((s) => s.id === sessionId)?.lastSeenAt ?? 0;

    await Bun.sleep(5);
    term.ws.send("pwd\n");
    await waitFor(() => (app.sessions.list().find((s) => s.id === sessionId)?.lastSeenAt ?? 0) > before, "the touch");
    term.ws.close(1000, "done");
    await term.closed;
  });

  test("a terminal opened with the access key is not tied to any browser session", async () => {
    const id = await createBox("alpha");
    signedInSession();
    const term = connect(`/api/boxes/${id}/terminal`);
    await term.opened;
    await waitFor(() => term.output().includes("$ "), "the shell prompt");

    app.sessions.revokeOthers(null);
    await Bun.sleep(50);
    expect(term.ws.readyState).toBe(WebSocket.OPEN);
    term.ws.close(1000, "done");
    await term.closed;
  });
});
