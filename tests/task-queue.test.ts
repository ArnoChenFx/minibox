import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { App } from "../src/app";
import { createRedactor } from "../src/events/redact";
import { ulid } from "../src/events/ulid";
import type { HelperSpec } from "../src/runtime";
import { startServer } from "../src/server";
import { TaskManager } from "../src/tasks/manager";
import { TaskStore } from "../src/tasks/store";
import type { NewTask, TaskError, TaskStreamEvent } from "../src/tasks/types";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

const KEY = "tool.write:local";

function toolTask(subject: string, extra: Partial<NewTask> = {}): NewTask {
  return {
    op: "tool.install",
    summary: `Install ${subject}`,
    subject,
    hostId: "local",
    target: { kind: "box", id: "box1", name: "alpha" },
    principal: { type: "owner", id: "owner", name: "owner" },
    source: "rest",
    exclusiveKey: KEY,
    queue: true,
    ...extra,
  };
}

const noop = (): void => {};

const interrupted: TaskError = { code: "interrupted", message: "The server stopped.", status: 500 };

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("the condition was not met in time");
    await Bun.sleep(5);
  }
}

describe("TaskStore queue", () => {
  let dir: string;
  let store: TaskStore | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "minibox-task-queue-"));
  });

  afterEach(() => {
    store?.close();
    store = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const open = () => (store = new TaskStore(join(dir, "tasks.db")));

  test("a queued task waits behind the holder and starts in the order it was queued", () => {
    const s = open();
    const [a, b, c] = [ulid(), ulid(), ulid()];
    expect(s.insert(a, toolTask("codex"))).toEqual({ ok: true });
    expect(s.insert(b, toolTask("claude-code"))).toEqual({ ok: true, queued: true });
    expect(s.insert(c, toolTask("gemini"))).toEqual({ ok: true, queued: true });
    expect(s.get(b, { output: false })?.status).toBe("queued");

    expect(s.promote(KEY)).toBeUndefined();
    s.finish(a, { status: "succeeded" });
    expect(s.promote(KEY)).toBeUndefined();
    s.releaseLock(a);
    expect(s.promote(KEY)?.taskId).toBe(b);
    expect(s.get(b, { output: false })?.status).toBe("running");
    expect(s.get(c, { output: false })?.status).toBe("queued");
    s.finish(b, { status: "succeeded" });
    s.releaseLock(b);
    expect(s.promote(KEY)?.taskId).toBe(c);
  });

  test("a task that repeats one queued or running returns that task, and a different tool is queued", () => {
    const s = open();
    const [a, b] = [ulid(), ulid()];
    s.insert(a, toolTask("codex"));
    s.insert(b, toolTask("claude-code"));
    expect(s.insert(ulid(), toolTask("codex"))).toEqual({ ok: false, existingId: a, duplicate: true });
    expect(s.insert(ulid(), toolTask("claude-code"))).toEqual({ ok: false, existingId: b, duplicate: true });
    expect(s.insert(ulid(), toolTask("codex", { op: "tool.uninstall" }))).toEqual({ ok: true, queued: true });
    expect(s.insert(ulid(), toolTask("codex", { target: { kind: "box", id: "box2", name: "beta" } }))).toEqual({
      ok: true,
      queued: true,
    });
  });

  test("a promotion writes a running status event after the task's earlier events", () => {
    const s = open();
    const [a, b] = [ulid(), ulid()];
    s.insert(a, toolTask("codex"));
    s.insert(b, toolTask("claude-code"));
    s.finish(a, { status: "succeeded" });
    s.releaseLock(a);
    const promoted = s.promote(KEY);
    expect(promoted?.event).toMatchObject({ taskId: b, kind: "status", status: "running" });
    expect(s.after(b, 0, 10).map((event) => event.kind === "status" && event.status)).toEqual(["running"]);
  });

  test("a queued task can be cancelled, and startup interrupts queued tasks with the running ones", () => {
    const s = open();
    const [a, b, c] = [ulid(), ulid(), ulid()];
    s.insert(a, toolTask("codex"));
    s.insert(b, toolTask("claude-code"));
    s.insert(c, toolTask("gemini"));
    expect(s.finish(b, { status: "cancelled", error: { code: "cancelled", message: "x", status: 409 } })).toBeDefined();
    expect(s.interruptRunning(interrupted)).toBe(2);
    expect(s.get(c, { output: false })?.status).toBe("interrupted");
    expect(s.insert(ulid(), toolTask("codex"))).toEqual({ ok: true });
  });

  test("an operation that does not queue is still refused while the key is held", () => {
    const s = open();
    const a = ulid();
    s.insert(a, toolTask("codex"));
    expect(s.insert(ulid(), toolTask("claude-code", { queue: undefined }))).toEqual({ ok: false, existingId: a });
  });
});

describe("TaskManager queue", () => {
  let dir: string;
  let manager: TaskManager;
  let events: TaskStreamEvent[];
  let releases: (() => void)[];
  let stopped: boolean;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "minibox-task-queue-"));
    events = [];
    releases = [];
    stopped = false;
    manager = new TaskManager(new TaskStore(join(dir, "tasks.db")), createRedactor(), (event) => events.push(event));
  });

  afterEach(async () => {
    for (const release of releases) release();
    if (!stopped) await manager.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Begins a task whose work waits for its turn, records that it ran, then waits for `release`. */
  function start(subject: string, order: string[]) {
    const begun = manager.begin(toolTask(subject));
    if (begun.duplicate) throw new Error("unexpected duplicate");
    let release = noop;
    const gate = new Promise<void>((resolve) => (release = resolve));
    releases.push(release);
    manager.track(
      begun.id,
      (async () => {
        try {
          await manager.turn(begun.id);
        } catch {
          return;
        }
        order.push(subject);
        await gate;
        manager.finish(begun.id, { status: "succeeded" });
      })(),
    );
    return { id: begun.id, release };
  }

  test("queued work runs one at a time, in order, each after the one before has ended", async () => {
    const order: string[] = [];
    const a = start("codex", order);
    const b = start("claude-code", order);
    const c = start("gemini", order);
    await Bun.sleep(10);
    expect(order).toEqual(["codex"]);
    a.release();
    await waitFor(() => order.length === 2);
    expect(order).toEqual(["codex", "claude-code"]);
    expect(manager.get(c.id, { output: false })?.status).toBe("queued");
    b.release();
    await waitFor(() => order.length === 3);
    c.release();
    await manager.done(c.id);
    expect(
      events.filter((event) => event.kind === "status" && event.status === "running").map((e) => e.taskId),
    ).toEqual([b.id, c.id]);
  });

  test("cancelling a queued task removes it from the queue without running it", async () => {
    const order: string[] = [];
    const a = start("codex", order);
    const b = start("claude-code", order);
    const c = start("gemini", order);
    expect(manager.cancel(b.id).status).toBe("cancelled");
    await manager.done(b.id);
    a.release();
    await waitFor(() => order.length === 2);
    expect(order).toEqual(["codex", "gemini"]);
    c.release();
    await manager.done(c.id);
  });

  test("a repeated request joins the queued task instead of adding another", () => {
    const order: string[] = [];
    start("codex", order);
    const b = start("claude-code", order);
    expect(manager.begin(toolTask("claude-code"))).toEqual({ id: b.id, duplicate: true });
  });

  test("shutdown interrupts queued tasks and their work never runs", async () => {
    const order: string[] = [];
    start("codex", order);
    const b = start("claude-code", order);
    for (const release of releases) release();
    await manager.shutdown();
    stopped = true;
    expect(order).toEqual(["codex"]);
    const reopened = new TaskStore(join(dir, "tasks.db"));
    expect(reopened.get(b.id, { output: false })?.status).toBe("interrupted");
    reopened.close();
  });
});

describe("tool installs over HTTP", () => {
  let app: App;
  let runtime: FakeRuntime;
  let server: ReturnType<typeof startServer> | undefined;
  let base: string;
  let restoreLogs: () => void;

  beforeEach(() => {
    restoreLogs = silenceLogs();
    ({ app, runtime } = createTestApp({ labelPrefix: "mbtest" }));
    const keys = app.hosts.get().keys;
    runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
    server = startServer(app);
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(() => {
    server?.stop(true);
    server = undefined;
    app.throttle.stop();
    app.sessions.stop();
    app.events.close();
    restoreLogs();
  });

  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${TEST_KEY}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  async function createBox(name: string): Promise<string> {
    const created = await call("POST", "/api/boxes", { name, cpus: 1, memoryMb: 256 });
    expect(created.status).toBe(201);
    return String((created.json.box as { id: string }).id);
  }

  const status = async (id: string) => String((await call("GET", `/api/tasks/${id}`)).json.status);
  const writers = () =>
    runtime
      .callsTo("runHelper")
      .map((entry) => entry.args[0] as HelperSpec)
      .filter((spec) => spec.network === true);

  async function settled(id: string): Promise<string> {
    const deadline = Date.now() + 3000;
    for (;;) {
      const now = await status(id);
      if ((now !== "running" && now !== "queued") || Date.now() > deadline) return now;
      await Bun.sleep(5);
    }
  }

  test("an install started while another runs is queued, not refused, and runs after it", async () => {
    const alpha = await createBox("alpha");
    const beta = await createBox("beta");
    const held = runtime.hold("runHelper", (args) => (args[0] as HelperSpec).network === true);

    const first = await call("POST", `/api/boxes/${alpha}/tools/install`, { tool: "codex", version: "latest" });
    expect(first.status).toBe(202);
    await waitFor(() => writers().length === 1);
    const [second, third] = await Promise.all([
      call("POST", `/api/boxes/${alpha}/tools/install`, { tool: "claude-code", version: "latest" }),
      call("POST", `/api/boxes/${beta}/tools/install`, { tool: "codex", version: "latest" }),
    ]);
    expect(second.status).toBe(202);
    expect(third.status).toBe(202);
    const ids = [first, second, third].map((res) => String(res.json.taskId));
    expect(new Set(ids).size).toBe(3);
    expect(await status(ids[1] ?? "")).toBe("queued");
    expect(await status(ids[2] ?? "")).toBe("queued");

    held.release();
    for (const id of ids) expect(await settled(id)).toBe("succeeded");
    expect(writers()).toHaveLength(3);
  });

  test("repeating a queued install returns the same task, and the tool is installed once", async () => {
    const alpha = await createBox("alpha");
    const held = runtime.hold("runHelper", (args) => (args[0] as HelperSpec).network === true);
    await call("POST", `/api/boxes/${alpha}/tools/install`, { tool: "codex", version: "latest" });
    await waitFor(() => writers().length === 1);
    const repeats = await Promise.all(
      [1, 2, 3].map(() =>
        call("POST", `/api/boxes/${alpha}/tools/install`, { tool: "claude-code", version: "latest" }),
      ),
    );
    const ids = new Set(repeats.map((res) => String(res.json.taskId)));
    expect(ids.size).toBe(1);
    held.release();
    expect(await settled([...ids][0] ?? "")).toBe("succeeded");
    expect(writers()).toHaveLength(2);
  });

  test("a queued install can be cancelled and its writer never runs", async () => {
    const alpha = await createBox("alpha");
    const held = runtime.hold("runHelper", (args) => (args[0] as HelperSpec).network === true);
    const first = await call("POST", `/api/boxes/${alpha}/tools/install`, { tool: "codex", version: "latest" });
    await waitFor(() => writers().length === 1);
    const second = await call("POST", `/api/boxes/${alpha}/tools/install`, { tool: "claude-code", version: "latest" });
    const cancelled = await call("POST", `/api/tasks/${String(second.json.taskId)}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.status).toBe("cancelled");
    held.release();
    expect(await settled(String(first.json.taskId))).toBe("succeeded");
    await Bun.sleep(20);
    expect(writers()).toHaveLength(1);
    expect(await status(String(second.json.taskId))).toBe("cancelled");
  });
});
