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
import { startServer } from "../src/server";
import { createTestApp, rejectionOf, silenceLogs, TEST_KEY } from "./support/app";

const OWNER: Principal = { type: "owner" };
const SNAPSHOT_REF = "mbtest-snap:nightly";

/** One valid input for each operation, given the id of a box that exists; see `withBox`. */
const SAMPLES: Record<string, (boxId: string) => unknown> = {
  "box.list": () => ({}),
  "box.get": (id) => ({ id }),
  "box.create": () => ({ name: "gamma", cpus: 1, memoryMb: 256 }),
  "box.delete": (id) => ({ id, deleteVolume: false }),
  "box.action": (id) => ({ id, action: "stop" }),
  "box.resources": (id) => ({ id, cpus: 1 }),
  "box.logs": (id) => ({ id, tail: 10 }),
  "box.stats": (id) => ({ id }),
  "snapshot.create": (id) => ({ id, name: "nightly" }),
  "snapshot.fork": () => ({ name: "delta", ref: SNAPSHOT_REF }),
};

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
  const ctx: OperationContext = { host: app.hosts.get(), principal: OWNER };
  return { app, runtime, ctx };
}

async function withBox(app: App, ctx: OperationContext): Promise<string> {
  const { box } = (await app.operations.run("box.create", ctx, { name: "alpha", cpus: 1, memoryMb: 256 })) as {
    box: { id: string };
  };
  return box.id;
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

  test("the registry holds the box and box-snapshot operations in scope", () => {
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
    expect(ownerOnly({ principal: { type: "owner" }, operation })).toBe(true);
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
      { operation: "box.create", kind: "write", principal: "owner", outcome: "denied", code: "forbidden", status: 403 },
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
        },
      });
      expect(events.map((e) => [e.operation, e.outcome])).toEqual([["box.list", "denied"]]);
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
      {
        operation: "box.create",
        kind: "write",
        principal: "owner",
        outcome: "failed",
        code: "validation_failed",
        status: 400,
      },
    ]);
    expect(app.activity.list()).toEqual([]);
  });

  test("every registered operation calls the audit sink once when it succeeds", async () => {
    for (const operation of OPERATIONS) {
      const sample = SAMPLES[operation.name];
      if (sample === undefined) throw new Error(`no sample input for ${operation.name}`);
      const events: AuditEvent[] = [];
      const { app, ctx } = appWith({ audit: (event) => events.push(event) });
      const boxId = await withBox(app, ctx);
      events.length = 0;

      await app.operations.run(operation.name, ctx, sample(boxId));
      expect(events).toEqual([{ operation: operation.name, kind: operation.kind, principal: "owner", outcome: "ok" }]);
    }
  });

  test("every registered operation calls the audit sink once when it fails", async () => {
    for (const operation of OPERATIONS) {
      const events: AuditEvent[] = [];
      const { app, ctx } = appWith({ audit: (event) => events.push(event) });
      await app.operations.run(operation.name, ctx, {}).catch(() => undefined);
      expect(events.map((event) => event.operation)).toEqual([operation.name]);
    }
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
      logAudit({ operation: "box.create", kind: "write", principal: "owner", run: "run-1", outcome: "ok" });
      logAudit({ operation: "box.list", kind: "read", principal: "owner", outcome: "ok" });
    } finally {
      spy.mockRestore();
    }
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([
      expect.objectContaining({ level: "info", msg: "operation.ok", operation: "box.create", run: "run-1" }),
      expect.objectContaining({ level: "debug", msg: "operation.ok", operation: "box.list" }),
    ]);
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
    ]);
    expect(mcpTools(OPERATIONS, ["storage"])).toEqual([]);
  });

  test("each tool carries the operation's input and output schemas and its read or destructive hint", () => {
    const tools = new Map(mcpTools(OPERATIONS).map((tool) => [tool.name, tool]));
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
