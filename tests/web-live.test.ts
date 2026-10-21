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
        };
      `),
    ).toEqual({ running: "running", idle: "sleeping", ttl: "expired", manual: "stopped" });
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
