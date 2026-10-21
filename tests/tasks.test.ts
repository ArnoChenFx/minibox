import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
import { COOKIE_NAME } from "../src/auth";
import type { OperationContext } from "../src/operations/types";
import { startServer } from "../src/server";
import { TASK_LOG_MAX_BYTES, TASK_LOG_OMITTED } from "../src/tasks/store";
import { createTestApp, rejectionOf, silenceLogs, TEST_KEY } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";
import { SseReader } from "./support/sse";

const OWNER = { type: "owner" as const, id: "owner", name: "owner" };
const MISSING = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

function serve(app: App) {
  const server = startServer(app);
  return {
    base: `http://127.0.0.1:${server.port}`,
    stop: () => {
      server.stop(true);
      app.throttle.stop();
    },
  };
}

const auth = { authorization: `Bearer ${TEST_KEY}` };

async function postBuild(
  base: string,
): Promise<{ status: number; body: { taskId?: string; error?: { key?: string; details?: { taskId?: string } } } }> {
  const res = await fetch(`${base}/api/templates/base/build`, { method: "POST", headers: auth });
  return {
    status: res.status,
    body: (await res.json()) as { taskId?: string; error?: { key?: string; details?: { taskId?: string } } },
  };
}

const cookieFor = (token: string) => ({ cookie: `${COOKIE_NAME}=${token}` });

async function openProgress(
  base: string,
  taskId: string | undefined,
  headers: Record<string, string>,
): Promise<SseReader> {
  const res = await fetch(`${base}/api/tasks/${taskId}/events`, { headers });
  expect(res.status).toBe(200);
  if (!res.body) throw new Error("the stream has no body");
  return new SseReader(res.body.getReader());
}

describe("tasks", () => {
  let restoreLogs: () => void;
  let app: App;
  let runtime: FakeRuntime;
  let ctx: OperationContext;

  beforeEach(() => {
    restoreLogs = silenceLogs();
    const created = createTestApp({ labelPrefix: "mbtest" });
    app = created.app;
    runtime = created.runtime;
    ctx = { host: app.hosts.get(), principal: OWNER, source: "rest", events: app.events };
  });

  afterEach(() => restoreLogs());

  test("a template build returns 202 before the build finishes, and a second one is refused", async () => {
    const held = runtime.hold("buildImage");
    const server = serve(app);
    try {
      const started = performance.now();
      const first = await postBuild(server.base);
      expect(performance.now() - started).toBeLessThan(1000);
      expect(first.status).toBe(202);
      expect(first.body.taskId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

      const second = await postBuild(server.base);
      expect(second.status).toBe(409);
      expect(second.body.error).toMatchObject({ key: "task_busy", details: { taskId: first.body.taskId } });
      expect(runtime.callsTo("buildImage")).toHaveLength(1);

      const running = await fetch(`${server.base}/api/tasks/${first.body.taskId}`, { headers: auth });
      expect(running.status).toBe(200);
      expect(await running.json()).toMatchObject({
        status: "running",
        op: "template.build",
        output: "Successfully built fake\n",
      });
    } finally {
      held.release();
      await app.tasks.drain();
      server.stop();
    }
  });

  test("cancelling a build keeps it cancelled after the engine returns", async () => {
    const held = runtime.hold("buildImage");
    const server = serve(app);
    try {
      const { body } = await postBuild(server.base);
      const cancel = await fetch(`${server.base}/api/tasks/${body.taskId}/cancel`, { method: "POST", headers: auth });
      expect(cancel.status).toBe(200);
      expect(await cancel.json()).toMatchObject({
        status: "cancelled",
        error: { code: "cancelled", key: "task_cancelled" },
      });
      held.release();
      await app.tasks.drain();
      const done = await fetch(`${server.base}/api/tasks/${body.taskId}`, { headers: auth });
      expect(await done.json()).toMatchObject({ status: "cancelled" });
      expect(runtime.callsTo("buildImage")).toHaveLength(1);
    } finally {
      held.release();
      await app.tasks.drain();
      server.stop();
    }
  });

  test("one snapshot at a time per box, and a different box is not blocked", async () => {
    const keys = app.hosts.get().keys;
    runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
    const alpha = (await app.operations.run("box.create", ctx, { name: "alpha", cpus: 1, memoryMb: 256 })) as {
      box: { id: string };
    };
    const beta = (await app.operations.run("box.create", ctx, { name: "beta", cpus: 1, memoryMb: 256 })) as {
      box: { id: string };
    };
    const held = runtime.hold("commitContainer");
    try {
      const first = (await app.operations.run("snapshot.create", ctx, { id: alpha.box.id, name: "one" })) as {
        taskId: string;
      };
      const busy = await rejectionOf(app.operations.run("snapshot.create", ctx, { id: "alpha", name: "two" }));
      expect(busy).toMatchObject({ status: 409, key: "task_busy", details: { taskId: first.taskId } });
      const other = (await app.operations.run("snapshot.create", ctx, { id: beta.box.id, name: "other" })) as {
        taskId: string;
      };
      expect(other.taskId).not.toBe(first.taskId);
    } finally {
      held.release();
      await app.tasks.drain();
    }
    const listed = (await app.operations.run("task.list", ctx, {})) as { tasks: { id: string; status: string }[] };
    expect(listed.tasks.every((task) => task.status === "succeeded")).toBe(true);
  });

  test("the retained log is redacted and capped, and the task result is the operation output", async () => {
    runtime.buildLog = `${"x".repeat(TASK_LOG_MAX_BYTES)} key ${TEST_KEY} sk-abcdefghijklmnopqrstuvwxyz\n`;
    const { taskId } = (await app.operations.run("template.build", ctx, {})) as { taskId: string };
    await app.tasks.drain();
    const task = (await app.operations.run("task.get", ctx, { id: taskId })) as {
      status: string;
      output: string;
      truncated: boolean;
      result: { ref: string };
    };
    expect(task.status).toBe("succeeded");
    expect(task.result).toEqual({ ref: app.cfg.baseTemplateTag });
    expect(task.truncated).toBe(true);
    expect(task.output.startsWith(TASK_LOG_OMITTED)).toBe(true);
    expect(task.output.length).toBe(TASK_LOG_OMITTED.length + TASK_LOG_MAX_BYTES);
    expect(task.output).not.toContain(TEST_KEY);
    expect(task.output).toContain("***");
  });

  test("a task that was running when the process stopped is interrupted and does not block the next one", async () => {
    const dir = app.cfg.dataDir;
    const held = runtime.hold("buildImage");
    const { taskId } = (await app.operations.run("template.build", ctx, {})) as { taskId: string };
    app.tasks.crash();
    held.release();

    const restarted = createTestApp(
      { dataDir: dir, labelPrefix: "mbtest" },
      new (runtime.constructor as typeof FakeRuntime)(),
    );
    const nextCtx: OperationContext = {
      host: restarted.app.hosts.get(),
      principal: OWNER,
      source: "rest",
      events: restarted.app.events,
    };
    const task = (await restarted.app.operations.run("task.get", nextCtx, { id: taskId })) as {
      status: string;
      error?: { key?: string };
    };
    expect(task).toMatchObject({ status: "interrupted", error: { key: "task_interrupted" } });
    const again = (await restarted.app.operations.run("template.build", nextCtx, {})) as { taskId: string };
    await restarted.app.tasks.drain();
    const built = (await restarted.app.operations.run("task.get", nextCtx, { id: again.taskId })) as { status: string };
    expect(built.status).toBe("succeeded");
  });

  test("the progress stream replays with after and then delivers the terminal status", async () => {
    const held = runtime.hold("buildImage");
    const server = serve(app);
    let reader: SseReader | undefined;
    try {
      const { body } = await postBuild(server.base);
      const res = await fetch(`${server.base}/api/tasks/${body.taskId}/events?after=0`, { headers: auth });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      reader = new SseReader(res.body!.getReader());
      const log = await reader.until((frame) => (frame.data as { kind?: string } | undefined)?.kind === "log");
      expect(log.data).toMatchObject({ kind: "log", text: "Successfully built fake\n" });
      held.release();
      const status = await reader.until((frame) => (frame.data as { kind?: string } | undefined)?.kind === "status");
      expect(status.data).toMatchObject({ kind: "status", status: "succeeded" });
    } finally {
      held.release();
      await reader?.close();
      await app.tasks.drain();
      server.stop();
    }
  });

  test("the progress stream ends when the browser session that opened it is revoked, and another session keeps receiving", async () => {
    const held = runtime.hold("buildImage");
    const server = serve(app);
    const revoked = app.sessions.create({ userAgent: "test", ip: "127.0.0.1" });
    const kept = app.sessions.create({ userAgent: "test", ip: "127.0.0.1" });
    let ended: SseReader | undefined;
    let live: SseReader | undefined;
    try {
      const { body } = await postBuild(server.base);
      ended = await openProgress(server.base, body.taskId, cookieFor(revoked.token));
      live = await openProgress(server.base, body.taskId, cookieFor(kept.token));
      await ended.next();
      await live.next();

      const res = await fetch(`${server.base}/api/auth/sessions/${revoked.session.id}`, {
        method: "DELETE",
        headers: auth,
      });
      expect(res.status).toBe(200);
      await ended.untilEnd();

      held.release();
      const status = await live.until((frame) => (frame.data as { kind?: string } | undefined)?.kind === "status");
      expect(status.data).toMatchObject({ kind: "status", status: "succeeded" });
    } finally {
      held.release();
      await ended?.close();
      await live?.close();
      await app.tasks.drain();
      server.stop();
    }
  });

  test("the progress stream ends when the browser session that opened it expires", async () => {
    const held = runtime.hold("buildImage");
    const server = serve(app);
    const session = app.sessions.create({ userAgent: "test", ip: "127.0.0.1" });
    let stream: SseReader | undefined;
    try {
      const { body } = await postBuild(server.base);
      stream = await openProgress(server.base, body.taskId, cookieFor(session.token));
      await stream.next();

      app.sessions.sweep(session.session.expiresAt);
      await stream.untilEnd();
    } finally {
      held.release();
      await stream?.close();
      await app.tasks.drain();
      server.stop();
    }
  });

  test("unknown, malformed and finished tasks answer 404, 400 and 409", async () => {
    const server = serve(app);
    try {
      const { taskId } = (await app.operations.run("template.build", ctx, {})) as { taskId: string };
      await app.tasks.drain();
      const missing = await fetch(`${server.base}/api/tasks/${MISSING}`, { headers: auth });
      const malformed = await fetch(`${server.base}/api/tasks/not-a-task`, { headers: auth });
      const finished = await fetch(`${server.base}/api/tasks/${taskId}/cancel`, { method: "POST", headers: auth });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ error: { key: "task_not_found" } });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toMatchObject({ error: { key: "task_id_invalid" } });
      expect(finished.status).toBe(409);
      expect(await finished.json()).toMatchObject({ error: { key: "task_not_running" } });
    } finally {
      server.stop();
    }
  });
});
