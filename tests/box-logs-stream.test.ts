import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { HostSampler } from "../src/host/sampler";
import { silenceLogs, TEST_KEY } from "./support/app";
import { SseReader } from "./support/sse";
import { call, type Harness, mint, refused, startHarness } from "./support/tokens";

const STREAM_CAP = 2;
const EVIL_SITE = "https://evil.example";

interface AuditedRead {
  op: string;
  status: string;
  source: string;
  principal: { id: string };
  target?: { kind: string; id?: string; name: string };
  detail?: unknown;
  error?: { code: string; status: number };
}

let harness: Harness;
let restoreLogs: () => void;
const readers: SseReader[] = [];

beforeEach(() => {
  restoreLogs = silenceLogs();
  harness = startHarness({ streamMaxConnections: STREAM_CAP });
});

afterEach(async () => {
  for (const reader of readers.splice(0)) await reader.close();
  harness.app.hosts.get().sampler.stop();
  harness.stop();
  restoreLogs();
});

async function waitFor(check: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

/** Creates a running box as `token`, or as the owner without one. */
async function createBox(name: string, token?: string): Promise<{ id: string; boxId: string }> {
  const made = await call(harness.base, "/api/boxes", { token, body: { name, cpus: 1, memoryMb: 256 } });
  expect(made.status).toBe(201);
  return { id: made.json.box?.id ?? "", boxId: made.json.box?.boxId ?? "" };
}

/** Starts the host's sampler, so its log follows run, and returns once its first listing is applied. */
async function startSampler(): Promise<HostSampler> {
  const sampler = harness.app.hosts.get().sampler;
  sampler.start();
  await waitFor(() => sampler.ready(), "the first listing");
  await sampler.settle();
  return sampler;
}

/** Opens a box's log stream and returns its reader once the server has answered 200. */
async function openLogs(boxRef: string, token = TEST_KEY, query = ""): Promise<SseReader> {
  const res = await fetch(`${harness.base}/api/boxes/${boxRef}/logs/stream${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  if (!res.body) throw new Error("the stream has no body");
  const reader = new SseReader(res.body.getReader());
  readers.push(reader);
  return reader;
}

/** The line without the engine's stamp in front of it. */
const bodyOf = (text: string): string => text.slice(text.indexOf(" ") + 1);
const linesOf = (frame: { data?: unknown }): string[] => (frame.data as { lines: string[] }).lines.map(bodyOf);
const textOf = (frame: { data?: unknown }): string => bodyOf((frame.data as { text: string }).text);

describe("GET /api/boxes/:id/logs/stream", () => {
  test("the owner's stream opens with a retry hint and a sync of the lines held, then sends each new line", async () => {
    const box = await createBox("alpha");
    harness.runtime.appendLogs(box.id, "one\ntwo\n");
    const sampler = await startSampler();
    const holder = sampler.logs.subscribe(box.boxId, () => {});
    await waitFor(() => holder.snapshot(2).length === 2, "the lines held");

    const reader = await openLogs(box.boxId);
    expect((await reader.next()).retry).toBe(3000);
    const sync = await reader.next();
    expect(sync.event).toBe("sync");
    expect(linesOf(sync)).toEqual(["one", "two"]);

    harness.runtime.appendLogs(box.id, "three\n");
    expect(textOf(await reader.until((frame) => frame.event === "line"))).toBe("three");
  });

  test("a tail asks for the newest lines, and a tail out of range is refused with a 400", async () => {
    const box = await createBox("bravo");
    harness.runtime.appendLogs(box.id, "1\n2\n3\n");
    const sampler = await startSampler();
    const holder = sampler.logs.subscribe(box.boxId, () => {});
    await waitFor(() => holder.snapshot(3).length === 3, "the lines held");

    const reader = await openLogs(box.boxId, TEST_KEY, "?tail=2");
    expect(linesOf(await reader.until((frame) => frame.event === "sync"))).toEqual(["2", "3"]);

    for (const query of ["?tail=0", "?tail=5001", "?tail=abc"]) {
      const res = await fetch(`${harness.base}/api/boxes/${box.boxId}/logs/stream${query}`, {
        headers: { authorization: `Bearer ${TEST_KEY}` },
      });
      expect([query, res.status]).toEqual([query, 400]);
      expect(await res.json()).toMatchObject({ error: { code: "validation_failed", details: { field: "tail" } } });
    }
  });

  test("a request without a credential is refused with 401, and one from another site with 403", async () => {
    const box = await createBox("charlie");
    await startSampler();
    const anonymous = await fetch(`${harness.base}/api/boxes/${box.boxId}/logs/stream`);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ error: { code: "unauthorized" } });

    const foreign = await fetch(`${harness.base}/api/boxes/${box.boxId}/logs/stream`, {
      headers: { authorization: `Bearer ${TEST_KEY}`, origin: EVIL_SITE },
    });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({ error: { key: "origin_forbidden" } });
  });

  test("an unknown box is 404, as the REST read answers it", async () => {
    await startSampler();
    const stream = await call(harness.base, "/api/boxes/mbtest-missing/logs/stream");
    const rest = await call(harness.base, "/api/boxes/mbtest-missing/logs");
    expect(refused(stream)).toEqual({ status: 404, key: "box_not_found" });
    expect(refused(stream)).toEqual(refused(rest));
  });

  test("a token without box:read is refused as the REST read refuses it", async () => {
    const files = mint(harness.app, { name: "files", scopes: ["files:read"] });
    const box = await createBox("delta");
    const stream = await call(harness.base, `/api/boxes/${box.boxId}/logs/stream`, { token: files.secret });
    const rest = await call(harness.base, `/api/boxes/${box.boxId}/logs`, { token: files.secret });
    expect(refused(stream)).toEqual({ status: 403, key: "operation_forbidden" });
    expect(refused(stream)).toEqual(refused(rest));
  });

  test("a token reads the logs of the boxes it may see, and is refused the others as the REST read is", async () => {
    const maker = mint(harness.app, { name: "maker", preset: "operator" });
    const mine = await createBox("mine", maker.secret);
    const rival = mint(harness.app, { name: "rival", preset: "readonly", boxes: { type: "created-by-me" } });
    const owned = await createBox("owned");
    await startSampler();

    const reader = await openLogs(mine.boxId, maker.secret);
    expect((await reader.next()).retry).toBe(3000);

    const stream = await call(harness.base, `/api/boxes/${owned.boxId}/logs/stream`, { token: rival.secret });
    const rest = await call(harness.base, `/api/boxes/${owned.boxId}/logs`, { token: rival.secret });
    expect(refused(stream)).toEqual({ status: 403, key: "box_out_of_scope" });
    expect(refused(stream)).toEqual(refused(rest));
  });

  test("two streams of one box share one follow, and opening the second reads the engine for no listing or inspect", async () => {
    const box = await createBox("echo");
    await startSampler();
    const first = await openLogs(box.boxId);
    await first.until((frame) => frame.event === "sync");
    await waitFor(() => harness.runtime.callsTo("followLogs").length === 1, "the follow");
    harness.runtime.appendLogs(box.id, "hello\n");
    await first.until((frame) => frame.event === "line");

    const mark = harness.runtime.calls.length;
    const second = await openLogs(box.boxId);
    expect(linesOf(await second.until((frame) => frame.event === "sync"))).toEqual(["hello"]);
    expect(harness.runtime.callsTo("followLogs")).toHaveLength(1);
    const engineReads = harness.runtime.calls
      .slice(mark)
      .map((call) => call.op)
      .filter((op) => ["listContainers", "inspectContainer", "containerStats"].includes(op));
    expect(engineReads).toEqual([]);
  });

  test("a stream past the cap on live streams is refused with 429 that names the limit", async () => {
    const box = await createBox("foxtrot");
    await startSampler();
    await openLogs(box.boxId);
    await openLogs(box.boxId);

    const refusedStream = await fetch(`${harness.base}/api/boxes/${box.boxId}/logs/stream`, {
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    expect(refusedStream.status).toBe(429);
    expect(await refusedStream.json()).toMatchObject({
      error: { code: "too_many_requests", key: "stream_limit", params: { max: STREAM_CAP }, retryable: true },
    });
    expect(harness.app.streams.count).toBe(STREAM_CAP);
  });

  test("the opens are audited as reads of the box, and a refused open as denied", async () => {
    const maker = mint(harness.app, { name: "maker", preset: "operator" });
    const mine = await createBox("golf", maker.secret);
    const rival = mint(harness.app, { name: "rival", preset: "readonly", boxes: { type: "created-by-me" } });
    await startSampler();

    await openLogs(mine.boxId, maker.secret, "?tail=40");
    await call(harness.base, `/api/boxes/${mine.boxId}/logs/stream`, { token: rival.secret });

    const res = await fetch(`${harness.base}/api/events?op=box.logs`, {
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    const { events } = (await res.json()) as { events: AuditedRead[] };
    const opened = events.find((event) => event.status === "ok");
    const denied = events.find((event) => event.status === "denied");
    expect(opened).toMatchObject({
      op: "box.logs",
      kind: "read",
      source: "rest",
      principal: { id: maker.id },
      target: { kind: "box", id: mine.id, name: "golf" },
      detail: { tail: 40 },
    });
    expect(denied).toMatchObject({
      op: "box.logs",
      principal: { id: rival.id },
      target: { kind: "box", id: mine.id, name: "golf" },
      error: { code: "forbidden", status: 403 },
    });
  });

  test("removing the box sends closed, then ends the stream", async () => {
    const box = await createBox("hotel");
    await startSampler();
    const reader = await openLogs(box.boxId);
    await reader.until((frame) => frame.event === "sync");

    const removed = await call(harness.base, `/api/boxes/${box.boxId}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    await reader.until((frame) => frame.event === "closed");
    await reader.untilEnd();
  });

  test("stopping the host ends the stream without a closed frame, so the client reconnects", async () => {
    const box = await createBox("juliet");
    await startSampler();
    const reader = await openLogs(box.boxId);
    await reader.until((frame) => frame.event === "sync");

    harness.app.hosts.get().sampler.stop();
    const rest = await reader.framesUntilEnd();
    expect(rest.map((frame) => frame.event)).not.toContain("closed");
  });

  test("revoking the token that opened the stream ends it", async () => {
    const watcher = mint(harness.app, { name: "watcher", preset: "readonly", boxes: { type: "all" } });
    const box = await createBox("india");
    await startSampler();
    const reader = await openLogs(box.boxId, watcher.secret);
    await reader.until((frame) => frame.event === "sync");

    const revoked = await call(harness.base, `/api/tokens/${watcher.id}`, { method: "DELETE" });
    expect(revoked.status).toBe(200);
    await reader.untilEnd();
  });
});
