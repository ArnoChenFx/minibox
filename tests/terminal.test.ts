import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Server } from "bun";

import type { App } from "../src/app";
import { RuntimeError } from "../src/runtime";
import { startServer } from "../src/server";
import type { TerminalData } from "../src/ws/terminal";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

const AUTH = { authorization: `Bearer ${TEST_KEY}` };
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
  server.stop(true);
  restoreLogs();
});

async function createBox(name: string): Promise<string> {
  const res = await fetch(`${base}/api/boxes`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ name, cpus: 1, memoryMb: 256 }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { box: { id: string } }).box.id;
}

function connect(path: string): {
  opened: Promise<void>;
  closed: Promise<CloseEvent>;
  ws: WebSocket;
  output: () => string;
} {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}${path}`, { headers: AUTH });
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
