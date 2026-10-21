import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { App } from "../src/app";
import type { OperationContext } from "../src/operations/types";
import { startServer } from "../src/server";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";
import { SseReader } from "./support/sse";

const OWNER = { type: "owner" as const, id: "owner", name: "owner" };
const auth = { authorization: `Bearer ${TEST_KEY}` };

let app: App;
let runtime: FakeRuntime;
let server: ReturnType<typeof startServer> | undefined;
let base: string;
let readers: SseReader[] = [];
let held: { release(): void } | undefined;
let restoreLogs: () => void;

beforeEach(() => {
  restoreLogs = silenceLogs();
  ({ app, runtime } = createTestApp({ labelPrefix: "mbtest", streamMaxConnections: 2 }));
  server = startServer(app);
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  for (const reader of readers) await reader.close();
  readers = [];
  held?.release();
  held = undefined;
  await app.tasks.drain();
  server?.stop(true);
  server = undefined;
  app.throttle.stop();
  app.sessions.stop();
  app.events.close();
  restoreLogs();
});

async function open(path: string): Promise<SseReader> {
  const res = await fetch(`${base}${path}`, { headers: auth });
  expect(res.status).toBe(200);
  if (!res.body) throw new Error("the stream has no body");
  const reader = new SseReader(res.body.getReader());
  readers.push(reader);
  return reader;
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("the condition was not met in time");
    await Bun.sleep(5);
  }
}

async function startTask(): Promise<string> {
  held = runtime.hold("buildImage");
  const ctx: OperationContext = { host: app.hosts.get(), principal: OWNER, source: "rest", events: app.events };
  const { taskId } = (await app.operations.run("template.build", ctx, {})) as { taskId: string };
  return taskId;
}

describe("the cap on live streams", () => {
  test("the event and task streams share one cap, and a stream past it is refused with 429 that names the limit", async () => {
    const taskId = await startTask();
    await open("/api/events/stream");
    await open(`/api/tasks/${taskId}/events`);
    expect(app.streams.count).toBe(2);

    const refused = await fetch(`${base}/api/events/stream`, { headers: auth });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({
      error: { code: "too_many_requests", key: "stream_limit", params: { max: 2 }, retryable: true },
    });

    const taskRefused = await fetch(`${base}/api/tasks/${taskId}/events`, { headers: auth });
    expect(taskRefused.status).toBe(429);
    await taskRefused.json();
    expect(app.streams.count).toBe(2);
  });

  test("a closed stream gives its slot back, so the next stream is admitted", async () => {
    const first = await open("/api/events/stream");
    await open("/api/events/stream");
    await first.close();
    await waitFor(() => app.streams.count === 1);
    await open("/api/events/stream");
    expect(app.streams.count).toBe(2);
  });

  test("a stream request that fails validation is refused before it takes a slot", async () => {
    const res = await fetch(`${base}/api/events/stream`, { headers: { ...auth, "last-event-id": "nope" } });
    expect(res.status).toBe(400);
    await res.json();
    expect(app.streams.count).toBe(0);
  });
});
