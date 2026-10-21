import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { LogFollows, type LogSource, type LogSubscription } from "../src/host/log-follow";
import { logStream } from "../src/logs/stream";
import { silenceLogs } from "./support/app";
import { FakeRuntime } from "./support/fake-runtime";
import { type SseFrame, SseReader } from "./support/sse";

const FAST = { retryMinMs: 2, retryMaxMs: 10, leaseMs: 10_000 };

/** A cache the test controls: which container each box runs. */
class TestSource implements LogSource {
  readonly targets = new Map<string, { containerId: string; running: boolean }>();

  constructor(private readonly engine: FakeRuntime) {}

  runtime() {
    return this.engine;
  }

  target(boxId: string) {
    return this.targets.get(boxId) ?? null;
  }

  ready() {
    return true;
  }
}

let restoreLogs: () => void;
let engine: FakeRuntime;
let source: TestSource;
let follows: LogFollows;
const readers: SseReader[] = [];

beforeEach(() => {
  restoreLogs = silenceLogs();
  engine = new FakeRuntime();
  source = new TestSource(engine);
  follows = new LogFollows(source, FAST);
});

afterEach(async () => {
  for (const reader of readers.splice(0)) await reader.close();
  follows.stop();
  restoreLogs();
});

async function waitFor(check: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(3);
  }
}

/** The line without the engine's stamp in front of it. */
const bodyOf = (text: string): string => text.slice(text.indexOf(" ") + 1);

const textOf = (frame: SseFrame): string => bodyOf((frame.data as { text: string }).text);

function linesOf(frame: SseFrame): string[] {
  return (frame.data as { lines: string[] }).lines.map(bodyOf);
}

/** Seeds a running container for `boxId`, points the cache at it, and writes `text` to its log. */
function boxWith(boxId: string, text: string): string {
  const id = engine.seedContainer({ image: "fake:base", name: `box-${boxId}`, labels: {}, running: true });
  source.targets.set(boxId, { containerId: id, running: true });
  if (text) engine.appendLogs(id, text);
  return id;
}

/** Subscribes to a box's feed as a holder, so its lines are held before a stream opens. The holder is never read. */
async function holdFeed(boxId: string, lines: number): Promise<LogSubscription> {
  const holder = follows.subscribe(boxId, () => {});
  await waitFor(() => holder.snapshot(lines).length >= lines, "the feed's lines");
  return holder;
}

function open(
  boxId: string,
  options: { tail?: number; pendingLimit?: number; heartbeatMs?: number; onEnd?: () => void } = {},
): SseReader {
  const stream = logStream({
    follows,
    boxId,
    tail: options.tail ?? 300,
    onEnd: options.onEnd,
    pendingLimit: options.pendingLimit,
    heartbeatMs: options.heartbeatMs,
  });
  const reader = new SseReader(stream.getReader());
  readers.push(reader);
  return reader;
}

describe("the log stream of a box", () => {
  test("opens with a retry hint and a sync of the lines held, then sends each new line", async () => {
    const id = boxWith("alpha", "a\nb\n");
    await holdFeed("alpha", 2);
    const reader = open("alpha");

    expect((await reader.next()).retry).toBe(3000);
    const sync = await reader.next();
    expect(sync.event).toBe("sync");
    expect(linesOf(sync)).toEqual(["a", "b"]);

    engine.appendLogs(id, "c\n");
    const line = await reader.until((frame) => frame.event === "line");
    expect(textOf(line)).toBe("c");
  });

  test("a tail asks for the newest lines only", async () => {
    boxWith("bravo", "1\n2\n3\n");
    await holdFeed("bravo", 3);
    const reader = open("bravo", { tail: 2 });

    const sync = await reader.until((frame) => frame.event === "sync");
    expect(linesOf(sync)).toEqual(["2", "3"]);
  });

  test("a slow client that overflows its queue is sent a sync of the newest lines, then the lines after", async () => {
    const id = boxWith("charlie", "");
    const holder = follows.subscribe("charlie", () => {});
    const reader = open("charlie", { pendingLimit: 2 });
    await Bun.sleep(5);

    engine.appendLogs(id, "1\n2\n3\n4\n5\n");
    await waitFor(() => holder.snapshot(10).length === 5, "five lines");

    const sync = await reader.until((frame) => frame.event === "sync" && linesOf(frame).length === 5);
    expect(linesOf(sync)).toEqual(["1", "2", "3", "4", "5"]);

    engine.appendLogs(id, "6\n");
    const line = await reader.until((frame) => frame.event === "line");
    expect(textOf(line)).toBe("6");
  });

  test("a container change is sent as a sync of what the feed holds now, then the new container's lines", async () => {
    boxWith("delta", "old-1\n");
    await holdFeed("delta", 1);
    const reader = open("delta");
    await reader.until((frame) => frame.event === "sync" && linesOf(frame).length === 1);

    const fresh = engine.seedContainer({ image: "fake:base", name: "box-delta-2", labels: {}, running: true });
    engine.appendLogs(fresh, "new-1\n");
    source.targets.set("delta", { containerId: fresh, running: true });
    follows.changed();

    const reset = await reader.until((frame) => frame.event === "sync" && linesOf(frame).length === 0);
    expect(reset.event).toBe("sync");
    const line = await reader.until((frame) => frame.event === "line");
    expect(textOf(line)).toBe("new-1");
  });

  test("a removed box sends closed, then ends the stream, and the end is reported once", async () => {
    boxWith("echo", "x\n");
    await holdFeed("echo", 1);
    let ended = 0;
    const reader = open("echo", { onEnd: () => (ended += 1) });
    await reader.until((frame) => frame.event === "sync");

    follows.close("echo");
    await reader.until((frame) => frame.event === "closed");
    await reader.untilEnd();
    expect(ended).toBe(1);
  });

  test("an aborted signal ends the stream and reports the end", async () => {
    boxWith("foxtrot", "");
    let ended = 0;
    const controller = new AbortController();
    const stream = logStream({
      follows,
      boxId: "foxtrot",
      tail: 10,
      signal: controller.signal,
      onEnd: () => (ended += 1),
    });
    const reader = new SseReader(stream.getReader());
    readers.push(reader);
    await reader.until((frame) => frame.event === "sync");

    controller.abort();
    await reader.untilEnd();
    expect(ended).toBe(1);
  });

  test("a cancelled reader ends the stream and reports the end, once", async () => {
    boxWith("golf", "");
    let ended = 0;
    const reader = open("golf", { onEnd: () => (ended += 1) });
    await reader.until((frame) => frame.event === "sync");

    await reader.close();
    await waitFor(() => ended === 1, "the end of the stream");
    await Bun.sleep(10);
    expect(ended).toBe(1);
  });

  test("a heartbeat keeps an idle stream open", async () => {
    boxWith("hotel", "");
    const reader = open("hotel", { heartbeatMs: 5 });
    const beat = await reader.until((frame) => frame.comment === "keep-alive");
    expect(beat.comment).toBe("keep-alive");
  });
});
