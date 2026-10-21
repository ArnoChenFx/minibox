import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
import type { BoxFrame, LinkFrame, SampleFrame } from "../src/host/live";
import { HostSampler, type SamplerOptions } from "../src/host/sampler";
import type { LabelKeys } from "../src/labels";
import { RuntimeError } from "../src/runtime";
import { createBox, stopBox } from "../src/services/boxes";
import { createTestApp, silenceLogs } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

const MB = 1024 * 1024;

let app: App;
let runtime: FakeRuntime;
let keys: LabelKeys;
let restoreLogs: () => void;
let boxFrames: BoxFrame[];
let linkFrames: LinkFrame[];
let sampleFrames: SampleFrame[];

beforeEach(() => {
  restoreLogs = silenceLogs();
  ({ app, runtime } = createTestApp({ labelPrefix: "mbtest", metricsHistory: 10 }));
  keys = app.hosts.get().keys;
  runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
  boxFrames = [];
  linkFrames = [];
  sampleFrames = [];
  app.bus.subscribe("box", (frame) => boxFrames.push(frame));
  app.bus.subscribe("link", (frame) => linkFrames.push(frame));
  app.bus.subscribe("sample", (frame) => sampleFrames.push(frame));
});

afterEach(() => {
  app.hosts.get().sampler.stop();
  restoreLogs();
});

async function waitFor(check: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

function seedBox(name: string, running: boolean): string {
  return runtime.seedContainer({
    image: app.cfg.baseTemplateTag,
    name: `mbtest-${name}`,
    labels: { [keys.box]: "true", [keys.name]: name },
    running,
    cpus: 1.5,
    memoryBytes: 256 * MB,
  });
}

/** Starts the sampler and returns once its first listing and its first sample are applied. */
async function started(): Promise<HostSampler> {
  const sampler = app.hosts.get().sampler;
  sampler.start();
  await waitFor(() => sampler.ready(), "the first listing");
  await sampler.settle();
  return sampler;
}

/** A sampler with short reconnect delays, so a test does not wait out the production backoff. */
function fastSampler(overrides: Partial<SamplerOptions> = {}): HostSampler {
  const host = app.hosts.get();
  host.sampler.stop();
  host.sampler = new HostSampler(
    () => host,
    { intervalMs: 60_000, history: 10, backoffMinMs: 5, backoffMaxMs: 20, ...overrides },
    app.bus,
  );
  return host.sampler;
}

function stateOf(sampler: HostSampler, name: string): boolean | undefined {
  return sampler.boxes({ withStats: false }).find((box) => box.name === name)?.running;
}

describe("the box cache", () => {
  test("once started, listing the boxes makes no Docker call, however many boxes there are", async () => {
    for (let i = 0; i < 12; i++) seedBox(`box${i}`, i % 2 === 0);
    const sampler = await started();
    const before = runtime.calls.length;

    const boxes = sampler.boxes({ withStats: true });
    expect(boxes).toHaveLength(12);
    expect(boxes.filter((box) => box.running)).toHaveLength(6);
    expect(runtime.calls.length).toBe(before);
    expect(app.hosts.get().specs.list()).toHaveLength(12);
  });

  test("a start and a stop reach the cache, and each one is published as a box frame", async () => {
    const id = seedBox("alpha", true);
    const sampler = await started();
    const boxId = sampler.boxes({ withStats: false })[0]?.boxId ?? "";
    boxFrames = [];

    await runtime.stopContainer(id, { timeoutSec: 1 });
    await waitFor(() => boxFrames.some((frame) => frame.op === "upsert" && !frame.box.running), "the stop frame");
    expect(stateOf(sampler, "alpha")).toBe(false);

    await runtime.startContainer(id);
    await waitFor(() => stateOf(sampler, "alpha") === true, "the start in the cache");
    expect(boxFrames.filter((frame) => frame.op === "upsert" && frame.boxId === boxId).length).toBeGreaterThanOrEqual(
      2,
    );
  });

  test("a container that is removed leaves the cache and is published as removed", async () => {
    const id = seedBox("beta", false);
    const sampler = await started();
    const boxId = sampler.boxes({ withStats: false })[0]?.boxId ?? "";
    boxFrames = [];

    await runtime.removeContainer(id, { force: true });
    await waitFor(() => boxFrames.some((frame) => frame.op === "remove" && frame.boxId === boxId), "the removal frame");
    expect(sampler.boxes({ withStats: false })).toEqual([]);
  });

  test("a change applied while an earlier inspect is still held is not overwritten by that inspect", async () => {
    const id = seedBox("gamma", false);
    const sampler = await started();
    const hold = runtime.hold("inspectContainer");

    await runtime.startContainer(id);
    await waitFor(() => runtime.callsTo("inspectContainer").length === 1, "the held inspect");
    await runtime.stopContainer(id, { timeoutSec: 1 });
    hold.release();

    await waitFor(() => stateOf(sampler, "gamma") === false, "the last state, stopped");
    await sampler.settle();
    expect(stateOf(sampler, "gamma")).toBe(false);
  });

  test("a dropped event stream is reconnected after a backoff, and the cache is listed again", async () => {
    const id = seedBox("delta", true);
    const sampler = fastSampler();
    sampler.start();
    await waitFor(() => sampler.ready(), "the first listing");

    runtime.interruptEvents(new RuntimeError("unavailable", "connection reset"));
    await waitFor(() => linkFrames.some((frame) => frame.state === "down"), "the link going down");
    expect(linkFrames.find((frame) => frame.state === "down")).toMatchObject({ error: "connection reset" });
    await waitFor(() => sampler.ready(), "the reconnect");
    expect(runtime.callsTo("listContainers")).toHaveLength(2);

    await runtime.stopContainer(id, { timeoutSec: 1 });
    await waitFor(() => stateOf(sampler, "delta") === false, "a change after the reconnect");
  });

  test("a box created through the service is in the cache once its container has started", async () => {
    const sampler = await started();
    const host = app.hosts.get();

    const box = await createBox(host, { name: "fresh", cpus: 1, memoryMb: 256 });
    await waitFor(() => stateOf(sampler, "fresh") === true, "the new box in the cache");
    expect(sampler.find(box.boxId)?.name).toBe("fresh");
    expect(boxFrames.some((frame) => frame.op === "upsert" && frame.boxId === box.boxId)).toBe(true);
  });

  test("stop leaves nothing cached and publishes nothing afterwards", async () => {
    const id = seedBox("epsilon", true);
    const sampler = await started();
    sampler.stop();
    boxFrames = [];

    await runtime.stopContainer(id, { timeoutSec: 1 });
    await Bun.sleep(10);
    expect(boxFrames).toEqual([]);
    expect(sampler.ready()).toBe(false);
    expect(sampler.boxes({ withStats: false })).toEqual([]);
  });
});

describe("resource samples", () => {
  test("each round samples the running boxes once, and the ring keeps only the newest samples", async () => {
    seedBox("alpha", true);
    seedBox("beta", false);
    seedBox("gamma", true);
    const sampler = await started();
    expect(runtime.callsTo("containerStats")).toHaveLength(2);
    sampleFrames = [];

    for (let i = 0; i < 12; i++) await sampler.sampleNow();
    expect(runtime.callsTo("containerStats")).toHaveLength(2 * 13);

    const alpha = sampler.boxes({ withStats: true }).find((box) => box.name === "alpha");
    expect(alpha?.stats).toEqual({ cpuPercent: 1.5, memUsage: 64 * MB, memLimit: 256 * MB, memPercent: 25 });
    expect(sampler.historyOf(alpha?.boxId ?? "")).toHaveLength(10);
    expect(sampler.boxes({ withStats: true }).find((box) => box.name === "beta")?.stats).toBeNull();
    expect(sampleFrames).toHaveLength(12);
    expect(sampleFrames[0]?.boxes.map((box) => box.cpuPercent)).toEqual([1.5, 1.5]);
  });

  test("a stats call that hangs does not hold up a stop, and the cache shows the box stopped", async () => {
    const id = seedBox("theta", true);
    const sampler = fastSampler({ intervalMs: 100 });
    sampler.start();
    await waitFor(() => sampler.ready(), "the first listing");
    await sampler.settle();

    const hold = runtime.hold("containerStats");
    try {
      const round = sampler.sampleNow();
      await waitFor(() => runtime.callsTo("containerStats").length === 2, "the held stats call");
      const began = performance.now();
      const box = await stopBox(app.hosts.get(), id);
      expect(performance.now() - began).toBeLessThan(500);
      expect(box.running).toBe(false);
      expect(stateOf(sampler, "theta")).toBe(false);
      await round;
    } finally {
      hold.release();
    }
  });

  test("a stats call with no answer in time is a missed sample: the ring and the frames keep what they had", async () => {
    seedBox("iota", true);
    const sampler = fastSampler({ intervalMs: 100 });
    sampler.start();
    await waitFor(() => sampler.ready(), "the first listing");
    await sampler.settle();
    const boxId = sampler.boxes({ withStats: false })[0]?.boxId ?? "";
    expect(sampler.historyOf(boxId)).toHaveLength(1);
    sampleFrames = [];

    const hold = runtime.hold("containerStats");
    try {
      await sampler.sampleNow();
    } finally {
      hold.release();
    }
    const signal = (runtime.callsTo("containerStats").at(-1)?.args[1] as { signal?: AbortSignal } | undefined)?.signal;
    expect(signal?.aborted).toBe(true);
    expect(sampler.historyOf(boxId)).toHaveLength(1);
    expect(sampler.statsOf(boxId)).toMatchObject({ memUsage: 64 * MB });
    expect(sampleFrames).toEqual([]);
  });
});

describe("the sample cadence", () => {
  test("with no watcher, the boxes are sampled once when the listing lands, and not again before the idle interval", async () => {
    seedBox("kappa", true);
    const sampler = fastSampler({ intervalMs: 5, idleIntervalMs: 60_000 });
    sampler.start();
    await waitFor(() => sampler.ready(), "the first listing");
    await sampler.settle();

    await Bun.sleep(60);
    await sampler.settle();
    expect(runtime.callsTo("containerStats")).toHaveLength(1);
  });

  test("a watcher gets a sample at once, then one per live interval, until it is released", async () => {
    seedBox("lambda", true);
    const sampler = fastSampler({ intervalMs: 5, idleIntervalMs: 60_000 });
    sampler.start();
    await waitFor(() => sampler.ready(), "the first listing");
    await sampler.settle();
    const before = runtime.callsTo("containerStats").length;

    const release = sampler.watch();
    await waitFor(() => runtime.callsTo("containerStats").length >= before + 3, "samples while watched");
    release();
    await sampler.settle();
    const released = runtime.callsTo("containerStats").length;
    await Bun.sleep(60);
    await sampler.settle();
    expect(runtime.callsTo("containerStats")).toHaveLength(released);
  });

  test("sampling goes on while any watcher is left, and releasing one watcher twice counts once", async () => {
    seedBox("mu", true);
    const sampler = fastSampler({ intervalMs: 5, idleIntervalMs: 60_000 });
    sampler.start();
    await waitFor(() => sampler.ready(), "the first listing");
    await sampler.settle();

    const first = sampler.watch();
    const second = sampler.watch();
    first();
    first();
    const before = runtime.callsTo("containerStats").length;
    await waitFor(() => runtime.callsTo("containerStats").length >= before + 3, "samples for the remaining watcher");

    second();
    await sampler.settle();
    const released = runtime.callsTo("containerStats").length;
    await Bun.sleep(60);
    await sampler.settle();
    expect(runtime.callsTo("containerStats")).toHaveLength(released);
  });

  test("a stopped sampler takes no samples, even while it is watched", async () => {
    seedBox("nu", true);
    const sampler = fastSampler({ intervalMs: 5, idleIntervalMs: 60_000 });
    sampler.start();
    await waitFor(() => sampler.ready(), "the first listing");
    const release = sampler.watch();
    await waitFor(() => runtime.callsTo("containerStats").length >= 3, "samples while watched");

    sampler.stop();
    await sampler.settle();
    const stopped = runtime.callsTo("containerStats").length;
    await Bun.sleep(60);
    expect(runtime.callsTo("containerStats")).toHaveLength(stopped);
    release();
  });
});

describe("the host summary", () => {
  test("totals come from the cache, and are null until the first listing", async () => {
    seedBox("one", true);
    seedBox("two", false);
    const sampler = app.hosts.get().sampler;
    expect(sampler.summary()).toBeNull();

    await started();
    expect(sampler.summary()).toEqual({
      total: 2,
      running: 1,
      allocatedCpus: 1.5,
      allocatedMemory: 256 * MB,
      unlimited: 0,
    });
  });
});
