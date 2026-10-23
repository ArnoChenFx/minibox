import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
import type { AuditNote, Source } from "../src/events/types";
import type { HostCtx } from "../src/host/registry";
import { createLocalHost } from "../src/host/registry";
import { msg } from "../src/lib/messages";
import { OWNER } from "../src/operations/types";
import { type PreviewDeps, resolvePreview } from "../src/preview/proxy";
import { ActivityPulse } from "../src/services/activity-pulse";
import * as boxes from "../src/services/boxes";
import type { Box } from "../src/services/boxes";
import { copyFiles, downloadArchive, listFiles, readFile, uploadArchive, writeFile } from "../src/services/files";
import { fileArchive } from "../src/services/files-tar";
import { type LifecycleOptions, LifecycleWatcher } from "../src/services/lifecycle";
import { BoxPower } from "../src/services/power";
import { rebuildBox } from "../src/services/rebuild";
import { reconcileHost } from "../src/services/reconcile";
import { readStartupCommand, runStartupCommand, setStartupCommand } from "../src/services/startup-command";
import type { RecordNote } from "../src/services/terminals";
import { createVolume, type VolumeView } from "../src/services/volumes";
import { ttlEndsAt, ttlExpired } from "../src/specs/lifetime";
import { createTestApp, rejectionOf, silenceLogs } from "./support/app";
import { FakeRuntime } from "./support/fake-runtime";

interface Noted {
  readonly hostId: string;
  readonly source: Source;
  readonly op: string;
  readonly detail: unknown;
}

let app: App;
let runtime: FakeRuntime;
let host: HostCtx;
let notes: Noted[];
/** Added to the clock the watcher reads, so a test can let idle time pass without waiting. */
let offsetMs: number;
let primed: HostCtx[];
let restoreLogs: () => void;

beforeEach(() => {
  restoreLogs = silenceLogs();
  ({ app, runtime } = createTestApp({
    labelPrefix: "mbtest",
    boxIdleTimeoutSec: 60,
    boxIdleCpuPercent: 5,
    lifecycleIntervalMs: 60_000,
  }));
  host = app.hosts.get();
  runtime.seedImage(host.baseTemplateTag, { [host.keys.template]: "true", [host.keys.templateName]: "base" });
  notes = [];
  offsetMs = 0;
  primed = [];
});

afterEach(() => {
  for (const sampled of primed) sampled.sampler.stop();
  restoreLogs();
});

const recordLifecycle: RecordNote = (hostId, source, _principal, note) => {
  notes.push({ hostId, source, op: note.op, detail: note.detail });
};

const auditTo =
  (hostId: string, source: Source) =>
  (note: AuditNote): void => {
    notes.push({ hostId, source, op: note.op, detail: note.detail });
  };

function watcher(): LifecycleWatcher {
  const options: LifecycleOptions = {
    hosts: app.hosts,
    pulse: app.pulse,
    terminals: app.terminals,
    execs: app.execs,
    tasks: app.tasks,
    cfg: app.cfg,
    record: recordLifecycle,
    now: () => Date.now() + offsetMs,
  };
  return new LifecycleWatcher(options);
}

function newBox(
  name: string,
  patch: { idleTimeoutSec?: number | null; ttlSec?: number | null; startupCommand?: string } = {},
): Promise<Box> {
  return boxes.createBox(host, { name, cpus: 1, memoryMb: 256, ...patch });
}

function backdate(boxId: string, ms: number): void {
  const spec = host.specs.read(boxId);
  if (!spec) throw new Error(`no spec for ${boxId}`);
  host.specs.write({ ...spec, createdAt: new Date(Date.now() - ms).toISOString() });
}

async function primeSampler(on: HostCtx, box: Box): Promise<void> {
  primed.push(on);
  on.sampler.start();
  await on.sampler.observe(box.id);
  await on.sampler.sampleNow();
}

/** A running box, idle for two minutes with a 30 second window, whose CPU sample is low. */
async function quietBox(name: string, startupCommand?: string): Promise<Box> {
  const box = await newBox(name, { idleTimeoutSec: 30, startupCommand });
  app.pulse.touch(box.boxId, "exec", Date.now() - 120_000);
  await primeSampler(host, box);
  return box;
}

/** A box whose TTL has elapsed, put to sleep by the watcher the way a real pass would. */
async function expiredBox(name: string): Promise<Box> {
  const box = await newBox(name, { ttlSec: 60 });
  backdate(box.boxId, 120_000);
  await watcher().tick();
  return boxes.getBox(host, box.boxId);
}

function previewUrl(ref: string): URL {
  return new URL(`http://minibox.test/box/${ref}/3000/`);
}

function previewDeps(): PreviewDeps {
  return {
    pulse: app.pulse,
    audit: (hostId, note) => {
      notes.push({ hostId, source: "ui", op: note.op, detail: note.detail });
    },
    relay: app.previewRelay,
  };
}

function addSecondHost(): { lab: HostCtx; labRuntime: FakeRuntime } {
  const labRuntime = new FakeRuntime();
  labRuntime.seedImage(host.baseTemplateTag, { [host.keys.template]: "true", [host.keys.templateName]: "base" });
  const lab = createLocalHost(app.cfg, labRuntime, host.specs, host.volumes, undefined, app.pulse, {
    id: "lab",
    name: "Lab",
  });
  app.hosts.add(lab);
  return { lab, labRuntime };
}

describe("activity pulse", () => {
  test("a hold keeps a box from idle sleep until it is released, and the release counts as activity", () => {
    const pulse = new ActivityPulse();
    pulse.touch("bx_a", "create", Date.now() - 600_000);
    const release = pulse.hold("bx_a");
    expect(pulse.isHeld("bx_a")).toBe(true);
    release();
    expect(pulse.isHeld("bx_a")).toBe(false);
    expect(pulse.lastAt("bx_a")).toBeGreaterThan(Date.now() - 5_000);
  });

  test("holds nest, and a second release of one hold does not drop another", () => {
    const pulse = new ActivityPulse();
    const first = pulse.hold("bx_a");
    const second = pulse.hold("bx_a");
    first();
    first();
    expect(pulse.isHeld("bx_a")).toBe(true);
    second();
    expect(pulse.isHeld("bx_a")).toBe(false);
  });
});

describe("BoxPower", () => {
  test("runs one task per box at a time, and another box does not wait for it", async () => {
    const power = new BoxPower();
    const order: string[] = [];
    const gate = Promise.withResolvers<void>();
    const first = power.run("bx_a", async () => {
      order.push("first:start");
      await gate.promise;
      order.push("first:end");
    });
    const second = power.run("bx_a", async () => {
      order.push("second");
    });
    await power.run("bx_b", async () => {
      order.push("other");
    });
    expect(order).toEqual(["first:start", "other"]);

    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "other", "first:end", "second"]);
  });

  test("a task that fails does not block the next task for the same box", async () => {
    const power = new BoxPower();
    await expect(
      power.run("bx_a", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await power.run("bx_a", async () => "next")).toBe("next");
  });
});

describe("TTL arithmetic", () => {
  const created = Date.parse("2026-01-01T00:00:00.000Z");
  const spec = (ttlSec: number | null, createdAt = new Date(created).toISOString()) => ({
    createdAt,
    lifecycle: { desired: "running" as const, idleTimeoutSec: null, ttlSec, stopReason: null },
  });

  test("no TTL, or a zero TTL, never expires", () => {
    expect(ttlEndsAt(spec(null))).toBeNull();
    expect(ttlEndsAt(spec(0))).toBeNull();
    expect(ttlExpired(spec(null), created + 10 ** 12)).toBe(false);
  });

  test("the TTL counts from creation and expires exactly at its end", () => {
    expect(ttlEndsAt(spec(60))).toBe(created + 60_000);
    expect(ttlExpired(spec(60), created + 59_999)).toBe(false);
    expect(ttlExpired(spec(60), created + 60_000)).toBe(true);
  });

  test("a creation time that cannot be read is never treated as expired", () => {
    expect(ttlEndsAt(spec(60, "not a date"))).toBeNull();
    expect(ttlExpired(spec(60, "not a date"), Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});

describe("idle sleep", () => {
  test("a quiet box sleeps, keeps its container, and records the sleep", async () => {
    const box = await quietBox("sleepy");
    const report = await watcher().tick();
    expect(report.slept).toContain(box.boxId);

    const after = await boxes.getBox(host, box.boxId);
    expect(after).toMatchObject({ running: false, desired: "stopped", stopReason: "idle", sleeping: true });
    expect(runtime.containers.has(box.id)).toBe(true);
    expect(notes).toContainEqual({
      hostId: host.host.id,
      source: "system",
      op: "box.sleep",
      detail: { boxId: box.boxId, reason: "idle" },
    });
  });

  test("the idle window runs from the last activity, not from creation", async () => {
    const box = await newBox("window", { idleTimeoutSec: 60 });
    app.pulse.touch(box.boxId, "exec");
    await primeSampler(host, box);
    const idle = watcher();

    expect((await idle.tick()).slept).not.toContain(box.boxId);
    offsetMs = 59_000;
    expect((await idle.tick()).slept).not.toContain(box.boxId);
    offsetMs = 61_000;
    expect((await idle.tick()).slept).toContain(box.boxId);
  });

  test("after a restart, a box with no heartbeat counts idle from when watching began, not from creation", async () => {
    const box = await newBox("restarted", { idleTimeoutSec: 60 });
    backdate(box.boxId, 24 * 60 * 60 * 1000);
    app.pulse.clear(box.boxId);
    await primeSampler(host, box);
    const idle = watcher();

    expect((await idle.tick()).slept).not.toContain(box.boxId);
    offsetMs = 61_000;
    expect((await idle.tick()).slept).toContain(box.boxId);
  });

  test("a per-box idle timeout of 0 keeps a quiet box awake", async () => {
    const box = await newBox("never", { idleTimeoutSec: 0 });
    app.pulse.touch(box.boxId, "exec", Date.now() - 120_000);
    await primeSampler(host, box);
    offsetMs = 24 * 60 * 60 * 1000;
    expect((await watcher().tick()).slept).not.toContain(box.boxId);
    expect((await boxes.getBox(host, box.boxId)).running).toBe(true);
  });

  test("with no global default, a box without its own timeout never sleeps", async () => {
    app.cfg.boxIdleTimeoutSec = 0;
    const box = await newBox("plain");
    app.pulse.touch(box.boxId, "exec", Date.now() - 120_000);
    await primeSampler(host, box);
    offsetMs = 24 * 60 * 60 * 1000;
    expect((await watcher().tick()).slept).not.toContain(box.boxId);
  });

  test("CPU above the threshold keeps a quiet box awake", async () => {
    const box = await quietBox("busy-cpu");
    runtime.containerStats = async () => ({ cpuPercent: 80, memUsage: 1, memLimit: 1024 ** 3, memPercent: 1 });
    await host.sampler.sampleNow();
    expect((await watcher().tick()).slept).not.toContain(box.boxId);
  });

  test("an open terminal keeps the box awake, and closing it starts the idle window", async () => {
    const box = await quietBox("terminal");
    await app.terminals.start(host, box, "work", "rest");
    const attachment = await app.terminals.attach(host, box, "work", { source: "rest", principal: OWNER });
    const idle = watcher();

    expect((await idle.tick()).slept).not.toContain(box.boxId);
    await attachment.close();
    expect((await idle.tick()).slept).not.toContain(box.boxId);
    offsetMs = 31_000;
    expect((await idle.tick()).slept).toContain(box.boxId);
  });

  test("a terminal opened outside MiniBox keeps the box awake, and the idle window starts at the first pass that finds it closed", async () => {
    const box = await quietBox("external-terminal");
    await app.terminals.start(host, box, "work", "rest");
    const client = { output: () => undefined, end: () => undefined };
    expect(runtime.tmux.attach(box.id, "work", client)).toBe(true);
    const idle = watcher();

    expect((await idle.tick()).slept).not.toContain(box.boxId);
    runtime.tmux.detach(box.id, "work", client);
    offsetMs = 25_000;
    expect((await idle.tick()).slept).not.toContain(box.boxId);
    offsetMs = 50_000;
    expect((await idle.tick()).slept).not.toContain(box.boxId);
    offsetMs = 56_000;
    expect((await idle.tick()).slept).toContain(box.boxId);
  });

  test("a detached session with no client does not keep a quiet box awake", async () => {
    const box = await newBox("detached-session", { idleTimeoutSec: 30 });
    await app.terminals.start(host, box, "work", "rest");
    app.pulse.touch(box.boxId, "exec", Date.now() - 120_000);
    await primeSampler(host, box);

    expect((await watcher().tick()).slept).toContain(box.boxId);
  });

  test("a running startup command in its init session does not keep a quiet box awake", async () => {
    const box = await quietBox("init-command", "sleep 3600");
    expect(runtime.tmux.sessionNames(box.id)).toContain("minibox-init");

    expect((await watcher().tick()).slept).toContain(box.boxId);
  });

  test("a person attached to the init session keeps the box awake until they detach", async () => {
    const box = await quietBox("init-attached", "sleep 3600");
    const client = { output: () => undefined, end: () => undefined };
    expect(runtime.tmux.attach(box.id, "minibox-init", client)).toBe(true);
    const idle = watcher();

    expect((await idle.tick()).slept).not.toContain(box.boxId);
    runtime.tmux.detach(box.id, "minibox-init", client);
    offsetMs = 25_000;
    expect((await idle.tick()).slept).not.toContain(box.boxId);
    offsetMs = 56_000;
    expect((await idle.tick()).slept).toContain(box.boxId);
  });

  test("reading a startup command's status does not keep a quiet box awake", async () => {
    const box = await quietBox("read-status", "sleep 3600");
    await readStartupCommand(host, box.boxId);

    expect((await watcher().tick()).slept).toContain(box.boxId);
  });

  test("running the startup command by hand counts as activity, so the idle clock starts from the run", async () => {
    const box = await quietBox("rerun", "sleep 3600");
    await runStartupCommand(host, box.boxId);

    expect((await watcher().tick()).slept).not.toContain(box.boxId);
    offsetMs = 56_000;
    expect((await watcher().tick()).slept).toContain(box.boxId);
  });

  test("applying a startup command now counts as activity, so the idle clock starts from the apply", async () => {
    const box = await quietBox("apply-now", "sleep 3600");
    await setStartupCommand(host, box.boxId, { command: "sleep 7200", applyNow: true });

    expect((await watcher().tick()).slept).not.toContain(box.boxId);
    offsetMs = 56_000;
    expect((await watcher().tick()).slept).toContain(box.boxId);
  });

  test("a box whose image has no tmux has no terminal to keep it awake, and still sleeps", async () => {
    const box = await quietBox("no-tmux");
    runtime.tmuxMissing = true;

    expect((await watcher().tick()).slept).toContain(box.boxId);
  });

  test("a terminal opened after the decision but before the sleep keeps the box awake", async () => {
    const box = await quietBox("late-terminal");
    await app.terminals.start(host, box, "work", "rest");
    const client = { output: () => undefined, end: () => undefined };
    const checkOnce = app.terminals.hasAttachedClient.bind(app.terminals);
    let checks = 0;
    app.terminals.hasAttachedClient = async (on, containerId) => {
      checks += 1;
      const attached = await checkOnce(on, containerId);
      if (checks === 1) runtime.tmux.attach(box.id, "work", client);
      return attached;
    };
    offsetMs = 31_000;

    expect((await watcher().tick()).slept).not.toContain(box.boxId);
    expect(checks).toBe(2);
    expect(await boxes.getBox(host, box.boxId)).toMatchObject({ running: true, desired: "running" });
  });

  test("a hold taken while the check under the lock asks tmux keeps the box awake", async () => {
    const box = await quietBox("late-hold");
    const checkOnce = app.terminals.hasAttachedClient.bind(app.terminals);
    let checks = 0;
    let release: (() => void) | undefined;
    app.terminals.hasAttachedClient = async (on, containerId) => {
      checks += 1;
      const attached = await checkOnce(on, containerId);
      if (checks === 2) release = app.pulse.hold(box.boxId);
      return attached;
    };
    offsetMs = 31_000;

    expect((await watcher().tick()).slept).not.toContain(box.boxId);
    expect(checks).toBe(2);
    expect(await boxes.getBox(host, box.boxId)).toMatchObject({ running: true, desired: "running" });
    release?.();
  });

  test("a tmux check that fails keeps the box awake for that pass and reports it", async () => {
    const box = await quietBox("probe-fails");
    app.terminals.hasAttachedClient = async () => {
      throw new Error("tmux timed out");
    };

    const report = await watcher().tick();
    expect(report.slept).not.toContain(box.boxId);
    expect(report.failed).toContainEqual({ id: box.boxId, error: "tmux timed out" });
    expect(await boxes.getBox(host, box.boxId)).toMatchObject({ running: true, desired: "running" });
  });

  test("a background exec keeps the box awake until it ends, and its end starts the idle window", async () => {
    const box = await quietBox("job");
    runtime.execScript = null;
    const job = await app.execs.run(host, box, {
      argv: ["sleep", "3000"],
      cwd: "/workspace",
      env: {},
      timeoutSec: 3000,
      user: "dev",
      background: true,
    });
    const idle = watcher();

    expect((await idle.tick()).slept).not.toContain(box.boxId);
    await app.execs.kill(job.execId);
    expect((await idle.tick()).slept).not.toContain(box.boxId);
    offsetMs = 31_000;
    expect((await idle.tick()).slept).toContain(box.boxId);
  });

  test("a running background task for the box keeps it awake, and its end starts the idle window", async () => {
    const box = await quietBox("task");
    const task = app.tasks.begin({
      op: "test.hold",
      summary: "hold the box",
      hostId: host.host.id,
      target: { kind: "box", id: box.id, name: box.name },
      principal: OWNER,
      source: "rest",
    });
    const finished = Promise.withResolvers<void>();
    app.tasks.track(task.id, finished.promise);

    offsetMs = 31_000;
    expect((await watcher().tick()).slept).not.toContain(box.boxId);
    offsetMs = 0;
    finished.resolve();
    await app.tasks.done(task.id);
    expect((await watcher().tick()).slept).not.toContain(box.boxId);
    offsetMs = 31_000;
    expect((await watcher().tick()).slept).toContain(box.boxId);
  });

  test("a hold keeps the box awake while it is held, and its release starts the idle window", async () => {
    const box = await quietBox("held");
    const release = app.pulse.hold(box.boxId);
    offsetMs = 31_000;
    expect((await watcher().tick()).slept).not.toContain(box.boxId);
    expect(app.pulse.isHeld(box.boxId)).toBe(true);

    offsetMs = 0;
    release();
    expect((await watcher().tick()).slept).not.toContain(box.boxId);
    expect(app.pulse.isHeld(box.boxId)).toBe(false);

    offsetMs = 31_000;
    expect((await watcher().tick()).slept).toContain(box.boxId);
  });

  test("a box a person stopped is not turned into an idle sleep", async () => {
    const box = await quietBox("manual");
    await boxes.stopBox(host, box.boxId, "manual");

    expect((await watcher().tick()).slept).not.toContain(box.boxId);
    expect(await boxes.getBox(host, box.boxId)).toMatchObject({ stopReason: "manual", sleeping: false });
  });

  test("the check under the box's lock refuses a sleep the box no longer qualifies for", async () => {
    const box = await quietBox("late");
    const stops = runtime.callsTo("stopContainer").length;

    expect(await boxes.sleepBox(host, box.boxId, "idle", () => false)).toBe(false);
    expect((await boxes.getBox(host, box.boxId)).running).toBe(true);
    expect(runtime.callsTo("stopContainer")).toHaveLength(stops);
  });
});

describe("TTL is effective", () => {
  test("TTL expiry sleeps the box with reason ttl, records the expiry, and keeps the container", async () => {
    const box = await newBox("agent", { ttlSec: 60 });
    backdate(box.boxId, 120_000);

    const report = await watcher().tick();
    expect(report.expired).toContain(box.boxId);
    expect(await boxes.getBox(host, box.boxId)).toMatchObject({ running: false, stopReason: "ttl", sleeping: true });
    expect(runtime.containers.has(box.id)).toBe(true);
    expect(notes).toContainEqual({
      hostId: host.host.id,
      source: "system",
      op: "box.ttl_expire",
      detail: { boxId: box.boxId, reason: "ttl" },
    });
  });

  test("a box that outlives its TTL is slept on the next pass, and a start is then refused", async () => {
    const box = await newBox("runner", { ttlSec: 60 });
    backdate(box.boxId, 120_000);
    const report = await watcher().tick();
    expect(report.expired).toContain(box.boxId);

    const starts = runtime.callsTo("startContainer").length;
    const error = await rejectionOf(boxes.startBox(host, box.boxId));
    expect(error).toMatchObject({ status: 409, key: "box_ttl_expired", hint: msg("box_ttl_expired_hint").text });
    expect(runtime.callsTo("startContainer")).toHaveLength(starts);
    expect((await boxes.getBox(host, box.boxId)).running).toBe(false);
  });

  test("a restart of an expired box is refused before the container is touched", async () => {
    const box = await expiredBox("restart-expired");
    const restarts = runtime.callsTo("restartContainer").length;
    const error = await rejectionOf(boxes.restartBox(host, box.boxId));
    expect(error).toMatchObject({ status: 409, key: "box_ttl_expired" });
    expect(runtime.callsTo("restartContainer")).toHaveLength(restarts);
  });

  test("a request that would wake an expired box is refused with 409 and starts nothing", async () => {
    const box = await expiredBox("wake-expired");
    const starts = runtime.callsTo("startContainer").length;
    const error = await rejectionOf(boxes.wakeIfSleeping(host, box.boxId, { record: auditTo(host.host.id, "rest") }));
    expect(error).toMatchObject({ status: 409, key: "box_ttl_expired" });
    expect(runtime.callsTo("startContainer")).toHaveLength(starts);
    expect(notes.some((note) => note.op === "box.wake")).toBe(false);
  });

  test("an exec-style start of an expired box is refused too", async () => {
    const box = await expiredBox("ensure-expired");
    const error = await rejectionOf(boxes.ensureRunning(host, box.boxId));
    expect(error).toMatchObject({ status: 409, key: "box_ttl_expired" });
    expect((await boxes.getBox(host, box.boxId)).running).toBe(false);
  });

  test("a rebuild of an expired box is refused before a container is created or started", async () => {
    const box = await expiredBox("rebuild-expired");
    const current = await boxes.getBox(host, box.boxId);
    const creates = runtime.callsTo("createContainer").length;
    const starts = runtime.callsTo("startContainer").length;

    const error = await rejectionOf(rebuildBox(host, box.boxId, current.revision, { profile: "strict" }, true));
    expect(error).toMatchObject({ status: 409, key: "box_ttl_expired" });
    expect(runtime.callsTo("createContainer")).toHaveLength(creates);
    expect(runtime.callsTo("startContainer")).toHaveLength(starts);
  });

  test("clearing the TTL lets an expired box start again", async () => {
    const box = await expiredBox("cleared");
    const current = await boxes.getBox(host, box.boxId);
    await boxes.updateBox(host, box.boxId, current.revision, { ttlSec: null });

    const started = await boxes.startBox(host, box.boxId);
    expect(started).toMatchObject({ running: true, stopReason: null, sleeping: false });
  });

  test("raising the TTL past its end lets the box start again", async () => {
    const box = await expiredBox("extended");
    const current = await boxes.getBox(host, box.boxId);
    await boxes.updateBox(host, box.boxId, current.revision, { ttlSec: 3600 });

    expect((await boxes.startBox(host, box.boxId)).running).toBe(true);
  });

  test("reconcile sleeps a box that should be running but whose TTL has elapsed, instead of starting it", async () => {
    const box = await newBox("reconciled", { ttlSec: 60 });
    backdate(box.boxId, 120_000);
    await runtime.stopContainer(box.id, { timeoutSec: 1 });
    const starts = runtime.callsTo("startContainer").length;

    const report = await reconcileHost(host);
    expect(report.stopped).toContain(box.boxId);
    expect(report.started).not.toContain(box.boxId);
    expect(runtime.callsTo("startContainer")).toHaveLength(starts);
    expect(await boxes.getBox(host, box.boxId)).toMatchObject({ running: false, stopReason: "ttl", sleeping: true });
  });

  test("reconcile still starts a stopped box whose TTL has not elapsed", async () => {
    const box = await newBox("reconciled-live", { ttlSec: 3600 });
    await runtime.stopContainer(box.id, { timeoutSec: 1 });

    const report = await reconcileHost(host);
    expect(report.started).toContain(box.boxId);
    expect((await boxes.getBox(host, box.boxId)).running).toBe(true);
  });
});

describe("on-demand wake", () => {
  test("a request wakes an idle-sleeping box, bumps its revision, and audits what it woke from", async () => {
    const box = await quietBox("wake-idle");
    await watcher().tick();
    const asleep = await boxes.getBox(host, box.boxId);
    expect(asleep.sleeping).toBe(true);

    const woken = await boxes.wakeIfSleeping(host, box.boxId, { record: auditTo(host.host.id, "rest") });
    expect(woken).toMatchObject({ running: true, desired: "running", stopReason: null, sleeping: false });
    expect(woken.revision).toBe(asleep.revision + 1);
    expect(notes).toContainEqual({
      hostId: host.host.id,
      source: "rest",
      op: "box.wake",
      detail: { boxId: box.boxId, from: "idle" },
    });
  });

  test("a TTL sleep wakes once its TTL has been raised, and the audit says it woke from ttl", async () => {
    const box = await expiredBox("wake-ttl");
    const current = await boxes.getBox(host, box.boxId);
    await boxes.updateBox(host, box.boxId, current.revision, { ttlSec: 3600 });

    const woken = await boxes.wakeIfSleeping(host, box.boxId, { record: auditTo(host.host.id, "ui") });
    expect(woken.running).toBe(true);
    expect(notes).toContainEqual({
      hostId: host.host.id,
      source: "ui",
      op: "box.wake",
      detail: { boxId: box.boxId, from: "ttl" },
    });
  });

  test("concurrent requests start a sleeping box once, and audit one wake", async () => {
    const box = await quietBox("wake-once");
    await watcher().tick();
    const starts = runtime.callsTo("startContainer").length;

    const record = auditTo(host.host.id, "rest");
    const [first, second] = await Promise.all([
      boxes.wakeIfSleeping(host, box.boxId, { record }),
      boxes.wakeIfSleeping(host, box.boxId, { record }),
    ]);
    expect(first.running).toBe(true);
    expect(second.running).toBe(true);
    expect(runtime.callsTo("startContainer")).toHaveLength(starts + 1);
    expect(notes.filter((note) => note.op === "box.wake")).toHaveLength(1);
  });

  test("a request does not wake a box a person stopped", async () => {
    const box = await newBox("manual-stop");
    await boxes.stopBox(host, box.boxId, "manual");
    const starts = runtime.callsTo("startContainer").length;

    const after = await boxes.wakeIfSleeping(host, box.boxId, { record: auditTo(host.host.id, "rest") });
    expect(after).toMatchObject({ running: false, stopReason: "manual", sleeping: false });
    expect(runtime.callsTo("startContainer")).toHaveLength(starts);
    expect(notes).toEqual([]);
  });

  test("an exec-style wake starts a box a person stopped, and writes no sleep wake", async () => {
    const box = await newBox("exec-wake");
    await boxes.stopBox(host, box.boxId, "manual");

    const result = await boxes.ensureRunning(host, box.boxId);
    expect(result.woke).toBe(true);
    expect(result.box.running).toBe(true);
    expect(notes.some((note) => note.op === "box.wake")).toBe(false);
  });
});

/** Keeps the last box frame the bus publishes for `boxId`, which is what a web client shows once the frames settle. */
function watchFrames(bus: App["bus"], boxId: string): { last: () => Box | undefined; off: () => void } {
  let last: Box | undefined;
  const off = bus.subscribe("box", (frame) => {
    if (frame.boxId === boxId && frame.op === "upsert") last = frame.box;
  });
  return { last: () => last, off };
}

describe("live box frames", () => {
  test("the last frame of an idle sleep shows the box asleep, not running", async () => {
    const box = await quietBox("frames-idle");
    const frames = watchFrames(app.bus, box.boxId);
    try {
      await watcher().tick();
      await host.sampler.settle();
      expect(frames.last()).toMatchObject({ running: false, desired: "stopped", stopReason: "idle", sleeping: true });
    } finally {
      frames.off();
    }
  });

  test("the last frame of a TTL sleep shows the box asleep for ttl", async () => {
    const box = await newBox("frames-ttl", { ttlSec: 60 });
    await primeSampler(host, box);
    backdate(box.boxId, 120_000);
    const frames = watchFrames(app.bus, box.boxId);
    try {
      await watcher().tick();
      await host.sampler.settle();
      expect(frames.last()).toMatchObject({ running: false, desired: "stopped", stopReason: "ttl", sleeping: true });
    } finally {
      frames.off();
    }
  });

  test("the last frame of a wake shows the box running, with no sleep left", async () => {
    const box = await quietBox("frames-wake");
    await watcher().tick();
    const frames = watchFrames(app.bus, box.boxId);
    try {
      await boxes.wakeIfSleeping(host, box.boxId, { record: auditTo(host.host.id, "rest") });
      await host.sampler.settle();
      expect(frames.last()).toMatchObject({ running: true, desired: "running", stopReason: null, sleeping: false });
    } finally {
      frames.off();
    }
  });
});

describe("more than one Docker host", () => {
  test("locateBox finds a box on a second host by its stable id or its name, and reports that host", async () => {
    const { lab } = addSecondHost();
    const labBox = await boxes.createBox(lab, { name: "lab-box", cpus: 1, memoryMb: 256 });

    const byId = await boxes.locateBox(app.hosts, labBox.boxId);
    expect(byId.host.host.id).toBe("lab");
    expect(byId.box.boxId).toBe(labBox.boxId);
    expect((await boxes.locateBox(app.hosts, "lab-box")).host.host.id).toBe("lab");
  });

  test("the watcher sleeps a quiet box on the second host, and a request wakes it on that host only", async () => {
    const { lab, labRuntime } = addSecondHost();
    const labBox = await boxes.createBox(lab, { name: "lab-quiet", cpus: 1, memoryMb: 256, idleTimeoutSec: 30 });
    app.pulse.touch(labBox.boxId, "exec", Date.now() - 120_000);
    await primeSampler(lab, labBox);
    const localStarts = runtime.callsTo("startContainer").length;

    expect((await watcher().tick()).slept).toContain(labBox.boxId);
    const labStarts = labRuntime.callsTo("startContainer").length;
    const woken = await boxes.wakeIfSleeping(lab, labBox.boxId, { record: auditTo(lab.host.id, "rest") });

    expect(woken.running).toBe(true);
    expect(labRuntime.callsTo("startContainer")).toHaveLength(labStarts + 1);
    expect(runtime.callsTo("startContainer")).toHaveLength(localStarts);
    expect(notes).toContainEqual({
      hostId: "lab",
      source: "rest",
      op: "box.wake",
      detail: { boxId: labBox.boxId, from: "idle" },
    });
  });

  test("a preview request wakes a box on the second host and audits the wake under that host", async () => {
    const { lab, labRuntime } = addSecondHost();
    const labBox = await boxes.createBox(lab, { name: "lab-preview", cpus: 1, memoryMb: 256 });
    await boxes.stopBox(lab, labBox.boxId, "idle");
    const audited: { hostId: string; op: string }[] = [];

    const resolved = await resolvePreview(app.hosts, new URL("http://minibox.test/box/lab-preview/3000/"), {
      pulse: app.pulse,
      audit: (hostId, note) => audited.push({ hostId, op: note.op }),
      relay: app.previewRelay,
    });
    try {
      expect(resolved.host.host.id).toBe("lab");
      expect(resolved.box.running).toBe(true);
      expect(resolved.upstreamOrigin).toMatch(/^http:\/\/10\.255\.0\.\d+:3000$/);
      expect(labRuntime.callsTo("startContainer").length).toBeGreaterThan(0);
      expect(audited).toEqual([{ hostId: "lab", op: "box.wake" }]);
      expect(app.pulse.isHeld(labBox.boxId)).toBe(true);
    } finally {
      resolved.release();
    }
    expect(app.pulse.isHeld(labBox.boxId)).toBe(false);
  });
});

describe("preview resolution", () => {
  test("a preview wakes an idle-sleeping box and holds it until the response is released", async () => {
    const box = await quietBox("preview-wake");
    await watcher().tick();

    const resolved = await resolvePreview(app.hosts, previewUrl("preview-wake"), previewDeps());
    expect(resolved.box.running).toBe(true);
    expect(app.pulse.isHeld(box.boxId)).toBe(true);
    resolved.release();
    expect(app.pulse.isHeld(box.boxId)).toBe(false);
    resolved.release();
    expect(app.pulse.isHeld(box.boxId)).toBe(false);
  });

  test("a preview for a box a person stopped is refused with 409, and nothing stays held", async () => {
    const box = await newBox("preview-stopped");
    await boxes.stopBox(host, box.boxId, "manual");

    const error = await rejectionOf(resolvePreview(app.hosts, previewUrl("preview-stopped"), previewDeps()));
    expect(error).toMatchObject({ status: 409, key: "preview_box_stopped" });
    expect(app.pulse.isHeld(box.boxId)).toBe(false);
  });

  test("a preview for a box whose TTL has expired is refused with 409, and nothing stays held", async () => {
    const box = await expiredBox("preview-expired");

    const error = await rejectionOf(resolvePreview(app.hosts, previewUrl("preview-expired"), previewDeps()));
    expect(error).toMatchObject({ status: 409, key: "box_ttl_expired" });
    expect(app.pulse.isHeld(box.boxId)).toBe(false);
  });

  test("a preview whose container has no address is a 502, and nothing stays held", async () => {
    const box = await newBox("preview-no-ip");
    const inspect = runtime.inspectContainer.bind(runtime);
    runtime.inspectContainer = async (id, opts) => ({ ...(await inspect(id, opts)), ipAddress: null });

    const error = await rejectionOf(resolvePreview(app.hosts, previewUrl("preview-no-ip"), previewDeps()));
    expect(error).toMatchObject({ status: 502, key: "preview_no_ip" });
    expect(app.pulse.isHeld(box.boxId)).toBe(false);
  });
});

/** A box that mounts its own volume, quiet for two minutes, with a 30 second window and a low CPU sample. */
async function quietMountedBox(name: string): Promise<{ box: Box; volume: VolumeView }> {
  const volume = await createVolume(host, { name: `${name}-notes`, role: null, createdBy: "owner" });
  const box = await boxes.createBox(host, {
    name,
    cpus: 1,
    memoryMb: 256,
    idleTimeoutSec: 30,
    mounts: [{ volume: volume.id, path: "/workspace", mode: "rw" }],
  });
  app.pulse.touch(box.boxId, "exec", Date.now() - 120_000);
  await primeSampler(host, box);
  runtime.seedVolumeFile(volume.engineName, "seed.txt", { type: "file", content: Buffer.from("seed") });
  return { box, volume };
}

describe("file API activity", () => {
  const fileCalls: [string, (volumeRef: string) => Promise<unknown>][] = [
    ["read", (ref) => readFile(host, ref, { path: "seed.txt" })],
    ["write", (ref) => writeFile(host, ref, { path: "new.txt", content: "x" })],
    ["list", (ref) => listFiles(host, ref, {})],
    ["copy", (ref) => copyFiles(host, ref, { from: "seed.txt", to: "copy.txt" })],
    ["download", (ref) => downloadArchive(host, ref, { path: "seed.txt" })],
    [
      "upload",
      (ref) =>
        uploadArchive(host, ref, {
          path: "/",
          content: fileArchive("up.txt", Buffer.from("up")).toString("base64"),
          encoding: "base64",
        }),
    ],
  ];

  test.each(fileCalls)("a %s call refreshes the heartbeat of a box that mounts the volume", async (_label, call) => {
    const { box, volume } = await quietMountedBox("files-touch");
    await call(volume.id);
    expect(app.pulse.lastAt(box.boxId)).toBeGreaterThan(Date.now() - 5_000);
  });

  test("a file call keeps its box awake while a quiet box on another volume sleeps", async () => {
    const { box, volume } = await quietMountedBox("files-awake");
    const neighbour = await quietMountedBox("files-neighbour");

    await writeFile(host, volume.id, { path: "notes.md", content: "hello\n" });
    const report = await watcher().tick();

    expect(report.slept).toContain(neighbour.box.boxId);
    expect(report.slept).not.toContain(box.boxId);
    expect(await boxes.getBox(host, box.boxId)).toMatchObject({ running: true, desired: "running" });
  });

  test("a file call holds its boxes while it runs, so idle sleep cannot cut it short", async () => {
    const { box, volume } = await quietMountedBox("files-held");
    const gate = runtime.hold("putArchive");

    const pending = writeFile(host, volume.id, { path: "slow.txt", content: "x" });
    expect(app.pulse.isHeld(box.boxId)).toBe(true);
    expect((await watcher().tick()).slept).not.toContain(box.boxId);

    gate.release();
    await pending;
    expect(app.pulse.isHeld(box.boxId)).toBe(false);
    expect(app.pulse.lastAt(box.boxId)).toBeGreaterThan(Date.now() - 5_000);
  });

  test("a failed file call still releases its boxes", async () => {
    const { box, volume } = await quietMountedBox("files-failed");

    const error = await rejectionOf(readFile(host, volume.id, { path: "missing.txt" }));
    expect(error).toMatchObject({ status: 404 });
    expect(app.pulse.isHeld(box.boxId)).toBe(false);
  });

  test("a file call on a volume no box mounts leaves every heartbeat alone", async () => {
    const { box } = await quietMountedBox("files-mounted");
    const loose = await createVolume(host, { name: "files-loose", role: null, createdBy: "owner" });
    const before = app.pulse.lastAt(box.boxId);

    await writeFile(host, loose.id, { path: "alone.txt", content: "x" });
    expect(app.pulse.lastAt(box.boxId)).toBe(before);
  });

  test("a file call refreshes every box that mounts the volume, read-write or read-only", async () => {
    const { box, volume } = await quietMountedBox("files-writer");
    const reader = await boxes.createBox(host, {
      name: "files-reader",
      cpus: 1,
      memoryMb: 256,
      mounts: [{ volume: volume.id, path: "/data", mode: "ro" }],
    });
    app.pulse.touch(reader.boxId, "exec", Date.now() - 120_000);

    await writeFile(host, volume.id, { path: "shared.txt", content: "x" });
    expect(app.pulse.lastAt(box.boxId)).toBeGreaterThan(Date.now() - 5_000);
    expect(app.pulse.lastAt(reader.boxId)).toBeGreaterThan(Date.now() - 5_000);
  });

  test("a file call does not start a box that is asleep", async () => {
    const { box, volume } = await quietMountedBox("files-asleep");
    await watcher().tick();
    expect(await boxes.getBox(host, box.boxId)).toMatchObject({ running: false, sleeping: true });
    const starts = runtime.callsTo("startContainer").length;

    expect((await readFile(host, volume.id, { path: "seed.txt" })).content).toBe("seed");
    await writeFile(host, volume.id, { path: "later.txt", content: "later" });

    expect(runtime.callsTo("startContainer")).toHaveLength(starts);
    expect(await boxes.getBox(host, box.boxId)).toMatchObject({
      running: false,
      desired: "stopped",
      sleeping: true,
      stopReason: "idle",
    });
  });

  test("a file call touches only the boxes that mount the volume on its own host", async () => {
    const { lab } = addSecondHost();
    const labVolume = await createVolume(lab, { name: "lab-notes", role: null, createdBy: "owner" });
    const labBox = await boxes.createBox(lab, {
      name: "lab-files",
      cpus: 1,
      memoryMb: 256,
      mounts: [{ volume: labVolume.id, path: "/workspace", mode: "rw" }],
    });
    app.pulse.touch(labBox.boxId, "exec", Date.now() - 120_000);
    const { volume } = await quietMountedBox("files-local");
    const labBefore = app.pulse.lastAt(labBox.boxId);

    await writeFile(host, volume.id, { path: "local.txt", content: "x" });
    expect(app.pulse.lastAt(labBox.boxId)).toBe(labBefore);

    await writeFile(lab, labVolume.id, { path: "lab.txt", content: "x" });
    expect(app.pulse.lastAt(labBox.boxId)).toBeGreaterThan(Date.now() - 5_000);
  });
});
