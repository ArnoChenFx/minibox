import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { ROOT } from "../src/config";

const TERMINAL_PANEL = join(ROOT, "web", "js", "components", "terminal-panel.js");

/**
 * The browser the terminal tab touches, faked: a root that records its listeners, a WebSocket that records each
 * connection, a fetch that answers with `reply`, and a document that records the toasts it is asked for. Each scenario
 * runs in a fresh process, since the i18n module reads the language when it loads.
 */
const BROWSER = `
const realTimeout = globalThis.setTimeout;
const element = () => ({ append() {}, classList: { add() {}, remove() {}, toggle() {} }, remove() {}, content: {} });
const toasts = [];
globalThis.document = {
  documentElement: {},
  body: { append() {} },
  querySelector: (selector) => {
    if (selector === "#toasts") toasts.push(selector);
    return element();
  },
  createElement: () => element(),
};
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.navigator = { languages: ["en-US"], language: "en-US" };
globalThis.location = { hash: "", search: "", pathname: "/", origin: "http://localhost", host: "localhost", protocol: "http:" };
globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};
const sockets = [];
globalThis.WebSocket = class {
  constructor(url) {
    sockets.push(url);
  }
};
const requests = [];
let reply = () => new Response("{}", { status: 200 });
globalThis.fetch = async (path, init = {}) => {
  requests.push({ path, method: init.method ?? "GET", body: init.body ?? null });
  return reply(path, init);
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const settled = async (condition) => {
  for (let turn = 0; turn < 1000 && !condition(); turn += 1) await new Promise((resolve) => realTimeout(resolve, 0));
};
const subscribers = new Set();
const onChange = (fn) => {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
};
const view = (fields) => ({ id: "c1", boxId: "bx_1", name: "dev", running: false, sleeping: false, stopReason: "manual", ...fields });
const { mountTerminal } = await import(${JSON.stringify(TERMINAL_PANEL)});
`;

/** Runs `body` in a fresh process with the fakes above. The body returns its results, which come back as JSON. */
function inBrowser<T>(body: string): T {
  const script = `${BROWSER}\nconsole.log(JSON.stringify(await (async () => {\n${body}\n})()));`;
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000 });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout) as T;
}

describe("terminal tab for a box that is not running", () => {
  test("a sleeping box offers a wake action and opens no socket, and waking it starts a session and remounts the tab", () => {
    const results = inBrowser<{
      sleepingView: string;
      socketsWhileSleeping: number;
      wakingView: string;
      request: { path: string; method: string; body: string };
      rerenders: number;
      socketsAfterWake: number;
      listenersAfterDispose: number;
      subscribersAfterDispose: number;
    }>(`
      const root = {
        innerHTML: "",
        listeners: [],
        addEventListener(type, fn) { this.listeners.push([type, fn]); },
        removeEventListener(type, fn) { this.listeners = this.listeners.filter(([kind, handler]) => !(kind === type && handler === fn)); },
      };
      const box = () => current;
      let current = view({ sleeping: true, stopReason: "idle" });
      const click = (selector) => {
        for (const [kind, fn] of root.listeners) if (kind === "click") fn({ target: { closest: (sel) => (sel === selector ? {} : null) } });
      };
      const remounted = Promise.withResolvers();
      let rerenders = 0;
      const rerender = () => {
        rerenders += 1;
        remounted.resolve();
      };

      const dispose = mountTerminal(root, { box, onChange, rerender });
      const sleepingView = root.innerHTML;
      const socketsWhileSleeping = sockets.length;

      reply = () => json(200, { session: { name: "console", origin: "agent", controller: "agent", takenOver: false }, created: true, woke: true });
      click('[data-action="wake"]');
      const wakingView = root.innerHTML;
      await remounted.promise;
      dispose();

      return {
        sleepingView,
        socketsWhileSleeping,
        wakingView,
        request: requests.at(-1),
        rerenders,
        socketsAfterWake: sockets.length,
        listenersAfterDispose: root.listeners.length,
        subscribersAfterDispose: subscribers.size,
      };
    `);

    expect(results.socketsWhileSleeping).toBe(0);
    expect(results.sleepingView).toContain("The box is asleep");
    expect(results.sleepingView).toContain('data-action="wake"');
    expect(results.wakingView).toContain("Waking the box");
    expect(results.wakingView).toContain("disabled");
    expect(results.wakingView).not.toContain('data-action="wake"');
    expect(results.request).toEqual({ path: "/api/boxes/c1/sessions", method: "POST", body: '{"name":"console"}' });
    expect(results.rerenders).toBe(1);
    expect(results.socketsAfterWake).toBe(0);
    expect(results.listenersAfterDispose).toBe(0);
    expect(results.subscribersAfterDispose).toBe(0);
  });

  test("a wake that fails shows the box's current state again, says why, and does not remount", () => {
    const results = inBrowser<{ failedView: string; toasts: number; rerenders: number; sockets: number }>(`
      const root = {
        innerHTML: "",
        listeners: [],
        addEventListener(type, fn) { this.listeners.push([type, fn]); },
        removeEventListener() {},
      };
      let current = view({ sleeping: true, stopReason: "idle" });
      let rerenders = 0;
      const dispose = mountTerminal(root, { box: () => current, onChange, rerender: () => { rerenders += 1; } });
      current = view({ sleeping: true, stopReason: "ttl" });
      reply = () => json(409, { error: { code: "conflict", message: "x", key: "box_ttl_expired", hint: "x", hintKey: "box_ttl_expired_hint" } });
      for (const [kind, fn] of root.listeners) if (kind === "click") fn({ target: { closest: (sel) => (sel === '[data-action="wake"]' ? {} : null) } });
      await settled(() => toasts.length > 0);
      const failedView = root.innerHTML;
      dispose();
      return { failedView, toasts: toasts.length, rerenders, sockets: sockets.length };
    `);

    expect(results.failedView).toContain("The TTL has passed");
    expect(results.failedView).not.toContain('data-action="wake"');
    expect(results.toasts).toBeGreaterThan(0);
    expect(results.rerenders).toBe(0);
    expect(results.sockets).toBe(0);
  });

  test("an expired box says so and offers no start, and a box a person stopped offers start", () => {
    const results = inBrowser<{ expiredView: string; stoppedView: string; sockets: number }>(`
      const root = { innerHTML: "", addEventListener() {}, removeEventListener() {} };
      const show = (box) => {
        const dispose = mountTerminal(root, { box: () => box, onChange, rerender() {} });
        const html = root.innerHTML;
        dispose();
        return html;
      };
      return {
        expiredView: show(view({ sleeping: true, stopReason: "ttl" })),
        stoppedView: show(view({})),
        sockets: sockets.length,
      };
    `);

    expect(results.expiredView).toContain("The TTL has passed");
    expect(results.expiredView).not.toContain('data-action="wake"');
    expect(results.expiredView).not.toContain('data-action="start"');
    expect(results.stoppedView).toContain('data-action="start"');
    expect(results.stoppedView).not.toContain('data-action="wake"');
    expect(results.sockets).toBe(0);
  });

  test("a box frame that moves a sleeping box to its TTL replaces the sleeping view", () => {
    const results = inBrowser<{ before: string; after: string; sockets: number }>(`
      const root = { innerHTML: "", addEventListener() {}, removeEventListener() {} };
      let current = view({ sleeping: true, stopReason: "idle" });
      const dispose = mountTerminal(root, { box: () => current, onChange, rerender() {} });
      const before = root.innerHTML;
      current = view({ sleeping: true, stopReason: "ttl" });
      for (const fn of subscribers) fn();
      const after = root.innerHTML;
      dispose();
      return { before, after, sockets: sockets.length };
    `);

    expect(results.before).toContain('data-action="wake"');
    expect(results.after).toContain("The TTL has passed");
    expect(results.after).not.toContain('data-action="wake"');
    expect(results.sockets).toBe(0);
  });
});
