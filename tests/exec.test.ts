import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { REDACTED } from "../src/events/redact";
import type { StoredEvent } from "../src/events/store";
import { msg } from "../src/lib/messages";
import type { OperationContext, Principal } from "../src/operations/types";
import { RuntimeError } from "../src/runtime";
import { startServer } from "../src/server";
import { sleepBox } from "../src/services/boxes";
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
    tokens: app.tokens,
    execs: app.execs,
  };
  return { app, runtime, ctx };
}

/** The stable `bx_…` id of a box, which the activity heartbeat is keyed on. */
function boxIdOf(app: ReturnType<typeof setup>["app"], containerId: string): string {
  const spec = app.hosts
    .get()
    .specs.list()
    .find((candidate) => candidate.containerId === containerId);
  if (!spec) throw new Error(`no spec for container ${containerId}`);
  return spec.id;
}

async function createBox(
  app: ReturnType<typeof setup>["app"],
  ctx: OperationContext,
  name = "alpha",
  profile?: "standard" | "strict" | "relaxed",
): Promise<string> {
  const created = (await app.operations.run("box.create", ctx, { name, cpus: 1, memoryMb: 256, profile })) as {
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
      stopAs: "root",
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

  test("an exec that wakes a sleeping box audits the wake under the exec, and an exec on a running box wakes nothing", async () => {
    const { app, runtime, ctx } = setup();
    runtime.execScript = { stdout: "", stderr: "", code: 0 };
    const published: StoredEvent[] = [];
    app.bus.subscribe("event", (event) => published.push(event));
    const id = await createBox(app, ctx);
    await sleepBox(app.hosts.get(), id, "idle");
    published.length = 0;

    const woken = (await app.operations.run("exec.run", ctx, { id, argv: ["true"] })) as { woke: boolean };
    expect(woken.woke).toBe(true);
    const run = published.find((event) => event.op === "exec.run");
    expect(published.find((event) => event.op === "box.wake")).toMatchObject({
      parentId: run?.id,
      source: "rest",
      detail: { from: "idle" },
    });

    published.length = 0;
    const running = (await app.operations.run("exec.run", ctx, { id, argv: ["true"] })) as { woke: boolean };
    expect(running.woke).toBe(false);
    expect(published.some((event) => event.op === "box.wake")).toBe(false);
  });

  test("an exec counts as activity when it starts and when it ends", async () => {
    const { app, runtime, ctx } = setup();
    runtime.execScript = null;
    const id = await createBox(app, ctx);
    const boxId = boxIdOf(app, id);
    const stale = Date.now() - 600_000;

    app.pulse.touch(boxId, "exec", stale);
    const started = (await app.operations.run("exec.run", ctx, {
      id,
      argv: ["sleep", "30"],
      background: true,
      timeoutSec: 30,
    })) as { execId: string };
    expect(app.pulse.lastAt(boxId)).toBeGreaterThan(Date.now() - 5_000);

    app.pulse.touch(boxId, "exec", stale);
    await app.operations.run("exec.kill", ctx, { execId: started.execId });
    expect(app.pulse.lastAt(boxId)).toBeGreaterThan(Date.now() - 5_000);
  });

  test("an exec on a box whose TTL has expired is refused with 409, and starts nothing", async () => {
    const { app, runtime, ctx } = setup();
    const created = (await app.operations.run("box.create", ctx, {
      name: "expiring",
      cpus: 1,
      memoryMb: 256,
      ttlSec: 60,
    })) as { box: { id: string } };
    const id = created.box.id;
    const host = app.hosts.get();
    const spec = host.specs.findByName("expiring");
    if (!spec) throw new Error("no spec for expiring");
    host.specs.write({ ...spec, createdAt: new Date(Date.now() - 120_000).toISOString() });
    expect(await sleepBox(host, id, "ttl")).toBe(true);
    const starts = runtime.callsTo("startContainer").length;
    const execs = runtime.callsTo("startExec").length;

    const error = await rejectionOf(app.operations.run("exec.run", ctx, { id, argv: ["true"] }));
    expect(error).toMatchObject({
      status: 409,
      key: "box_ttl_expired",
      hint: msg("exec_wake_failed_hint").text,
    });
    expect(runtime.callsTo("startContainer")).toHaveLength(starts);
    expect(runtime.callsTo("startExec")).toHaveLength(execs);
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
    expect(result).toMatchObject({ timedOut: true, exitCode: 137, status: "killed", background: false });
  });

  test("a failed kill reports 502, keeps the exec running, and a retry can stop it", async () => {
    const { app, runtime, ctx } = setup();
    runtime.execScript = null;
    const published: StoredEvent[] = [];
    app.bus.subscribe("event", (event) => published.push(event));
    const id = await createBox(app, ctx);
    const started = (await app.operations.run("exec.run", ctx, {
      id,
      argv: ["sleep", "30"],
      background: true,
    })) as { execId: string };

    runtime.failExecKill(new RuntimeError("engine", "a process survived the kill"));
    const failed = await rejectionOf(app.operations.run("exec.kill", ctx, { execId: started.execId }));
    expect(failed).toMatchObject({ status: 502, code: "docker_error", key: "exec_kill_failed" });
    expect(await app.operations.run("exec.get", ctx, { execId: started.execId, waitMs: 0 })).toMatchObject({
      status: "running",
      exitCode: null,
    });
    expect(published.some((event) => event.op === "exec.kill_failed" && event.status === "error")).toBe(true);

    await app.operations.run("exec.kill", ctx, { execId: started.execId });
    expect(await app.operations.run("exec.get", ctx, { execId: started.execId, waitMs: 0 })).toMatchObject({
      status: "killed",
      exitCode: 137,
    });
  });

  test("a timeout whose kill fails returns as running, and exec_kill can still stop it", async () => {
    const { app, runtime, ctx } = setup();
    runtime.execScript = null;
    const id = await createBox(app, ctx);
    runtime.failExecKill(new RuntimeError("engine", "a process survived the kill"));
    const result = (await app.operations.run("exec.run", ctx, {
      id,
      argv: ["sleep", "30"],
      timeoutSec: 1,
    })) as { execId: string };
    expect(result).toMatchObject({ status: "running", exitCode: null, timedOut: true });

    await app.operations.run("exec.kill", ctx, { execId: result.execId });
    expect(await app.operations.run("exec.get", ctx, { execId: result.execId, waitMs: 0 })).toMatchObject({
      status: "killed",
      exitCode: 137,
      timedOut: true,
    });
  });

  test("a timeout whose stop keeps failing is retried with a growing delay until it stops the exec", async () => {
    const { app, runtime, ctx } = setup();
    runtime.execScript = null;
    const id = await createBox(app, ctx);
    runtime.failExecKill(new RuntimeError("engine", "a process survived the kill"));
    runtime.failExecKill(new RuntimeError("engine", "a process survived the kill"));
    const started = (await app.operations.run("exec.run", ctx, {
      id,
      argv: ["sleep", "30"],
      background: true,
      timeoutSec: 1,
    })) as { execId: string };

    const session = runtime.execs.at(-1);
    const attempts: number[] = [];
    const deadline = Date.now() + 10_000;
    for (;;) {
      while (attempts.length < (session?.kills ?? 0)) attempts.push(Date.now());
      const view = (await app.operations.run("exec.get", ctx, { execId: started.execId, waitMs: 0 })) as {
        status: string;
      };
      if (view.status === "killed" || Date.now() > deadline) break;
      await Bun.sleep(10);
    }

    expect(attempts).toHaveLength(3);
    expect(attempts[1] as number).toBeGreaterThanOrEqual((attempts[0] as number) + 900);
    expect(attempts[2] as number).toBeGreaterThanOrEqual((attempts[1] as number) + 1900);
    expect(await app.operations.run("exec.get", ctx, { execId: started.execId, waitMs: 0 })).toMatchObject({
      status: "killed",
      exitCode: 137,
      timedOut: true,
    });
  }, 15_000);

  test("kills that overlap share one stop", async () => {
    const { app, runtime, ctx } = setup();
    runtime.execScript = null;
    const id = await createBox(app, ctx);
    const started = (await app.operations.run("exec.run", ctx, { id, argv: ["sleep", "30"], background: true })) as {
      execId: string;
    };

    const gate = runtime.holdExecKill();
    const first = app.operations.run("exec.kill", ctx, { execId: started.execId });
    const second = app.operations.run("exec.kill", ctx, { execId: started.execId });
    await Bun.sleep(30);
    gate.release();
    await Promise.all([first, second]);

    expect(runtime.execs.at(-1)?.kills).toBe(1);
    expect(await app.operations.run("exec.get", ctx, { execId: started.execId, waitMs: 0 })).toMatchObject({
      status: "killed",
      exitCode: 137,
    });
  });

  test("a foreground timeout may be at most 55 seconds, and a background one may be longer", async () => {
    const { app, runtime, ctx } = setup();
    runtime.execScript = { stdout: "", stderr: "", code: 0 };
    const id = await createBox(app, ctx);
    const tooLong = await rejectionOf(app.operations.run("exec.run", ctx, { id, argv: ["true"], timeoutSec: 56 }));
    expect(tooLong).toMatchObject({
      status: 400,
      key: "exec_timeout_foreground",
      details: { field: "timeoutSec" },
    });
    expect(await app.operations.run("exec.run", ctx, { id, argv: ["true"], timeoutSec: 55 })).toMatchObject({
      exitCode: 0,
    });
    const background = (await app.operations.run("exec.run", ctx, {
      id,
      argv: ["true"],
      timeoutSec: 3600,
      background: true,
    })) as { execId: string };
    expect(background).toMatchObject({ background: true });
    expect(await app.operations.run("exec.get", ctx, { execId: background.execId, waitMs: 2000 })).toMatchObject({
      status: "exited",
    });
  });

  test("background execs are capped per box and across boxes, and a refused one does not wake its box", async () => {
    const { app, runtime, ctx } = setup();
    runtime.execScript = null;
    const boxes: string[] = [];
    for (let i = 0; i < 9; i++) boxes.push(await createBox(app, ctx, `cap-${i}`));
    const running: string[] = [];
    const background = (boxId: string) =>
      app.operations.run("exec.run", ctx, { id: boxId, argv: ["sleep", "30"], background: true }) as Promise<{
        execId: string;
      }>;

    for (let i = 0; i < 8; i++) running.push((await background(boxes[0] as string)).execId);
    const perBox = await rejectionOf(background(boxes[0] as string));
    expect(perBox).toMatchObject({ status: 429, code: "too_many_requests", key: "exec_background_box_limit" });

    await app.operations.run("exec.kill", ctx, { execId: running.shift() as string });
    running.push((await background(boxes[0] as string)).execId);

    for (const boxId of boxes.slice(1, 8)) {
      for (let i = 0; i < 8; i++) running.push((await background(boxId)).execId);
    }
    expect(running).toHaveLength(64);
    const total = await rejectionOf(background(boxes[8] as string));
    expect(total).toMatchObject({ status: 429, code: "too_many_requests", key: "exec_background_total_limit" });

    await app.operations.run("box.action", ctx, { id: boxes[0], action: "stop" });
    const starts = runtime.callsTo("startContainer").length;
    const stopped = await rejectionOf(background(boxes[0] as string));
    expect(stopped).toMatchObject({ status: 429, key: "exec_background_box_limit" });
    expect(runtime.callsTo("startContainer").length).toBe(starts);

    for (const execId of running) await app.operations.run("exec.kill", ctx, { execId });
  }, 20_000);

  test("the strict profile runs exec only as dev or 1000, and a refused user does not wake the box", async () => {
    const { app, runtime, ctx } = setup();
    runtime.execScript = { stdout: "", stderr: "", code: 0 };
    const id = await createBox(app, ctx, "locked", "strict");
    await app.operations.run("box.action", ctx, { id, action: "stop" });
    const starts = runtime.callsTo("startContainer").length;
    const execs = runtime.callsTo("startExec").length;

    const refused = await rejectionOf(app.operations.run("exec.run", ctx, { id, argv: ["id", "-u"], user: "root" }));
    expect(refused).toMatchObject({ status: 403, code: "forbidden", key: "exec_user_strict" });
    expect(runtime.callsTo("startContainer").length).toBe(starts);
    expect(runtime.callsTo("startExec").length).toBe(execs);

    for (const user of ["dev", "1000"]) {
      await app.operations.run("exec.run", ctx, { id, argv: ["true"], user });
      expect(runtime.execs.at(-1)?.spec.stopAs).toBe(user);
    }
    expect(runtime.callsTo("startExec").length).toBe(execs + 2);
  });

  test("a strict refusal is audited as denied, not as an error", async () => {
    const { app, ctx } = setup();
    const id = await createBox(app, ctx, "locked", "strict");
    await rejectionOf(app.operations.run("exec.run", ctx, { id, argv: ["id", "-u"], user: "root" }));
    expect(app.events.list({ op: "exec.run", status: "denied" }, { limit: 5 }).events).toHaveLength(1);
    expect(app.events.list({ op: "exec.run", status: "error" }, { limit: 5 }).events).toHaveLength(0);
  });

  test("root runs are marked privileged in the audit, and a finished exec keeps its duration", async () => {
    const { app, runtime, ctx } = setup();
    runtime.execScript = { stdout: "", stderr: "", code: 0 };
    const id = await createBox(app, ctx);
    const published: StoredEvent[] = [];
    app.bus.subscribe("event", (event) => published.push(event));

    const rooted = (await app.operations.run("exec.run", ctx, { id, argv: ["id"], user: "0:0" })) as {
      execId: string;
    };
    const asDev = await app.operations.run("exec.run", ctx, { id, argv: ["id"] });
    const runs = published.filter((event) => event.op === "exec.run");
    expect(runs[0]?.detail).toMatchObject({ user: "0:0", privileged: true });
    expect(runs[1]?.detail).toMatchObject({ user: "dev", privileged: false });
    expect(asDev).toMatchObject({ exitCode: 0 });

    const first = (await app.operations.run("exec.get", ctx, { execId: rooted.execId, waitMs: 0 })) as {
      status: string;
      durationMs: number;
    };
    expect(first.status).toBe("exited");
    await Bun.sleep(60);
    const later = (await app.operations.run("exec.get", ctx, { execId: rooted.execId, waitMs: 0 })) as {
      durationMs: number;
    };
    expect(later.durationMs).toBe(first.durationMs);
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
      expect(events.some((event) => event.source === "rest" && event.status === "error")).toBe(true);
      expect(events.some((event) => event.source === "cli")).toBe(false);
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
