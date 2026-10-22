import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";

import type { App } from "../src/app";
import type { BoxFrame, LinkFrame, SampleFrame } from "../src/host/live";
import { HostSampler, type SamplerOptions } from "../src/host/sampler";
import type { LabelKeys } from "../src/labels";
import { RuntimeError } from "../src/runtime";
import { createBox, getBox, stopBox } from "../src/services/boxes";
import { createTestApp, silenceLogs } from "./support/app";
import { advance } from "./support/clock";
import type { Call, FakeRuntime } from "./support/fake-runtime";

const MB = 1024 * 1024;

let app: App;
let runtime: FakeRuntime;
let keys: LabelKeys;
let restoreLogs: () => void;
let boxFrames: BoxFrame[];
let linkFrames: LinkFrame[];
let sampleFrames: SampleFrame[];
let fakeClock = false;

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
  fakeClock = false;
  jest.useRealTimers();
});

/**
 * For the tests whose outcome depends on how long a timer runs: the cadence, the lease, the stale age and the re-list.
 * They move a fake clock, so each check happens at an exact moment and nothing depends on how loaded the machine is.
 */
function useFakeClock(): void {
  fakeClock = true;
  jest.useFakeTimers();
}

/**
 * Lets `ms` pass on the clock the test runs on. The fake clock moves a millisecond at a time: the sampler schedules its
 * next wait from a promise continuation, which runs only after the clock stops, so one long step would lose every wait
 * that falls inside it.
 */
async function elapse(ms: number): Promise<void> {
  if (!fakeClock) {
    await Bun.sleep(ms);
    return;
  }
  for (let left = ms; left > 0; left--) await advance(1);
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await elapse(5);
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

/** The abort signal a recorded call was made with. Every call that takes options has them second. */
function signalOf(call: Call | undefined): AbortSignal | undefined {
  return (call?.args[1] as { signal?: AbortSignal } | undefined)?.signal;
}

function inspectsOf(containerId: string): Call[] {
  return runtime.callsTo("inspectContainer").filter((call) => call.args[0] === containerId);
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
    expect(runtime.callsTo("containerStats")).toHaveLength(0);
    sampleFrames = [];

    for (let i = 0; i < 12; i++) await sampler.sampleNow();
    expect(runtime.callsTo("containerStats")).toHaveLength(2 * 12);

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
      await waitFor(() => runtime.callsTo("containerStats").length === 1, "the held stats call");
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
    await sampler.sampleNow();
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
  test("with no watcher and no reader, nothing is sampled, and a reader gets one round at once", async () => {
    useFakeClock();
    seedBox("kappa", true);
    const sampler = fastSampler({ intervalMs: 5, idleIntervalMs: 60_000 });
    sampler.start();
    await waitFor(() => sampler.ready(), "the first listing");
    await sampler.settle();

    await elapse(60);
    await sampler.settle();
    expect(runtime.callsTo("containerStats")).toHaveLength(0);

    sampler.need();
    await waitFor(() => runtime.callsTo("containerStats").length === 1, "the round a reader asked for");
    await elapse(60);
    await sampler.settle();
    expect(runtime.callsTo("containerStats")).toHaveLength(1);
  });

  test("a reader's lease keeps samples going only until it runs out, and then sampling stops", async () => {
    useFakeClock();
    seedBox("xi", true);
    const sampler = fastSampler({ intervalMs: 5, idleIntervalMs: 5 });
    sampler.start();
    await waitFor(() => sampler.ready(), "the first listing");
    await sampler.settle();

    sampler.need(60);
    const leaseEnd = Date.now() + 60;
    await waitFor(() => runtime.callsTo("containerStats").length >= 2, "samples within the lease");
    await elapse(leaseEnd - Date.now());
    await sampler.settle();
    const ended = runtime.callsTo("containerStats").length;
    await elapse(60);
    await sampler.settle();
    expect(runtime.callsTo("containerStats")).toHaveLength(ended);
  });

  test("callers that ask while a round is queued share that one round", async () => {
    seedBox("omicron", true);
    const sampler = await started();
    const before = runtime.callsTo("containerStats").length;

    await Promise.all([sampler.sampleSoon(), sampler.sampleSoon(), sampler.sampleSoon()]);
    expect(runtime.callsTo("containerStats").length - before).toBe(1);
  });

  test("a sample older than the stale age is not reported", async () => {
    useFakeClock();
    seedBox("pi", true);
    const sampler = fastSampler({ intervalMs: 5, staleAfterMs: 30 });
    sampler.start();
    await waitFor(() => sampler.ready(), "the first listing");
    await sampler.sampleNow();
    const boxId = sampler.boxes({ withStats: false })[0]?.boxId ?? "";
    expect(sampler.statsOf(boxId)).not.toBeNull();

    await elapse(29);
    expect(sampler.statsOf(boxId)).not.toBeNull();
    await elapse(1);
    expect(sampler.statsOf(boxId)).toBeNull();
  });

  test("a watcher gets a sample at once, then one per live interval, until it is released", async () => {
    useFakeClock();
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
    await elapse(60);
    await sampler.settle();
    expect(runtime.callsTo("containerStats")).toHaveLength(released);
  });

  test("sampling goes on while any watcher is left, and releasing one watcher twice counts once", async () => {
    useFakeClock();
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
    await elapse(60);
    await sampler.settle();
    expect(runtime.callsTo("containerStats")).toHaveLength(released);
  });

  test("a stopped sampler takes no samples, even while it is watched", async () => {
    useFakeClock();
    seedBox("nu", true);
    const sampler = fastSampler({ intervalMs: 5, idleIntervalMs: 60_000 });
    sampler.start();
    await waitFor(() => sampler.ready(), "the first listing");
    const release = sampler.watch();
    await waitFor(() => runtime.callsTo("containerStats").length >= 3, "samples while watched");

    sampler.stop();
    await sampler.settle();
    const stopped = runtime.callsTo("containerStats").length;
    await elapse(60);
    expect(runtime.callsTo("containerStats")).toHaveLength(stopped);
    release();
  });
});

describe("the periodic re-list", () => {
  test("a change the event stream never reported reaches the cache on the next re-list, and the link stays up", async () => {
    useFakeClock();
    const id = seedBox("zeta", true);
    const sampler = fastSampler({ relistMs: 20 });
    sampler.start();
    await waitFor(() => sampler.ready(), "the first listing");
    const links = linkFrames.length;
    boxFrames = [];

    const container = runtime.containers.get(id);
    if (!container) throw new Error("the seeded container is missing");
    container.running = false;
    await waitFor(() => stateOf(sampler, "zeta") === false, "the re-listed state");
    expect(boxFrames.some((frame) => frame.op === "upsert" && frame.box.running === false)).toBe(true);
    expect(linkFrames).toHaveLength(links);
    expect(sampler.ready()).toBe(true);
  });

  test("a container removed without an event leaves the cache on the next re-list", async () => {
    useFakeClock();
    const id = seedBox("eta", true);
    const sampler = fastSampler({ relistMs: 20 });
    sampler.start();
    await waitFor(() => sampler.ready(), "the first listing");
    boxFrames = [];

    runtime.containers.delete(id);
    await waitFor(() => boxFrames.some((frame) => frame.op === "remove"), "the removal frame");
    expect(sampler.boxes({ withStats: false })).toEqual([]);
  });

  test("a re-list that finds nothing changed publishes nothing", async () => {
    useFakeClock();
    seedBox("iota", true);
    const sampler = fastSampler({ relistMs: 5 });
    sampler.start();
    await waitFor(() => sampler.ready(), "the first listing");
    boxFrames = [];
    const listed = runtime.callsTo("listContainers").length;

    await waitFor(() => runtime.callsTo("listContainers").length >= listed + 3, "three re-lists");
    await sampler.settle();
    expect(boxFrames).toEqual([]);
  });

  test("stop ends the re-lists", async () => {
    useFakeClock();
    seedBox("theta", true);
    const sampler = fastSampler({ relistMs: 5 });
    sampler.start();
    await waitFor(() => runtime.callsTo("listContainers").length >= 3, "three listings");
    sampler.stop();
    await sampler.settle();
    const listed = runtime.callsTo("listContainers").length;

    await elapse(40);
    expect(runtime.callsTo("listContainers").length).toBe(listed);
  });

  test("a listing that does not answer holds up no write: a stop returns at once, and the cache shows the box stopped", async () => {
    const id = seedBox("rho", true);
    const sampler = fastSampler({ relistMs: 5 });
    sampler.start();
    await waitFor(() => sampler.ready(), "the first listing");
    await sampler.settle();

    const listed = runtime.callsTo("listContainers").length;
    const hold = runtime.hold("listContainers");
    try {
      await waitFor(() => runtime.callsTo("listContainers").length > listed, "the held re-list");
      const began = performance.now();
      const box = await stopBox(app.hosts.get(), id);
      expect(performance.now() - began).toBeLessThan(500);
      expect(box.running).toBe(false);
      expect(stateOf(sampler, "rho")).toBe(false);
      await Bun.sleep(30);
      expect(runtime.callsTo("listContainers")).toHaveLength(listed + 1);
    } finally {
      hold.release();
    }
  });

  test("a listing taken before a change is dropped, so it cannot put the old state back", async () => {
    const id = seedBox("sigma", true);
    const sampler = fastSampler({ relistMs: 5 });
    sampler.start();
    await waitFor(() => sampler.ready(), "the first listing");
    await sampler.settle();
    boxFrames = [];

    const listed = runtime.callsTo("listContainers").length;
    const hold = runtime.hold("listContainers");
    try {
      await waitFor(() => runtime.callsTo("listContainers").length > listed, "the held re-list");
      await stopBox(app.hosts.get(), id);
      boxFrames = [];
    } finally {
      hold.release();
    }
    await sampler.settle();
    await Bun.sleep(20);
    await sampler.settle();
    expect(boxFrames.some((frame) => frame.op === "upsert" && frame.box.running === true)).toBe(false);
    expect(stateOf(sampler, "sigma")).toBe(false);
  });

  test("a listing that does not answer in time is given up, and no second listing starts behind it", async () => {
    seedBox("tau", true);
    const sampler = fastSampler({ relistMs: 5, relistTimeoutMs: 20 });
    sampler.start();
    await waitFor(() => sampler.ready(), "the first listing");
    await sampler.settle();
    const links = linkFrames.length;

    const listed = runtime.callsTo("listContainers").length;
    const hold = runtime.hold("listContainers");
    let pending = 0;
    try {
      await waitFor(() => runtime.callsTo("listContainers").length > listed, "the held re-list");
      pending = runtime.callsTo("listContainers").length;
      await waitFor(() => signalOf(runtime.callsTo("listContainers")[pending - 1])?.aborted === true, "its deadline");
      await Bun.sleep(60);
      expect(runtime.callsTo("listContainers")).toHaveLength(pending);
      expect(sampler.ready()).toBe(true);
      expect(linkFrames).toHaveLength(links);
    } finally {
      hold.release();
    }
    await waitFor(() => runtime.callsTo("listContainers").length > pending, "a re-list once the held one has settled");
  });
});

describe("reads that do not answer in time", () => {
  test("a hung inspect of one box does not hold up a write to another, and that box keeps its last state", async () => {
    const x = seedBox("xi", true);
    const y = seedBox("upsilon", true);
    const sampler = fastSampler({ intervalMs: 60_000, inspectTimeoutMs: 800, observeWaitMs: 20 });
    sampler.start();
    await waitFor(() => sampler.ready(), "the first listing");
    await sampler.settle();

    const hold = runtime.hold("inspectContainer", ([id]) => id === x);
    try {
      await runtime.stopContainer(x, { timeoutSec: 1 });
      await waitFor(() => inspectsOf(x).length === 1, "the held inspect of xi");
      const began = performance.now();
      const box = await stopBox(app.hosts.get(), y);
      expect(performance.now() - began).toBeLessThan(400);
      expect(box.running).toBe(false);

      await waitFor(() => stateOf(sampler, "upsilon") === false, "the stop of upsilon in the cache");
      expect(stateOf(sampler, "xi")).toBe(true);
      expect(signalOf(inspectsOf(x)[0])?.aborted).toBe(true);
    } finally {
      hold.release();
    }

    await sampler.sampleNow();
    expect(inspectsOf(x).length).toBeGreaterThan(1);
    expect(stateOf(sampler, "xi")).toBe(false);
  });

  test("a first listing that does not answer in time takes the link down, and the next brings it back", async () => {
    const id = seedBox("phi", true);
    const sampler = fastSampler({ listTimeoutMs: 800, observeWaitMs: 20 });
    const hold = runtime.hold("listContainers");
    try {
      sampler.start();
      await waitFor(() => runtime.callsTo("listContainers").length === 1, "the held first listing");
      const began = performance.now();
      const box = await stopBox(app.hosts.get(), id);
      expect(performance.now() - began).toBeLessThan(400);
      expect(box.running).toBe(false);
      expect(sampler.ready()).toBe(false);

      await waitFor(() => runtime.callsTo("listContainers").length >= 2, "the listing retried after the backoff");
      expect(signalOf(runtime.callsTo("listContainers")[0])?.aborted).toBe(true);
      expect(sampler.ready()).toBe(false);
    } finally {
      hold.release();
    }
    await waitFor(() => sampler.ready(), "the listing once the engine answers");
    expect(stateOf(sampler, "phi")).toBe(false);
  });
});

describe("the drain of a burst of changes", () => {
  test("a burst of changes is inspected eight at a time, not one container after another", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => seedBox(`burst${String(i).padStart(2, "0")}`, true));
    const sampler = await started();
    const before = runtime.callsTo("inspectContainer").length;

    const hold = runtime.hold("inspectContainer");
    try {
      void sampler.observe(...ids);
      await waitFor(() => runtime.callsTo("inspectContainer").length === before + 8, "eight inspects in flight");
      await Bun.sleep(30);
      expect(runtime.callsTo("inspectContainer")).toHaveLength(before + 8);
    } finally {
      hold.release();
    }
    await sampler.settle();
    expect(runtime.callsTo("inspectContainer")).toHaveLength(before + 20);
  });
});

describe("engine reads of a box request", () => {
  test("a read whose engine call never answers fails as unavailable once the read timeout passes", async () => {
    const id = seedBox("eta", true);
    const host = app.hosts.get();
    host.readTimeoutMs = 30;

    const hold = runtime.hold("inspectContainer");
    try {
      const began = performance.now();
      const failure = await getBox(host, id).then(
        () => null,
        (e: unknown) => e,
      );
      expect(failure).toBeInstanceOf(RuntimeError);
      expect((failure as RuntimeError).kind).toBe("unavailable");
      expect(performance.now() - began).toBeLessThan(1000);
    } finally {
      hold.release();
    }
  });
});

describe("the host metrics", () => {
  test("the engine is read for them only while a live subscriber watches, and the local reading goes on regardless", async () => {
    const host = app.hosts.get();
    host.monitor.start();
    host.monitor.stop();
    expect(runtime.callsTo("info")).toHaveLength(0);

    const release = host.sampler.watch();
    host.monitor.start();
    host.monitor.stop();
    release();
    expect(runtime.callsTo("info")).toHaveLength(1);

    host.monitor.start();
    host.monitor.stop();
    expect(runtime.callsTo("info")).toHaveLength(1);
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
