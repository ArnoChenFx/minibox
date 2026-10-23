import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
import type { HostCtx } from "../src/host/registry";
import { HostSampler } from "../src/host/sampler";
import type { ExecSpec, RuntimeEvent } from "../src/runtime";
import { createBox, stopBox } from "../src/services/boxes";
import { finishClone } from "../src/services/startup";
import { INIT_SESSION } from "../src/startup/command";
import { createTestApp, silenceLogs } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

const PREFIX = "mbtest";

let running: App | null = null;
let restoreLogs: () => void;
let eventSeq = 0;

interface Scene {
  app: App;
  runtime: FakeRuntime;
  host: HostCtx;
}

/** A server with its engine sampler started and listing the engine, as a running server has it. */
async function scene(): Promise<Scene> {
  const { app, runtime } = createTestApp({ labelPrefix: PREFIX });
  running = app;
  const host = app.hosts.get();
  runtime.seedImage(host.baseTemplateTag, { [host.keys.template]: "true", [host.keys.templateName]: "base" });
  return { app, runtime, host };
}

/** Replaces the host's sampler with one that reconnects quickly, starts it, and returns once its listing is in the cache. */
async function listen(app: App): Promise<void> {
  const host = app.hosts.get();
  host.sampler.stop();
  host.sampler = new HostSampler(
    () => host,
    { intervalMs: 60_000, history: 10, backoffMinMs: 5, backoffMaxMs: 20 },
    app.bus,
  );
  host.sampler.start();
  await waitFor(() => host.sampler.ready(), "the first listing");
  await host.sampler.settle();
}

function containerEvent(action: string, id: string): RuntimeEvent {
  eventSeq += 1;
  return {
    type: "container",
    action,
    id,
    attributes: {},
    time: "2026-10-23T04:00:00Z",
    timeNano: Date.now() * 1_000_000 + eventSeq,
  };
}

/** How many times the box's init session was started, which is how many launches the container had. */
function launchCount(runtime: FakeRuntime, containerId: string): number {
  return runtime
    .callsTo("startExec")
    .map((call) => call.args as [string, ExecSpec])
    .filter(([id, spec]) => id === containerId && spec.cmd.includes("new-session")).length;
}

/** Lets the queued engine events and launches run out, so a launch that should not happen has had its chance. */
async function quiet(host: HostCtx): Promise<void> {
  await Bun.sleep(20);
  await host.sampler.settle();
  await host.startup.settle();
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(2);
  }
}

describe("startup watch", () => {
  beforeEach(() => {
    restoreLogs = silenceLogs();
  });
  afterEach(() => {
    running?.hosts.get().sampler.stop();
    running = null;
    restoreLogs();
  });

  test("a restart of the container runs the command again, once", async () => {
    const { app, runtime, host } = await scene();
    const box = await createBox(host, { name: "alpha", cpus: 1, memoryMb: 256, startupCommand: "npm run dev" });
    await host.startup.settle();
    await listen(app);
    app.startups.start();

    await runtime.restartContainer(box.id, { timeoutSec: 1 });
    await waitFor(() => launchCount(runtime, box.id) === 2, "the relaunch");
    await host.startup.settle();

    expect(launchCount(runtime, box.id)).toBe(2);
    expect(runtime.tmux.sessionNames(box.id)).toContain(INIT_SESSION);
  });

  test("the engine starts a container the user did not stop, and its command runs again", async () => {
    const { app, runtime, host } = await scene();
    const box = await createBox(host, { name: "beta", cpus: 1, memoryMb: 256, startupCommand: "make watch" });
    await host.startup.settle();
    await listen(app);
    app.startups.start();

    await runtime.stopContainer(box.id, { timeoutSec: 1 });
    await runtime.startContainer(box.id);
    await waitFor(() => launchCount(runtime, box.id) === 2, "the start by the engine");
    await host.startup.settle();

    expect(launchCount(runtime, box.id)).toBe(2);
  });

  test("a start event while the run is going launches nothing, and a later restart still does", async () => {
    const { app, runtime, host } = await scene();
    const box = await createBox(host, { name: "gamma", cpus: 1, memoryMb: 256, startupCommand: "make watch" });
    await host.startup.settle();
    await listen(app);
    app.startups.start();

    runtime.emitEvent(containerEvent("start", box.id));
    runtime.emitEvent(containerEvent("start", box.id));
    await quiet(host);
    expect(launchCount(runtime, box.id)).toBe(1);

    await runtime.restartContainer(box.id, { timeoutSec: 1 });
    await waitFor(() => launchCount(runtime, box.id) === 2, "the relaunch after the restart");
    await host.startup.settle();
    expect(launchCount(runtime, box.id)).toBe(2);
  });

  test("a start the engine makes for a box the user stopped does not run its command", async () => {
    const { app, runtime, host } = await scene();
    const box = await createBox(host, { name: "delta", cpus: 1, memoryMb: 256, startupCommand: "make watch" });
    await host.startup.settle();
    await listen(app);
    app.startups.start();

    await stopBox(host, box.boxId);
    await runtime.startContainer(box.id);
    await quiet(host);

    expect(launchCount(runtime, box.id)).toBe(1);
  });

  test("a box with no command is left alone by a restart", async () => {
    const { app, runtime, host } = await scene();
    const box = await createBox(host, { name: "epsilon", cpus: 1, memoryMb: 256 });
    await listen(app);
    app.startups.start();

    await runtime.restartContainer(box.id, { timeoutSec: 1 });
    await quiet(host);

    expect(launchCount(runtime, box.id)).toBe(0);
  });

  test("a box still cloning is left to its clone, which runs the command once the clone ends", async () => {
    const { app, runtime, host } = await scene();
    const box = await createBox(host, {
      name: "zeta",
      cpus: 1,
      memoryMb: 256,
      startupCommand: "npm run dev",
      awaitsClone: true,
    });
    await host.startup.settle();
    await listen(app);
    app.startups.start();

    await runtime.restartContainer(box.id, { timeoutSec: 1 });
    await quiet(host);
    expect(launchCount(runtime, box.id)).toBe(0);

    await finishClone(host, box.boxId, null);
    await host.startup.settle();
    expect(launchCount(runtime, box.id)).toBe(1);
  });

  test("once the watch stops, a restart does not run the command", async () => {
    const { app, runtime, host } = await scene();
    const box = await createBox(host, { name: "eta", cpus: 1, memoryMb: 256, startupCommand: "make watch" });
    await host.startup.settle();
    await listen(app);
    app.startups.start();
    app.startups.stop();

    await runtime.restartContainer(box.id, { timeoutSec: 1 });
    await quiet(host);

    expect(launchCount(runtime, box.id)).toBe(1);
  });
});
