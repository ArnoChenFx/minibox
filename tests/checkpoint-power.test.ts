import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
import type { HostCtx } from "../src/host/registry";
import { RuntimeError } from "../src/runtime";
import * as boxes from "../src/services/boxes";
import type { Box } from "../src/services/boxes";
import {
  type CheckpointView,
  forkCheckpoint,
  rollbackBox,
  takeCheckpoint,
  type TakeCheckpointInput,
} from "../src/services/checkpoints";
import { type LifecycleOptions, LifecycleWatcher } from "../src/services/lifecycle";
import { newBoxId } from "../src/specs/revision";
import type { BoxMount } from "../src/specs/types";
import { createIndependentVolume, provisionDefaultMounts } from "../src/volumes/provision";
import { createTestApp, rejectionOf, silenceLogs } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";
import type { FakeCheckpointEngine } from "./support/fake-snapshots";

let app: App;
let runtime: FakeRuntime;
let engine: FakeCheckpointEngine;
let host: HostCtx;
let restoreLogs: () => void;
/** Added to the clock the watcher reads, so a test can let idle time pass without waiting. */
let offsetMs: number;
let primed: HostCtx[];

const NOTHING: TakeCheckpointInput = {
  pinned: false,
  include: { system: false, volumes: [] },
  consistency: "live",
};

beforeEach(() => {
  restoreLogs = silenceLogs();
  ({
    app,
    runtime,
    checkpoints: engine,
  } = createTestApp({
    labelPrefix: "mbtest",
    boxIdleTimeoutSec: 30,
    boxIdleCpuPercent: 5,
    lifecycleIntervalMs: 60_000,
  }));
  host = app.hosts.get();
  runtime.seedImage(host.baseTemplateTag, { [host.keys.template]: "true", [host.keys.templateName]: "base" });
  offsetMs = 0;
  primed = [];
});

afterEach(() => {
  for (const sampled of primed) sampled.sampler.stop();
  restoreLogs();
});

function watcher(): LifecycleWatcher {
  const options: LifecycleOptions = {
    hosts: app.hosts,
    pulse: app.pulse,
    terminals: app.terminals,
    execs: app.execs,
    tasks: app.tasks,
    cfg: app.cfg,
    record: () => {},
    now: () => Date.now() + offsetMs,
  };
  return new LifecycleWatcher(options);
}

function take(
  ref: string,
  overrides: Partial<TakeCheckpointInput> = {},
  progress?: { log(text: string): void },
): Promise<CheckpointView> {
  return takeCheckpoint(host, ref, { ...NOTHING, ...overrides }, "owner", progress);
}

/** Resolves once `ready` holds, so a test waits for a call it started rather than for a fixed time. */
async function waitFor(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a call to reach the engine");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** Lets queued work run, for a test that checks that something did not happen yet. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

function backdate(boxId: string, ms: number): void {
  const spec = host.specs.read(boxId);
  if (!spec) throw new Error(`no spec for ${boxId}`);
  host.specs.write({ ...spec, createdAt: new Date(Date.now() - ms).toISOString() });
}

async function primeSampler(box: Box): Promise<void> {
  if (!primed.includes(host)) {
    primed.push(host);
    host.sampler.start();
  }
  await host.sampler.observe(box.id);
  await host.sampler.sampleNow();
}

/** A running box that has been quiet for two minutes, with a 30 second idle window and a low CPU sample. */
async function quietBox(name: string, extra: BoxMount[] = []): Promise<Box> {
  const id = newBoxId();
  const roles = await provisionDefaultMounts(host, { id, name, createdBy: "owner" }, new Set());
  const box = await boxes.createBox(host, {
    id,
    name,
    cpus: 1,
    memoryMb: 256,
    createdBy: "owner",
    idleTimeoutSec: 30,
    mounts: [...roles, ...extra],
  });
  app.pulse.touch(box.boxId, "exec", Date.now() - 120_000);
  await primeSampler(box);
  return box;
}

describe("a checkpoint holds the box's power lock", () => {
  test("a stop waits until a backup in progress has finished", async () => {
    const box = await boxes.createBox(host, { name: "busy", cpus: 1, memoryMb: 256, createdBy: "owner" });
    const gate = engine.hold();
    const taking = take(box.boxId);
    await waitFor(() => engine.started > 0);

    const stopping = boxes.stopBox(host, box.boxId);
    await settle();
    expect(runtime.callsTo("stopContainer")).toHaveLength(0);

    gate.release();
    await taking;
    await stopping;
    expect(runtime.callsTo("stopContainer")).toHaveLength(1);
    expect((await boxes.getBox(host, box.boxId)).running).toBe(false);
  });

  test("the idle watcher leaves a box alone while its backup runs, and the end of the backup counts as activity", async () => {
    const busy = await quietBox("busy");
    const control = await quietBox("control");
    const gate = engine.hold();
    const taking = take(busy.boxId);
    await waitFor(() => engine.started > 0);

    offsetMs = 10 * 60_000;
    const report = await watcher().tick();
    expect(report.slept).toEqual([control.boxId]);
    expect((await boxes.getBox(host, busy.boxId)).running).toBe(true);

    gate.release();
    await taking;
    offsetMs = 0;
    expect((await watcher().tick()).slept).toEqual([]);
  });

  test("a backup that reads a shared volume holds every box that mounts it", async () => {
    const shared = await createIndependentVolume(
      host,
      { name: "shared-data", role: null, createdBy: "owner" },
      new Set(),
    );
    const mount: BoxMount = { volume: shared.engineName, path: "/shared", mode: "rw" };
    const writer = await quietBox("writer", [mount]);
    const reader = await quietBox("reader", [mount]);
    const control = await quietBox("control");
    const gate = engine.hold();
    const taking = take(writer.boxId, { include: { system: false, volumes: [shared.name] } });
    await waitFor(() => engine.started > 0);

    offsetMs = 10 * 60_000;
    const report = await watcher().tick();
    expect(report.slept).toEqual([control.boxId]);
    expect(report.slept).not.toContain(reader.boxId);

    gate.release();
    await taking;
  });

  test("the idle watcher leaves a running box alone while a rollback restores its volumes", async () => {
    const rolling = await quietBox("rolling");
    const control = await quietBox("rolling-control");
    const view = await take(rolling.boxId);
    const revision = host.specs.read(rolling.boxId)?.revision ?? 0;
    const gate = engine.hold("restore");
    const restoring = rollbackBox(host, rolling.boxId, { checkpoint: view.id, confirm: true, revision }, "owner");
    await waitFor(() => gate.blocked() > 0);

    offsetMs = 10 * 60_000;
    const report = await watcher().tick();
    expect(report.slept).toEqual([control.boxId]);
    expect(host.specs.read(rolling.boxId)?.lifecycle).toMatchObject({ desired: "running" });
    expect((await boxes.getBox(host, rolling.boxId)).running).toBe(true);

    gate.release();
    await restoring;
    offsetMs = 0;
    expect((await boxes.getBox(host, rolling.boxId)).running).toBe(true);
  });
});

describe("checkpoints and a sleeping box", () => {
  test("a checkpoint of a sleeping box reads it as it is and leaves it asleep", async () => {
    const box = await boxes.createBox(host, { name: "sleepy", cpus: 1, memoryMb: 256, createdBy: "owner" });
    await boxes.sleepBox(host, box.boxId, "idle");
    const before = runtime.calls.length;

    const view = await take(box.boxId, { consistency: "stop" });

    const ops = runtime.calls.slice(before).map((call) => call.op);
    expect(ops).not.toContain("startContainer");
    expect(ops).not.toContain("stopContainer");
    expect(ops).not.toContain("pauseContainer");
    expect(view.data.length).toBeGreaterThan(0);
    expect(host.specs.read(box.boxId)?.lifecycle).toMatchObject({ desired: "stopped", stopReason: "idle" });
    expect((await boxes.getBox(host, box.boxId)).sleeping).toBe(true);
  });

  test("a rollback of a sleeping box leaves it asleep", async () => {
    const box = await boxes.createBox(host, { name: "sleepy-rollback", cpus: 1, memoryMb: 256, createdBy: "owner" });
    const view = await take(box.boxId);
    await boxes.sleepBox(host, box.boxId, "idle");
    const revision = host.specs.read(box.boxId)?.revision ?? 0;

    await rollbackBox(host, box.boxId, { checkpoint: view.id, confirm: true, revision }, "owner");

    expect(host.specs.read(box.boxId)?.lifecycle).toMatchObject({ desired: "stopped", stopReason: "idle" });
    expect((await boxes.getBox(host, box.boxId)).sleeping).toBe(true);
  });

  test("a rollback of a box whose lifetime has ended is refused before any volume is made", async () => {
    const box = await boxes.createBox(host, {
      name: "expiring",
      cpus: 1,
      memoryMb: 256,
      createdBy: "owner",
      ttlSec: 60,
    });
    const view = await take(box.boxId);
    backdate(box.boxId, 120_000);
    await watcher().tick();
    const volumes = host.volumes.list().length;
    const revision = host.specs.read(box.boxId)?.revision ?? 0;

    const error = await rejectionOf(
      rollbackBox(host, box.boxId, { checkpoint: view.id, confirm: true, revision }, "owner"),
    );

    expect(error).toMatchObject({ status: 409, key: "box_ttl_expired" });
    expect(host.volumes.list()).toHaveLength(volumes);
    expect((await boxes.getBox(host, box.boxId)).running).toBe(false);
  });

  test("a fork leaves its source box asleep", async () => {
    const box = await boxes.createBox(host, { name: "source", cpus: 1, memoryMb: 256, createdBy: "owner" });
    const view = await take(box.boxId);
    await boxes.sleepBox(host, box.boxId, "idle");
    const before = runtime.calls.length;

    await forkCheckpoint(host, view.id, { name: "forked", cpus: 1, memoryMb: 256, copyHome: false }, "owner");

    const started = runtime.calls
      .slice(before)
      .filter((call) => call.op === "startContainer")
      .map((call) => call.args[0]);
    expect(started).not.toContain(box.id);
    expect((await boxes.getBox(host, box.boxId)).sleeping).toBe(true);
  });

  test("a delete of the source box waits for a fork that is reading the checkpoint", async () => {
    const box = await boxes.createBox(host, { name: "doomed-source", cpus: 1, memoryMb: 256, createdBy: "owner" });
    const view = await take(box.boxId);
    const restoresBefore = engine.started;
    const gate = engine.hold();
    let forked = false;
    const forking = forkCheckpoint(
      host,
      view.id,
      { name: "forked", cpus: 1, memoryMb: 256, copyHome: false },
      "owner",
    ).then(() => {
      forked = true;
    });
    await waitFor(() => engine.started > restoresBefore);

    const deleting = boxes.deleteBox(host, box.boxId, false);
    await settle();
    expect(forked).toBe(false);
    expect(runtime.callsTo("removeContainer")).toHaveLength(0);

    gate.release();
    await forking;
    await deleting;
    expect(runtime.callsTo("removeContainer").length).toBeGreaterThan(0);
  });
});

describe("a checkpoint whose box cannot be resumed", () => {
  test("a stop checkpoint keeps the checkpoint, leaves the box stopped, and says so in the task log", async () => {
    const box = await boxes.createBox(host, { name: "stubborn", cpus: 1, memoryMb: 256, createdBy: "owner" });
    runtime.fail("startContainer", new RuntimeError("engine", "start refused"));
    const lines: string[] = [];

    const view = await take(box.boxId, { consistency: "stop" }, { log: (text) => lines.push(text) });

    expect(host.checkpoints.read(view.id)).not.toBeNull();
    expect(lines.join("")).toContain("could not be resumed");
    expect((await boxes.getBox(host, box.boxId)).running).toBe(false);
  });

  test("a pause checkpoint keeps the checkpoint and says so in the task log", async () => {
    const box = await boxes.createBox(host, { name: "frozen", cpus: 1, memoryMb: 256, createdBy: "owner" });
    runtime.fail("unpauseContainer", new RuntimeError("engine", "unpause refused"));
    const lines: string[] = [];

    const view = await take(box.boxId, { consistency: "pause" }, { log: (text) => lines.push(text) });

    expect(host.checkpoints.read(view.id)).not.toBeNull();
    expect(lines.join("")).toContain("could not be resumed");
    expect(runtime.callsTo("pauseContainer")).toHaveLength(1);
  });
});
