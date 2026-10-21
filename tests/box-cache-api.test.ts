import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { App } from "../src/app";
import { RuntimeError } from "../src/runtime";
import { startServer } from "../src/server";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";

const MB = 1024 * 1024;

let app: App;
let runtime: FakeRuntime;
let server: ReturnType<typeof startServer> | undefined;
let restoreLogs: () => void;

beforeEach(() => {
  restoreLogs = silenceLogs();
  ({ app, runtime } = createTestApp({ labelPrefix: "mbtest", metricsHistory: 10 }));
  const keys = app.hosts.get().keys;
  runtime.seedImage(app.cfg.baseTemplateTag, { [keys.template]: "true", [keys.templateName]: "base" });
});

afterEach(() => {
  app.hosts.get().sampler.stop();
  server?.stop(true);
  server = undefined;
  app.throttle.stop();
  app.sessions.stop();
  app.events.close();
  restoreLogs();
});

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

/** Serves the app on an ephemeral port with the host sampler running and its first listing applied. */
async function startApp(): Promise<string> {
  server = startServer(app);
  const sampler = app.hosts.get().sampler;
  sampler.start();
  await waitFor(() => sampler.ready(), "the first listing");
  await sampler.settle();
  return `http://127.0.0.1:${server.port}`;
}

const auth = { authorization: `Bearer ${TEST_KEY}` };

async function getJson(url: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, { headers: auth });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("reads served from the box cache", () => {
  test("listing boxes makes no Docker call, however many boxes or tabs ask", async () => {
    for (let i = 0; i < 20; i++) seedBox(`box${String(i).padStart(2, "0")}`, i % 2 === 0);
    const base = await startApp();
    await app.hosts.get().sampler.sampleNow();
    const before = runtime.calls.length;

    for (let tab = 0; tab < 4; tab++) {
      const { status, json } = await getJson(`${base}/api/boxes?stats=true`);
      expect(status).toBe(200);
      const boxes = json.boxes as { running: boolean; stats: unknown }[];
      expect(boxes).toHaveLength(20);
      expect(boxes.filter((box) => box.running).every((box) => box.stats !== null)).toBe(true);
    }
    expect(runtime.calls.length).toBe(before);
  });

  test("reading one box, and its usage, makes no Docker call while the cache is current", async () => {
    const id = seedBox("alpha", true);
    const base = await startApp();
    await app.hosts.get().sampler.sampleNow();
    const before = runtime.calls.length;

    const box = await getJson(`${base}/api/boxes/${id}`);
    expect(box.status).toBe(200);
    expect((box.json.box as { name: string; stats: unknown }).name).toBe("alpha");
    expect((box.json.box as { stats: unknown }).stats).toMatchObject({ memLimit: 256 * MB });

    const stats = await getJson(`${base}/api/boxes/${id}/stats`);
    expect(stats.json.stats).toMatchObject({ memLimit: 256 * MB });
    expect(runtime.calls.length).toBe(before);
  });

  test("a stop made through the API is in the next list read, without a Docker read", async () => {
    const id = seedBox("bravo", true);
    const base = await startApp();

    const res = await fetch(`${base}/api/boxes/${id}/stop`, { method: "POST", headers: auth });
    expect(res.status).toBe(200);
    const before = runtime.calls.length;

    const { json } = await getJson(`${base}/api/boxes?stats=false`);
    const boxes = json.boxes as { name: string; running: boolean }[];
    expect(boxes.find((box) => box.name === "bravo")?.running).toBe(false);
    expect(runtime.calls.length).toBe(before);
  });

  test("the stats history is returned only when asked, oldest first, and kept to the ring size", async () => {
    const id = seedBox("charlie", true);
    const base = await startApp();
    const sampler = app.hosts.get().sampler;
    for (let i = 0; i < 12; i++) await sampler.sampleNow();

    const plain = await getJson(`${base}/api/boxes/${id}/stats`);
    expect(plain.json).not.toHaveProperty("history");

    const withHistory = await getJson(`${base}/api/boxes/${id}/stats?history=true`);
    const history = withHistory.json.history as { t: number; memUsage: number }[];
    expect(history).toHaveLength(10);
    expect(history.every((sample) => sample.memUsage === 64 * MB)).toBe(true);
    const times = history.map((sample) => sample.t);
    expect(times.toSorted((a, b) => a - b)).toEqual(times);
  });

  test("a bad history flag is refused before the operation runs", async () => {
    const id = seedBox("delta", true);
    const base = await startApp();
    const { status } = await getJson(`${base}/api/boxes/${id}/stats?history=maybe`);
    expect(status).toBe(400);
  });
});

describe("host totals", () => {
  test("the host monitor takes its box totals from the cache, not from a listing", async () => {
    seedBox("one", true);
    seedBox("two", true);
    seedBox("three", false);
    await startApp();
    const before = runtime.calls.length;

    const metrics = await app.monitor.snapshot();

    expect(metrics.boxes).toEqual({ total: 3, running: 2, allocatedCpus: 3, allocatedMemory: 512 * MB, unlimited: 0 });
    expect(runtime.ops().slice(before)).not.toContain("listContainers");
    expect(runtime.ops().slice(before)).not.toContain("inspectContainer");
  });
});

describe("logs shared between readers", () => {
  test("open tabs asking for the same logs at once cost the engine one read, and no inspect", async () => {
    const id = seedBox("echo", true);
    const base = await startApp();
    const before = runtime.calls.length;
    const reads = runtime.callsTo("containerLogs").length;

    const replies = await Promise.all(
      Array.from({ length: 5 }, () => getJson(`${base}/api/boxes/${id}/logs?tail=200`)),
    );

    expect(replies.map((reply) => reply.status)).toEqual([200, 200, 200, 200, 200]);
    expect(runtime.callsTo("containerLogs").length - reads).toBe(1);
    expect(runtime.ops().slice(before)).not.toContain("inspectContainer");
  });

  test("a read is shared for its window, and the engine is read again after it", async () => {
    const id = seedBox("foxtrot", true);
    const base = await startApp();
    const reads = runtime.callsTo("containerLogs").length;
    const start = Date.now();
    const clock = spyOn(Date, "now");
    try {
      clock.mockReturnValue(start);
      await getJson(`${base}/api/boxes/${id}/logs?tail=200`);
      clock.mockReturnValue(start + 1500);
      await getJson(`${base}/api/boxes/${id}/logs?tail=200`);
      expect(runtime.callsTo("containerLogs").length - reads).toBe(1);

      clock.mockReturnValue(start + 2500);
      await getJson(`${base}/api/boxes/${id}/logs?tail=200`);
      expect(runtime.callsTo("containerLogs").length - reads).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  test("each tail is read on its own, and a failed read is not kept", async () => {
    const id = seedBox("golf", true);
    const base = await startApp();
    const reads = runtime.callsTo("containerLogs").length;
    runtime.fail("containerLogs", new RuntimeError("engine", "daemon hiccup"));

    const failed = await getJson(`${base}/api/boxes/${id}/logs?tail=200`);
    expect(failed.status).not.toBe(200);
    expect((await getJson(`${base}/api/boxes/${id}/logs?tail=200`)).status).toBe(200);
    expect((await getJson(`${base}/api/boxes/${id}/logs?tail=50`)).status).toBe(200);
    expect(runtime.callsTo("containerLogs").length - reads).toBe(3);
  });
});
