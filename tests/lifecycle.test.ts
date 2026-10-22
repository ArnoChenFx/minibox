import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
import type { AuditNote } from "../src/events/types";
import type { HostCtx } from "../src/host/registry";
import * as boxes from "../src/services/boxes";
import { effectiveIdleSec, LifecycleWatcher } from "../src/services/lifecycle";
import { createTestApp, silenceLogs } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

let runtime: FakeRuntime;
let app: App;
let host: HostCtx;
let restoreLogs: () => void;

beforeAll(() => {
  restoreLogs = silenceLogs();
});
afterAll(() => restoreLogs());

beforeEach(() => {
  const created = createTestApp({
    labelPrefix: "mbtest",
    boxIdleTimeoutSec: 60,
    boxIdleCpuPercent: 5,
    lifecycleIntervalMs: 60_000,
  });
  app = created.app;
  runtime = created.runtime;
  host = app.hosts.get();
  runtime.seedImage(host.baseTemplateTag, {
    [host.keys.template]: "true",
    [host.keys.templateName]: "base",
  });
});

const newBox = (name: string, patch?: { idleTimeoutSec?: number | null; ttlSec?: number | null }) =>
  boxes.createBox(host, { name, cpus: 1, memoryMb: 256, ...patch });

describe("effectiveIdleSec", () => {
  test("per-box 0 disables sleep even when the global default is set", async () => {
    const box = await newBox("off", { idleTimeoutSec: 0 });
    const spec = host.specs.read(box.boxId)!;
    expect(effectiveIdleSec(spec, app.cfg)).toBeNull();
  });

  test("null inherits the global default", async () => {
    const box = await newBox("inherit");
    const spec = host.specs.read(box.boxId)!;
    expect(spec.lifecycle.idleTimeoutSec).toBeNull();
    expect(effectiveIdleSec(spec, app.cfg)).toBe(60);
  });

  test("a positive per-box timeout wins over the global default", async () => {
    const box = await newBox("own", { idleTimeoutSec: 120 });
    expect(effectiveIdleSec(host.specs.read(box.boxId)!, app.cfg)).toBe(120);
  });
});

describe("LifecycleWatcher", () => {
  test("idle timeout stops a quiet low-CPU box and marks it sleeping", async () => {
    const box = await newBox("sleepy", { idleTimeoutSec: 30 });
    app.pulse.touch(box.boxId, "create", Date.now() - 120_000);
    // Seed a CPU sample below the threshold.
    host.sampler.start();
    await host.sampler.observe(box.id);
    // FakeRuntime stats default to zeros; force a sample into the ring via sampleNow after observe.
    await host.sampler.sampleNow();

    const watcher = new LifecycleWatcher({
      hosts: app.hosts,
      pulse: app.pulse,
      terminals: app.terminals,
      execs: app.execs,
      tasks: app.tasks,
      cfg: app.cfg,
      record: () => undefined,
      now: () => Date.now(),
    });
    const report = await watcher.tick();
    expect(report.slept).toContain(box.boxId);

    const after = await boxes.getBox(host, box.boxId);
    expect(after.running).toBe(false);
    expect(after.desired).toBe("stopped");
    expect(after.stopReason).toBe("idle");
    expect(after.sleeping).toBe(true);
  });

  test("an open terminal attachment prevents idle sleep", async () => {
    const box = await newBox("busy-term", { idleTimeoutSec: 30 });
    app.pulse.touch(box.boxId, "create", Date.now() - 120_000);
    host.sampler.start();
    await host.sampler.observe(box.id);
    await host.sampler.sampleNow();

    // Pretend a terminal is attached.
    const original = app.terminals.hasOpenAttachment.bind(app.terminals);
    app.terminals.hasOpenAttachment = () => true;

    const watcher = new LifecycleWatcher({
      hosts: app.hosts,
      pulse: app.pulse,
      terminals: app.terminals,
      execs: app.execs,
      tasks: app.tasks,
      cfg: app.cfg,
      record: () => undefined,
    });
    const report = await watcher.tick();
    expect(report.slept).not.toContain(box.boxId);
    expect((await boxes.getBox(host, box.boxId)).running).toBe(true);

    app.terminals.hasOpenAttachment = original;
  });

  test("an open SSH connection prevents idle sleep", async () => {
    const box = await newBox("busy-ssh", { idleTimeoutSec: 30 });
    app.pulse.touch(box.boxId, "create", Date.now() - 120_000);
    host.sampler.start();
    await host.sampler.observe(box.id);
    await host.sampler.sampleNow();

    const watcher = new LifecycleWatcher({
      hosts: app.hosts,
      pulse: app.pulse,
      terminals: app.terminals,
      execs: app.execs,
      tasks: app.tasks,
      cfg: app.cfg,
      record: () => undefined,
      ssh: { hasOpenConnection: (boxId) => boxId === box.boxId },
    });
    const report = await watcher.tick();
    expect(report.slept).not.toContain(box.boxId);
    expect((await boxes.getBox(host, box.boxId)).running).toBe(true);
  });

  test("TTL expiry stops the box without deleting the container", async () => {
    const box = await newBox("agent-ttl", { ttlSec: 60 });
    // Backdate createdAt so TTL has elapsed.
    const spec = host.specs.read(box.boxId)!;
    host.specs.write({
      ...spec,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
    });

    const watcher = new LifecycleWatcher({
      hosts: app.hosts,
      pulse: app.pulse,
      terminals: app.terminals,
      execs: app.execs,
      tasks: app.tasks,
      cfg: app.cfg,
      record: () => undefined,
    });
    const report = await watcher.tick();
    expect(report.expired).toContain(box.boxId);

    const after = await boxes.getBox(host, box.boxId);
    expect(after.running).toBe(false);
    expect(after.sleeping).toBe(true);
    expect(after.stopReason).toBe("ttl");
    expect(runtime.containers.has(box.id)).toBe(true);
  });

  test("exec wakes a sleeping box and clears the sleep reason", async () => {
    const box = await newBox("wake-me", { idleTimeoutSec: 30 });
    await boxes.stopBox(host, box.boxId, "idle");
    expect((await boxes.getBox(host, box.boxId)).sleeping).toBe(true);

    const woke = await boxes.startBox(host, box.boxId);
    expect(woke.running).toBe(true);
    expect(woke.desired).toBe("running");
    expect(woke.sleeping).toBe(false);
    expect(woke.stopReason).toBeNull();
    expect(app.pulse.lastAt(box.boxId)).not.toBeNull();
  });

  test("restart of a sleeping box refreshes the pulse so the watcher does not re-sleep", async () => {
    const box = await newBox("restart-wake", { idleTimeoutSec: 30 });
    await boxes.stopBox(host, box.boxId, "idle");
    expect((await boxes.getBox(host, box.boxId)).sleeping).toBe(true);
    // Stale heartbeat as if the box had been idle past the window before Restart.
    app.pulse.touch(box.boxId, "create", Date.now() - 120_000);

    const restarted = await boxes.restartBox(host, box.boxId);
    expect(restarted.running).toBe(true);
    expect(restarted.desired).toBe("running");
    expect(restarted.sleeping).toBe(false);
    expect(restarted.stopReason).toBeNull();
    const last = app.pulse.lastAt(box.boxId);
    expect(last).not.toBeNull();
    expect(Date.now() - last!).toBeLessThan(5_000);

    host.sampler.start();
    await host.sampler.observe(box.id);
    await host.sampler.sampleNow();
    const watcher = new LifecycleWatcher({
      hosts: app.hosts,
      pulse: app.pulse,
      terminals: app.terminals,
      execs: app.execs,
      tasks: app.tasks,
      cfg: app.cfg,
      record: () => undefined,
    });
    const report = await watcher.tick();
    expect(report.slept).not.toContain(box.boxId);
    expect((await boxes.getBox(host, box.boxId)).running).toBe(true);
    expect((await boxes.getBox(host, box.boxId)).sleeping).toBe(false);
  });
});

function watcherAt(clock: () => number, notes: AuditNote[]): LifecycleWatcher {
  return new LifecycleWatcher({
    hosts: app.hosts,
    pulse: app.pulse,
    terminals: app.terminals,
    execs: app.execs,
    tasks: app.tasks,
    cfg: app.cfg,
    record: (_hostId, _source, _principal, note) => notes.push(note),
    now: clock,
  });
}

describe("warnings ahead of a TTL end or an idle sleep", () => {
  const MINUTE = 60_000;

  test("a running box gets one TTL warning, five minutes before its end, and no more", async () => {
    const box = await newBox("ttl-warn", { ttlSec: 600, idleTimeoutSec: 0 });
    const spec = host.specs.read(box.boxId)!;
    const ends = Date.parse(spec.createdAt) + 600_000;
    const notes: AuditNote[] = [];
    let clock = ends - 6 * MINUTE;
    const watcher = watcherAt(() => clock, notes);

    await watcher.tick();
    expect(notes).toEqual([]);

    clock = ends - 4 * MINUTE;
    await watcher.tick();
    clock = ends - 3 * MINUTE;
    await watcher.tick();
    expect(notes).toEqual([
      expect.objectContaining({
        op: "box.ttl_soon",
        kind: "write",
        status: "ok",
        target: { kind: "box", id: spec.containerId, name: "ttl-warn" },
        detail: { boxId: box.boxId, deadline: new Date(ends).toISOString() },
      }),
    ]);

    clock = ends + 1;
    const report = await watcher.tick();
    expect(report.expired).toContain(box.boxId);
    expect(notes.map((note) => note.op)).toEqual(["box.ttl_soon", "box.ttl_expire"]);
  });

  test("a box that is already stopped gets no TTL warning", async () => {
    const box = await newBox("ttl-stopped", { ttlSec: 600, idleTimeoutSec: 0 });
    await boxes.stopBox(host, box.boxId, "manual");
    const ends = Date.parse(host.specs.read(box.boxId)!.createdAt) + 600_000;
    const notes: AuditNote[] = [];

    await watcherAt(() => ends - 2 * MINUTE, notes).tick();
    expect(notes).toEqual([]);
  });

  test("a quiet box is warned before it sleeps, once per idle deadline, and not while something holds it", async () => {
    const box = await newBox("idle-warn", { idleTimeoutSec: 600, ttlSec: null });
    const heartbeat = Date.now();
    app.pulse.touch(box.boxId, "create", heartbeat);
    const deadline = heartbeat + 600_000;
    const notes: AuditNote[] = [];
    let clock = deadline - 4 * MINUTE;
    const watcher = watcherAt(() => clock, notes);

    const release = app.pulse.hold(box.boxId, { quiet: true });
    await watcher.tick();
    expect(notes).toEqual([]);
    release();

    await watcher.tick();
    await watcher.tick();
    expect(notes.map((note) => note.op)).toEqual(["box.idle_soon"]);
    expect(notes[0]?.detail).toEqual({ boxId: box.boxId, deadline: new Date(deadline).toISOString() });

    const renewed = clock;
    app.pulse.touch(box.boxId, "terminal", renewed);
    clock = renewed + 600_000 - 4 * MINUTE;
    await watcher.tick();
    expect(notes.map((note) => note.op)).toEqual(["box.idle_soon", "box.idle_soon"]);
  });

  test("a quiet box far from its idle deadline is not warned", async () => {
    const box = await newBox("idle-far", { idleTimeoutSec: 600, ttlSec: null });
    const heartbeat = Date.now();
    app.pulse.touch(box.boxId, "create", heartbeat);
    const notes: AuditNote[] = [];

    const report = await watcherAt(() => heartbeat + MINUTE, notes).tick();
    expect(notes).toEqual([]);
    expect(report.slept).toEqual([]);
  });
});
