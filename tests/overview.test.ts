import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { App } from "../src/app";
import type { Config } from "../src/config";
import type { EventInput, EventTarget, PrincipalRef } from "../src/events/types";
import { ulid } from "../src/events/ulid";
import type { HostMetrics } from "../src/host/metrics";
import { startServer } from "../src/server";
import type { VolumeLimits } from "../src/volumes/types";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { bootCluster } from "./support/cluster";
import type { FakeRuntime } from "./support/fake-runtime";
import type { FakeCheckpointEngine } from "./support/fake-snapshots";
import { selfTokenOf } from "./support/self";
import { call, finishedTask, mint, refused } from "./support/tokens";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const GB = 1024 ** 3;
const MB = 1024 ** 2;
/** A machine with room to spare, so the local host reports nothing it needs attention for. */
const ROOMY_HOST = { cpu: { cores: 64 }, memory: { total: 64 * GB } } as unknown as HostMetrics;
/** A machine of 2 CPUs and 4 GiB, which the boxes of a test can fill past what the default overcommit ratio allows. */
const TIGHT_HOST = { cpu: { cores: 2 }, memory: { total: 4 * GB } } as unknown as HostMetrics;

interface Progress {
  box: { id: string; name: string; hostId: string };
  principal: { type: string; id: string; name: string };
  lastAt: string;
  lastOp: string;
  command: { text: string; execId: string; running: boolean; output: string[] } | null;
  session: string | null;
  note: string | null;
}

interface Attention {
  kind: string;
  severity: "error" | "warning";
  hostId: string;
  at: string | null;
  subject: string;
  box: { id: string; name: string } | null;
  params: Record<string, string | number>;
}

interface Overview {
  inProgress: Progress[];
  attention: Attention[];
}

interface Running {
  readonly app: App;
  readonly runtime: FakeRuntime;
  readonly engine: FakeCheckpointEngine;
  readonly base: string;
}

const servers: (() => void)[] = [];
let restoreLogs: () => void;

beforeEach(() => {
  restoreLogs = silenceLogs();
});

afterEach(() => {
  for (const stop of servers.splice(0)) stop();
  restoreLogs();
});

/** An app on an ephemeral port. Its fake engine keeps every exec running until the test ends it. */
function start(overrides: Partial<Config> = {}): Running {
  const { app, runtime, checkpoints } = createTestApp({ labelPrefix: "mbtest", ...overrides });
  app.monitor.snapshot = async () => ROOMY_HOST;
  const keys = app.hosts.get().keys;
  runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
  runtime.execScript = null;
  const server = startServer(app);
  servers.push(() => {
    server.stop(true);
    app.throttle.stop();
    app.sessions.stop();
    app.tokens.stop();
    app.events.close();
  });
  return { app, runtime, engine: checkpoints, base: `http://127.0.0.1:${server.port}` };
}

async function overview(base: string, token?: string): Promise<Overview> {
  const reply = await call(base, "/api/overview", { token });
  expect(reply.status).toBe(200);
  return reply.json as unknown as Overview;
}

/** Reads the overview as it would look `ms` later, for the windows that depend on how long ago something happened. */
async function overviewAfter(base: string, ms: number): Promise<Overview> {
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + ms);
  try {
    return await overview(base);
  } finally {
    clock.mockRestore();
  }
}

/** Polls `read` until `done` accepts its value. The fake engine delivers output asynchronously, so a read can lag it. */
async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

async function makeBox(base: string, name: string, token?: string, extra: Record<string, unknown> = {}) {
  const reply = await call(base, "/api/boxes", { token, body: { name, cpus: 1, memoryMb: 256, ...extra } });
  expect(reply.status).toBe(201);
  if (!reply.json.box) throw new Error("the create reply has no box");
  return reply.json.box;
}

async function startCommand(
  base: string,
  boxId: string,
  body: Record<string, unknown>,
  token?: string,
): Promise<{ execId: string }> {
  const reply = await call(base, `/api/boxes/${boxId}/exec`, { token, body: { background: true, ...body } });
  expect(reply.status).toBe(200);
  return reply.json as unknown as { execId: string };
}

function lastExec(runtime: FakeRuntime) {
  const exec = runtime.execs.at(-1);
  if (!exec) throw new Error("no exec was started");
  return exec;
}

async function takeCheckpoint(base: string, boxId: string, body: Record<string, unknown> = {}) {
  const started = await call(base, `/api/boxes/${boxId}/checkpoints`, { method: "POST", body });
  expect(started.status).toBe(202);
  const done = await finishedTask(base, started.json.taskId ?? "");
  expect(done.status).toBe("succeeded");
  if (!done.result?.checkpoint) throw new Error("the task returned no checkpoint");
  return done.result.checkpoint;
}

function volumeNamed(app: App, name: string) {
  const volume = app.hosts
    .get()
    .volumes.list()
    .find((item) => item.name === name);
  if (!volume) throw new Error(`no volume named ${name}`);
  return volume;
}

function markUsage(app: App, name: string, bytes: number, limits: Partial<VolumeLimits>): void {
  app.hosts.get().volumes.write({
    ...volumeNamed(app, name),
    bytes,
    bytesAt: new Date().toISOString(),
    limits: { softBytes: null, hardBytes: null, action: "warn", ...limits },
  });
}

interface SeededEvent {
  readonly ts: number;
  readonly op: string;
  readonly kind: EventInput["kind"];
  readonly principal: PrincipalRef;
  readonly target?: EventTarget;
}

/** Records an event the way the server's own recording does, at the time given. */
function seed(app: App, event: SeededEvent): void {
  app.events.append({
    id: ulid(event.ts),
    ts: event.ts,
    durationMs: 0,
    status: "ok",
    op: event.op,
    kind: event.kind,
    principal: event.principal,
    source: "system",
    hostId: "local",
    summary: event.op,
    target: event.target,
  });
}

const OWNER: PrincipalRef = { type: "owner", id: "owner", name: "owner" };

function workspaceEngineOf(app: App, boxId: string): string {
  const mount = app.hosts
    .get()
    .specs.read(boxId)
    ?.mounts.find((item) => item.path === "/workspace");
  if (!mount) throw new Error("the box has no workspace mount");
  return mount.volume;
}

function poolHealth(app: App, status: "reachable" | "unreachable", message: string | null): string {
  const host = app.hosts.get();
  const checkedAt = new Date().toISOString();
  host.volumes.rememberHealth({
    pool: "local",
    hostId: host.host.id,
    status,
    message,
    checkedAt,
    totalBytes: null,
    freeBytes: null,
    usedBytes: null,
    lowSpace: false,
  });
  return checkedAt;
}

describe("who can read the overview", () => {
  test("an empty server has nothing in progress and nothing that needs attention", async () => {
    const h = start();
    expect(await overview(h.base)).toEqual({ inProgress: [], attention: [] });
  });

  test("a token, even an admin one, and a box's own agent are refused it", async () => {
    const h = start();
    const admin = mint(h.app, { name: "admin", preset: "admin" });
    expect(refused(await call(h.base, "/api/overview", { token: admin.secret }))).toEqual({
      status: 403,
      key: "operation_forbidden",
    });

    const box = await makeBox(h.base, "alpha", undefined, { selfToken: true });
    const self = await selfTokenOf(h.runtime, box.id);
    expect(refused(await call(h.base, "/api/overview", { token: self }))).toEqual({
      status: 403,
      key: "operation_forbidden",
    });
  });
});

describe("what is in progress", () => {
  test("a command an agent starts is in progress, with the last lines it printed", async () => {
    const h = start();
    const builder = mint(h.app, { name: "builder", preset: "sandboxed-agent" });
    const box = await makeBox(h.base, "alpha", builder.secret);
    const started = await startCommand(h.base, box.id, { cmd: "npm run dev" }, builder.secret);
    lastExec(h.runtime).print("compiling\nready in 1.2s\nlistening on 3000\n");

    const view = await waitFor(
      () => overview(h.base),
      (value) => value.inProgress[0]?.command?.output.length === 3,
      "the output of the command",
    );
    expect(view.inProgress).toEqual([
      {
        box: { id: box.id, name: "alpha", hostId: "local" },
        principal: { type: "token", id: builder.id, name: "builder" },
        lastAt: expect.any(String),
        lastOp: expect.any(String),
        command: {
          text: "npm run dev",
          execId: started.execId,
          running: true,
          output: ["compiling", "ready in 1.2s", "listening on 3000"],
        },
        session: null,
        note: null,
      },
    ]);
  });

  test("the output tail shows the newest three lines, and the command ends when the process exits", async () => {
    const h = start();
    const builder = mint(h.app, { name: "builder", preset: "sandboxed-agent" });
    const box = await makeBox(h.base, "alpha", builder.secret);
    await startCommand(h.base, box.id, { cmd: "tail -f app.log" }, builder.secret);

    lastExec(h.runtime).print("one\ntwo\n");
    await waitFor(
      () => overview(h.base),
      (value) => value.inProgress[0]?.command?.output.join("|") === "one|two",
      "two lines",
    );
    lastExec(h.runtime).print("three\nfour\n");
    await waitFor(
      () => overview(h.base),
      (value) => value.inProgress[0]?.command?.output.join("|") === "two|three|four",
      "the newest three lines",
    );

    lastExec(h.runtime).exit(0);
    const ended = await waitFor(
      () => overview(h.base),
      (value) => value.inProgress[0]?.command?.running === false,
      "the command to end",
    );
    expect(ended.inProgress[0]?.command).toEqual({
      text: "tail -f app.log",
      execId: expect.any(String),
      running: false,
      output: [],
    });
  });

  test("the owner's own commands and changes never put a box in progress", async () => {
    const h = start();
    const box = await makeBox(h.base, "alpha");
    await startCommand(h.base, box.id, { cmd: "npm run dev" });
    expect(await overview(h.base)).toEqual({ inProgress: [], attention: [] });
  });

  test("activity more than ten minutes old is not in progress, but a command still running keeps its box", async () => {
    const h = start();
    const builder = mint(h.app, { name: "builder", preset: "sandboxed-agent" });
    const finished = await makeBox(h.base, "finished", builder.secret);
    await startCommand(h.base, finished.id, { cmd: "make" }, builder.secret);
    lastExec(h.runtime).exit(0);
    const busy = await makeBox(h.base, "busy", builder.secret);
    await startCommand(h.base, busy.id, { cmd: "npm start" }, builder.secret);
    await waitFor(
      () => overview(h.base),
      (value) => value.inProgress.length === 2 && value.inProgress.some((item) => item.command?.running === false),
      "both boxes and the finished command",
    );

    const later = await overviewAfter(h.base, 11 * MINUTE);
    expect(later.inProgress.map((item) => item.box.name)).toEqual(["busy"]);
    expect(later.inProgress[0]?.command?.running).toBe(true);
  });

  test("a command started more than two hours ago is not looked for, even while it still runs", async () => {
    const h = start();
    const builder = mint(h.app, { name: "builder", preset: "sandboxed-agent" });
    const box = await makeBox(h.base, "alpha", builder.secret);
    await startCommand(h.base, box.id, { cmd: "sleep 99999" }, builder.secret);
    expect((await overview(h.base)).inProgress).toHaveLength(1);

    expect(await overviewAfter(h.base, 3 * HOUR)).toEqual({ inProgress: [], attention: [] });
  });

  test("argv is shown as the words of the command, and an env value never appears", async () => {
    const h = start();
    const builder = mint(h.app, { name: "builder", preset: "sandboxed-agent" });
    const box = await makeBox(h.base, "alpha", builder.secret);
    await startCommand(
      h.base,
      box.id,
      { argv: ["tail", "-f", "/var/log/app.log"], env: { API_TOKEN: "super-secret-value" } },
      builder.secret,
    );

    const view = await overview(h.base);
    expect(view.inProgress[0]?.command?.text).toBe("tail -f /var/log/app.log");
    expect(JSON.stringify(view)).not.toContain("super-secret-value");
  });

  test("a secret the command prints is redacted in the output tail", async () => {
    const h = start();
    const builder = mint(h.app, { name: "builder", preset: "sandboxed-agent" });
    const box = await makeBox(h.base, "alpha", builder.secret);
    await startCommand(h.base, box.id, { cmd: "env" }, builder.secret);
    lastExec(h.runtime).print(`ACCESS=${TEST_KEY}\n`);

    const view = await waitFor(
      () => overview(h.base),
      (value) => (value.inProgress[0]?.command?.output.length ?? 0) > 0,
      "the printed line",
    );
    const line = view.inProgress[0]?.command?.output[0] ?? "";
    expect(line).toContain("ACCESS=");
    expect(line).not.toContain(TEST_KEY);
  });

  test("the terminal session an agent opened last is named on its box", async () => {
    const h = start();
    const builder = mint(h.app, { name: "builder", preset: "sandboxed-agent" });
    const box = await makeBox(h.base, "alpha", builder.secret);
    const opened = await call(h.base, `/api/boxes/${box.id}/sessions`, {
      token: builder.secret,
      body: { name: "work" },
    });
    expect(opened.status).toBeLessThan(300);

    expect((await overview(h.base)).inProgress).toEqual([
      expect.objectContaining({ box: expect.objectContaining({ name: "alpha" }), session: "work" }),
    ]);
  });

  test("a box's own agent is its principal, and its note shows", async () => {
    const h = start();
    const box = await makeBox(h.base, "alpha", undefined, { selfToken: true });
    const self = await selfTokenOf(h.runtime, box.id);
    const reported = await call(h.base, "/api/self/status", {
      token: self,
      body: { state: "working", note: "compiling the release" },
    });
    expect(reported.status).toBe(200);

    expect((await overview(h.base)).inProgress).toEqual([
      expect.objectContaining({
        box: { id: box.id, name: "alpha", hostId: "local" },
        principal: { type: "box-self", id: box.boxId, name: "alpha" },
        note: "compiling the release",
        command: null,
      }),
    ]);
  });

  test("a box deleted and replaced by a box of the same name carries none of the old box's activity", async () => {
    const h = start();
    const builder = mint(h.app, { name: "builder", preset: "sandboxed-agent" });
    const old = await makeBox(h.base, "alpha", builder.secret);
    await startCommand(h.base, old.id, { cmd: "sleep 600" }, builder.secret);
    expect((await overview(h.base)).inProgress).toHaveLength(1);

    expect((await call(h.base, `/api/boxes/${old.id}`, { method: "DELETE" })).status).toBe(200);
    await makeBox(h.base, "alpha");

    expect((await overview(h.base)).inProgress).toEqual([]);
  });
});

describe("what needs attention", () => {
  test("an out-of-memory kill the server recorded is an error on its box", async () => {
    const h = start();
    const box = await makeBox(h.base, "alpha");
    seed(h.app, {
      ts: Date.now(),
      op: "container.oom",
      kind: "write",
      principal: OWNER,
      target: { kind: "box", id: box.id, name: "alpha" },
    });

    expect((await overview(h.base)).attention).toEqual([
      expect.objectContaining({
        kind: "box.oom",
        severity: "error",
        hostId: "local",
        subject: "alpha",
        box: { id: box.id, name: "alpha" },
        params: {},
      }),
    ]);
  });

  test("a checkpoint the server failed is an error, and a request it refused is not listed", async () => {
    const h = start();
    const box = await makeBox(h.base, "alpha");
    h.engine.failBackupOf.add(workspaceEngineOf(h.app, box.boxId));
    const started = await call(h.base, `/api/boxes/${box.id}/checkpoints`, { method: "POST", body: {} });
    expect(started.status).toBe(202);
    expect((await finishedTask(h.base, started.json.taskId ?? "")).status).toBe("failed");
    const refusedBox = await call(h.base, "/api/boxes/bx_missing/checkpoints", { method: "POST", body: {} });
    expect(refusedBox.status).toBe(404);

    expect((await overview(h.base)).attention).toEqual([
      expect.objectContaining({
        kind: "box.checkpoint_failed",
        severity: "error",
        subject: "alpha",
        box: { id: box.id, name: "alpha" },
      }),
    ]);
  });

  test("a box whose live config drifted from its spec is listed with the fields that differ", async () => {
    const h = start();
    const box = await makeBox(h.base, "alpha");
    const container = h.runtime.containers.get(box.id);
    if (!container) throw new Error("the box has no container");
    container.cpus = 3;
    const host = h.app.hosts.get();
    await host.sampler.observe(box.id);
    await host.sampler.settle();

    expect((await overview(h.base)).attention).toEqual([
      expect.objectContaining({
        kind: "box.drift",
        severity: "warning",
        subject: "alpha",
        box: { id: box.id, name: "alpha" },
        params: { fields: "cpus" },
      }),
    ]);
  });

  test("a rollback that waits for its confirm or undo is listed with the checkpoint it went back to", async () => {
    const h = start();
    const box = await makeBox(h.base, "alpha");
    const checkpoint = await takeCheckpoint(h.base, box.id, { label: "before the refactor" });
    const started = await call(h.base, `/api/boxes/${box.id}/rollback`, {
      method: "POST",
      body: { checkpoint: checkpoint.id, confirm: true },
      headers: { "if-match": String(box.revision) },
    });
    expect(started.status).toBe(202);
    expect((await finishedTask(h.base, started.json.taskId ?? "")).status).toBe("succeeded");
    const current = await call(h.base, `/api/boxes/${box.boxId}`);
    const currentId = current.json.box?.id;

    expect((await overview(h.base)).attention).toEqual([
      expect.objectContaining({
        kind: "box.rollback_pending",
        severity: "warning",
        subject: "alpha",
        box: { id: currentId, name: "alpha" },
        params: { checkpoint: "before the refactor" },
      }),
    ]);
  });

  test("a volume over its hard limit is an error when the limit stops it, and a warning when it only warns", async () => {
    const h = start();
    await makeBox(h.base, "alpha");
    markUsage(h.app, "alpha-workspace", 5 * MB, { hardBytes: 4 * MB, action: "stop" });
    markUsage(h.app, "alpha-home", 5 * MB, { hardBytes: 4 * MB, action: "warn" });
    markUsage(h.app, "alpha-cache", 3 * MB, { softBytes: 2 * MB, hardBytes: 4 * MB, action: "stop" });

    const view = await overview(h.base);
    expect(view.attention.map((item) => [item.kind, item.severity, item.subject])).toEqual([
      ["volume.over_limit", "error", "alpha-workspace"],
      ["volume.over_limit", "warning", "alpha-home"],
    ]);
    expect(view.attention[0]).toMatchObject({
      params: { used: 5 * MB, limit: 4 * MB, action: "stop" },
      box: { name: "alpha" },
    });
  });

  test("a pool that did not answer is an error with the message it reported", async () => {
    const h = start();
    const host = h.app.hosts.get();
    const checkedAt = poolHealth(h.app, "unreachable", "the engine did not answer");

    expect((await overview(h.base)).attention).toEqual([
      {
        kind: "pool.unreachable",
        severity: "error",
        hostId: host.host.id,
        at: checkedAt,
        subject: "local",
        box: null,
        params: { detail: "the engine did not answer" },
      },
    ]);
  });

  test("a host disk below its minimum free space is listed with the free and minimum percentages", async () => {
    const h = start();
    const host = h.app.hosts.get();
    host.volumes.rememberDisk(host.host.id, { totalBytes: 100 * GB, freeBytes: 5 * GB, at: Date.now() });

    expect((await overview(h.base)).attention).toEqual([
      expect.objectContaining({
        kind: "host.disk_low",
        severity: "warning",
        hostId: host.host.id,
        subject: host.host.name,
        box: null,
        params: { free: 5, min: 10 },
      }),
    ]);
  });

  test("boxes that reserve more CPU than the host allows are a warning, with the booked and allowed cores", async () => {
    const h = start();
    h.app.monitor.snapshot = async () => TIGHT_HOST;
    await makeBox(h.base, "alpha", undefined, { cpus: 2 });
    await makeBox(h.base, "beta", undefined, { cpus: 2 });

    expect((await overview(h.base)).attention).toEqual([
      expect.objectContaining({
        kind: "host.cpu_overcommit",
        severity: "warning",
        hostId: "local",
        at: null,
        subject: h.app.hosts.get().host.name,
        box: null,
        params: { booked: 4, limit: 2 },
      }),
    ]);
  });

  test("a host whose FORWARD rules drop a proxy-only box's traffic is an error, naming the bridge and the boxes", async () => {
    const h = start();
    const host = h.app.hosts.get();
    await makeBox(h.base, "agent", undefined, {
      egress: { mode: "proxy-only", domains: ["example.com"] },
    });
    h.runtime.forwardVerdict = { forwarding: false, cause: "policy", detail: "iptables FORWARD policy is DROP" };
    await h.app.egressForward.tick();

    const view = await overview(h.base);
    expect(view.attention).toEqual([
      expect.objectContaining({
        kind: "host.forward_blocked",
        severity: "error",
        hostId: host.host.id,
        subject: host.host.name,
        box: null,
        params: expect.objectContaining({
          boxes: "agent",
          count: 1,
          detail: "iptables FORWARD policy is DROP",
        }),
      }),
    ]);
    expect(String(view.attention[0]?.params.bridge)).toMatch(/^br-/);
  });

  test("a host whose rules are fine lists nothing, and an open box alone is never checked", async () => {
    const h = start();
    await makeBox(h.base, "plain");
    await h.app.egressForward.tick();
    expect((await overview(h.base)).attention).toEqual([]);
  });

  test("an offline host is not also listed for forwarding, since its last reading is from before it went away", async () => {
    const h = start();
    await makeBox(h.base, "agent", undefined, { egress: { mode: "proxy-only", domains: ["example.com"] } });
    h.runtime.forwardVerdict = { forwarding: false, cause: "policy", detail: "iptables FORWARD policy is DROP" };
    await h.app.egressForward.tick();
    expect((await overview(h.base)).attention.map((item) => item.kind)).toEqual(["host.forward_blocked"]);

    h.app.hosts.get().host.status = "offline";
    expect((await overview(h.base)).attention.map((item) => item.kind)).toEqual(["host.offline"]);
  });

  test("the item clears once a pass finds the rules right, since the check is what decides", async () => {
    const h = start();
    await makeBox(h.base, "agent", undefined, { egress: { mode: "proxy-only", domains: ["example.com"] } });
    h.runtime.forwardVerdict = { forwarding: false, cause: "policy", detail: "iptables FORWARD policy is DROP" };
    await h.app.egressForward.tick();
    expect((await overview(h.base)).attention.map((item) => item.kind)).toEqual(["host.forward_blocked"]);

    h.runtime.forwardVerdict = { forwarding: true, cause: null, detail: "iptables accepts the uplink" };
    h.app.egressForward.hostOnline(h.app.hosts.get().host.id);
    await h.app.egressForward.tick();
    expect((await overview(h.base)).attention).toEqual([]);
  });

  test("boxes that reserve more memory than the host allows are a warning, with the booked and allowed bytes", async () => {
    const h = start();
    h.app.monitor.snapshot = async () => TIGHT_HOST;
    await makeBox(h.base, "alpha", undefined, { memoryMb: 3 * 1024 });
    await makeBox(h.base, "beta", undefined, { memoryMb: 3 * 1024 });

    expect((await overview(h.base)).attention).toEqual([
      expect.objectContaining({
        kind: "host.memory_overcommit",
        severity: "warning",
        hostId: "local",
        subject: h.app.hosts.get().host.name,
        box: null,
        params: { booked: 6 * 1024 * MB, limit: 4 * GB },
      }),
    ]);
  });

  test("a total that only equals what the host allows is not over it", async () => {
    const h = start();
    h.app.monitor.snapshot = async () => TIGHT_HOST;
    await makeBox(h.base, "alpha", undefined, { cpus: 1, memoryMb: 2048 });
    await makeBox(h.base, "beta", undefined, { cpus: 1, memoryMb: 2048 });

    expect((await overview(h.base)).attention).toEqual([]);
  });

  test("the overcommit ratio raises the limit the booked total is held to", async () => {
    const h = start({ hostOvercommit: 2 });
    h.app.monitor.snapshot = async () => TIGHT_HOST;
    await makeBox(h.base, "alpha", undefined, { cpus: 2 });
    await makeBox(h.base, "beta", undefined, { cpus: 2 });
    expect((await overview(h.base)).attention).toEqual([]);

    await makeBox(h.base, "gamma", undefined, { cpus: 1 });
    expect((await overview(h.base)).attention).toEqual([
      expect.objectContaining({ kind: "host.cpu_overcommit", params: { booked: 5, limit: 4 } }),
    ]);
  });

  test("a capacity the host does not report is not checked", async () => {
    const h = start();
    const host = h.app.hosts.get();
    host.capacity = async () => ({ cpus: null, memoryBytes: null });
    await makeBox(h.base, "alpha", undefined, { cpus: 2, memoryMb: 2048 });
    await makeBox(h.base, "beta", undefined, { cpus: 2, memoryMb: 2048 });

    expect((await overview(h.base)).attention).toEqual([]);
  });

  test("a capacity read that never answers times out while the other attention items remain visible", async () => {
    const h = start();
    await makeBox(h.base, "alpha");
    poolHealth(h.app, "unreachable", "gone");
    const host = h.app.hosts.get();
    host.readTimeoutMs = 40;
    const gate = Promise.withResolvers<{ cpus: number; memoryBytes: number }>();
    host.capacity = () => gate.promise;
    try {
      const result = await Promise.race([overview(h.base), Bun.sleep(1000).then(() => null)]);
      expect(result).not.toBeNull();
      expect(result?.attention).toEqual([expect.objectContaining({ kind: "pool.unreachable" })]);
    } finally {
      gate.resolve({ cpus: 64, memoryBytes: 64 * GB });
    }
  });

  test("a host that is offline reports no overcommit, since its boxes cannot be read", async () => {
    const h = start();
    h.app.monitor.snapshot = async () => TIGHT_HOST;
    await makeBox(h.base, "alpha", undefined, { cpus: 2 });
    await makeBox(h.base, "beta", undefined, { cpus: 2 });
    expect((await overview(h.base)).attention).toEqual([expect.objectContaining({ kind: "host.cpu_overcommit" })]);

    h.app.hosts.get().host.status = "offline";
    expect((await overview(h.base)).attention).toEqual([
      expect.objectContaining({ kind: "host.offline", severity: "error" }),
    ]);
  });

  test("a condition that clears is no longer listed", async () => {
    const h = start();
    await makeBox(h.base, "alpha");
    markUsage(h.app, "alpha-workspace", 5 * MB, { hardBytes: 4 * MB, action: "stop" });
    poolHealth(h.app, "unreachable", "gone");
    const kinds = async () => (await overview(h.base)).attention.map((item) => item.kind).toSorted();
    expect(await kinds()).toEqual(["pool.unreachable", "volume.over_limit"]);

    markUsage(h.app, "alpha-workspace", 1 * MB, { hardBytes: 4 * MB, action: "stop" });
    poolHealth(h.app, "reachable", null);
    expect(await kinds()).toEqual([]);
  });

  test("a failure older than a day is no longer listed, and a recent one still is", async () => {
    const h = start();
    seed(h.app, {
      ts: Date.now() - 25 * HOUR,
      op: "container.oom",
      kind: "write",
      principal: OWNER,
      target: { kind: "box", id: "c-old", name: "gone-old" },
    });
    seed(h.app, {
      ts: Date.now() - 23 * HOUR,
      op: "container.oom",
      kind: "write",
      principal: OWNER,
      target: { kind: "box", id: "c-recent", name: "gone-recent" },
    });

    expect((await overview(h.base)).attention.map((item) => item.subject)).toEqual(["gone-recent"]);
  });

  test("errors come before warnings, and the newest comes first within each", async () => {
    const h = start();
    await makeBox(h.base, "alpha");
    markUsage(h.app, "alpha-home", 5 * MB, { hardBytes: 4 * MB, action: "warn" });
    seed(h.app, {
      ts: Date.now() - 2 * HOUR,
      op: "container.oom",
      kind: "write",
      principal: OWNER,
      target: { kind: "box", id: "c-a", name: "older" },
    });
    seed(h.app, {
      ts: Date.now() - HOUR,
      op: "container.oom",
      kind: "write",
      principal: OWNER,
      target: { kind: "box", id: "c-b", name: "newer" },
    });

    expect((await overview(h.base)).attention.map((item) => item.subject)).toEqual(["newer", "older", "alpha-home"]);
  });
});

describe("across hosts", () => {
  test("a box on another host shows its host, and an offline host and a low disk are listed", async () => {
    const cluster = await bootCluster();
    try {
      cluster.engines.small.execScript = null;
      const builder = mint(cluster.app, { name: "builder", preset: "sandboxed-agent", hosts: { type: "all" } });
      const created = await call(cluster.base, "/api/boxes", {
        token: builder.secret,
        body: { name: "remote", cpus: 1, memoryMb: 256, host: "small" },
      });
      expect(created.status).toBe(201);
      const box = created.json.box;
      if (!box) throw new Error("the create reply has no box");
      await call(cluster.base, `/api/boxes/${box.id}/exec`, {
        token: builder.secret,
        body: { cmd: "npm test", background: true },
      });
      cluster.engines.small.execs.at(-1)?.print("running 4 tests\n");

      cluster.app.hosts.get("large").host.status = "offline";
      cluster.app.hosts
        .get()
        .volumes.rememberDisk("small", { totalBytes: 100 * GB, freeBytes: 2 * GB, at: Date.now() });

      const view = await waitFor(
        async () => (await call(cluster.base, "/api/overview")).json as unknown as Overview,
        (value) => value.inProgress[0]?.command?.output.length === 1,
        "the remote command's output",
      );
      expect(view.inProgress[0]).toMatchObject({
        box: { id: box.id, name: "remote", hostId: "small" },
        command: { text: "npm test", running: true, output: ["running 4 tests"] },
      });
      expect(view.attention.map((item) => [item.kind, item.hostId, item.subject]).toSorted()).toEqual([
        ["host.disk_low", "small", "small"],
        ["host.offline", "large", "large"],
      ]);
    } finally {
      cluster.close();
    }
  }, 20_000);

  test("only the host whose boxes reserve past its capacity is listed, with that host's own totals", async () => {
    const cluster = await bootCluster();
    try {
      const create = (name: string, host: string, cpus: number) =>
        call(cluster.base, "/api/boxes", { body: { name, host, cpus, memoryMb: 256, mounts: [] } });
      expect((await create("fits", "large", 1)).status).toBe(201);
      expect((await create("over", "small", 2)).status).toBe(201);

      // The engine of `small` now reports fewer cores than the boxes it holds already reserve.
      cluster.engines.small.engine = { cpus: 1, memoryBytes: 4 * GB };

      const view = await waitFor(
        async () => (await call(cluster.base, "/api/overview")).json as unknown as Overview,
        (value) => value.attention.length > 0,
        "the overcommitted host to be listed",
      );
      expect(view.attention).toEqual([
        expect.objectContaining({
          kind: "host.cpu_overcommit",
          severity: "warning",
          hostId: "small",
          at: null,
          subject: "small",
          box: null,
          params: { booked: 2, limit: 1 },
        }),
      ]);
    } finally {
      cluster.close();
    }
  }, 20_000);

  test("a hosts file that repeats a name still reports both hosts distinguishably, by id beside the name", async () => {
    const cluster = await bootCluster();
    try {
      // `small` and `large` are stored under one display name, which an older hosts file may hold. Both are marked offline
      // through the state the server keeps, so both conditions are listed in one answer and must not read as one host.
      cluster.app.hosts.get("small").host.name = "Lab";
      cluster.app.hosts.get("large").host.name = "Lab";
      cluster.app.hosts.get("small").host.status = "offline";
      cluster.app.hosts.get("large").host.status = "offline";
      const view = await overview(cluster.base);
      const offline = view.attention.filter((item) => item.kind === "host.offline");
      expect(offline.map((item) => [item.hostId, item.subject]).toSorted()).toEqual([
        ["large", "Lab · large"],
        ["small", "Lab · small"],
      ]);
    } finally {
      cluster.close();
    }
  }, 20_000);
});
