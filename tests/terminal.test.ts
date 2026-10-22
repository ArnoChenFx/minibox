import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Server, ServerWebSocket, Socket } from "bun";

import type { App } from "../src/app";
import { COOKIE_NAME, LEGACY_KEY_COOKIE } from "../src/auth";
import type { StoredEvent } from "../src/events/store";
import type { Source } from "../src/events/types";
import { OWNER } from "../src/operations/types";
import { RuntimeError } from "../src/runtime";
import { startServer } from "../src/server";
import { getBox, sleepBox } from "../src/services/boxes";
import { type TerminalData, parseControl, terminalHandlers } from "../src/ws/terminal";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import type { FakeExec, FakeRuntime } from "./support/fake-runtime";
import { mint } from "./support/tokens";

const AUTH = { authorization: `Bearer ${TEST_KEY}` };
const sessionCookie = (token: string) => ({ cookie: `${COOKIE_NAME}=${token}` });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
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
  app.tokens.stop();
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

async function createBox(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await fetch(`${base}/api/boxes`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ name, cpus: 1, memoryMb: 256, ...extra }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { box: { id: string } }).box.id;
}

/** Starts a tmux session the way the API does: `ui` makes a session the person owns, anything else the agent. */
async function startSession(id: string, name: string, source: Source): Promise<void> {
  const host = app.hosts.get();
  await app.terminals.start(host, await getBox(host, id), name, source);
}

/** The attach process of the last terminal opened in the box. The attach is the only TTY tmux exec. */
function attachExec(): FakeExec | undefined {
  return runtime.execs.findLast((exec) => exec.spec.tty === true && exec.spec.cmd[0] === "tmux");
}

function connect(
  path: string,
  headers: Record<string, string> = AUTH,
): {
  opened: Promise<void>;
  closed: Promise<CloseEvent>;
  ws: WebSocket;
  output: () => string;
  frames: () => Record<string, unknown>[];
} {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}${path}`, { headers });
  ws.binaryType = "arraybuffer";
  let screen = "";
  const frames: Record<string, unknown>[] = [];
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") frames.push(JSON.parse(event.data) as Record<string, unknown>);
    else screen += new TextDecoder().decode(event.data);
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("websocket failed before opening")));
  });
  const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener("close", resolve));
  return { opened, closed, ws, output: () => screen, frames: () => frames };
}

/** The last state frame the socket sent, which says who controls the session and what this viewer may do. */
function lastState(term: ReturnType<typeof connect>): Record<string, unknown> | undefined {
  return term.frames().findLast((frame) => frame.type === "state");
}

/** Opens an upgrade by hand, so a test can drop the TCP connection without a close frame. */
function rawUpgrade(path: string, headers: Record<string, string>): Promise<Socket> {
  const port = server.port;
  if (port === undefined) throw new Error("server is not listening");
  const request = [
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    ...Object.entries({ ...UPGRADE, ...headers }).map(([name, value]) => `${name}: ${value}`),
    "",
    "",
  ].join("\r\n");
  return new Promise((resolve, reject) => {
    let head = "";
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open: (socket) => {
          socket.write(request);
        },
        data: (socket, chunk) => {
          head += new TextDecoder().decode(chunk);
          if (!head.includes("\r\n\r\n")) return;
          if (head.startsWith("HTTP/1.1 101")) resolve(socket);
          else reject(new Error(head.split("\r\n")[0]));
        },
        error: (_socket, error) => reject(error),
        close: () => undefined,
      },
    }).catch(reject);
  });
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
    const res = await fetch(`${base}/api/boxes/${id}/terminal?session=work`, { headers: UPGRADE });
    expect(res.status).toBe(401);
    expect(runtime.callsTo("startExec")).toHaveLength(0);
  });

  test("for a stopped box, with 409 and a translation key", async () => {
    const id = await createBox("alpha");
    await fetch(`${base}/api/boxes/${id}/stop`, { method: "POST", headers: AUTH });

    const res = await fetch(`${base}/api/boxes/${id}/terminal?session=work`, {
      headers: { ...UPGRADE, ...AUTH },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "conflict", key: "terminal_not_running" } });
    expect(runtime.callsTo("startExec")).toHaveLength(0);
  });

  test("for a container that is not a MiniBox box", async () => {
    const id = runtime.seedContainer({ image: app.cfg.baseTemplateTag, name: "plain", running: true });
    const res = await fetch(`${base}/api/boxes/${id}/terminal?session=work`, { headers: { ...UPGRADE, ...AUTH } });
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
    const res = await fetch(`${base}/api/boxes/${id}/terminal?session=work`, { headers: { ...UPGRADE, ...AUTH } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "conflict", key: "terminal_not_running" } });
    expect(runtime.callsTo("startExec")).toHaveLength(0);
  });

  test("without a session name, or with one that is not a valid name", async () => {
    const id = await createBox("alpha");
    for (const path of [`/api/boxes/${id}/terminal`, `/api/boxes/${id}/terminal?session=bad%20name!`]) {
      const res = await fetch(`${base}${path}`, { headers: { ...UPGRADE, ...AUTH } });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "validation_failed", key: "session_name_invalid" } });
    }
    expect(runtime.callsTo("startExec")).toHaveLength(0);
  });
});

describe("terminal authentication and origin", () => {
  test("a wrong Bearer key is refused with 401 before any exec starts", async () => {
    const id = await createBox("alpha");
    const res = await fetch(`${base}/api/boxes/${id}/terminal?session=work`, {
      headers: { ...UPGRADE, authorization: `Bearer ${"x".repeat(TEST_KEY.length)}` },
    });
    expect(res.status).toBe(401);
    expect(runtime.callsTo("startExec")).toHaveLength(0);
  });

  test("a wrong session cookie is refused with 401 before any exec starts", async () => {
    const id = await createBox("alpha");
    const res = await fetch(`${base}/api/boxes/${id}/terminal?session=work`, {
      headers: { ...UPGRADE, cookie: `${COOKIE_NAME}=${"x".repeat(TEST_KEY.length)}` },
    });
    expect(res.status).toBe(401);
    expect(runtime.callsTo("startExec")).toHaveLength(0);
  });

  test("the access key in the legacy cookie is never honoured, so the upgrade is refused with 401", async () => {
    const id = await createBox("alpha");
    const res = await fetch(`${base}/api/boxes/${id}/terminal?session=work`, {
      headers: { ...UPGRADE, cookie: `${LEGACY_KEY_COOKIE}=${TEST_KEY}` },
    });
    expect(res.status).toBe(401);
    expect(runtime.callsTo("startExec")).toHaveLength(0);
  });

  test("the session from the console's sign-in opens a same-origin terminal without a Bearer key", async () => {
    const id = await createBox("alpha");
    const token = await signIn();
    await startSession(id, "work", "ui");
    const term = connect(`/api/boxes/${id}/terminal?session=work`, { cookie: `${COOKIE_NAME}=${token}`, origin: base });
    await term.opened;
    await waitFor(() => lastState(term) !== undefined, "the state frame");
    term.ws.close(1000, "done");
    await term.closed;
  });

  test("a same-origin browser upgrade with valid credentials is accepted", async () => {
    const id = await createBox("alpha");
    await startSession(id, "work", "rest");
    const term = connect(`/api/boxes/${id}/terminal?session=work`, { ...AUTH, origin: base });
    await term.opened;
    await waitFor(() => lastState(term) !== undefined, "the state frame");
    term.ws.close(1000, "done");
    await term.closed;
  });

  test.each([
    ["a foreign Origin", { origin: "https://evil.example" }],
    ["a cross-site Fetch Metadata header", { "sec-fetch-site": "cross-site" }],
  ])("%s is refused with 403 even with valid credentials and the session cookie", async (_name, site) => {
    const id = await createBox("alpha");
    const { token } = signedInSession();
    const res = await fetch(`${base}/api/boxes/${id}/terminal?session=work`, {
      headers: { ...UPGRADE, ...AUTH, cookie: `${COOKIE_NAME}=${token}`, ...site },
    });
    expect(res.status).toBe(403);
    expect(runtime.callsTo("startExec")).toHaveLength(0);
  });
});

describe("the minibox-init session is kept for a credential that may use secrets", () => {
  test("an operator token, which may open terminals, is refused it with 403, and no exec starts", async () => {
    const id = await createBox("alpha");
    const operator = mint(app, { name: "operator", preset: "operator", boxes: { type: "all" } });
    const execsBefore = runtime.callsTo("startExec").length;
    const res = await fetch(`${base}/api/boxes/${id}/terminal?session=minibox-init`, {
      headers: { ...UPGRADE, ...bearer(operator.secret) },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "forbidden", key: "startup_session_forbidden" } });
    expect(runtime.callsTo("startExec")).toHaveLength(execsBefore);
  });

  test("a token with exec and secret:use opens it", async () => {
    const id = await createBox("alpha");
    await startSession(id, "minibox-init", "rest");
    const holder = mint(app, { name: "holder", scopes: ["exec", "box:read", "secret:use"], boxes: { type: "all" } });
    const term = connect(`/api/boxes/${id}/terminal?session=minibox-init`, bearer(holder.secret));
    await term.opened;
    await waitFor(() => lastState(term) !== undefined, "the state frame");
    term.ws.close(1000, "done");
    await term.closed;
  });
});

describe("parseControl", () => {
  test("reads resize frames and clamps them to the terminal limits", () => {
    expect(parseControl('{"type":"resize","cols":80,"rows":24}')).toEqual({ type: "resize", cols: 80, rows: 24 });
    expect(parseControl('{"type":"resize","cols":9999,"rows":1}')).toEqual({ type: "resize", cols: 500, rows: 5 });
    expect(parseControl('{"type":"resize","cols":-4,"rows":999}')).toEqual({ type: "resize", cols: 10, rows: 200 });
  });

  test("reads takeover and release frames", () => {
    expect(parseControl('{"type":"takeover"}')).toEqual({ type: "takeover" });
    expect(parseControl('{"type":"release"}')).toEqual({ type: "release" });
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
  ])("treats %s as input", (_name, data) => {
    expect(parseControl(data)).toBeNull();
  });
});

describe("terminal session with the console", () => {
  test("bridges input and output, forwards resize, and closes with 1000 when the session ends", async () => {
    const id = await createBox("alpha");
    const { token } = signedInSession();
    await startSession(id, "work", "ui");
    const term = connect(`/api/boxes/${id}/terminal?session=work`, sessionCookie(token));
    await term.opened;
    await waitFor(() => lastState(term)?.canType === true, "a state frame that lets the console type");

    const attach = attachExec();
    if (!attach) throw new Error("no attach exec was started");
    expect(attach.spec).toEqual({
      cmd: ["tmux", "-u", "attach-session", "-t", "=work"],
      env: ["TERM=xterm-256color", "LANG=C.UTF-8"],
      workingDir: "/",
      user: "dev",
      tty: true,
    });

    term.ws.send("echo hi\n");
    await waitFor(() => term.output().includes("echo hi"), "echoed input");

    term.ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await waitFor(() => attach.sizes.length === 1, "the resize");
    expect(attach.sizes).toEqual([{ cols: 120, rows: 40 }]);

    const ended = await fetch(`${base}/api/boxes/${id}/sessions/work`, {
      method: "DELETE",
      headers: { ...sessionCookie(token), origin: base },
    });
    expect(ended.status).toBe(200);
    const close = await term.closed;
    expect(close.code).toBe(1000);
    expect(close.reason).toBe("session ended");
  });

  test("resize frames are clamped to the terminal limits", async () => {
    const id = await createBox("alpha");
    const { token } = signedInSession();
    await startSession(id, "work", "ui");
    const term = connect(`/api/boxes/${id}/terminal?session=work`, sessionCookie(token));
    await term.opened;
    await waitFor(() => lastState(term) !== undefined, "the state frame");
    const attach = attachExec();
    if (!attach) throw new Error("no attach exec was started");

    term.ws.send(JSON.stringify({ type: "resize", cols: 9999, rows: 1 }));
    await waitFor(() => attach.sizes.length === 1, "the resize");
    expect(attach.sizes).toEqual([{ cols: 500, rows: 5 }]);
    term.ws.close(1000, "done");
    await term.closed;
  });

  test("a bearer terminal attaches read-only and ignoring size, and its resize frames are dropped", async () => {
    const id = await createBox("alpha");
    await startSession(id, "work", "rest");
    const term = connect(`/api/boxes/${id}/terminal?session=work`);
    await term.opened;
    await waitFor(() => lastState(term) !== undefined, "the state frame");
    const attach = attachExec();
    if (!attach) throw new Error("no attach exec was started");
    expect(attach.spec.cmd).toEqual(["tmux", "-u", "attach-session", "-r", "-f", "ignore-size", "-t", "=work"]);

    term.ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    term.ws.send("typed");
    await waitFor(() => term.frames().some((f) => f.type === "error"), "the refusal that follows the resize");
    expect(attach.sizes).toEqual([]);
    term.ws.close(1000, "done");
    await term.closed;
  });

  test("an agent's DELETE is refused with 409 while a person holds the session, and the console's DELETE closes it", async () => {
    const id = await createBox("alpha");
    const { token } = signedInSession();
    await startSession(id, "work", "rest");
    const term = connect(`/api/boxes/${id}/terminal?session=work`, sessionCookie(token));
    await term.opened;
    await waitFor(() => lastState(term)?.canTakeOver === true, "the console may take the session over");
    term.ws.send('{"type":"takeover"}');
    await waitFor(() => lastState(term)?.controller === "human", "the takeover");

    const refused = await fetch(`${base}/api/boxes/${id}/sessions/work`, { method: "DELETE", headers: AUTH });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: { code: "taken_over", retryable: true, details: { session: "work" } },
    });
    expect(runtime.tmux.sessionNames(id)).toEqual(["work"]);

    const closed = await fetch(`${base}/api/boxes/${id}/sessions/work`, {
      method: "DELETE",
      headers: { ...sessionCookie(token), origin: base },
    });
    expect(closed.status).toBe(200);
    expect(runtime.tmux.sessionNames(id)).toEqual([]);
    expect((await term.closed).code).toBe(1000);
  });

  test("control frames are consumed by the server and never reach the session", async () => {
    const id = await createBox("alpha");
    const { token } = signedInSession();
    await startSession(id, "work", "ui");
    const term = connect(`/api/boxes/${id}/terminal?session=work`, sessionCookie(token));
    await term.opened;
    await waitFor(() => lastState(term)?.canType === true, "a state frame that lets the console type");
    const attach = attachExec();
    if (!attach) throw new Error("no attach exec was started");

    term.ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    term.ws.send("pwd\n");
    await waitFor(() => term.output().includes("pwd"), "echoed input");
    expect(attach.sizes).toEqual([{ cols: 100, rows: 30 }]);
    expect(runtime.tmux.paneText(id, "work")).not.toContain('"type"');
    term.ws.close(1000, "done");
    await term.closed;
  });

  test("an attach failure is sent as a structured error and closes with 1011", async () => {
    const id = await createBox("alpha");
    await startSession(id, "work", "rest");
    runtime.fail("startExec", new RuntimeError("engine", "exec refused", "exec refused"));

    const term = connect(`/api/boxes/${id}/terminal?session=work`);
    await term.opened;
    const close = await term.closed;
    expect(close.code).toBe(1011);
    expect(term.frames()).toContainEqual({
      type: "error",
      error: expect.objectContaining({ code: "docker_error" }),
    });
  });

  test("a box whose image cannot run sessions sends the image error, with its hint, and closes with 1011", async () => {
    const id = await createBox("alpha");
    await startSession(id, "work", "rest");
    const refusal = "unable to find user dev: no matching entries in passwd file";
    runtime.fail("startExec", new RuntimeError("engine", refusal, refusal));

    const term = connect(`/api/boxes/${id}/terminal?session=work`);
    await term.opened;
    const close = await term.closed;
    expect(close.code).toBe(1011);
    expect(term.frames()).toContainEqual({
      type: "error",
      error: expect.objectContaining({
        code: "conflict",
        key: "session_image_unsupported",
        hintKey: "session_image_unsupported_hint",
      }),
    });
  });

  test("a session that does not exist is refused with its 404 and closes with 1011", async () => {
    const id = await createBox("alpha");
    const term = connect(`/api/boxes/${id}/terminal?session=missing`);
    await term.opened;
    const close = await term.closed;
    expect(close.code).toBe(1011);
    expect(term.frames()).toContainEqual({
      type: "error",
      error: expect.objectContaining({ code: "not_found", key: "session_not_found" }),
    });
  });
});

describe("terminal viewed by the agent's session", () => {
  test("a Bearer terminal is read-only: typing is refused and nothing reaches the session", async () => {
    const id = await createBox("alpha");
    await startSession(id, "work", "rest");
    const term = connect(`/api/boxes/${id}/terminal?session=work`);
    await term.opened;
    await waitFor(() => lastState(term) !== undefined, "the state frame");
    expect(lastState(term)).toMatchObject({ controller: "agent", canType: false, canTakeOver: false });

    term.ws.send("echo leak\n");
    await waitFor(() => term.frames().some((f) => f.type === "error"), "the refusal");
    expect(term.frames()).toContainEqual({
      type: "error",
      error: expect.objectContaining({ code: "forbidden", key: "terminal_read_only" }),
    });
    expect(runtime.tmux.paneText(id, "work")).not.toContain("echo leak");
    term.ws.close(1000, "done");
    await term.closed;
  });

  test("a Bearer terminal cannot take a session over or hand it back", async () => {
    const id = await createBox("alpha");
    await startSession(id, "work", "rest");
    const term = connect(`/api/boxes/${id}/terminal?session=work`);
    await term.opened;
    await waitFor(() => lastState(term) !== undefined, "the state frame");

    term.ws.send('{"type":"takeover"}');
    await waitFor(() => term.frames().some((f) => f.type === "error"), "the refusal");
    expect(lastState(term)).toMatchObject({ controller: "agent" });
    term.ws.close(1000, "done");
    await term.closed;
  });

  test("the console takes a session over, types into it, and hands it back", async () => {
    const id = await createBox("alpha");
    const { token } = signedInSession();
    await startSession(id, "work", "rest");
    const term = connect(`/api/boxes/${id}/terminal?session=work`, sessionCookie(token));
    await term.opened;
    await waitFor(() => lastState(term) !== undefined, "the state frame");
    expect(lastState(term)).toMatchObject({ controller: "agent", canType: false, canTakeOver: true });

    term.ws.send('{"type":"takeover"}');
    await waitFor(() => lastState(term)?.controller === "human", "the takeover");
    expect(lastState(term)).toMatchObject({ controller: "human", takenOver: true, canType: true, canRelease: true });

    const refused = await fetch(`${base}/api/boxes/${id}/sessions/work/input`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ text: "agent input\n" }),
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "taken_over", retryable: true } });

    term.ws.send("human input\n");
    await waitFor(() => term.output().includes("human input"), "the human's input");

    term.ws.send('{"type":"release"}');
    await waitFor(() => lastState(term)?.controller === "agent", "the hand-back");
    expect(lastState(term)).toMatchObject({ controller: "agent", takenOver: false, canType: false });
    term.ws.close(1000, "done");
    await term.closed;
  });

  test("a dropped socket with no close frame ends its attach inside the box and keeps the tmux session", async () => {
    const id = await createBox("alpha");
    await startSession(id, "work", "rest");
    const socket = await rawUpgrade(`/api/boxes/${id}/terminal?session=work`, AUTH);
    await waitFor(() => attachExec() !== undefined, "the attach exec");
    const attach = attachExec();
    if (!attach) throw new Error("no attach exec was started");

    socket.terminate();
    await waitFor(() => attach.killed, "the attach exec to be killed");
    expect(attach.killed).toBe(true);
    expect(runtime.tmux.sessionNames(id)).toEqual(["work"]);
  });

  test("a terminal opened with the access key is not tied to any browser session", async () => {
    const id = await createBox("alpha");
    await startSession(id, "work", "rest");
    signedInSession();
    const term = connect(`/api/boxes/${id}/terminal?session=work`);
    await term.opened;
    await waitFor(() => lastState(term) !== undefined, "the state frame");

    app.sessions.revokeOthers(null);
    await Bun.sleep(50);
    expect(term.ws.readyState).toBe(WebSocket.OPEN);
    term.ws.close(1000, "done");
    await term.closed;
  });
});

describe("terminal with a browser session", () => {
  test("a session cookie opens a terminal, and signing out closes it with 1008", async () => {
    const id = await createBox("alpha");
    const { token } = signedInSession();
    await startSession(id, "work", "ui");
    const term = connect(`/api/boxes/${id}/terminal?session=work`, sessionCookie(token));
    await term.opened;
    await waitFor(() => lastState(term) !== undefined, "the state frame");
    const attach = attachExec();
    if (!attach) throw new Error("no attach exec was started");

    const logout = await fetch(`${base}/api/auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json", ...sessionCookie(token) },
      body: "{}",
    });
    expect(logout.status).toBe(200);
    const close = await term.closed;
    expect(close.code).toBe(1008);
    expect(close.reason).toBe("signed out");
    await waitFor(() => attach.killed, "the attach exec to be killed");
  });

  test("a session that was signed out cannot open a terminal", async () => {
    const id = await createBox("alpha");
    const { token, id: sessionId } = signedInSession();
    expect(app.sessions.revoke(sessionId, "test")).toBe(true);

    const res = await fetch(`${base}/api/boxes/${id}/terminal?session=work`, {
      headers: { ...UPGRADE, ...sessionCookie(token) },
    });
    expect(res.status).toBe(401);
    expect(runtime.callsTo("startExec")).toHaveLength(0);
  });

  test("a terminal closes with 1008 once its session expires and the store sweeps", async () => {
    const id = await createBox("alpha");
    const { token } = signedInSession(500);
    await startSession(id, "work", "ui");
    const term = connect(`/api/boxes/${id}/terminal?session=work`, sessionCookie(token));
    await term.opened;
    await waitFor(() => lastState(term) !== undefined, "the state frame");

    await Bun.sleep(600);
    app.sessions.sweep();
    const close = await term.closed;
    expect(close.code).toBe(1008);
    expect(close.reason).toBe("signed out");
  });

  test("typing in a terminal counts as use of its session", async () => {
    const id = await createBox("alpha");
    const { token, id: sessionId } = signedInSession();
    await startSession(id, "work", "ui");
    const term = connect(`/api/boxes/${id}/terminal?session=work`, sessionCookie(token));
    await term.opened;
    await waitFor(() => lastState(term)?.canType === true, "a state frame that lets the console type");
    const before = app.sessions.list().find((s) => s.id === sessionId)?.lastSeenAt ?? 0;

    await Bun.sleep(5);
    term.ws.send("pwd\n");
    await waitFor(() => (app.sessions.list().find((s) => s.id === sessionId)?.lastSeenAt ?? 0) > before, "the touch");
    term.ws.close(1000, "done");
    await term.closed;
  });
});

describe("terminal with an agent token", () => {
  test("a token without exec is refused the terminal before any exec starts", async () => {
    const id = await createBox("alpha");
    await startSession(id, "work", "rest");
    const token = mint(app, { name: "no-exec", scopes: ["box:read", "box:write"], boxes: { type: "all" } });
    const execsBefore = runtime.callsTo("startExec").length;

    const res = await fetch(`${base}/api/boxes/${id}/terminal?session=work`, {
      headers: { ...UPGRADE, ...bearer(token.secret) },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { key: "box_out_of_scope" } });
    expect(runtime.callsTo("startExec")).toHaveLength(execsBefore);
  });

  test("a token's terminal closes with 1008 when the token is revoked, and its attach is torn down", async () => {
    const id = await createBox("alpha");
    await startSession(id, "work", "rest");
    const token = mint(app, { name: "viewer", preset: "operator", boxes: { type: "all" } });
    const term = connect(`/api/boxes/${id}/terminal?session=work`, bearer(token.secret));
    await term.opened;
    await waitFor(() => lastState(term) !== undefined, "the state frame");
    const attach = attachExec();
    if (!attach) throw new Error("no attach exec was started");

    const revoked = await fetch(`${base}/api/tokens/${token.id}`, { method: "DELETE", headers: AUTH });
    expect(revoked.status).toBe(200);
    const close = await term.closed;
    expect(close.code).toBe(1008);
    expect(close.reason).toBe("token revoked");
    await waitFor(() => attach.killed, "the attach exec to be killed");
  });

  test("a token's terminal is a viewer: its takeover is refused and the session stays with the agent", async () => {
    const id = await createBox("alpha");
    await startSession(id, "work", "rest");
    const token = mint(app, { name: "viewer", preset: "operator", boxes: { type: "all" } });
    const term = connect(`/api/boxes/${id}/terminal?session=work`, bearer(token.secret));
    await term.opened;
    await waitFor(() => lastState(term) !== undefined, "the state frame");

    term.ws.send(JSON.stringify({ type: "takeover" }));
    await waitFor(() => term.frames().some((frame) => frame.type === "error"), "the refusal");
    expect(lastState(term)).toMatchObject({
      canType: false,
      canTakeOver: false,
      controller: "agent",
      takenOver: false,
    });
    term.ws.close(1000, "done");
    await term.closed;
  });
});

describe("terminal backpressure", () => {
  test("output pauses when the socket reports backpressure and resumes once it drains", async () => {
    const id = await createBox("alpha");
    await startSession(id, "work", "rest");
    const host = app.hosts.get();
    let status = -1;
    const sent: unknown[] = [];
    const closed: unknown[] = [];
    const ws = {
      data: {
        boxId: id,
        box: await getBox(host, id),
        host,
        name: "work",
        source: "rest",
        sessionId: null,
        principal: OWNER,
      },
      send: (frame: unknown) => {
        sent.push(frame);
        return status;
      },
      close: (...args: unknown[]) => closed.push(args),
    } as unknown as ServerWebSocket<TerminalData>;
    const handlers = terminalHandlers({ sessions: app.sessions, tokens: app.tokens, terminals: app.terminals });
    await handlers.open(ws);
    const attach = attachExec();
    if (!attach) throw new Error("no attach exec was started");

    attach.print("a long screen\n");
    await waitFor(() => sent.length >= 2, "the first output frame");
    expect(attach.stream.isPaused()).toBe(true);

    status = 1024;
    handlers.drain(ws);
    expect(attach.stream.isPaused()).toBe(false);
    await handlers.close(ws);
    expect(attach.killed).toBe(true);
    expect(closed).toEqual([]);
  });
});

/** Puts a box's creation time far enough back that its TTL has run out, as a long-lived box would be. */
function backdate(name: string, ms: number): void {
  const host = app.hosts.get();
  const spec = host.specs.findByName(name);
  if (!spec) throw new Error(`no spec for ${name}`);
  host.specs.write({ ...spec, createdAt: new Date(Date.now() - ms).toISOString() });
}

describe("terminal and idle sleep (#12)", () => {
  test("an upgrade wakes an idle-sleeping box and audits the wake, and a session started after it attaches", async () => {
    const id = await createBox("alpha");
    const host = app.hosts.get();
    await startSession(id, "work", "rest");
    expect(await sleepBox(host, id, "idle")).toBe(true);
    const starts = runtime.callsTo("startContainer").length;
    const published: StoredEvent[] = [];
    app.bus.subscribe("event", (event) => published.push(event));

    const lost = connect(`/api/boxes/${id}/terminal?session=work`, AUTH);
    await lost.opened;
    expect((await lost.closed).code).toBe(1011);
    expect(lost.frames()).toContainEqual(
      expect.objectContaining({ type: "error", error: expect.objectContaining({ key: "session_not_found" }) }),
    );
    expect(runtime.callsTo("startContainer")).toHaveLength(starts + 1);
    expect(await getBox(host, id)).toMatchObject({ running: true, sleeping: false });
    expect(published.find((event) => event.op === "box.wake")).toMatchObject({
      source: "rest",
      detail: { from: "idle" },
    });

    await startSession(id, "work", "rest");
    const term = connect(`/api/boxes/${id}/terminal?session=work`, AUTH);
    await term.opened;
    await waitFor(() => lastState(term) !== undefined, "the state frame");
    term.ws.close(1000, "done");
    await term.closed;
  });

  test("an upgrade for a sleeping box whose TTL has expired is refused with 409, and starts nothing", async () => {
    const id = await createBox("alpha", { ttlSec: 60 });
    backdate("alpha", 120_000);
    expect(await sleepBox(app.hosts.get(), id, "ttl")).toBe(true);
    const starts = runtime.callsTo("startContainer").length;

    const res = await fetch(`${base}/api/boxes/${id}/terminal?session=work`, { headers: { ...UPGRADE, ...AUTH } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "conflict", key: "box_ttl_expired" } });
    expect(runtime.callsTo("startContainer")).toHaveLength(starts);
    expect(await getBox(app.hosts.get(), id)).toMatchObject({ running: false, sleeping: true, stopReason: "ttl" });
  });

  test("a session name that is not valid does not wake a sleeping box", async () => {
    const id = await createBox("alpha");
    await startSession(id, "work", "rest");
    expect(await sleepBox(app.hosts.get(), id, "idle")).toBe(true);
    const starts = runtime.callsTo("startContainer").length;

    const res = await fetch(`${base}/api/boxes/${id}/terminal?session=bad%20name!`, {
      headers: { ...UPGRADE, ...AUTH },
    });
    expect(res.status).toBe(400);
    expect(runtime.callsTo("startContainer")).toHaveLength(starts);
    expect(await getBox(app.hosts.get(), id)).toMatchObject({ running: false, sleeping: true });
  });

  test("a token without box:session is refused before a sleeping box wakes", async () => {
    const id = await createBox("alpha");
    await startSession(id, "work", "rest");
    expect(await sleepBox(app.hosts.get(), id, "idle")).toBe(true);
    const starts = runtime.callsTo("startContainer").length;
    const token = mint(app, { name: "reader", scopes: ["box:read", "box:write"], boxes: { type: "all" } });

    const res = await fetch(`${base}/api/boxes/${id}/terminal?session=work`, {
      headers: { ...UPGRADE, ...bearer(token.secret) },
    });
    expect(res.status).toBe(403);
    expect(runtime.callsTo("startContainer")).toHaveLength(starts);
    expect(await getBox(app.hosts.get(), id)).toMatchObject({ running: false, sleeping: true });
  });

  test("an open browser terminal is an attachment until it closes, and typing in it refreshes the heartbeat", async () => {
    const id = await createBox("alpha");
    await startSession(id, "work", "ui");
    const { token } = signedInSession();
    const box = await getBox(app.hosts.get(), id);
    const term = connect(`/api/boxes/${id}/terminal?session=work`, sessionCookie(token));
    await term.opened;
    await waitFor(() => lastState(term)?.canType === true, "a state frame that lets the console type");
    expect(app.terminals.hasOpenAttachment(box.id)).toBe(true);

    app.pulse.touch(box.boxId, "exec", Date.now() - 600_000);
    term.ws.send("pwd\n");
    await waitFor(() => (app.pulse.lastAt(box.boxId) ?? 0) > Date.now() - 5_000, "the typing to refresh the heartbeat");

    term.ws.close(1000, "done");
    await term.closed;
    await waitFor(() => !app.terminals.hasOpenAttachment(box.id), "the attachment to close");
  });
});
