import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
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
});
