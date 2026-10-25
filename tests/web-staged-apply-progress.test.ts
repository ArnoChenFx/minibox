import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { ROOT } from "../src/config";

const STAGED_CHANGES = join(ROOT, "web", "js", "components", "staged-changes.js");

/**
 * The browser the staged-changes banner touches, faked: `innerHTML` keeps the markup it is given and finds the elements
 * in it, and `document.querySelectorAll` reaches every element the page drew, so the apply buttons a banner and a dialog
 * draw are the ones a click and a state change find. `fetch` records every request and answers by path, with the apply
 * held open until the scenario releases it. Timers only schedule, since the dialogs focus on one.
 */
const BROWSER = `
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = () => 0;
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

function parse(html) {
  const nodes = [];
  const tag = /<(\\/?)([a-zA-Z][\\w-]*)((?:\\s+[^<>]*?)?)(\\/?)>/g;
  const stack = [];
  let match;
  while ((match = tag.exec(html))) {
    const [whole, closing, name, raw, selfClosed] = match;
    if (closing) {
      stack.pop();
      continue;
    }
    const attributes = {};
    for (const [, key, quoted, single, bare] of raw.matchAll(/([\\w:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+)))?/g)) {
      attributes[key] = quoted ?? single ?? bare ?? "";
    }
    const classes = () => (attributes.class ?? "").split(/\\s+/).filter(Boolean);
    const setClasses = (names) => {
      attributes.class = [...new Set(names)].join(" ");
    };
    const node = {
      tagName: name.toUpperCase(),
      attributes,
      parent: stack.at(-1) ?? null,
      children: [],
      listeners: [],
      get dataset() {
        const out = {};
        for (const [key, value] of Object.entries(attributes)) {
          if (key.startsWith("data-")) out[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
        }
        return out;
      },
      classList: {
        add: (name) => setClasses([...classes(), name]),
        remove: (name) => setClasses(classes().filter((item) => item !== name)),
        contains: (name) => classes().includes(name),
        toggle(name, force) {
          const on = force === undefined ? !classes().includes(name) : Boolean(force);
          setClasses(on ? [...classes(), name] : classes().filter((item) => item !== name));
          return on;
        },
      },
      get hidden() {
        return attributes.hidden !== undefined;
      },
      set hidden(value) {
        if (value) attributes.hidden = "";
        else delete attributes.hidden;
      },
      get disabled() {
        return attributes.disabled !== undefined;
      },
      set disabled(value) {
        if (value) attributes.disabled = "";
        else delete attributes.disabled;
      },
      get innerHTML() {
        return "";
      },
      set innerHTML(html) {
        this.children = parse(html);
        for (const child of this.children) child.parent = this;
      },
      getAttribute: (key) => attributes[key] ?? null,
      setAttribute(key, value) {
        attributes[key] = String(value);
      },
      removeAttribute(key) {
        delete attributes[key];
      },
      addEventListener(type, fn) {
        this.listeners.push([type, fn]);
      },
      removeEventListener(type, fn) {
        this.listeners = this.listeners.filter(([kind, handler]) => !(kind === type && handler === fn));
      },
      append(child) {
        this.children.push(child);
        child.parent = this;
      },
      remove() {
        if (this.parent) this.parent.children = this.parent.children.filter((item) => item !== this);
      },
      focus() {},
      closest(selector) {
        let node = this;
        while (node) {
          if (node.matches(selector)) return node;
          node = node.parent;
        }
        return null;
      },
      matches(selector) {
        for (const part of selector.split(",").map((item) => item.trim())) {
          if (part.startsWith("#")) {
            if (attributes.id === part.slice(1)) return true;
            continue;
          }
          if (part.startsWith("[")) {
            const [key, quoted] = part.slice(1, -1).split("=");
            if (!(key in attributes)) continue;
            if (quoted === undefined || attributes[key] === quoted.replace(/^"|"$/g, "")) return true;
            continue;
          }
          if (part.startsWith(".")) {
            if (classes().includes(part.slice(1))) return true;
            continue;
          }
          if (this.tagName === part.toUpperCase()) return true;
        }
        return false;
      },
      descendants() {
        return this.children.flatMap((child) => [child, ...child.descendants()]);
      },
      querySelectorAll(selector) {
        return this.descendants().filter((node) => node.matches(selector));
      },
      querySelector(selector) {
        return this.querySelectorAll(selector)[0] ?? null;
      },
    };
    stack.at(-1)?.children.push(node);
    if (!stack.length) nodes.push(node);
    if (!selfClosed) stack.push(node);
  }
  return nodes;
}

/** Queries only connected nodes, as a real document does after a redraw or a dialog closes. */
const drawn = () => [document.body, ...document.body.descendants()];
const documentListeners = [];
const document = {
  documentElement: {},
  body: parse('<div class="body"></div>')[0],
  createElement(tag) {
    if (tag !== "template") return parse("<" + tag + "></" + tag + ">")[0];
    const holder = { content: { firstElementChild: null } };
    Object.defineProperty(holder, "innerHTML", {
      set(html) {
        holder.content.firstElementChild = parse(html.trim())[0] ?? null;
      },
    });
    return holder;
  },
  addEventListener(type, fn) {
    documentListeners.push([type, fn]);
  },
  removeEventListener(type, fn) {
    const at = documentListeners.findIndex(([kind, handler]) => kind === type && handler === fn);
    if (at >= 0) documentListeners.splice(at, 1);
  },
  dispatchEvent(event) {
    for (const [type, fn] of documentListeners) if (type === event.type) fn(event);
    return true;
  },
  querySelector: (selector) => drawn().find((node) => node.matches(selector)) ?? null,
  querySelectorAll: (selector) => drawn().filter((node) => node.matches(selector)),
};
Object.defineProperty(globalThis, "document", { configurable: true, value: document });
Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) } });
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {} } });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"], language: "en-US" } });
Object.defineProperty(globalThis, "location", { configurable: true, value: { hash: "", search: "", pathname: "/", origin: "http://localhost", href: "" } });

const requests = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const staged = {
  fields: { profile: "strict" },
  pending: ["profile"],
  changes: [{ field: "profile", from: "standard", to: "strict" }],
  problem: null,
  stagedAt: "2026-10-20T10:00:00.000Z",
};
const preview = { changes: staged.changes, diff: [], sessions: 0, systemCheckpoint: false, stagedAt: staged.stagedAt };
const APPLY = "/staged/apply";
const BOXES = { bx_1: { id: "bx_1", boxId: "bx_1", name: "dev", revision: 1 }, bx_2: { id: "bx_2", boxId: "bx_2", name: "ops", revision: 1 } };
/** What each box has staged, so each banner reads its own. */
const stagedOf = { bx_1: staged, bx_2: staged };
const boxIdOf = (path) => path.split("/")[3] ?? "";
let applyResult = { box: { id: "bx_1" }, safety: null };
let applyFailure = null;
// The apply waits on this promise, so a scenario can look at the page while the rebuild is in flight.
let release = () => {};
let gate = Promise.resolve();
const hold = () => {
  gate = new Promise((resolve) => {
    release = resolve;
  });
};
const finish = async () => {
  release();
  gate = Promise.resolve();
  await settle();
};
globalThis.fetch = async (path, init = {}) => {
  const method = init.method ?? "GET";
  const route = path.split("?")[0];
  requests.push({ path: route, method });
  if (method === "POST" && route.endsWith(APPLY)) {
    await gate;
    if (applyFailure) return json({ error: { code: applyFailure.code, message: applyFailure.message } }, applyFailure.status);
    return json(applyResult);
  }
  if (route.endsWith("/staged/preview")) return json({ preview });
  if (route.endsWith("/staged")) return json({ staged: stagedOf[boxIdOf(route)] ?? null });
  if (route.startsWith("/api/boxes/")) return json({ box: BOXES[boxIdOf(route)] });
  return json({});
};

const settle = async () => {
  for (let turn = 0; turn < 200; turn += 1) await new Promise((resolve) => realTimeout(resolve, 0));
};
/** Presses node where the click bubbles to listener. */
const press = (node, listener = node.parent) => {
  for (const [type, fn] of listener.listeners) if (type === "click") fn({ target: node, currentTarget: listener });
};
/** Mounts the banner of a box, which reads that box's staged changes and draws its own apply button. */
const mount = (boxId = "bx_1") => {
  const container = parse('<div id="bsStaged"></div>')[0];
  document.body.append(container);
  const box = () => BOXES[boxId];
  module.mountStagedBanner(container, { box });
  return container;
};
/** The apply button of one mounted banner. */
const applyIn = (container) => container.querySelectorAll('[data-staged="apply"]')[0] ?? null;
/** Presses the banner's apply button and confirms the dialog; the rebuild then waits on the gate. */
const confirmApply = async (container) => {
  hold();
  press(applyIn(container), container);
  await settle();
  for (const [, fn] of document.querySelector("#cfm-ok").listeners) fn();
  await settle();
};
const applyButtons = () => document.querySelectorAll('[data-staged="apply"]');
const applyRequests = () => requests.filter((request) => request.method === "POST" && request.path.endsWith(APPLY));
/** What an apply button shows: whether it is disabled, its busy class, and whether it draws a spinner. */
const state = (button) => ({
  disabled: button.disabled,
  busy: button.classList.contains("is-busy"),
  ariaBusy: button.getAttribute("aria-busy"),
  spinner: button.querySelectorAll(".spinner").length,
  icon: button.querySelectorAll(".icon").length,
});
`;

/** Runs `body` in a fresh process with the fakes above; the value it returns comes back as JSON. */
function inBrowser<T>(body: string): T {
  const script = [
    BROWSER,
    `const module = await import(${JSON.stringify(STAGED_CHANGES)});`,
    `const result = await (async () => {`,
    body,
    `})();`,
    `console.log(JSON.stringify(result));`,
  ].join("\n");
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 30_000 });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "null") as T;
}

type ButtonState = {
  disabled: boolean;
  busy: boolean;
  ariaBusy: string | null;
  spinner: number;
  icon: number;
};

const IDLE: ButtonState = { disabled: false, busy: false, ariaBusy: null, spinner: 0, icon: 1 };
const BUSY: ButtonState = { disabled: true, busy: true, ariaBusy: "true", spinner: 1, icon: 0 };

describe("applying staged changes", () => {
  test("a double click during a slow preview opens one confirmation, and cancelling permits a retry", () => {
    const run = inBrowser<{
      loading: ButtonState;
      previews: number;
      dialogs: number;
      cancelled: ButtonState;
      requests: number;
    }>(`
      const container = mount();
      await settle();
      const normalFetch = globalThis.fetch;
      let releasePreview;
      const previewGate = new Promise(resolve => releasePreview = resolve);
      let previews = 0;
      globalThis.fetch = async (path, init) => {
        if (path.endsWith("/staged/preview")) { previews += 1; await previewGate; }
        return normalFetch(path, init);
      };
      const button = applyIn(container);
      press(button, container);
      press(button, container);
      await settle();
      const loading = state(button);
      releasePreview();
      await settle();
      const dialogs = document.querySelectorAll(".overlay").length;
      const close = document.querySelector(".overlay").querySelector("[data-close]");
      press(close, close);
      await settle();
      const cancelled = state(applyIn(container));
      const firstPreviews = previews;
      await confirmApply(container);
      await finish();
      return { loading, previews: firstPreviews, dialogs, cancelled, requests: applyRequests().length };
    `);
    expect(run.loading).toEqual(BUSY);
    expect(run.previews).toBe(1);
    expect(run.dialogs).toBe(1);
    expect(run.cancelled).toEqual(IDLE);
    expect(run.requests).toBe(1);
  });

  test("a failed preview releases the box so it can be applied again", () => {
    const run = inBrowser<{ failed: ButtonState; pending: boolean; requests: number }>(`
      const container = mount();
      await settle();
      const normalFetch = globalThis.fetch;
      globalThis.fetch = (path, init) => path.endsWith("/staged/preview")
        ? Promise.resolve(json({ error: { code: "internal", message: "preview failed" } }, 500))
        : normalFetch(path, init);
      press(applyIn(container), container);
      await settle();
      const failed = state(applyIn(container));
      const pending = module.isApplying("bx_1");
      globalThis.fetch = normalFetch;
      await confirmApply(container);
      await finish();
      return {failed, pending, requests: applyRequests().length};
    `);
    expect(run.failed).toEqual(IDLE);
    expect(run.pending).toBe(false);
    expect(run.requests).toBe(1);
  });

  for (const status of [200, 412]) {
    test(`one box's apply finishing with ${status} leaves another box's apply busy`, () => {
      const run = inBrowser<{ otherBefore: ButtonState; otherAfter: ButtonState; pending: boolean; requests: number }>(`
        const normalFetch = globalThis.fetch;
        const releases = {};
        const gates = Object.fromEntries(["bx_1", "bx_2"].map(id => [id, new Promise(resolve => releases[id] = resolve)]));
        globalThis.fetch = async (path, init = {}) => {
          if (init.method === "POST" && path.endsWith(APPLY)) {
            const id = boxIdOf(path);
            requests.push({path, method: "POST"});
            await gates[id];
            if (id === "bx_1" && ${status} === 412) return json({error: {code: "precondition_failed", message: "changed"}}, 412);
            return json({box: {id}, safety: null});
          }
          return normalFetch(path, init);
        };
        const first = mount("bx_1");
        const second = mount("bx_2");
        await settle();
        await confirmApply(first);
        const otherBefore = state(applyIn(second));
        await confirmApply(second);
        releases.bx_1();
        await settle();
        const otherAfter = state(applyIn(second));
        const pending = module.isApplying("bx_2");
        const requestsSent = applyRequests().length;
        releases.bx_2();
        await settle();
        return {otherBefore, otherAfter, pending, requests: requestsSent};
      `);
      expect(run.otherBefore).toEqual(IDLE);
      expect(run.otherAfter).toEqual(BUSY);
      expect(run.pending).toBe(true);
      expect(run.requests).toBe(2);
    });
  }

  test("the banner's apply button shows progress while the rebuild runs, and a second press sends nothing", () => {
    const run = inBrowser<{
      before: ButtonState;
      applying: ButtonState;
      requestsWhileApplying: number;
      dialogsWhileApplying: number;
      hidden: boolean;
      pending: boolean;
      applyRequests: number;
      stagedReads: number;
    }>(`
      const container = mount();
      await settle();
      const before = state(applyButtons()[0]);

      await confirmApply(container);
      const applying = state(applyButtons()[0]);
      const requestsWhileApplying = applyRequests().length;
      const dialogsWhileApplying = document.querySelectorAll(".overlay").length;

      // A second press while the rebuild runs must not start another one.
      press(applyButtons()[0], container);
      await settle();

      await finish();
      return {
        before,
        applying,
        requestsWhileApplying,
        dialogsWhileApplying,
        hidden: container.hidden,
        pending: module.isApplying("bx_1"),
        applyRequests: applyRequests().length,
        stagedReads: requests.filter((request) => request.path.endsWith("/staged")).length,
      };
    `);

    expect(run.before).toEqual(IDLE);
    // The spinner replaces the refresh icon, so the button says it is working and cannot be pressed again.
    expect(run.applying).toEqual(BUSY);
    expect(run.requestsWhileApplying).toBe(1);
    // The second press opened no confirm dialog, so no second apply was prepared.
    expect(run.dialogsWhileApplying).toBe(0);
    expect(run.applyRequests).toBe(1);
    expect(run.hidden).toBe(true);
    expect(run.pending).toBe(false);
  });

  test("a failed apply brings the buttons back and reads the staged changes again", () => {
    const run = inBrowser<{
      applying: ButtonState;
      after: ButtonState;
      stagedReadsWhileApplying: number;
      stagedReadsAfter: number;
    }>(`
      const container = mount();
      await settle();
      applyFailure = { status: 412, code: "revision_conflict", message: "The box changed since the preview." };
      await confirmApply(container);
      const applying = state(applyButtons()[0]);
      const stagedReadsWhileApplying = requests.filter((request) => request.path.endsWith("/staged")).length;

      await finish();
      return {
        applying,
        after: state(applyButtons()[0]),
        stagedReadsWhileApplying,
        stagedReadsAfter: requests.filter((request) => request.path.endsWith("/staged")).length,
      };
    `);

    expect(run.applying).toEqual(BUSY);
    expect(run.after).toEqual(IDLE);
    // The banner reads the staged changes again, so a 412 shows them as they now stand.
    expect(run.stagedReadsAfter).toBeGreaterThan(run.stagedReadsWhileApplying);
  });

  test("the diff dialog's apply button is disabled and busy while an apply of the box is in flight", () => {
    const run = inBrowser<{ next: ButtonState; dialogs: number; sent: number }>(`
      const container = mount();
      await settle();
      await confirmApply(container);

      // The diff can still be opened while the rebuild runs; its own apply button must not start a second one.
      press(document.querySelector('[data-staged="diff"]'), container);
      await settle();
      const next = state(document.querySelector("[data-staged-next]"));

      // Pressing it starts nothing either.
      press(document.querySelector("[data-staged-next]"), document.querySelector("[data-staged-next]"));
      await settle();
      const sent = applyRequests().length;
      await finish();
      return { next, dialogs: document.querySelectorAll(".overlay").length, sent };
    `);

    expect(run.dialogs).toBe(1);
    expect(run.next).toEqual(BUSY);
    expect(run.sent).toBe(1);
  });

  test("a banner whose staged changes cannot be applied keeps its apply button disabled once another apply ends", () => {
    const run = inBrowser<{ blocked: ButtonState; other: ButtonState; afterFailure: ButtonState }>(`
      // A problem keeps the button of that box disabled, while another box's changes can still be applied.
      stagedOf.bx_1 = { ...staged, problem: "The volume is gone." };
      const first = mount("bx_1");
      const second = mount("bx_2");
      await settle();
      const blocked = state(applyIn(first));
      const other = state(applyIn(second));

      // An apply of the other box ends: the disabled button must stay disabled.
      await confirmApply(second);
      await finish();
      return { blocked, other, afterFailure: state(applyIn(first)) };
    `);

    expect(run.blocked).toMatchObject({ disabled: true, busy: false });
    expect(run.other).toEqual(IDLE);
    // Ending an apply leaves a button disabled by a problem disabled.
    expect(run.afterFailure).toMatchObject({ disabled: true, busy: false, ariaBusy: null, icon: 1 });
  });

  test("an apply that moves the box follows it to its new container and leaves no apply pending", () => {
    const run = inBrowser<{ hash: string; busy: boolean; stillApplying: boolean }>(`
      location.hash = "#/boxes/bx_1/settings/env";
      const container = mount();
      await settle();
      applyResult = { box: { id: "bx_2" }, safety: null };
      await confirmApply(container);
      const busy = state(applyButtons()[0]).busy;
      await finish();
      return { hash: location.hash, busy, stillApplying: module.isApplying("bx_1") };
    `);

    expect(run.busy).toBe(true);
    // The page is drawn again for the new container, so its buttons start idle there and nothing stays pending.
    expect(run.hash).toBe("#/boxes/bx_2/settings/env");
    expect(run.stillApplying).toBe(false);
  });
});
