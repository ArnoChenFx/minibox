import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { ROOT } from "../src/config";

const LIB = join(ROOT, "web", "js", "lib");

/**
 * The browser pieces the live client touches, faked: an EventSource that the scenario drives by hand, and timers that
 * only run when the scenario fires them. Each scenario runs in a fresh process, since the client keeps its connection in
 * module state. `live` and `boxState` are the loaded modules, and `FakeEventSource.made` lists every connection opened.
 */
const PRELUDE = `
class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static made = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.handlers = new Map();
    FakeEventSource.made.push(this);
  }
  addEventListener(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }
  close() {
    this.readyState = 2;
  }
  emit(type, data) {
    const event = data === undefined ? {} : { data: typeof data === "string" ? data : JSON.stringify(data) };
    for (const fn of this.handlers.get(type) ?? []) fn(event);
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  fail(final) {
    this.readyState = final ? 2 : 0;
    this.emit("error");
  }
}
globalThis.EventSource = FakeEventSource;
const timers = [];
const schedule = (repeat) => (fn, ms) => {
  const timer = { fn, ms, repeat, cleared: false };
  timers.push(timer);
  return timer;
};
globalThis.setTimeout = schedule(false);
globalThis.setInterval = schedule(true);
globalThis.clearTimeout = (timer) => {
  if (timer) timer.cleared = true;
};
globalThis.clearInterval = globalThis.clearTimeout;
const pending = () => timers.filter((timer) => !timer.cleared);
const fire = (timer) => {
  timer.fn();
  if (!timer.repeat) timer.cleared = true;
};
const live = await import(${JSON.stringify(join(LIB, "live.js"))});
const boxState = await import(${JSON.stringify(join(LIB, "box-state.js"))});
const logs = await import(${JSON.stringify(join(LIB, "logs-stream.js"))});
`;

/** Runs `body` in a fresh process with the prelude above. The body's return value comes back as JSON. */
function inBrowser<T>(body: string): T {
  const script = `${PRELUDE}\nconsole.log(JSON.stringify((() => {\n${body}\n})()));`;
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000 });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout) as T;
}

describe("live stream client", () => {
  test("retryDelay doubles from one second and stops at thirty", () => {
    expect(inBrowser(`return [0, 1, 2, 3, 4, 5, 6, 20].map((n) => live.retryDelay(n));`)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ]);
  });

  test("one connection serves every subscriber, and each frame reaches the subscribers of its kind", () => {
    expect(
      inBrowser(`
        const seen = [];
        const offA = live.subscribe("box", (frame) => seen.push(["a", frame.boxId]));
        live.subscribe("box", (frame) => seen.push(["b", frame.boxId]));
        live.subscribe("sample", (frame) => seen.push(["sample", frame.t]));
        live.subscribe("sync", (frame) => seen.push(["sync", frame]));
        live.subscribe("event", (frame) => seen.push(["event", frame.seq]));
        const source = FakeEventSource.made[0];
        source.open();
        source.emit("box", { boxId: "x" });
        offA();
        source.emit("box", { boxId: "y" });
        source.emit("sample", { t: 5 });
        source.emit("sync", "{not json");
        source.emit("message", { seq: 9 });
        return { connections: FakeEventSource.made.length, url: source.url, seen };
      `),
    ).toEqual({
      connections: 1,
      url: "/api/events/stream",
      seen: [
        ["a", "x"],
        ["b", "x"],
        ["b", "y"],
        ["sample", 5],
        ["event", 9],
      ],
    });
  });

  test("onLiveState reports the state at once, then on each change", () => {
    expect(
      inBrowser(`
        const states = [];
        live.onLiveState((on) => states.push(on));
        const source = FakeEventSource.made[0];
        source.open();
        source.fail(false);
        source.open();
        return states;
      `),
    ).toEqual([false, true, false, true]);
  });

  test("pollWhileDown refreshes only while the stream is down", () => {
    expect(
      inBrowser(`
        let refreshes = 0;
        const stop = live.pollWhileDown(() => {
          refreshes += 1;
        }, 5000);
        const source = FakeEventSource.made[0];
        const polls = () => pending().filter((timer) => timer.repeat).length;
        const counts = [polls()];
        fire(pending().find((timer) => timer.repeat));
        counts.push(refreshes);
        source.open();
        counts.push(polls());
        source.fail(false);
        counts.push(polls());
        stop();
        counts.push(polls());
        return counts;
      `),
    ).toEqual([1, 1, 0, 1, 0]);
  });

  test("a connection the browser gives up on is reopened after a delay that grows, and resets on success", () => {
    expect(
      inBrowser(`
        live.subscribe("box", () => {});
        const delays = [];
        for (let i = 0; i < 3; i += 1) {
          FakeEventSource.made.at(-1).fail(true);
          const retry = pending().filter((timer) => !timer.repeat).at(-1);
          delays.push(retry.ms);
          fire(retry);
        }
        FakeEventSource.made.at(-1).open();
        FakeEventSource.made.at(-1).fail(true);
        delays.push(pending().filter((timer) => !timer.repeat).at(-1).ms);
        return { delays, connections: FakeEventSource.made.length };
      `),
    ).toEqual({ delays: [1000, 2000, 4000, 1000], connections: 4 });
  });
});

describe("box log stream client", () => {
  test("the stream opens for the box with its tail, sync replaces the lines, and each line follows", () => {
    expect(
      inBrowser(`
        const seen = [];
        const handle = logs.openBoxLogs({
          boxId: "bx 1",
          tail: 200,
          onSync: (lines) => seen.push(["sync", lines]),
          onLine: (text) => seen.push(["line", text]),
          onClosed: () => seen.push(["closed"]),
          onState: (live) => seen.push(["state", live]),
        });
        const source = FakeEventSource.made[0];
        source.open();
        source.emit("sync", { lines: ["2026-10-21T01:00:00.5Z a", "2026-10-21T01:00:01Z b"] });
        source.emit("line", { text: "2026-10-21T01:00:02Z c" });
        handle.close();
        return { url: source.url, seen, readyState: source.readyState };
      `),
    ).toEqual({
      url: "/api/boxes/bx%201/logs/stream?tail=200",
      seen: [
        ["state", true],
        ["sync", ["2026-10-21T01:00:00.5Z a", "2026-10-21T01:00:01Z b"]],
        ["line", "2026-10-21T01:00:02Z c"],
      ],
      readyState: 2,
    });
  });

  test("a closed frame ends the stream: nothing reconnects, and frames after it are ignored", () => {
    expect(
      inBrowser(`
        const seen = [];
        logs.openBoxLogs({
          boxId: "bx",
          tail: 300,
          onSync: () => seen.push("sync"),
          onLine: (text) => seen.push(text),
          onClosed: () => seen.push("closed"),
        });
        const source = FakeEventSource.made[0];
        source.open();
        source.emit("closed", {});
        source.emit("line", { text: "late" });
        source.fail(true);
        return { seen, connections: FakeEventSource.made.length, pending: pending().length };
      `),
    ).toEqual({ seen: ["closed"], connections: 1, pending: 0 });
  });

  test("a connection the browser gives up on is reopened after a delay that grows, and onState reports each change", () => {
    expect(
      inBrowser(`
        const states = [];
        logs.openBoxLogs({ boxId: "bx", tail: 300, onSync() {}, onLine() {}, onState: (live) => states.push(live) });
        FakeEventSource.made[0].open();
        const delays = [];
        for (let i = 0; i < 3; i += 1) {
          FakeEventSource.made.at(-1).fail(true);
          const retry = pending().filter((timer) => !timer.repeat).at(-1);
          delays.push(retry.ms);
          fire(retry);
        }
        FakeEventSource.made.at(-1).open();
        FakeEventSource.made.at(-1).fail(true);
        delays.push(pending().filter((timer) => !timer.repeat).at(-1).ms);
        return { delays, connections: FakeEventSource.made.length, states };
      `),
    ).toEqual({ delays: [1000, 2000, 4000, 1000], connections: 4, states: [true, false, true, false] });
  });

  test("close cancels a pending reopen, and a late open of the closed connection changes nothing", () => {
    expect(
      inBrowser(`
        const states = [];
        const handle = logs.openBoxLogs({ boxId: "bx", tail: 300, onSync() {}, onLine() {}, onState: (live) => states.push(live) });
        FakeEventSource.made[0].fail(true);
        const waiting = pending().length;
        handle.close();
        FakeEventSource.made[0].open();
        return { waiting, after: pending().length, connections: FakeEventSource.made.length, states };
      `),
    ).toEqual({ waiting: 1, after: 0, connections: 1, states: [false] });
  });

  test("a browser without EventSource reports the stream down and opens nothing", () => {
    expect(
      inBrowser(`
        delete globalThis.EventSource;
        const states = [];
        logs.openBoxLogs({ boxId: "bx", tail: 300, onSync() {}, onLine() {}, onState: (live) => states.push(live) });
        return { states, made: FakeEventSource.made.length };
      `),
    ).toEqual({ states: [false], made: 0 });
  });

  test("a frame that is not JSON, or lacks its field, is ignored", () => {
    expect(
      inBrowser(`
        const seen = [];
        logs.openBoxLogs({
          boxId: "bx",
          tail: 300,
          onSync: (lines) => seen.push(["sync", lines]),
          onLine: (text) => seen.push(["line", text]),
        });
        const source = FakeEventSource.made[0];
        source.open();
        source.emit("sync", "{not json");
        source.emit("sync", { lines: "x" });
        source.emit("line", {});
        source.emit("line", { text: "kept" });
        return seen;
      `),
    ).toEqual([["line", "kept"]]);
  });

  test("a line window keeps the newest lines up to its tail, and a replace is bounded the same way", () => {
    expect(
      inBrowser(`
        const win = logs.lineWindow(3);
        win.replace(["a", "b", "c", "d", "e"]);
        const replaced = win.lines().slice();
        win.push("f");
        const pushed = win.lines().slice();
        win.replace(["x"]);
        return { replaced, pushed, small: win.lines() };
      `),
    ).toEqual({ replaced: ["c", "d", "e"], pushed: ["d", "e", "f"], small: ["x"] });
  });
});

describe("box list state", () => {
  test("applyBoxFrame keeps a running box's usage, clears it for a stopped box, and keeps the list sorted by name", () => {
    expect(
      inBrowser(`
        const usage = { cpuPercent: 4, memUsage: 1, memLimit: 2, memPercent: 50 };
        const boxes = [
          { boxId: "b", name: "beta", running: true, stats: usage },
          { boxId: "a", name: "alpha", running: true, stats: usage },
        ];
        const shown = (list) => list.map((box) => [box.name, box.stats?.cpuPercent ?? null]);
        return {
          added: shown(boxState.applyBoxFrame(boxes, { op: "upsert", boxId: "c", containerId: "c1", box: { boxId: "c", name: "aardvark", running: true } })),
          kept: shown(boxState.applyBoxFrame(boxes, { op: "upsert", boxId: "b", containerId: "b1", box: { boxId: "b", name: "beta", running: true } })),
          stopped: shown(boxState.applyBoxFrame(boxes, { op: "upsert", boxId: "b", containerId: "b1", box: { boxId: "b", name: "beta", running: false } })),
          removed: shown(boxState.applyBoxFrame(boxes, { op: "remove", boxId: "a", containerId: "a1" })),
        };
      `),
    ).toEqual({
      added: [
        ["aardvark", null],
        ["alpha", 4],
        ["beta", 4],
      ],
      kept: [
        ["alpha", 4],
        ["beta", 4],
      ],
      stopped: [
        ["alpha", 4],
        ["beta", null],
      ],
      removed: [["beta", 4]],
    });
  });

  test("applySamples gives each listed box its usage and reports whether any box changed", () => {
    expect(
      inBrowser(`
        const boxes = [{ boxId: "a", name: "alpha", stats: null }];
        const none = boxState.applySamples(boxes, [{ boxId: "zzz", cpuPercent: 1, memUsage: 1, memLimit: 1, memPercent: 1 }]);
        const some = boxState.applySamples(boxes, [
          { boxId: "a", cpuPercent: 7, memUsage: 3, memLimit: 9, memPercent: 33 },
        ]);
        return { none, some, stats: boxes[0].stats };
      `),
    ).toEqual({ none: false, some: true, stats: { cpuPercent: 7, memUsage: 3, memLimit: 9, memPercent: 33 } });
  });

  test("powerState tells a running box, one asleep for idle, one past its TTL, and one stopped by a person apart", () => {
    expect(
      inBrowser(`
        const view = (fields) => ({ boxId: "b", name: "beta", running: false, sleeping: false, stopReason: "manual", ...fields });
        return {
          running: boxState.powerState(view({ running: true, stopReason: null })),
          idle: boxState.powerState(view({ sleeping: true, stopReason: "idle" })),
          ttl: boxState.powerState(view({ sleeping: true, stopReason: "ttl" })),
          manual: boxState.powerState(view({})),
          ttlPassed: boxState.powerState(view({ sleeping: true, stopReason: "ttl", createdAt: "2026-01-01T00:00:00Z", ttlSec: 60 })),
          ttlCleared: boxState.powerState(view({ sleeping: true, stopReason: "ttl", createdAt: "2026-01-01T00:00:00Z", ttlSec: null })),
          ttlExtended: boxState.powerState(
            view({ sleeping: true, stopReason: "ttl", createdAt: "2026-01-01T00:00:00Z", ttlSec: 7200 }),
            Date.parse("2026-01-01T01:00:00Z"),
          ),
        };
      `),
    ).toEqual({
      running: "running",
      idle: "sleeping",
      ttl: "expired",
      manual: "stopped",
      ttlPassed: "expired",
      ttlCleared: "sleeping",
      ttlExtended: "sleeping",
    });
  });

  test("boxesOfSync keeps the list while any host's cache is not current, then merges the hosts by name", () => {
    expect(
      inBrowser(`
        const box = (name) => ({ boxId: name, name });
        const waiting = boxState.boxesOfSync({
          hosts: [
            { hostId: "local", state: "live", boxes: [box("beta")] },
            { hostId: "remote", state: "down", boxes: [] },
          ],
        });
        const merged = boxState.boxesOfSync({
          hosts: [
            { hostId: "local", state: "live", boxes: [box("beta")] },
            { hostId: "remote", state: "live", boxes: [box("alpha")] },
          ],
        });
        return { waiting, merged: merged.map((item) => item.name) };
      `),
    ).toEqual({ waiting: null, merged: ["alpha", "beta"] });
  });
});
