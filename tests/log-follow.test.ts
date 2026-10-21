import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  LOG_RING_BYTES,
  LOG_RING_LINES,
  type LogEvent,
  LogFollows,
  type LogLine,
  type LogSource,
  type LogSubscription,
  stampNanos,
} from "../src/host/log-follow";
import { type Runtime, RuntimeError } from "../src/runtime";
import { silenceLogs } from "./support/app";
import { FakeRuntime, fakeStamp, fakeStampMs } from "./support/fake-runtime";

const FAST = { retryMinMs: 2, retryMaxMs: 10, leaseMs: 10_000 };
const DROP = new RuntimeError("unavailable", "connection reset");

/** A cache the test controls: which container each box runs, and whether the cache is current. */
class TestSource implements LogSource {
  readonly targets = new Map<string, { containerId: string; running: boolean }>();
  current = true;

  constructor(private readonly engine: FakeRuntime) {}

  runtime() {
    return this.engine;
  }

  target(boxId: string) {
    return this.targets.get(boxId) ?? null;
  }

  ready() {
    return this.current;
  }
}

let restoreLogs: () => void;
let engine: FakeRuntime;
let source: TestSource;
let follows: LogFollows;

beforeEach(() => {
  restoreLogs = silenceLogs();
  engine = new FakeRuntime();
  source = new TestSource(engine);
  follows = new LogFollows(source, FAST);
});

afterEach(() => {
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

/** The stamp of a line the scripted engine writes `nanos` after the second it writes in, as the engine formats it. */
function stampAt(nanos: number): string {
  return `2026-10-21T12:00:00.${String(nanos).padStart(9, "0")}Z`;
}

/** The line without the engine's stamp in front of it. */
function bodyOf(line: LogLine): string {
  return line.text.slice(line.text.indexOf(" ") + 1);
}

function bodies(events: LogEvent[]): string[] {
  return events.flatMap((event) => (event.kind === "line" ? [bodyOf(event.line)] : []));
}

function subscribe(boxId: string): { events: LogEvent[]; subscription: LogSubscription } {
  const events: LogEvent[] = [];
  const subscription = follows.subscribe(boxId, (event) => events.push(event));
  return { events, subscription };
}

/** Seeds a container for `boxId` and points the cache at it. */
function seed(boxId: string, running = true): string {
  const id = engine.seedContainer({ image: "fake:base", name: `box-${boxId}`, labels: {}, running });
  source.targets.set(boxId, { containerId: id, running });
  return id;
}

function retarget(boxId: string, containerId: string, running: boolean): void {
  source.targets.set(boxId, { containerId, running });
  follows.changed();
}

function signalOf(index: number): AbortSignal | undefined {
  return (engine.callsTo("followLogs")[index]?.args[1] as { signal?: AbortSignal } | undefined)?.signal;
}

describe("one follow per box", () => {
  test("one follow serves every subscriber, and each line reaches each of them once", async () => {
    const id = seed("alpha");
    const subs = [subscribe("alpha"), subscribe("alpha"), subscribe("alpha")];
    engine.appendLogs(id, "one\ntwo\n");

    await waitFor(() => subs.every((sub) => bodies(sub.events).length === 2), "both lines at every subscriber");
    for (const sub of subs) expect(bodies(sub.events)).toEqual(["one", "two"]);
    expect(engine.callsTo("followLogs")).toHaveLength(1);
  });

  test("a subscriber that arrives later gets the lines held, then only the lines written after", async () => {
    const id = seed("bravo");
    const first = subscribe("bravo");
    engine.appendLogs(id, "a\nb\nc\n");
    await waitFor(() => bodies(first.events).length === 3, "three lines");

    const late = subscribe("bravo");
    expect(late.subscription.snapshot(10).map(bodyOf)).toEqual(["a", "b", "c"]);
    expect(late.events).toEqual([]);

    engine.appendLogs(id, "d\n");
    await waitFor(() => bodies(late.events).length === 1, "the new line");
    expect(bodies(late.events)).toEqual(["d"]);
    expect(late.subscription.snapshot(2).map(bodyOf)).toEqual(["c", "d"]);
    expect(engine.callsTo("followLogs")).toHaveLength(1);
  });

  test("a snapshot holds at most the tail asked for, and a zero tail holds none", async () => {
    const id = seed("charlie");
    const sub = subscribe("charlie");
    engine.appendLogs(id, "1\n2\n3\n");
    await waitFor(() => bodies(sub.events).length === 3, "three lines");

    expect(sub.subscription.snapshot(0)).toEqual([]);
    expect(sub.subscription.snapshot(2).map(bodyOf)).toEqual(["2", "3"]);
  });

  test("a box with no subscriber is not followed at all", async () => {
    seed("delta");
    await Bun.sleep(20);
    expect(engine.callsTo("followLogs")).toHaveLength(0);
  });
});

describe("resuming a dropped follow", () => {
  test("a line written while the follow is down arrives once, and no line repeats", async () => {
    const id = seed("echo");
    const sub = subscribe("echo");
    engine.appendLogs(id, "a\nb\n");
    await waitFor(() => bodies(sub.events).length === 2, "the first two lines");

    engine.interruptLogs(DROP);
    engine.appendLogs(id, "c\n");
    engine.appendLogs(id, "d\n");
    await waitFor(() => bodies(sub.events).length === 4, "the lines written after the drop");
    await Bun.sleep(20);

    expect(bodies(sub.events)).toEqual(["a", "b", "c", "d"]);
    expect(engine.callsTo("followLogs")).toHaveLength(2);
    expect(engine.callsTo("followLogs")[1]?.args[1]).toMatchObject({ since: expect.any(Date) });
  });

  test("a repeated line written after a drop is delivered, and the lines already sent are not", async () => {
    const id = seed("foxtrot");
    const sub = subscribe("foxtrot");
    engine.appendLogs(id, "tick\ntick\n");
    await waitFor(() => bodies(sub.events).length === 2, "two ticks");

    engine.interruptLogs(DROP);
    await waitFor(() => engine.callsTo("followLogs").length === 2, "the resumed follow");
    engine.appendLogs(id, "tick\n");
    await waitFor(() => bodies(sub.events).length === 3, "the third tick");
    await Bun.sleep(20);

    expect(bodies(sub.events)).toEqual(["tick", "tick", "tick"]);
  });

  test("two lines with the same stamp and text are two lines: a replay takes one, and the twin is kept", async () => {
    const line = "2026-10-21T12:00:00.000000001Z tick";
    const sinces: (Date | undefined)[] = [];
    const scripted = new LogFollows(
      {
        runtime: () =>
          ({
            async *followLogs(_id: string, opts: { since?: Date; signal?: AbortSignal }) {
              sinces.push(opts.since);
              if (sinces.length === 1) {
                yield line;
                throw DROP;
              }
              yield line;
              yield line;
              await new Promise<void>((resolve) =>
                opts.signal?.addEventListener("abort", () => resolve(), { once: true }),
              );
            },
          }) as unknown as Runtime,
        target: () => ({ containerId: "scripted", running: true }),
        ready: () => true,
      },
      FAST,
    );
    const events: LogEvent[] = [];
    scripted.subscribe("tango", (event) => events.push(event));
    try {
      await waitFor(() => bodies(events).length === 2, "both ticks");
      await Bun.sleep(10);
      expect(bodies(events)).toEqual(["tick", "tick"]);
      expect(sinces).toHaveLength(2);
    } finally {
      scripted.stop();
    }
  });

  test("a burst larger than the ring's bytes, then a drop, sends each line once", async () => {
    const body = "x".repeat(64 * 1024);
    const line = (i: number) => `${stampAt(i)} ${String(i).padStart(3, "0")}${body}`;
    const burst = Array.from({ length: 40 }, (_, i) => line(i));
    const log = [...burst, line(40)];
    let calls = 0;
    const scripted = new LogFollows(
      {
        runtime: () =>
          ({
            async *followLogs(_id: string, opts: { tail: number; since?: Date; signal?: AbortSignal }) {
              calls += 1;
              if (calls === 1) {
                for (const text of burst) yield text;
                throw DROP;
              }
              const sinceNs = opts.since ? BigInt(opts.since.getTime()) * 1_000_000n : null;
              for (const text of log.slice(-opts.tail)) {
                if (sinceNs !== null && (stampNanos(text) ?? 0n) < sinceNs) continue;
                yield text;
              }
              await new Promise<void>((resolve) =>
                opts.signal?.addEventListener("abort", () => resolve(), { once: true }),
              );
            },
          }) as unknown as Runtime,
        target: () => ({ containerId: "burst", running: true }),
        ready: () => true,
      },
      FAST,
    );
    const events: LogEvent[] = [];
    scripted.subscribe("bursty", (event) => events.push(event));
    try {
      await waitFor(() => bodies(events).length >= 41, "every line");
      await Bun.sleep(20);
      expect(bodies(events)).toHaveLength(41);
      expect(new Set(bodies(events)).size).toBe(41);
      expect(calls).toBe(2);
    } finally {
      scripted.stop();
    }
  });

  test("a follow the engine refuses to start is retried, and sends no line twice", async () => {
    const id = seed("golf");
    engine.appendLogs(id, "one\n");
    engine.fail("followLogs", new RuntimeError("engine", "boom"));
    const sub = subscribe("golf");

    await waitFor(() => bodies(sub.events).length === 1, "the line after the retry");
    await Bun.sleep(20);
    expect(bodies(sub.events)).toEqual(["one"]);
    expect(engine.callsTo("followLogs").length).toBeGreaterThanOrEqual(2);
  });

  test("a follow the engine reports as not found waits for the cache to change", async () => {
    const id = seed("hotel");
    engine.fail("followLogs", new RuntimeError("not_found", "No such container"));
    subscribe("hotel");

    await Bun.sleep(30);
    expect(engine.callsTo("followLogs")).toHaveLength(1);
    retarget("hotel", id, true);
    await waitFor(() => engine.callsTo("followLogs").length === 2, "the follow after the cache changed");
  });
});

describe("the box's container", () => {
  test("a replaced container gives its subscribers a reset, then the lines of the new container", async () => {
    const old = seed("india");
    engine.appendLogs(old, "old-1\n");
    const sub = subscribe("india");
    await waitFor(() => bodies(sub.events).length === 1, "the old line");

    const fresh = engine.seedContainer({ image: "fake:base", name: "box-india-2", labels: {}, running: true });
    engine.appendLogs(fresh, "new-1\n");
    retarget("india", fresh, true);

    await waitFor(() => bodies(sub.events).length === 2, "the new container's line");
    expect(sub.events.map((event) => event.kind)).toEqual(["line", "reset", "line"]);
    expect(bodies(sub.events)).toEqual(["old-1", "new-1"]);
    expect(engine.callsTo("followLogs").at(-1)?.args[0]).toBe(fresh);
  });

  test("a stopped box is not followed until it runs again, and then goes on from its newest line", async () => {
    const id = seed("juliet");
    engine.appendLogs(id, "start\n");
    const sub = subscribe("juliet");
    await waitFor(() => bodies(sub.events).length === 1, "the first line");

    await engine.stopContainer(id, { timeoutSec: 1 });
    retarget("juliet", id, false);
    await Bun.sleep(20);
    expect(engine.callsTo("followLogs")).toHaveLength(1);

    await engine.startContainer(id);
    retarget("juliet", id, true);
    await waitFor(() => engine.callsTo("followLogs").length === 2, "the follow after the start");
    engine.appendLogs(id, "again\n");

    await waitFor(() => bodies(sub.events).length === 2, "the line after the start");
    expect(sub.events.map((event) => event.kind)).toEqual(["line", "line"]);
    expect(bodies(sub.events)).toEqual(["start", "again"]);
  });

  test("a stopped box is read once, and changes that leave it stopped do not read it again", async () => {
    const id = seed("lima", false);
    engine.appendLogs(id, "last\n");
    const sub = subscribe("lima");
    await waitFor(() => bodies(sub.events).length === 1, "the last line of the stopped box");

    for (let round = 0; round < 3; round += 1) {
      follows.changed();
      await Bun.sleep(5);
    }
    expect(engine.callsTo("followLogs")).toHaveLength(1);
    expect(bodies(sub.events)).toEqual(["last"]);

    await engine.startContainer(id);
    retarget("lima", id, true);
    await waitFor(() => engine.callsTo("followLogs").length === 2, "the follow after the start");
    engine.appendLogs(id, "again\n");
    await waitFor(() => bodies(sub.events).length === 2, "the line after the start");
    expect(bodies(sub.events)).toEqual(["last", "again"]);
  });

  test("a follow in flight ends when the cache is not current, and resumes once it is", async () => {
    const id = seed("kilo");
    const sub = subscribe("kilo");
    engine.appendLogs(id, "one\n");
    await waitFor(() => bodies(sub.events).length === 1, "the first line");

    source.current = false;
    follows.changed();
    expect(signalOf(0)?.aborted).toBe(true);

    engine.appendLogs(id, "two\n");
    source.current = true;
    follows.changed();
    await waitFor(() => bodies(sub.events).length === 2, "the line written while the cache was down");
    expect(bodies(sub.events)).toEqual(["one", "two"]);
  });

  test("a box is not followed while the cache is not current", async () => {
    const id = seed("lima");
    source.current = false;
    const sub = subscribe("lima");
    engine.appendLogs(id, "wait\n");
    await Bun.sleep(20);
    expect(engine.callsTo("followLogs")).toHaveLength(0);

    source.current = true;
    follows.changed();
    await waitFor(() => bodies(sub.events).length === 1, "the line once the cache is current");
  });
});

describe("ending a feed", () => {
  test("closing a box tells each subscriber it is closed, and a later subscriber starts a new feed", async () => {
    const id = seed("mike");
    const first = subscribe("mike");
    const second = subscribe("mike");
    engine.appendLogs(id, "x\n");
    await waitFor(() => bodies(second.events).length === 1, "the line");

    follows.close("mike");
    expect(first.events.at(-1)).toEqual({ kind: "closed" });
    expect(second.events.at(-1)).toEqual({ kind: "closed" });
    engine.appendLogs(id, "y\n");
    await Bun.sleep(10);
    expect(bodies(first.events)).toEqual(["x"]);

    const again = subscribe("mike");
    await waitFor(() => bodies(again.events).length === 2, "both lines in the new feed");
    expect(bodies(again.events)).toEqual(["x", "y"]);
    expect(engine.callsTo("followLogs")).toHaveLength(2);
  });

  test("stop ends every feed as stopped, not closed, because the boxes still exist", async () => {
    seed("november");
    seed("oscar");
    const a = subscribe("november");
    const b = subscribe("oscar");

    follows.stop();
    expect(a.events).toEqual([{ kind: "stopped" }]);
    expect(b.events).toEqual([{ kind: "stopped" }]);
  });

  test("a feed with no subscriber is kept for its lease, so a reader that comes back finds it", async () => {
    follows.stop();
    follows = new LogFollows(source, { ...FAST, leaseMs: 60 });
    const id = seed("papa");
    engine.appendLogs(id, "kept\n");
    const first = subscribe("papa");
    await waitFor(() => bodies(first.events).length === 1, "the line");

    first.subscription.unsubscribe();
    await Bun.sleep(10);
    const back = subscribe("papa");
    expect(back.subscription.snapshot(10).map(bodyOf)).toEqual(["kept"]);
    expect(engine.callsTo("followLogs")).toHaveLength(1);

    back.subscription.unsubscribe();
    await Bun.sleep(120);
    expect(signalOf(0)?.aborted).toBe(true);
    const later = subscribe("papa");
    expect(later.subscription.snapshot(10)).toEqual([]);
    await waitFor(() => bodies(later.events).length === 1, "the line from the new follow");
    expect(engine.callsTo("followLogs")).toHaveLength(2);
  });
});

describe("the feed's bounds", () => {
  test("the feed holds the newest lines up to the tail a stream may ask for", async () => {
    const id = seed("quebec");
    const sub = subscribe("quebec");
    const count = LOG_RING_LINES + 3;
    engine.appendLogs(id, `${Array.from({ length: count }, (_, i) => `n${i}`).join("\n")}\n`);

    await waitFor(() => bodies(sub.events).length === count, "every line");
    const held = sub.subscription.snapshot(LOG_RING_LINES + 10);
    expect(held).toHaveLength(LOG_RING_LINES);
    expect(bodyOf(held[0] as LogLine)).toBe("n3");
    expect(bodyOf(held.at(-1) as LogLine)).toBe(`n${count - 1}`);
  });

  test("the feed holds no more than its byte budget, and keeps the newest line", async () => {
    const id = seed("romeo");
    const sub = subscribe("romeo");
    const long = "x".repeat(64 * 1024);
    const count = 48;
    engine.appendLogs(id, `${Array.from({ length: count }, () => long).join("\n")}\n`);

    await waitFor(() => bodies(sub.events).length === count, "every long line");
    const held = sub.subscription.snapshot(LOG_RING_LINES);
    const bytes = held.reduce((sum, line) => sum + Buffer.byteLength(line.text), 0);
    expect(bytes).toBeLessThanOrEqual(LOG_RING_BYTES);
    expect(held.length).toBeLessThan(count);
    expect(bodyOf(held.at(-1) as LogLine)).toBe(long);
  });
});

describe("stampNanos", () => {
  test("reads the engine's stamp with or without fractional digits, and gives null without one", () => {
    const base = BigInt(Date.parse("2026-10-21T12:00:00Z")) * 1_000_000n;
    expect(stampNanos("2026-10-21T12:00:00Z hello")).toBe(base);
    expect(stampNanos("2026-10-21T12:00:00.5Z hello")).toBe(base + 500_000_000n);
    expect(stampNanos("2026-10-21T12:00:00.000000123Z hello")).toBe(base + 123n);
    expect(stampNanos("2026-10-21T12:00:00.123456789Z")).toBeNull();
    expect(stampNanos("2026-10-21T12:00:00+00:00 hello")).toBeNull();
    expect(stampNanos("hello")).toBeNull();
  });

  test("reads the stamp the fake runtime writes, as the engine writes it", () => {
    expect(stampNanos(`${fakeStamp(3)} hello`)).toBe(BigInt(fakeStampMs(3)) * 1_000_000n);
  });
});
