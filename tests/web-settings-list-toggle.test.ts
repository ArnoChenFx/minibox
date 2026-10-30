import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { ROOT } from "../src/config";

const COMPONENTS = join(ROOT, "web", "js", "components");

/**
 * A settings page card in the browser the components touch, faked: `innerHTML` keeps the markup it is given and finds
 * the elements in it, so the toggles a draw binds are the ones a click reaches. `fetch` counts every request the page
 * makes, and the document is stubbed only for the pieces the modules read at import.
 */
const BROWSER = `
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
    for (const [, key, quoted, bare] of raw.matchAll(/([\\w:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+)))?/g)) {
      attributes[key] = quoted ?? bare ?? "";
    }
    const node = {
      tagName: name.toUpperCase(),
      attributes,
      parent: stack.at(-1) ?? null,
      children: [],
      listeners: [],
      focused: 0,
      get dataset() {
        const out = {};
        for (const [key, value] of Object.entries(attributes)) {
          if (key.startsWith("data-")) out[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
        }
        return out;
      },
      get hidden() {
        return Boolean(attributes.hidden);
      },
      set hidden(value) {
        attributes.hidden = value ? "" : undefined;
      },
      get innerHTML() {
        return "";
      },
      set innerHTML(html) {
        this.children = parse(html);
        for (const child of this.children) child.parent = this;
      },
      setAttribute(key, value) {
        attributes[key] = String(value);
      },
      addEventListener(type, fn) {
        this.listeners.push([type, fn]);
      },
      focus() {
        this.focused += 1;
      },
      closest(selector) {
        let node = this;
        while (node) {
          if (node.matches(selector)) return node;
          node = node.parent;
        }
        return null;
      },
      matches(selector) {
        for (const part of selector.split(",").map((s) => s.trim())) {
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
            if ((attributes.class ?? "").split(/\\s+/).includes(part.slice(1))) return true;
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

const card = (id) => parse('<div class="card" id="' + id + '"></div>')[0];

const stub = { documentElement: {}, body: {}, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };
Object.defineProperty(globalThis, "document", { configurable: true, value: stub });
Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) } });
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {} } });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"], language: "en-US" } });
Object.defineProperty(globalThis, "location", { configurable: true, value: { hash: "", search: "", pathname: "/", origin: "http://localhost", href: "" } });

const requests = [];
let answer = () => new Response("{}", { status: 200 });
globalThis.fetch = async (path, init = {}) => {
  requests.push({ path, method: init.method ?? "GET" });
  return answer(path);
};
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const byPath = (bodies) => (path) => json(bodies[path.split("?")[0]] ?? {});
const view = (node) => ({ querySelector: (selector) => (selector === "#" + node.attributes.id ? node : null) });
const press = (button) => {
  for (const [type, fn] of button.listeners) if (type === "click") fn({ currentTarget: button, target: button });
};
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
const toggles = (node) => node.querySelectorAll("[data-toggle]");
/** The body rows the card shows, over every table it draws. */
const rows = (node) => node.querySelectorAll("tbody").reduce((sum, body) => sum + body.querySelectorAll("tr").length, 0);
/** The buttons of the card that no click reaches: a redraw connects every button it draws. */
const unbound = (node) => node.querySelectorAll("button").filter((button) => button.listeners.length === 0).length;
`;

/** Runs `body` in a fresh process with the fake card above; the returned value comes back as JSON. */
function inBrowser<T>(body: string): T {
  const script = [
    BROWSER,
    `const result = await (async () => {`,
    body,
    `})();`,
    `console.log(JSON.stringify(result));`,
  ].join("\n");
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 30_000 });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "null") as T;
}

/** What one page did: the rows drawn at each step, and the requests each press made. */
type PageRun = {
  toggles: number;
  rowsBefore: number;
  rowsExpanded: number;
  rowsCollapsed: number;
  requestsWhileLoading: number;
  requestsOnExpand: number;
  requestsOnCollapse: number;
  focusAfterExpand: number;
  aria: string[];
  othersAfterExpand: string[];
  unboundBefore: number;
  unboundAfterExpand: number;
};

/** Loads `component`'s `loader` against `bodies` and presses its first list toggle twice. */
function pageRun(component: string, loader: string, cardId: string, bodies: Record<string, unknown>): PageRun {
  return inBrowser<PageRun>(`
    const module = await import(${JSON.stringify(join(COMPONENTS, component))});
    const node = card(${JSON.stringify(cardId)});
    answer = byPath(${JSON.stringify(bodies)});
    await module[${JSON.stringify(loader)}](view(node));
    const run = {
      toggles: toggles(node).length,
      rowsBefore: rows(node),
      rowsExpanded: 0,
      rowsCollapsed: 0,
      requestsWhileLoading: requests.length,
      requestsOnExpand: 0,
      requestsOnCollapse: 0,
      focusAfterExpand: 0,
      aria: toggles(node).slice(0, 1).map((button) => button.attributes["aria-expanded"]),
      othersAfterExpand: [],
      unboundBefore: unbound(node),
      unboundAfterExpand: 0,
    };
    // The loader may read on after it returns, as the hosts card does for each host's engine storage. Those reads are
    // part of loading the page, not of expanding a list.
    for (let turn = 0; turn < 200; turn += 1) await settle();
    run.requestsWhileLoading = requests.length;
    // A list that is not long draws no toggle, so there is nothing to press.
    if (run.toggles === 0) return run;
    let mark = requests.length;
    press(toggles(node)[0]);
    await settle();
    run.rowsExpanded = rows(node);
    run.requestsOnExpand = requests.length - mark;
    run.aria.push(toggles(node)[0].attributes["aria-expanded"]);
    // A card with two lists keeps the second as it was: only the list under the pressed toggle moves.
    run.othersAfterExpand = toggles(node)
      .slice(1)
      .map((button) => button.attributes["aria-expanded"]);
    run.focusAfterExpand = toggles(node)[0].focused;
    run.unboundAfterExpand = unbound(node);
    mark = requests.length;
    press(toggles(node)[0]);
    await settle();
    run.rowsCollapsed = rows(node);
    run.requestsOnCollapse = requests.length - mark;
    run.aria.push(toggles(node)[0].attributes["aria-expanded"]);
    return run;
  `);
}

const at = new Date(Date.UTC(2026, 9, 20, 10, 0)).toISOString();
const many = (count: number, make: (index: number) => Record<string, unknown>) =>
  Array.from({ length: count }, (_, index) => make(index));

const catalog = {
  groups: [{ id: "box", label: "label.box", scopes: ["box:read"] }],
  presets: [{ name: "readonly", label: "st.preset.readonly", boxes: "created", hosts: "local", scopes: ["box:read"] }],
};
const tokenList = many(7, (index) => ({
  id: `tk_${index}`,
  name: `token ${index}`,
  prefix: `mb_${index}`,
  scopes: ["box:read"],
  preset: "readonly",
  volumes: { type: "none", ids: [] },
  boxes: "created-by-me",
  hosts: "local",
  createdAt: at,
  expiresAt: null,
  lastUsedAt: null,
  lastUsedIp: null,
  revokedAt: null,
}));
const hostList = many(7, (index) => ({
  id: `host_${index}`,
  name: `host ${index}`,
  transport: "tcp",
  endpoint: `tcp://10.0.0.${index}:2376`,
  status: "online",
  boxes: index,
  latencyMs: index,
  capacity: null,
  error: null,
  agent: null,
}));
const secretList = many(7, (index) => ({ name: `secret_${index}`, updatedAt: at, boxes: [] }));
const sessionList = many(7, (index) => ({
  id: `se_${index}`,
  userAgent: `agent ${index}`,
  current: index === 0,
  createdAt: at,
  lastSeenAt: at,
}));
const keyList = many(7, (index) => ({
  id: `sk_${index}`,
  label: `key ${index}`,
  algorithm: "ssh-ed25519",
  fingerprint: `SHA256:fp${index}`,
  createdAt: at,
  lastUsedAt: null,
}));
const channelList = many(7, (index) => ({
  id: `ch_${index}`,
  name: `channel ${index}`,
  type: "webhook",
  url: `https://example.com/${index}`,
  events: ["box.oom"],
  boxes: [],
  enabled: true,
  hasSecret: true,
}));
const deliveryList = many(7, (index) => ({
  id: `dl_${index}`,
  ts: Date.parse(at) + index,
  channel: `ch_${index}`,
  notice: "box.oom",
  title: `title ${index}`,
  status: "ok",
  attempts: 1,
  error: null,
}));

/**
 * Each page: the loader that asks for the data, the card it fills, the replies its endpoints give, how many toggles it
 * draws, and the rows it shows collapsed, expanded and collapsed again.
 */
const PAGES = [
  {
    name: "Agent API tokens",
    component: "settings-tokens.js",
    loader: "loadTokens",
    card: "stTokens",
    bodies: { "/api/tokens": { tokens: tokenList }, "/api/tokens/presets": catalog },
    toggles: 1,
    collapsed: 5,
    expanded: 7,
  },
  {
    // The hosts card draws one detail row per host under its own row, for the engine's storage reading, so a list of
    // five hosts is ten rows and a list of seven is fourteen.
    name: "hosts",
    component: "settings-hosts.js",
    loader: "loadHosts",
    card: "stHosts",
    bodies: { "/api/hosts": { hosts: hostList } },
    toggles: 1,
    collapsed: 10,
    expanded: 14,
  },
  {
    name: "secrets",
    component: "settings-secrets.js",
    loader: "loadSecrets",
    card: "stSecrets",
    bodies: { "/api/secrets": { secrets: secretList } },
    toggles: 1,
    collapsed: 5,
    expanded: 7,
  },
  {
    name: "sessions",
    component: "settings-sessions.js",
    loader: "loadSessions",
    card: "stSessions",
    bodies: { "/api/auth/sessions": { sessions: sessionList } },
    toggles: 1,
    collapsed: 5,
    expanded: 7,
  },
  {
    name: "SSH keys",
    component: "settings-ssh-keys.js",
    loader: "loadSshKeys",
    card: "stSshKeys",
    bodies: { "/api/ssh-keys": { keys: keyList } },
    toggles: 1,
    collapsed: 5,
    expanded: 7,
  },
  {
    // Two long lists on one card: the first toggle expands the channels and leaves the deliveries as they were.
    name: "notifications",
    component: "settings-notify.js",
    loader: "loadNotify",
    card: "stNotify",
    bodies: {
      "/api/notify/channels": { channels: channelList },
      "/api/notify/deliveries": { deliveries: deliveryList },
    },
    toggles: 2,
    collapsed: 10,
    expanded: 12,
    others: ["false"],
  },
];

describe("a settings list expands and collapses without asking the API again", () => {
  for (const page of PAGES) {
    test(`${page.name}: the toggle redraws the card from the data it already has`, () => {
      const run = pageRun(page.component, page.loader, page.card, page.bodies);
      // Lists reuse their metadata. Newly revealed hosts read their disk once; collapsing reuses those readings too.
      expect(run.requestsWhileLoading).toBeGreaterThan(0);
      expect(run.requestsOnExpand).toBe(page.name === "hosts" ? 2 : 0);
      expect(run.requestsOnCollapse).toBe(0);
      // A long list shows its limit first, every item when expanded, and the limit again when collapsed.
      expect(run.toggles).toBe(page.toggles);
      expect([run.rowsBefore, run.rowsExpanded, run.rowsCollapsed]).toEqual([
        page.collapsed,
        page.expanded,
        page.collapsed,
      ]);
      // The toggle flips its own state and keeps the focus, so a keyboard user does not lose their place.
      expect(run.aria).toEqual(["false", "true", "false"]);
      expect(run.othersAfterExpand).toEqual(page.others ?? []);
      expect(run.focusAfterExpand).toBe(1);
      // The redrawn card connects every button it draws again, so a row action still works after an expand.
      expect([run.unboundBefore, run.unboundAfterExpand]).toEqual([0, 0]);
    });
  }

  test("a list of five or fewer has no toggle, and loading it is the only request", () => {
    const run = pageRun("settings-sessions.js", "loadSessions", "stSessions", {
      "/api/auth/sessions": { sessions: sessionList.slice(0, 2) },
    });
    expect(run.toggles).toBe(0);
    expect(run.rowsBefore).toBe(2);
    expect(run.requestsWhileLoading).toBe(1);
  });

  test("a full load is still what a create or delete asks for, so the list refreshes from the server", () => {
    const result = inBrowser<{ before: number; afterCreate: number; reloaded: number }>(`
      const module = await import(${JSON.stringify(join(COMPONENTS, "settings-ssh-keys.js"))});
      const node = card("stSshKeys");
      answer = byPath({ "/api/ssh-keys": { keys: ${JSON.stringify(keyList)} } });
      await module.loadSshKeys(view(node));
      const before = requests.length;
      // The card's own loader is exported and still reaches the API, which the create and delete paths call.
      await module.loadSshKeys(view(node));
      return { before, afterCreate: requests.length, reloaded: rows(node) };
    `);
    expect(result.before).toBe(1);
    expect(result.afterCreate).toBe(2);
    expect(result.reloaded).toBe(5);
  });
});

describe("a failed load keeps its handling", () => {
  test("a 401 sends the user to the login page and a failed load shows the error card", () => {
    const result = inBrowser<{ redirected: string; errorCards: number; rows: number }>(`
      const sessions = await import(${JSON.stringify(join(COMPONENTS, "settings-sessions.js"))});
      const tokens = await import(${JSON.stringify(join(COMPONENTS, "settings-tokens.js"))});

      answer = () => new Response(JSON.stringify({ error: { code: "unauthorized", message: "expired" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
      const first = card("stSessions");
      await sessions.loadSessions(view(first));

      answer = () => new Response(JSON.stringify({ error: { code: "internal", message: "boom" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
      const second = card("stTokens");
      await tokens.loadTokens(view(second));
      return {
        redirected: location.href,
        errorCards: second.querySelectorAll(".callout").length,
        rows: rows(second),
      };
    `);
    // api() redirects on a 401 itself; the components keep the same branch for a 401 they do see.
    expect(result.redirected).toBe("/login");
    // A failed load draws the error card instead of a table, and offers no toggle to expand.
    expect(result.errorCards).toBe(1);
    expect(result.rows).toBe(0);
  });
});

describe("the backup schedule card", () => {
  /** The requests the card made, and whether each button it drew is connected. */
  type CardRun = {
    requests: { path: string; method: string }[];
    offButtons: string[];
    onButtons: string[];
    unbound: number;
    errorCards: number;
  };

  const run = inBrowser<CardRun>(`
    const module = await import(${JSON.stringify(join(COMPONENTS, "settings-backups.js"))});

    const empty = card("stBackups");
    answer = byPath({ "/api/backups/schedule": { schedule: null } });
    await module.loadBackups(view(empty));
    const off = {
      requests: requests.map((request) => ({ path: request.path, method: request.method })),
      offButtons: empty.querySelectorAll("[data-action]").map((node) => node.attributes["data-action"]),
      onButtons: [],
      unbound: unbound(empty),
      errorCards: empty.querySelectorAll(".callout.danger").length,
    };

    const set = card("stBackups");
    answer = byPath({
      "/api/backups/schedule": {
        schedule: {
          mode: "interval",
          everyHours: 6,
          at: null,
          timezone: null,
          timezoneUnknown: false,
          nextRunAt: "2026-10-20T11:00:00.000Z",
          lastRun: { at: "2026-10-20T10:00:00.000Z", status: "ok", backupId: "bk_sample", bytes: 4096, error: null },
        },
      },
    });
    await module.loadBackups(view(set));
    return {
      requests: off.requests,
      offButtons: off.offButtons,
      onButtons: set.querySelectorAll("[data-action]").map((node) => node.attributes["data-action"]),
      unbound: off.unbound + unbound(set),
      errorCards: off.errorCards,
    };
  `);

  test("loading the card reads the schedule once and offers the button that sets one", () => {
    expect(run.requests).toEqual([{ path: "/api/backups/schedule", method: "GET" }]);
    expect(run.offButtons).toEqual(["st-backup-schedule"]);
    expect(run.errorCards).toBe(0);
    // Every button the card drew is connected to a click.
    expect(run.unbound).toBe(0);
  });

  test("a set schedule draws the change and turn-off buttons, not the set button alone", () => {
    expect(run.onButtons.toSorted()).toEqual(["st-backup-schedule", "st-backup-schedule-off"]);
  });
});
