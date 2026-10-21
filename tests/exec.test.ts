import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { REDACTED } from "../src/events/redact";
import type { StoredEvent } from "../src/events/store";
import { msg } from "../src/lib/messages";
import type { OperationContext, Principal } from "../src/operations/types";
import { RuntimeError } from "../src/runtime";
import { startServer } from "../src/server";
import { createTestApp, rejectionOf, silenceLogs, TEST_KEY } from "./support/app";

const OWNER: Principal = { type: "owner", id: "owner", name: "owner" };

function setup() {
  const { app, runtime } = createTestApp({ labelPrefix: "mbtest" });
  const keys = app.hosts.get().keys;
  runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
  const ctx: OperationContext = {
    host: app.hosts.get(),
    principal: OWNER,
    source: "rest",
    events: app.events,
    execs: app.execs,
  };
  return { app, runtime, ctx };
}

async function createBox(app: ReturnType<typeof setup>["app"], ctx: OperationContext): Promise<string> {
  const created = (await app.operations.run("box.create", ctx, { name: "alpha", cpus: 1, memoryMb: 256 })) as {
    box: { id: string };
  };
  return created.box.id;
}

describe("exec", () => {
  let restoreLogs: () => void;
  beforeEach(() => {
    restoreLogs = silenceLogs();
  });
  afterEach(() => restoreLogs());

  test("runs argv as the dev user, returns the real exit code, and audits start and finish", async () => {
    const { app, runtime, ctx } = setup();
    runtime.execScript = { stdout: "hello\n", stderr: "warn\n", code: 2 };
    const published: StoredEvent[] = [];
    app.bus.subscribe("event", (event) => published.push(event));
    const id = await createBox(app, ctx);
    published.length = 0;

    const result = await app.operations.run("exec.run", ctx, {
      id,
      argv: ["echo", "hello"],
      env: { TOKEN: "super-secret-value" },
      stdin: "line\n",
    });

    expect(result).toMatchObject({
      background: false,
      woke: false,
      exitCode: 2,
      stdout: "hello\n",
      stderr: "warn\n",
      truncated: false,
      outputRef: null,
      timedOut: false,
    });
    const spec = runtime.execs.at(-1)?.spec;
    expect(spec).toEqual({
      cmd: ["echo", "hello"],
      env: ["TOKEN=super-secret-value"],
      workingDir: "/workspace",
      user: "dev",
      tty: false,
    });
    expect(runtime.execs.at(-1)?.stdin()).toBe("line\n");
    const run = published.find((event) => event.op === "exec.run");
    const start = published.find((event) => event.op === "exec.start");
    const finish = published.find((event) => event.op === "exec.finish");
    expect(start).toMatchObject({ status: "started", tier: "activity", parentId: run?.id });
    expect(finish).toMatchObject({
      status: "ok",
      tier: "activity",
      parentId: run?.id,
      detail: { exitCode: 2 },
      ref: { execId: (result as { execId: string }).execId },
    });
    expect(JSON.stringify(run?.detail)).not.toContain("super-secret-value");
    expect(JSON.stringify(run?.detail)).not.toContain("line");
    expect(run?.detail).toMatchObject({ argv: ["echo", "hello"], env: ["TOKEN"], user: "dev", stdinBytes: 5 });
    expect(published.filter((event) => event.op === "exec.finish")).toHaveLength(1);
  });

  test("cmd goes through the shell, and exactly one of cmd or argv is accepted", async () => {
    const { app, runtime, ctx } = setup();
    const id = await createBox(app, ctx);
    await app.operations.run("exec.run", ctx, { id, cmd: "echo hi" });
    expect(runtime.execs.at(-1)?.spec.cmd).toEqual(["/bin/sh", "-c", "echo hi"]);

    const neither = await rejectionOf(app.operations.run("exec.run", ctx, { id }));
    const both = await rejectionOf(app.operations.run("exec.run", ctx, { id, cmd: "true", argv: ["true"] }));
    for (const error of [neither, both]) {
      expect(error).toMatchObject({
        status: 400,
        key: "exec_command_required",
        hint: msg("exec_command_hint").text,
        retryable: false,
        details: { field: "cmd" },
      });
    }
  });

  test("starts a stopped box and reports the hint when that start fails", async () => {
    const { app, runtime, ctx } = setup();
    const id = await createBox(app, ctx);
    await app.operations.run("box.action", ctx, { id, action: "stop" });
    const starts = runtime.callsTo("startContainer").length;
    const woke = (await app.operations.run("exec.run", ctx, { id, argv: ["true"] })) as { woke: boolean };
    expect(woke.woke).toBe(true);
    expect(runtime.callsTo("startContainer").length).toBe(starts + 1);
    const viewed = (await app.operations.run("box.get", ctx, { id })) as { box: { running: boolean } };
    expect(viewed.box.running).toBe(true);

    await app.operations.run("box.action", ctx, { id, action: "stop" });
    runtime.fail("startContainer", new RuntimeError("conflict", "cannot start", "cannot start"));
    const error = await rejectionOf(app.operations.run("exec.run", ctx, { id, argv: ["true"] }));
    expect(error).toMatchObject({
      status: 409,
      code: "conflict",
      hint: msg("exec_wake_failed_hint").text,
      retryable: false,
    });
  });

  test("keeps a head and a tail inline and the larger window behind outputRef", async () => {
    const { app, runtime, ctx } = setup();
    const id = await createBox(app, ctx);
    const big = `${"A".repeat(20 * 1024)}MIDDLE${"Z".repeat(20 * 1024)}${TEST_KEY}`;
    runtime.execScript = { stdout: big, stderr: "", code: 0 };
    const result = (await app.operations.run("exec.run", ctx, { id, argv: ["cat"] })) as {
      execId: string;
      stdout: string;
      truncated: boolean;
      outputRef: string | null;
    };
    expect(result.truncated).toBe(true);
    expect(result.outputRef).toBe(`exec/${result.execId}`);
    expect(result.stdout.startsWith("A")).toBe(true);
    expect(result.stdout.endsWith(REDACTED)).toBe(true);
    expect(result.stdout).toContain("bytes omitted");
    expect(result.stdout).not.toContain(TEST_KEY);
    expect(result.stdout.length).toBeLessThan(40 * 1024);

    const saved = (await app.operations.run("exec.output", ctx, { execId: result.execId })) as {
      stdout: string;
      stdoutBytes: number;
      truncated: boolean;
    };
    expect(saved.truncated).toBe(false);
    expect(saved.stdoutBytes).toBe(Buffer.byteLength(big));
    expect(saved.stdout.length).toBeGreaterThan(result.stdout.length);
    expect(saved.stdout).not.toContain(TEST_KEY);
    expect(saved.stdout).toContain("MIDDLE");
    expect(result.stdout).not.toContain("MIDDLE");
  });

  test("background returns an id, long-poll waits, and kill stops the process tree", async () => {
    const { app, runtime, ctx } = setup();
    runtime.execScript = null;
    const published: StoredEvent[] = [];
    app.bus.subscribe("event", (event) => published.push(event));
    const id = await createBox(app, ctx);
    const started = (await app.operations.run("exec.run", ctx, {
      id,
      argv: ["sleep", "30"],
      background: true,
      timeoutSec: 30,
    })) as { execId: string; exitCode: number | null; stdout: string };
    expect(started).toMatchObject({ background: true, exitCode: null, stdout: "", timedOut: false });

    const running = await app.operations.run("exec.get", ctx, { execId: started.execId, waitMs: 0 });
    expect(running).toMatchObject({ status: "running", exitCode: null });

    let settled = false;
    const pending = app.operations.run("exec.get", ctx, { execId: started.execId, waitMs: 2000 }).then((value) => {
      expect(settled).toBe(true);
      return value;
    });
    await Bun.sleep(40);
    settled = true;
    await app.operations.run("exec.kill", ctx, { execId: started.execId });
    expect(await pending).toMatchObject({ status: "killed", exitCode: 137 });
    const again = await rejectionOf(app.operations.run("exec.kill", ctx, { execId: started.execId }));
    expect(again).toMatchObject({ status: 409, key: "exec_not_running", hint: msg("exec_not_running_hint").text });
    const killed = published.find((event) => event.op === "exec.killed");
    expect(killed).toMatchObject({ tier: "activity", detail: { reason: "client" } });
  });

  test("a timeout is a successful result and kills the command", async () => {
    const { app, runtime, ctx } = setup();
    runtime.execScript = null;
    const id = await createBox(app, ctx);
    const result = await app.operations.run("exec.run", ctx, { id, argv: ["sleep", "30"], timeoutSec: 1 });
    expect(result).toMatchObject({ timedOut: true, exitCode: 137, background: false });
  });

  test("a missing exec and a bad id are distinct errors", async () => {
    const { app, ctx } = setup();
    const missing = `ex_${"0".repeat(26)}`;
    const absent = await rejectionOf(app.operations.run("exec.get", ctx, { execId: missing }));
    expect(absent).toMatchObject({ status: 404, key: "exec_not_found", hint: msg("exec_not_found_hint").text });
    const bad = await rejectionOf(app.operations.run("exec.get", ctx, { execId: "nope" }));
    expect(bad).toMatchObject({ status: 400, key: "exec_id_invalid", retryable: false });
    const gone = await rejectionOf(app.operations.run("exec.output", ctx, { execId: missing }));
    expect(gone).toMatchObject({ status: 404, key: "exec_output_missing" });
  });

  test("stdin may contain NUL, and the HTTP error names the field", async () => {
    const { app, runtime, ctx } = setup();
    const id = await createBox(app, ctx);
    await app.operations.run("exec.run", ctx, { id, argv: ["cat"], stdin: "a\0b" });
    expect(runtime.execs.at(-1)?.stdin()).toBe("a\0b");

    const server = startServer(app);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/boxes/${id}/exec`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TEST_KEY}`,
          "content-type": "application/json",
          "x-minibox-client": "cli",
        },
        body: "{}",
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: {
          code: "validation_failed",
          message: msg("exec_command_required").text,
          hint: msg("exec_command_hint").text,
          retryable: false,
          key: "exec_command_required",
          hintKey: "exec_command_hint",
          details: { field: "cmd" },
        },
      });
      const events = app.events.list({ op: "exec.run" }, { limit: 5 }).events;
      expect(events.some((event) => event.source === "cli" && event.status === "error")).toBe(true);
    } finally {
      server.stop(true);
      app.throttle.stop();
    }
  });

  test("finished execs past the in-memory cap can still be read from the output file", async () => {
    const { app, runtime, ctx } = setup();
    runtime.execScript = { stdout: "kept", stderr: "", code: 0 };
    const id = await createBox(app, ctx);
    const first = (await app.operations.run("exec.run", ctx, { id, argv: ["true"] })) as { execId: string };
    for (let i = 0; i < 200; i++) await app.operations.run("exec.run", ctx, { id, argv: ["true"] });
    expect(app.execs.lookup(first.execId)).toBeUndefined();
    expect(await app.operations.run("exec.output", ctx, { execId: first.execId })).toMatchObject({
      stdout: "kept",
      stdoutBytes: 4,
    });
  }, 20_000);
});
