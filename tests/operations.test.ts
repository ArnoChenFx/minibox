import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { z } from "zod";

import { ActivityLog } from "../src/activity";
import type { App } from "../src/app";
import { AppError } from "../src/lib/errors";
import { setLogLevel } from "../src/lib/logger";
import { defineOperation } from "../src/operations/define";
import { type AuditEvent, Executor, type ExecutorHooks, logAudit, ownerOnly } from "../src/operations/executor";
import { cliCommands, DEFAULT_TOOLSETS, mcpTools } from "../src/operations/projections";
import { OPERATIONS, registryProblems } from "../src/operations/registry";
import type { Operation, OperationContext, Principal } from "../src/operations/types";
import { runOf } from "../src/routes/operations";
import { RuntimeError } from "../src/runtime";
import { startServer } from "../src/server";
import { createTestApp, rejectionOf, silenceLogs, TEST_KEY } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

const OWNER: Principal = { type: "owner", id: "owner", name: "owner" };
const SNAPSHOT_REF = "mbtest-snap:nightly";
const TEMPLATE_REF = "mbtest-template:gold";
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** One valid input for each operation, given the id of a box that exists; see `withBox`. */
const SAMPLES: Record<string, (boxId: string) => unknown> = {
  "box.list": () => ({}),
  "box.get": (id) => ({ id }),
  "box.create": () => ({ name: "gamma", cpus: 1, memoryMb: 256 }),
  "box.delete": (id) => ({ id, deleteVolume: false }),
  "box.action": (id) => ({ id, action: "stop" }),
  "box.resources": (id) => ({ id, cpus: 1, expectedRevision: "1" }),
  "box.update": (id) => ({ id, idleTimeoutSec: 120, expectedRevision: "1" }),
  "box.rebuild": (id) => ({ id, profile: "strict", confirm: true, expectedRevision: "1" }),
  "box.logs": (id) => ({ id, tail: 10 }),
  "box.stats": (id) => ({ id }),
  "exec.run": (id) => ({ id, argv: ["true"] }),
  "exec.get": () => ({ execId: `ex_${"0".repeat(26)}` }),
  "exec.kill": () => ({ execId: `ex_${"0".repeat(26)}` }),
  "exec.output": () => ({ execId: `ex_${"0".repeat(26)}` }),
  "snapshot.list": () => ({}),
  "snapshot.create": (id) => ({ id, name: "nightly" }),
  "snapshot.fork": () => ({ name: "delta", ref: SNAPSHOT_REF }),
  "snapshot.delete": () => ({ ref: SNAPSHOT_REF }),
  "template.list": () => ({}),
  "template.promote": () => ({ ref: SNAPSHOT_REF, name: "silver" }),
  "template.build": () => ({}),
  "template.delete": () => ({ ref: TEMPLATE_REF }),
  "task.list": () => ({}),
  "task.get": () => ({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
  "task.cancel": () => ({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
  "events.list": () => ({ op: "box.create" }),
};

/** A real id for operations that cannot succeed against the placeholder in `SAMPLES`. */
async function preparedInput(
  app: App,
  ctx: OperationContext,
  runtime: FakeRuntime,
  operation: Operation,
  boxId: string,
): Promise<{ input: unknown; release?: () => void }> {
  if (operation.name === "task.get") {
    const started = (await app.operations.run("template.build", ctx, {})) as { taskId: string };
    await app.tasks.drain();
    return { input: { id: started.taskId } };
  }
  if (operation.name === "task.cancel") {
    const held = runtime.hold("buildImage");
    const started = (await app.operations.run("template.build", ctx, {})) as { taskId: string };
    return { input: { id: started.taskId }, release: held.release };
  }
  if (operation.name === "exec.get" || operation.name === "exec.output") {
    const started = (await app.operations.run("exec.run", ctx, { id: boxId, argv: ["true"] })) as { execId: string };
    return { input: { execId: started.execId } };
  }
  if (operation.name === "exec.kill") {
    runtime.execScript = null;
    const started = (await app.operations.run("exec.run", ctx, {
      id: boxId,
      argv: ["sleep", "30"],
      background: true,
      timeoutSec: 30,
    })) as { execId: string };
    return { input: { execId: started.execId } };
  }
  const sample = SAMPLES[operation.name];
  if (sample === undefined) throw new Error(`no sample input for ${operation.name}`);
  return { input: sample(boxId) };
}

function opNamed(name: string): Operation {
  const operation = OPERATIONS.find((op) => op.name === name);
  if (!operation) throw new Error(`no operation ${name}`);
  return operation;
}

function appWith(hooks: Partial<ExecutorHooks> = {}) {
  const { app, runtime } = createTestApp({ labelPrefix: "mbtest" }, undefined, hooks);
  const keys = app.hosts.get().keys;
  runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
  runtime.seedImage(SNAPSHOT_REF, { [keys.snapshot]: "true" });
  runtime.seedImage(TEMPLATE_REF, { [keys.template]: "true", [keys.templateName]: "gold" });
  const ctx: OperationContext = {
    host: app.hosts.get(),
    principal: OWNER,
    source: "rest",
    events: app.events,
    execs: app.execs,
  };
  return { app, runtime, ctx };
}

async function withBox(app: App, ctx: OperationContext): Promise<string> {
  const { box } = (await app.operations.run("box.create", ctx, { name: "alpha", cpus: 1, memoryMb: 256 })) as {
    box: { id: string };
  };
  return box.id;
}

function auditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: "01TESTTESTTESTTESTTESTTEST",
    ts: 1,
    durationMs: 0,
    status: "ok",
    op: "box.list",
    kind: "read",
    principal: OWNER,
    source: "rest",
    hostId: "local",
    summary: "List boxes",
    ...overrides,
  };
}

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

const auth = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${TEST_KEY}`, ...extra });

const requestWithRun = (value?: string) =>
  new Request("http://x/", value === undefined ? {} : { headers: { "x-minibox-run": value } });

function definition(overrides: Partial<Parameters<typeof defineOperation>[0]>) {
  return defineOperation({
    name: "thing.get",
    tag: "things",
    summary: "Get a thing",
    kind: "read",
    scope: "thing:read",
    async: false,
    input: z.object({ id: z.string() }),
    output: z.object({}),
    rest: [{ method: "GET", path: "/api/things/:id" }],
    run: async () => ({}),
    ...overrides,
  });
}

describe("registry definitions", () => {
  test("the registry is well formed", () => {
    expect(registryProblems(OPERATIONS)).toEqual([]);
  });

  test("the registry holds the box, exec, snapshot, template, task and event operations in scope", () => {
    expect(OPERATIONS.map((op) => op.name)).toEqual(Object.keys(SAMPLES));
  });

  test("the checker reports duplicate names, routes and operation ids", () => {
    const problems = registryProblems([definition({}), definition({ summary: "Again" })]).join("\n");
    expect(problems).toContain("duplicate operation: thing.get");
    expect(problems).toContain("duplicate REST route: GET /api/things/:id");
    expect(problems).toContain("duplicate operationId: thing.get");
  });

  test("the checker reports path parameters and query keys that are not inputs", () => {
    const orphan = definition({
      kind: "read",
      rest: [{ method: "GET", path: "/api/things/:thingId", query: ["verbose"] }],
    });
    const problems = registryProblems([orphan]).join("\n");
    expect(problems).toContain("path parameter :thingId that is not an input");
    expect(problems).toContain("binds verbose, which is not an input");
  });

  test("the checker reports writes without activity, and reads bound to a write method", () => {
    const quiet = definition({
      name: "thing.wipe",
      kind: "destructive",
      scope: "thing:delete",
      rest: [{ method: "DELETE", path: "/api/things/:id" }],
    });
    const mislabelled = definition({
      name: "thing.peek",
      rest: [{ method: "POST", path: "/api/things/:id", body: true }],
    });
    const problems = registryProblems([quiet, mislabelled]).join("\n");
    expect(problems).toContain("thing.wipe changes state but declares no activity");
    expect(problems).toContain("thing.peek is read but binds POST");
  });

  test("async operations answer 202, and a 202 binding is async", () => {
    const late = definition({
      name: "thing.build",
      kind: "write",
      async: true,
      activity: { action: () => "thing.build", target: () => "thing" },
      rest: [{ method: "POST", path: "/api/things/:id", body: true }],
    });
    const early = definition({
      name: "thing.peek",
      rest: [{ method: "GET", path: "/api/things/:id", status: 202 }],
    });
    const problems = registryProblems([late, early]).join("\n");
    expect(problems).toContain("thing.build is async but does not return 202");
    expect(problems).toContain("thing.peek returns 202 but is not async");
  });
});

describe("executor", () => {
  let restoreLogs: () => void;
  beforeEach(() => {
    restoreLogs = silenceLogs();
  });
  afterEach(() => restoreLogs());

  test("the default authorize hook admits the owner and refuses anyone else", () => {
    const operation = opNamed("box.list");
    expect(ownerOnly({ principal: OWNER, operation })).toBe(true);
    expect(ownerOnly({ principal: { type: "owner", id: "other", name: "other" }, operation })).toBe(true);
  });

  test("operation names must be unique", () => {
    const box = opNamed("box.list");
    const hooks = { authorize: ownerOnly, audit: () => {} };
    expect(() => new Executor([box, box], { activity: new ActivityLog(), hooks })).toThrow(
      "operation names must be unique",
    );
  });

  test("an unknown operation name is a programming error, not a client error", async () => {
    const { app, ctx } = appWith();
    const error = await rejectionOf(app.operations.run("box.nope", ctx, {}));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AppError);
  });

  test("a refused execution is audited as denied and never reaches the engine", async () => {
    const events: AuditEvent[] = [];
    const { app, runtime, ctx } = appWith({ authorize: () => false, audit: (event) => events.push(event) });
    const error = await rejectionOf(app.operations.run("box.create", ctx, { name: "alpha", cpus: 1, memoryMb: 256 }));
    expect(error).toMatchObject({
      status: 403,
      code: "forbidden",
      key: "operation_forbidden",
      params: { op: "box.create" },
    });
    expect(events).toEqual([
      expect.objectContaining({
        op: "box.create",
        kind: "write",
        status: "denied",
        error: { code: "forbidden", status: 403 },
      }),
    ]);
    expect(runtime.calls).toEqual([]);
    expect(app.activity.list()).toEqual([]);
  });

  test("a refused request over HTTP gets a 403 that names the operation", async () => {
    const events: AuditEvent[] = [];
    const { app, runtime } = appWith({ authorize: () => false, audit: (event) => events.push(event) });
    const server = serve(app);
    try {
      const res = await fetch(`${server.base}/api/boxes`, { headers: auth() });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: {
          code: "forbidden",
          message: "This credential may not run box.list.",
          key: "operation_forbidden",
          params: { op: "box.list" },
          retryable: false,
        },
      });
      expect(events.map((e) => [e.op, e.status])).toEqual([["box.list", "denied"]]);
      expect(runtime.calls).toEqual([]);
    } finally {
      server.stop();
    }
  });

  test("validation failures are audited as failed and leave no activity entry", async () => {
    const events: AuditEvent[] = [];
    const { app, ctx } = appWith({ audit: (event) => events.push(event) });
    await rejectionOf(app.operations.run("box.create", ctx, { name: "bad name!" }));
    expect(events).toEqual([
      expect.objectContaining({
        op: "box.create",
        kind: "write",
        status: "error",
        error: { code: "validation_failed", status: 400 },
      }),
    ]);
    expect(app.activity.list()).toEqual([]);
  });

  test("every registered operation records its outcome when it succeeds", async () => {
    for (const operation of OPERATIONS) {
      const events: AuditEvent[] = [];
      const { app, ctx, runtime } = appWith({ audit: (event) => events.push(event) });
      const boxId = await withBox(app, ctx);
      const prepared = await preparedInput(app, ctx, runtime, operation, boxId);
      events.length = 0;
      try {
        await app.operations.run(operation.name, ctx, prepared.input);
        await app.tasks.drain();
        const mine = events.filter((event) => event.op === operation.name);
        expect(mine.map((event) => [event.op, event.kind, event.status])).toEqual(
          operation.async
            ? [
                [operation.name, operation.kind, "started"],
                [operation.name, operation.kind, "ok"],
              ]
            : [[operation.name, operation.kind, "ok"]],
        );
      } finally {
        prepared.release?.();
        await app.tasks.drain();
      }
    }
  });

  test("every registered operation calls the audit sink when it fails", async () => {
    for (const operation of OPERATIONS) {
      const events: AuditEvent[] = [];
      const { app, ctx } = appWith({ audit: (event) => events.push(event) });
      await app.operations.run(operation.name, ctx, {}).catch(() => undefined);
      await app.tasks.drain();
      expect(events.map((event) => event.op)).toEqual(
        operation.name === "template.build" ? ["template.build", "template.build"] : [operation.name],
      );
      if (operation.name === "template.build") expect(events.map((event) => event.status)).toEqual(["started", "ok"]);
    }
  });

  test("an execution's event names the caller, the source, the host and the summary of the target", async () => {
    const events: AuditEvent[] = [];
    const { app, ctx } = appWith({ audit: (event) => events.push(event) });
    const traced: OperationContext = { ...ctx, run: "run-7", parentId: "01PARENT0000000000000000AA" };
    await app.operations.run("box.create", traced, { name: "alpha", cpus: 1, memoryMb: 256 });
    const [event] = events;
    expect(event).toMatchObject({
      op: "box.create",
      kind: "write",
      status: "ok",
      principal: OWNER,
      source: "rest",
      hostId: "local",
      summary: "Create and start a box: alpha",
      target: { kind: "box", name: "alpha" },
      detail: { name: "alpha", cpus: 1, memoryMb: 256 },
      run: "run-7",
      parentId: "01PARENT0000000000000000AA",
    });
    expect(event?.id).toMatch(ULID);
    expect(event?.target?.id).toMatch(/^[0-9a-f]{64}$/);
    expect(event?.error).toBeUndefined();
    expect(event?.durationMs).toBeGreaterThanOrEqual(0);
    expect(event?.ts).toBeGreaterThan(0);
  });

  test("a box action names the box it resolved, and a refused lookup names no object", async () => {
    const events: AuditEvent[] = [];
    const { app, ctx } = appWith({ audit: (event) => events.push(event) });
    const id = await withBox(app, ctx);
    await app.operations.run("box.action", ctx, { id, action: "stop" });
    await rejectionOf(app.operations.run("box.get", ctx, { id: "missing" }));
    const [action, lookup] = events.slice(-2);
    expect(action).toMatchObject({ op: "box.action", target: { kind: "box", id, name: "alpha" } });
    expect(lookup).toMatchObject({ op: "box.get", status: "error", summary: "Get one box" });
    expect(lookup?.target).toBeUndefined();
    expect(lookup?.detail).toEqual({ id: "missing" });
  });

  test("event ids sort in the order the executions ran", async () => {
    const events: AuditEvent[] = [];
    const { app, ctx } = appWith({ audit: (event) => events.push(event) });
    for (let i = 0; i < 5; i++) await app.operations.run("box.list", ctx, {});
    const ids = events.map((event) => event.id);
    expect(new Set(ids).size).toBe(5);
    expect(ids).toEqual(ids.toSorted());
  });

  test("only operations that change state reach the activity feed, with the outcome of the handler", async () => {
    const { app, ctx } = appWith();
    await app.operations.run("box.list", ctx, {});
    await app.operations.run("box.get", ctx, { id: "missing" }).catch(() => undefined);
    expect(app.activity.list()).toEqual([]);

    await withBox(app, ctx);
    expect(app.activity.list()).toEqual([expect.objectContaining({ action: "box.create", target: "alpha", ok: true })]);

    const duplicate = await rejectionOf(
      app.operations.run("box.create", ctx, { name: "alpha", cpus: 1, memoryMb: 256 }),
    );
    expect(duplicate).toMatchObject({ status: 409, key: "box_exists" });
    expect(app.activity.list()[0]).toMatchObject({
      action: "box.create",
      target: "alpha",
      ok: false,
      message: "A box named “alpha” already exists.",
    });
  });

  test("a box action is recorded as the action it performed, on the box's name", async () => {
    const { app, ctx } = appWith();
    const id = await withBox(app, ctx);
    await app.operations.run("box.action", ctx, { id, action: "stop" });
    expect(app.activity.list()[0]).toMatchObject({ action: "box.stop", target: "alpha", ok: true });
  });

  test("box.delete returns the reason a volume could not be removed, and the box is gone", async () => {
    const { app, runtime, ctx } = appWith();
    const id = await withBox(app, ctx);
    runtime.fail("removeVolume", new RuntimeError("engine", "device busy", "device busy"));

    expect(await app.operations.run("box.delete", ctx, { id, deleteVolume: true })).toEqual({
      name: "alpha",
      volumeDeleted: false,
      volumeError: "device busy",
    });
    expect(runtime.containers.size).toBe(0);
  });
});

describe("snapshot and template operations", () => {
  let restoreLogs: () => void;
  beforeEach(() => {
    restoreLogs = silenceLogs();
  });
  afterEach(() => restoreLogs());

  test("a template name is checked with the template label and reported on the name field", async () => {
    const { app, ctx } = appWith();
    const error = await rejectionOf(
      app.operations.run("template.promote", ctx, { ref: SNAPSHOT_REF, name: "bad name!" }),
    );
    expect(error).toMatchObject({
      status: 400,
      key: "name_invalid",
      params: { label: "templateName" },
      details: { field: "name" },
    });
  });

  test("a missing snapshot or template is a 404 with its own key", async () => {
    const { app, ctx } = appWith();
    const snapshot = await rejectionOf(app.operations.run("snapshot.delete", ctx, { ref: "missing:1" }));
    const template = await rejectionOf(app.operations.run("template.delete", ctx, { ref: "missing:1" }));
    expect(snapshot).toMatchObject({ status: 404, key: "snapshot_not_found" });
    expect(template).toMatchObject({ status: 404, key: "template_not_found" });
  });

  test("deleting an image names it as the target in the audit event and the activity feed", async () => {
    const events: AuditEvent[] = [];
    const { app, ctx } = appWith({ audit: (event) => events.push(event) });
    await app.operations.run("template.delete", ctx, { ref: TEMPLATE_REF });
    expect(events[0]).toMatchObject({
      op: "template.delete",
      kind: "destructive",
      status: "ok",
      summary: `Delete a template: ${TEMPLATE_REF}`,
      target: { kind: "template", name: TEMPLATE_REF },
    });
    expect(app.activity.list()[0]).toMatchObject({ action: "template.delete", target: TEMPLATE_REF, ok: true });
  });
});

describe("event log", () => {
  let restoreLogs: () => void;
  beforeEach(() => {
    restoreLogs = silenceLogs();
  });
  afterEach(() => restoreLogs());

  test("every registered operation leaves its outcome in the event log when it succeeds", async () => {
    for (const operation of OPERATIONS) {
      const { app, ctx, runtime } = appWith();
      const boxId = await withBox(app, ctx);
      const prepared = await preparedInput(app, ctx, runtime, operation, boxId);
      const before = app.events.head();
      try {
        await app.operations.run(operation.name, ctx, prepared.input);
        await app.tasks.drain();
        const rows = app.events.after(before, {}, 20).filter((event) => event.op === operation.name);
        expect(rows.map((event) => [event.op, event.status])).toEqual(
          operation.async
            ? [
                [operation.name, "started"],
                [operation.name, "ok"],
              ]
            : [[operation.name, "ok"]],
        );
        if (operation.async) expect(rows[0]?.ref?.taskId).toBe(rows[1]?.ref?.taskId);
      } finally {
        prepared.release?.();
        await app.tasks.drain();
      }
    }
  });

  test("every registered operation leaves one stored event when it is refused", async () => {
    for (const operation of OPERATIONS) {
      const { app, ctx } = appWith({ authorize: () => false });
      await app.operations.run(operation.name, ctx, {}).catch(() => undefined);
      expect(app.events.after(0, {}, 10).map((event) => [event.op, event.status])).toEqual([
        [operation.name, "denied"],
      ]);
    }
  });

  test("every registered operation leaves one stored event whatever its input", async () => {
    for (const operation of OPERATIONS) {
      const { app, ctx } = appWith();
      await app.operations.run(operation.name, ctx, {}).catch(() => undefined);
      await app.tasks.drain();
      expect(app.events.after(0, {}, 10).map((event) => event.op)).toEqual(
        operation.name === "template.build" ? ["template.build", "template.build"] : [operation.name],
      );
    }
  });
});

describe("audit sink", () => {
  beforeEach(() => setLogLevel("debug"));
  afterEach(() => setLogLevel("info"));

  test("the default sink writes a structured info line for a write and a debug line for a read", () => {
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      logAudit(auditEvent({ op: "box.create", kind: "write", run: "run-1", summary: "Create and start a box" }));
      logAudit(auditEvent({ op: "box.list", kind: "read" }));
    } finally {
      spy.mockRestore();
    }
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([
      expect.objectContaining({ level: "info", msg: "operation.ok", operation: "box.create", run: "run-1" }),
      expect.objectContaining({ level: "debug", msg: "operation.ok", operation: "box.list" }),
    ]);
  });

  test("a refusal logs at warn and a server-side failure at error, without the detail", () => {
    const lines: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      logAudit(auditEvent({ status: "denied", error: { code: "forbidden", status: 403 } }));
      logAudit(auditEvent({ status: "error", error: { code: "internal", status: 500 }, detail: { secret: "x" } }));
    } finally {
      spy.mockRestore();
    }
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([
      expect.objectContaining({ level: "warn", msg: "operation.denied", code: "forbidden", httpStatus: 403 }),
      expect.objectContaining({ level: "error", msg: "operation.failed", code: "internal", httpStatus: 500 }),
    ]);
    expect(lines.join("\n")).not.toContain("secret");
  });
});

describe("REST run grouping", () => {
  let restoreLogs: () => void;
  beforeEach(() => {
    restoreLogs = silenceLogs();
  });
  afterEach(() => restoreLogs());

  test("X-Minibox-Run is recorded on the audit events of the request", async () => {
    const events: AuditEvent[] = [];
    const { app } = appWith({ audit: (event) => events.push(event) });
    const server = serve(app);
    try {
      await fetch(`${server.base}/api/boxes`, { headers: auth({ "x-minibox-run": "run-42" }) });
      await fetch(`${server.base}/api/boxes`, { headers: auth() });
    } finally {
      server.stop();
    }
    expect(events.map((e) => e.run)).toEqual(["run-42", undefined]);
  });

  test("a malformed X-Minibox-Run is refused before the operation runs", async () => {
    const events: AuditEvent[] = [];
    const { app, runtime } = appWith({ audit: (event) => events.push(event) });
    const server = serve(app);
    try {
      const res = await fetch(`${server.base}/api/boxes`, { headers: auth({ "x-minibox-run": "bad value!" }) });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: { code: "validation_failed", key: "run_invalid", details: { field: "X-Minibox-Run" } },
      });
    } finally {
      server.stop();
    }
    expect(events).toEqual([]);
    expect(runtime.calls).toEqual([]);
  });

  test("runOf accepts 1 to 64 characters of the allowed set and nothing else", () => {
    expect(runOf(requestWithRun())).toBeUndefined();
    expect(runOf(requestWithRun("run-1.a_b:c"))).toBe("run-1.a_b:c");
    expect(runOf(requestWithRun("a".repeat(64)))).toBe("a".repeat(64));
    for (const bad of ["", "-run", ".run", "has space", "a".repeat(65), "slash/run"]) {
      expect(() => runOf(requestWithRun(bad))).toThrow(AppError);
    }
  });
});

describe("projections", () => {
  test("MCP tools default to the core and meta toolsets", () => {
    expect(DEFAULT_TOOLSETS).toEqual(["core", "meta"]);
    expect(mcpTools(OPERATIONS).map((tool) => tool.name)).toEqual([
      "list_boxes",
      "get_box",
      "create_box",
      "delete_box",
      "box_action",
      "update_box",
      "exec",
      "exec_get",
      "exec_kill",
    ]);
    expect(mcpTools(OPERATIONS, ["storage"])).toEqual([]);
  });

  test("rebuild_box is outside the default toolsets and only in the rebuild toolset", () => {
    expect(mcpTools(OPERATIONS, ["rebuild"]).map((tool) => tool.name)).toEqual(["rebuild_box"]);
    expect(mcpTools(OPERATIONS, ["rebuild"])[0]?.toolset).toBe("rebuild");
  });

  test("each tool carries the operation's input and output schemas and its read or destructive hint", () => {
    const tools = new Map(
      [...mcpTools(OPERATIONS), ...mcpTools(OPERATIONS, ["rebuild"])].map((tool) => [tool.name, tool]),
    );
    const create = tools.get("create_box");
    expect(create?.inputSchema).toMatchObject({ type: "object", required: ["name"] });
    expect(Object.keys((create?.inputSchema.properties ?? {}) as object)).toEqual([
      "name",
      "template",
      "cpus",
      "memoryMb",
      "profile",
    ]);
    expect(create?.outputSchema).toMatchObject({ type: "object", required: ["box"] });
    expect(create?.annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
    expect(tools.get("get_box")?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    expect(tools.get("delete_box")?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(tools.get("rebuild_box")?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
  });

  test("CLI commands come from the registry, with the operation kind", () => {
    const commands = cliCommands(OPERATIONS);
    expect(commands).toContainEqual(
      expect.objectContaining({ command: "box rm", operation: "box.delete", kind: "destructive" }),
    );
    expect(commands).toContainEqual(expect.objectContaining({ command: "snapshot fork", operation: "snapshot.fork" }));
    expect(new Set(commands.map((c) => c.command)).size).toBe(commands.length);
  });
});
