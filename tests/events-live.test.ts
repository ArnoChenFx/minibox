import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
import { liveSource } from "../src/events/live";
import { HostSampler } from "../src/host/sampler";
import { startServer } from "../src/server";
import type { Box } from "../src/services/boxes";
import type { TaskStreamEvent, TaskView } from "../src/tasks/types";
import { compileToken } from "../src/tokens/model";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";
import { type SseFrame, SseReader } from "./support/sse";

const MB = 1024 * 1024;

let app: App;
let runtime: FakeRuntime;
let server: ReturnType<typeof startServer> | undefined;
let readers: SseReader[] = [];
let restoreLogs: () => void;

beforeEach(() => {
  restoreLogs = silenceLogs();
  ({ app, runtime } = createTestApp({ labelPrefix: "mbtest", metricsHistory: 10 }));
  const keys = app.hosts.get().keys;
  runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
});

afterEach(async () => {
  for (const reader of readers) await reader.close();
  readers = [];
  app.hosts.get().sampler.stop();
  app.monitor.stop();
  server?.stop(true);
  server = undefined;
  app.throttle.stop();
  app.sessions.stop();
  app.events.close();
  restoreLogs();
});

const auth = { authorization: `Bearer ${TEST_KEY}` };

function seedBox(name: string, running: boolean): string {
  const keys = app.hosts.get().keys;
  return runtime.seedContainer({
    image: app.cfg.baseTemplateTag,
    name: `mbtest-${name}`,
    labels: { [keys.box]: "true", [keys.name]: name },
    running,
    cpus: 1.5,
    memoryBytes: 256 * MB,
  });
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

/** Serves the app and starts the host sampler, returning once its first listing is applied. */
async function startApp(): Promise<string> {
  server = startServer(app);
  const sampler = app.hosts.get().sampler;
  sampler.start();
  await waitFor(() => sampler.ready(), "the first listing");
  await sampler.settle();
  return `http://127.0.0.1:${server.port}`;
}

async function openStream(base: string, query = ""): Promise<SseReader> {
  const res = await fetch(`${base}/api/events/stream${query ? `?${query}` : ""}`, { headers: auth });
  expect(res.status).toBe(200);
  if (!res.body) throw new Error("the stream has no body");
  const reader = new SseReader(res.body.getReader());
  readers.push(reader);
  return reader;
}

const isLive = (kind: string) => (frame: { event?: string }) => frame.event === kind;

describe("the live state on the event stream", () => {
  test("an unfiltered stream opens with the boxes the cache holds, and says whether the host is live", async () => {
    seedBox("alpha", true);
    seedBox("beta", false);
    const base = await startApp();
    const sse = await openStream(base);

    expect((await sse.next()).retry).toBe(3000);
    const sync = await sse.next();
    expect(sync.event).toBe("sync");
    const hosts = (
      sync.data as { hosts: { hostId: string; state: string; boxes: { name: string; stats: unknown }[] }[] }
    ).hosts;
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.state).toBe("live");
    expect(hosts[0]?.boxes.map((box) => box.name)).toEqual(["alpha", "beta"]);
    expect(hosts[0]?.boxes[0]?.stats).toMatchObject({ memLimit: 256 * MB });
  });

  test("a box that starts is pushed as a box frame, with no SSE id", async () => {
    const id = seedBox("gamma", false);
    const base = await startApp();
    const sse = await openStream(base);
    await sse.until(isLive("sync"));

    await runtime.startContainer(id);
    const frame = await sse.until(isLive("box"));
    expect(frame.id).toBeUndefined();
    expect(frame.data).toMatchObject({ op: "upsert", containerId: id, box: { name: "gamma", running: true } });
  });

  test("live frames name a box's environment variables and never their values, and REST keeps the values", async () => {
    const id = seedBox("eta", true);
    const base = await startApp();
    const host = app.hosts.get();
    const sse = await openStream(base);
    await sse.until(isLive("sync"));

    const spec = host.specs.list()[0];
    if (!spec) throw new Error("the claimed box has no spec");
    host.specs.write({
      ...spec,
      env: [
        { name: "API_TOKEN", value: "s3cret-value" },
        { name: "DB_PASSWORD", secretRef: "db-password" },
      ],
    });
    const frame = await sse.until(isLive("box"));
    expect(frame.data).toMatchObject({ box: { name: "eta", env: [{ name: "API_TOKEN" }, { name: "DB_PASSWORD" }] } });
    expect(JSON.stringify(frame.data)).not.toContain("s3cret-value");

    const later = await openStream(base);
    const sync = await later.until(isLive("sync"));
    expect(JSON.stringify(sync.data)).not.toContain("s3cret-value");
    expect(JSON.stringify(sync.data)).toContain("API_TOKEN");

    const rest = await fetch(`${base}/api/boxes/${id}`, { headers: auth });
    expect((await rest.json()) as { box: { env: unknown } }).toMatchObject({
      box: {
        env: [
          { name: "API_TOKEN", value: "s3cret-value" },
          { name: "DB_PASSWORD", secretRef: "db-password" },
        ],
      },
    });
  });

  test("resource samples, link changes and host metrics are pushed while the stream is open", async () => {
    seedBox("delta", true);
    const base = await startApp();
    const sse = await openStream(base);
    await sse.until(isLive("sync"));

    await app.hosts.get().sampler.sampleNow();
    const sample = await sse.until(isLive("sample"));
    expect(sample.data).toMatchObject({ boxes: [{ memUsage: 64 * MB, cpuPercent: 1.5 }] });

    app.hosts.get().sampler.stop();
    const link = await sse.until(isLive("link"));
    expect(link.data).toMatchObject({ state: "down" });

    app.monitor.start();
    const host = await sse.until(isLive("host"));
    expect(host.data).toMatchObject({ hostId: "local", metrics: { boxes: { total: 1, running: 1 } } });
    app.monitor.stop();
  });

  test("status changes of tasks are pushed, and their output is not", async () => {
    const base = await startApp();
    const sse = await openStream(base);
    await sse.until(isLive("sync"));

    const log: TaskStreamEvent = { taskId: "01TASK", seq: 1, ts: 1, kind: "log", text: "pulling layer" };
    const status: TaskStreamEvent = { taskId: "01TASK", seq: 2, ts: 2, kind: "status", status: "succeeded" };
    app.bus.publish("task", log);
    app.bus.publish("task", status);

    const frame = await sse.until(isLive("task"));
    expect(frame.data).toEqual(status);
  });

  test("a filtered stream carries the stored events only, and no live state", async () => {
    const id = seedBox("epsilon", false);
    const base = await startApp();
    const sse = await openStream(base, "box=epsilon");
    expect((await sse.next()).retry).toBe(3000);

    const started = await fetch(`${base}/api/boxes/${id}/start`, { method: "POST", headers: auth });
    expect(started.status).toBe(200);
    const skipped: string[] = [];
    for (let frame = await sse.next(); frame.id === undefined; frame = await sse.next()) {
      skipped.push(frame.event ?? "other");
    }
    expect(skipped).toEqual([]);
  });

  test("live frames are not written to the event store", async () => {
    const id = seedBox("zeta", true);
    await startApp();
    const stored = () => app.events.after(0, {}, 10_000).length;
    const before = stored();

    await runtime.stopContainer(id, { timeoutSec: 1 });
    await app.hosts.get().sampler.sampleNow();
    await app.hosts.get().sampler.settle();

    expect(stored()).toBe(before);
  });
});

/** Gives the host a sampler with a short live interval, so a test sees the cadence without waiting a minute for it. */
function shortCadence(): void {
  const host = app.hosts.get();
  host.sampler.stop();
  host.sampler = new HostSampler(() => host, { intervalMs: 5, idleIntervalMs: 60_000, history: 10 }, app.bus);
}

function statsCalls(): number {
  return runtime.callsTo("containerStats").length;
}

/** Resolves with the count once it has not moved for `quietMs`. A count that keeps moving fails the wait. */
async function untilQuiet(count: () => number, quietMs = 30, timeoutMs = 2000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = count();
  let since = Date.now();
  while (Date.now() - since < quietMs) {
    if (Date.now() > deadline) throw new Error("the count keeps moving");
    await Bun.sleep(5);
    const now = count();
    if (now !== last) {
      last = now;
      since = Date.now();
    }
  }
  return last;
}

describe("the keys of live frames", () => {
  test("a sample frame is keyed by its host, and a link frame is not keyed", () => {
    const sent: { frame: string; key: string | undefined }[] = [];
    const unsubscribe = liveSource(app.bus, app.hosts).subscribe((frame, key) => sent.push({ frame, key }));
    app.bus.publish("sample", { hostId: "local", t: 1, boxes: [] });
    app.bus.publish("link", { hostId: "local", state: "live", error: null, at: "2026-10-21T00:00:00.000Z" });
    unsubscribe();

    expect(sent.map((item) => [item.frame.split("\n")[0], item.key])).toEqual([
      ["event: sample", "sample:local"],
      ["event: link", undefined],
    ]);
  });
});

describe("the sample cadence on the event stream", () => {
  test("box stats are sampled only while a stream is open: a stream samples at once, and sampling stops when it closes", async () => {
    seedBox("nu", true);
    shortCadence();
    const base = await startApp();
    await Bun.sleep(40);
    expect(statsCalls()).toBe(1);

    const sse = await openStream(base);
    await sse.until(isLive("sample"));
    expect(statsCalls()).toBeGreaterThan(1);

    await sse.close();
    const settled = await untilQuiet(statsCalls);
    await Bun.sleep(40);
    expect(statsCalls()).toBe(settled);
  });
});

function taskEvent(taskId: string, seq: number, kind: TaskStreamEvent["kind"]): TaskStreamEvent {
  return {
    taskId,
    seq,
    ts: 1,
    kind,
    ...(kind === "status" ? { status: "succeeded" as const } : { text: "output" }),
  };
}

const mint = () => app.tokens.create(compileToken({ name: "agent", scopes: ["box:read"] }), "owner");

function seedMade(name: string, createdBy: string): string {
  const keys = app.hosts.get().keys;
  return runtime.seedContainer({
    image: app.cfg.baseTemplateTag,
    name: `mbtest-${name}`,
    labels: { [keys.box]: "true", [keys.name]: name, [keys.createdBy]: createdBy },
    running: true,
    cpus: 1,
    memoryBytes: 256 * MB,
  });
}

function boxNamed(name: string): Box {
  const box = app.hosts
    .get()
    .sampler.boxes({ withStats: false })
    .find((item) => item.name === name);
  if (!box) throw new Error(`no box ${name}`);
  return box;
}

async function openStreamAs(base: string, secret: string): Promise<SseReader> {
  const res = await fetch(`${base}/api/events/stream`, { headers: { authorization: `Bearer ${secret}` } });
  expect(res.status).toBe(200);
  if (!res.body) throw new Error("the stream has no body");
  const reader = new SseReader(res.body.getReader());
  readers.push(reader);
  return reader;
}

async function framesUntil(sse: SseReader, match: (frame: SseFrame) => boolean): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  for (;;) {
    const frame = await sse.next();
    frames.push(frame);
    if (match(frame)) return frames;
  }
}

describe("a token's live state", () => {
  test("a token's stream opens with the boxes it made, and carries no host or link state", async () => {
    const { secret, record } = mint();
    const hiddenId = seedBox("hidden", true);
    seedMade("mine", record.id);
    const base = await startApp();
    const sse = await openStreamAs(base, secret);

    const sync = await sse.until(isLive("sync"));
    const hosts = (sync.data as { hosts: { boxes: { boxId: string; name: string }[] }[] }).hosts;
    expect(hosts.flatMap((host) => host.boxes.map((box) => box.name))).toEqual(["mine"]);

    app.bus.publish("link", { hostId: "local", state: "down", error: null, at: "2026-10-21T00:00:00.000Z" });
    app.bus.publish("sample", {
      hostId: "local",
      t: 1,
      boxes: [
        { boxId: hiddenId, cpuPercent: 1, memUsage: 1, memLimit: 1, memPercent: 1 },
        { boxId: boxNamed("mine").boxId, cpuPercent: 2, memUsage: 1, memLimit: 1, memPercent: 1 },
      ],
    });
    const frames = await framesUntil(sse, (frame) => frame.event === "sample");
    expect(frames.some((frame) => frame.event === "link")).toBe(false);
    const sample = frames.at(-1)?.data as { boxes: { boxId: string }[] };
    expect(sample.boxes.map((box) => box.boxId)).toEqual([boxNamed("mine").boxId]);
  });

  test("a box frame reaches a token only for a box it may see, and a box it stops seeing is removed", async () => {
    const { secret, record } = mint();
    seedBox("hidden", true);
    seedMade("mine", record.id);
    const base = await startApp();
    const sse = await openStreamAs(base, secret);
    await sse.until(isLive("sync"));

    const hidden = { ...boxNamed("hidden") };
    app.bus.publish("box", { hostId: "local", op: "upsert", boxId: hidden.boxId, containerId: hidden.id, box: hidden });
    app.bus.publish("box", { hostId: "local", op: "remove", boxId: hidden.boxId, containerId: hidden.id });
    const mine = boxNamed("mine");
    app.bus.publish("box", { hostId: "local", op: "upsert", boxId: mine.boxId, containerId: mine.id, box: mine });
    app.bus.publish("box", {
      hostId: "local",
      op: "upsert",
      boxId: mine.boxId,
      containerId: mine.id,
      box: { ...mine, createdBy: "owner" },
    });
    const late = { ...mine, boxId: "bx_late0000000", id: "late-container", name: "late", createdBy: record.id };
    app.bus.publish("box", { hostId: "local", op: "upsert", boxId: late.boxId, containerId: late.id, box: late });

    const frames = await framesUntil(sse, (frame) => frame.event === "box" && frameBoxName(frame) === "late");
    const boxFrames = frames
      .filter((frame) => frame.event === "box")
      .map((frame) => frame.data as { op: string; boxId: string });
    expect(boxFrames.map((frame) => [frame.op, frame.boxId])).toEqual([
      ["upsert", boxNamed("mine").boxId],
      ["remove", boxNamed("mine").boxId],
      ["upsert", late.boxId],
    ]);
  });

  test("a token receives the status of its own tasks and of tasks on boxes it sees, and never the output", () => {
    const { secret, record } = mint();
    const principal = app.tokens.authenticate(secret, "127.0.0.1");
    if (!principal) throw new Error("token did not authenticate");
    const tasks = new Map<string, TaskView>([
      ["mine", { principalId: record.id } as unknown as TaskView],
      ["theirs", { principalId: "owner" } as unknown as TaskView],
    ]);
    const sent: string[] = [];
    const unsubscribe = liveSource(app.bus, app.hosts, { principal, task: (id) => tasks.get(id) }).subscribe((frame) =>
      sent.push(frame),
    );
    app.bus.publish("task", taskEvent("theirs", 1, "status"));
    app.bus.publish("task", taskEvent("mine", 2, "log"));
    app.bus.publish("task", taskEvent("mine", 3, "status"));
    unsubscribe();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.split("\n")[0]).toBe("event: task");
    expect(sent[0]).toContain('"seq":3');
  });
});

function frameBoxName(frame: SseFrame): string | undefined {
  return (frame.data as { box?: { name?: string } }).box?.name;
}
