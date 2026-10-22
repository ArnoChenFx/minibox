import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "../src/config";
import { checkpointOperations } from "../src/operations/checkpoints";
import en from "../web/js/i18n/en.js";
import zh from "../web/js/i18n/zh-CN.js";
import {
  type CheckpointRow,
  contentsOf,
  HOLD_MODES,
  KINDS,
  kindsOf,
  newestFirst,
  REASON_KEYS,
  rowActions,
  usedPercent,
} from "../web/js/lib/checkpoint-state.js";

const WEB = join(ROOT, "web");
const COMPONENT = join(WEB, "js", "components", "checkpoints.js");
const STATE = join(WEB, "js", "lib", "checkpoint-state.js");

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 20, 10, minutes)).toISOString();

const escaped = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

function row(overrides: Partial<CheckpointRow> = {}): CheckpointRow {
  return {
    legacy: false,
    auto: false,
    pinned: false,
    createdAt: at(0),
    system: null,
    data: [{ role: "workspace", ownership: "owned" }],
    ...overrides,
  };
}

describe("checkpoint rules", () => {
  test("an ordinary checkpoint with owned data allows every action", () => {
    const actions = Object.values(rowActions(row()));
    expect(actions.map((action) => action.allowed)).toEqual([true, true, true, true]);
  });

  test("a legacy snapshot is read-only: it can be forked or deleted, and nothing else", () => {
    const actions = rowActions(row({ legacy: true, data: [] }));
    expect(actions.fork.allowed).toBe(true);
    expect(actions.delete.allowed).toBe(true);
    expect(actions.rollback).toEqual({ allowed: false, reason: "ck.reasonLegacy" });
    expect(actions.pin).toEqual({ allowed: false, reason: "ck.reasonLegacy" });
  });

  test("a checkpoint with no owned volume data cannot be rolled back", () => {
    const actions = rowActions(row({ data: [{ role: "cache", ownership: "independent" }] }));
    expect(actions.rollback).toEqual({ allowed: false, reason: "ck.reasonNoData" });
    expect(actions.fork.allowed).toBe(true);
  });

  test("while a rollback waits for its confirm or undo, no checkpoint of the box can be rolled back", () => {
    expect(rowActions(row(), { pending: true }).rollback).toEqual({ allowed: false, reason: "ck.reasonPending" });
  });

  test("the safety checkpoint of a waiting rollback cannot be deleted", () => {
    expect(rowActions(row(), { held: true, pending: true }).delete).toEqual({
      allowed: false,
      reason: "ck.reasonHeld",
    });
  });

  test("a pinned checkpoint cannot be deleted until it is unpinned, and can still be unpinned", () => {
    const actions = rowActions(row({ pinned: true }));
    expect(actions.delete).toEqual({ allowed: false, reason: "ck.reasonPinned" });
    expect(actions.pin.allowed).toBe(true);
  });

  test("every refusal names a reason the console translates", () => {
    const checkpoints = [row(), row({ pinned: true }), row({ legacy: true, data: [] }), row({ data: [] })];
    const states = [{}, { pending: true }, { held: true }, { held: true, pending: true }];
    const reasons = checkpoints
      .flatMap((checkpoint) => states.map((state) => rowActions(checkpoint, state)))
      .flatMap((actions) => Object.values(actions))
      .filter((rule) => !rule.allowed)
      .map((rule) => rule.reason);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.filter((reason) => !(REASON_KEYS as readonly string[]).includes(reason))).toEqual([]);
  });

  test("kinds say how a checkpoint was taken and whether it is pinned", () => {
    expect(kindsOf(row())).toEqual(["manual"]);
    expect(kindsOf(row({ auto: true, pinned: true }))).toEqual(["automatic", "pinned"]);
    expect(kindsOf(row({ legacy: true, data: [] }))).toEqual(["legacy"]);
  });

  test("contents name the workspace and home, count the other volumes, and flag a system layer", () => {
    const checkpoint = row({
      data: [
        { role: "home", ownership: "owned" },
        { role: "workspace", ownership: "owned" },
        { role: "cache", ownership: "owned" },
      ],
      system: { image: "minibox-checkpoint:ck_1" },
    });
    expect(contentsOf(checkpoint)).toEqual({ roles: ["home", "workspace"], others: 1, system: true });
  });

  test("newest first sorts a copy by the time each checkpoint was taken", () => {
    const items = [
      { id: "a", createdAt: at(1) },
      { id: "b", createdAt: at(3) },
      { id: "c", createdAt: at(2) },
    ];
    expect(newestFirst(items).map((item) => item.id)).toEqual(["b", "c", "a"]);
    expect(items.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  test("the used share is rounded, and there is none without a limit", () => {
    expect(usedPercent({ bytes: 2, limitBytes: 3 })).toBe(67);
    expect(usedPercent({ bytes: 5, limitBytes: null })).toBeNull();
    expect(usedPercent({ bytes: 5, limitBytes: 0 })).toBeNull();
  });
});

type Markup = Record<string, string>;

function browserGlobals(language: string): string[] {
  return [
    `const stub = { documentElement: {}, body: {}, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}), addEventListener() {}, removeEventListener() {} };`,
    `Object.defineProperty(globalThis, "document", { configurable: true, value: stub });`,
    `Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) } });`,
    `Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {} } });`,
    `Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: [${JSON.stringify(language)}], language: ${JSON.stringify(language)} } });`,
    `Object.defineProperty(globalThis, "location", { configurable: true, value: { hash: "", search: "", pathname: "/", origin: "http://localhost" } });`,
  ];
}

/**
 * Runs `body` in a fresh process where the console modules load with the browser globals they read at import. `body`
 * sees `component`, `state` and `fixtures`, and returns the value that comes back as JSON.
 */
function runConsole<T>(language: string, fixtures: unknown, body: string): T {
  const script = [
    ...browserGlobals(language),
    `const component = await import(${JSON.stringify(COMPONENT)});`,
    `const state = await import(${JSON.stringify(STATE)});`,
    `const fixtures = ${JSON.stringify(fixtures)};`,
    `const result = await (async () => {`,
    body,
    `})();`,
    `console.log(JSON.stringify(result));`,
  ].join("\n");
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000 });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "null") as T;
}

function checkpoint(overrides: Record<string, unknown>) {
  const workspace = {
    volumeId: "vol_w",
    name: "alpha-workspace",
    path: "/workspace",
    mode: "rw",
    role: "workspace",
    ownership: "owned",
    owner: "bx_alpha",
    snapshotId: "snap_w",
    bytes: 2048,
  };
  const home = {
    ...workspace,
    volumeId: "vol_h",
    name: "alpha-home",
    path: "/home/dev",
    role: "home",
    snapshotId: "snap_h",
    bytes: 512,
  };
  const cache = {
    ...workspace,
    volumeId: "vol_c",
    name: "shared-cache",
    path: "/cache",
    mode: "ro",
    role: "cache",
    ownership: "independent",
    owner: null,
    snapshotId: "snap_c",
    bytes: 0,
  };
  return {
    id: "ck_manual",
    legacy: false,
    hostId: "host_1",
    boxId: "bx_alpha",
    boxName: "alpha",
    label: "before <b>upgrade</b>",
    reason: "",
    createdBy: "owner",
    pinned: false,
    auto: false,
    consistency: "live",
    specRevision: 4,
    spec: {
      template: { ref: "base", image: "minibox-template:base", digest: null },
      cpus: 2,
      memoryBytes: null,
      profile: null,
    },
    data: [workspace, home, cache],
    system: null,
    bytes: 2560,
    createdAt: at(0),
    updatedAt: at(0),
    ...overrides,
  };
}

const BOX = { boxId: "bx_alpha", name: "alpha" };
const usage = (bytes: number, limitBytes: number | null, state: string, keepDays = 0) => ({
  bytes,
  limitBytes,
  state,
  policy: { keepLast: 5, keepDays },
});

const manual = checkpoint({});
const legacy = checkpoint({
  id: "img_1",
  legacy: true,
  label: "old snap",
  data: [],
  system: { image: "snap:1", imageId: "sha256:1" },
  bytes: 0,
  consistency: "pause",
  specRevision: null,
});
const pinnedManual = checkpoint({ id: "ck_pin", pinned: true, label: "keep this" });
const safety = checkpoint({
  id: "ck_safe",
  label: "Before rollback to ck_old",
  auto: true,
  pinned: true,
  reason: "Taken automatically before a rollback to ck_old",
});
const newer = checkpoint({ id: "ck_new", label: "newer", createdAt: at(9) });
const older = checkpoint({ id: "ck_old", label: "older", createdAt: at(1) });
const other = checkpoint({ id: "ck_other", boxId: "bx_beta", boxName: "beta", label: "beta only", createdAt: at(4) });

const pendingRollback = {
  boxId: "bx_alpha",
  checkpoint: { id: "ck_old", label: "older" },
  safetyCheckpointId: "ck_safe",
  createdBy: "owner",
  createdAt: at(5),
  replaced: [{ id: "vol_old", name: "alpha-workspace-old", path: "/workspace" }],
  restored: [{ id: "vol_w", name: "alpha-workspace", path: "/workspace" }],
};

const fixtures = {
  box: BOX,
  manual,
  legacy,
  pinnedManual,
  safety,
  pendingRollback,
  rollbackPreview: {
    checkpoint: { id: "ck_old", label: "before upgrade", createdAt: at(0) },
    restores: [
      { path: "/workspace", role: "workspace", volume: "alpha-workspace-restored" },
      { path: "/data", role: null, volume: "<img src=x onerror=alert(1)>" },
    ],
    keeps: ["id", "name", "history", "shared volumes"],
    loses: ["writableLayer", "processes", "ip"],
    diff: [
      { path: "/etc/hosts", kind: "C" },
      { path: "/tmp/cache", kind: "A" },
    ],
    revision: { current: 3, next: 4 },
  },
  confirmPreview: {
    action: "confirm_rollback",
    box: "alpha",
    safetyCheckpointId: "ck_safe",
    delete: [{ id: "vol_old", name: "alpha-workspace-old", path: "/workspace", bytes: 2048 }],
  },
  undoPreview: {
    action: "undo_rollback",
    box: "alpha",
    remount: [{ path: "/workspace", volume: "alpha-workspace-old" }],
    delete: [{ id: "vol_w", name: "alpha-workspace-restored", path: "/workspace", bytes: null }],
    revision: { current: 4, next: 5 },
  },
  exceeded: usage(2000, 2000, "exceeded", 7),
  warning: usage(1800, 2000, "warning"),
  unlimited: usage(1024, null, "unlimited"),
};

const markup = runConsole<Markup>(
  "en",
  fixtures,
  `return {
    manual: component.checkpointRowHtml(fixtures.manual, {}),
    legacy: component.checkpointRowHtml(fixtures.legacy, {}),
    pinned: component.checkpointRowHtml(fixtures.pinnedManual, {}),
    held: component.checkpointRowHtml(fixtures.safety, { held: true, pending: true }),
    empty: component.checkpointCardHtml({ rows: [], pending: null, usage: null }),
    card: component.checkpointCardHtml({ rows: [fixtures.manual, fixtures.safety], pending: fixtures.pendingRollback, usage: fixtures.exceeded }),
    rollbackPreview: component.rollbackPreviewHtml(fixtures.rollbackPreview),
    confirmPreview: component.confirmRollbackHtml(fixtures.confirmPreview),
    undoPreview: component.undoRollbackHtml(fixtures.undoPreview),
    exceeded: component.usageHtml(fixtures.exceeded),
    warning: component.usageHtml(fixtures.warning),
    unlimited: component.usageHtml(fixtures.unlimited),
    pending: component.pendingHtml(fixtures.pendingRollback),
    take: component.takeFormHtml(fixtures.box),
  };`,
);

/** The opening tags of the buttons that carry `action`. */
function buttonTags(html: string, action: string): string[] {
  return [...html.matchAll(/<button\b[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => tag.includes(`data-action="${action}"`));
}

const isDisabled = (tag: string) => /\sdisabled[\s>]/.test(tag);
const titleOf = (tag: string) => tag.match(/title="([^"]*)"/)?.[1];
const buttonFor = (html: string, action: string, id: string) =>
  buttonTags(html, action).find((tag) => tag.includes(`data-id="${id}"`)) ?? "";

describe("checkpoint rows", () => {
  test("an ordinary checkpoint offers every action, names its contents and size, and escapes its label", () => {
    const html = markup.manual ?? "";
    expect(buttonTags(html, "ck-rollback").map(isDisabled)).toEqual([false]);
    expect(buttonTags(html, "ck-delete").map(isDisabled)).toEqual([false]);
    expect(html).toContain('badge-accent">Manual</span>');
    expect(html).toContain("Workspace · Home · Other volumes: 1");
    expect(html).toContain("2.5 KB");
    expect(html).toContain("before &lt;b&gt;upgrade&lt;/b&gt;");
    expect(html).not.toContain("<b>upgrade</b>");
  });

  test("a legacy snapshot is read-only: rollback and pin are off with the reason, and fork and delete stay on", () => {
    const html = markup.legacy ?? "";
    expect(titleOf(buttonFor(html, "ck-rollback", "img_1"))).toBe(escaped(en["ck.reasonLegacy"] ?? ""));
    expect(isDisabled(buttonFor(html, "ck-rollback", "img_1"))).toBe(true);
    expect(isDisabled(buttonFor(html, "ck-pin", "img_1"))).toBe(true);
    expect(isDisabled(buttonFor(html, "ck-fork", "img_1"))).toBe(false);
    expect(isDisabled(buttonFor(html, "ck-delete", "img_1"))).toBe(false);
    expect(html).toContain('badge-warning">Legacy snapshot</span>');
  });

  test("a pinned checkpoint cannot be deleted until it is unpinned, and offers the unpin action", () => {
    const html = markup.pinned ?? "";
    expect(isDisabled(buttonFor(html, "ck-delete", "ck_pin"))).toBe(true);
    expect(titleOf(buttonFor(html, "ck-delete", "ck_pin"))).toBe(escaped(en["ck.reasonPinned"] ?? ""));
    expect(html).toContain(">Unpin</button>");
  });

  test("the safety checkpoint of a waiting rollback can be neither deleted nor rolled back again, and shows its reason", () => {
    const html = markup.held ?? "";
    expect(titleOf(buttonFor(html, "ck-delete", "ck_safe"))).toBe(escaped(en["ck.reasonHeld"] ?? ""));
    expect(titleOf(buttonFor(html, "ck-rollback", "ck_safe"))).toBe(escaped(en["ck.reasonPending"] ?? ""));
    expect(html).toContain(">Automatic</span>");
    expect(html).toContain("Taken automatically before a rollback to ck_old");
  });
});

describe("checkpoint card", () => {
  test("with no checkpoints it says so and still offers taking one", () => {
    expect(markup.empty).toContain(escaped(en["ck.empty"] ?? ""));
    expect(markup.empty).toContain('data-action="ck-take"');
    expect(markup.empty).not.toContain("<table");
  });

  test("a waiting rollback locks rollback on every row, holds the safety checkpoint, and offers confirm and undo", () => {
    const html = markup.card ?? "";
    const rollbacks = buttonTags(html, "ck-rollback");
    expect(rollbacks.length).toBe(2);
    expect(rollbacks.every(isDisabled)).toBe(true);
    expect(titleOf(buttonFor(html, "ck-delete", "ck_safe"))).toBe(escaped(en["ck.reasonHeld"] ?? ""));
    expect(html).toContain('data-action="ck-confirm"');
    expect(html).toContain('data-action="ck-undo"');
    expect(html).toContain("The repository is full");
  });
});

describe("rollback previews", () => {
  test("the rollback preview names what is replaced and kept, what is lost, and the revision change", () => {
    const html = markup.rollbackPreview ?? "";
    expect(html).toContain("alpha-workspace-restored");
    expect(html).toContain("Stable id, Name, Revision history, Shared volumes");
    for (const lost of [
      "Writable layer",
      "Running processes and tmux",
      "Container IP",
      "Changed files in the container: 2",
    ]) {
      expect(html).toContain(lost);
    }
    expect(html).toContain("3 → 4");
    expect(html).toContain('class="callout info"');
  });

  test("names in a preview are escaped", () => {
    const html = markup.rollbackPreview ?? "";
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x");
  });

  test("the confirm preview lists the volumes it deletes and the safety checkpoint that keeps their data", () => {
    const html = markup.confirmPreview ?? "";
    expect(html).toContain("alpha-workspace-old");
    expect(html).toContain("2.0 KB");
    expect(html).toContain("ck_safe");
    expect(html).toContain(escaped(en["ck.willDelete"] ?? ""));
  });

  test("the undo preview lists the volumes it mounts again and deletes, and says later writes are lost", () => {
    const html = markup.undoPreview ?? "";
    expect(html).toContain("alpha-workspace-old");
    expect(html).toContain("alpha-workspace-restored");
    expect(html).toContain("4 → 5");
    expect(html).toContain("—");
    expect(html).toContain(escaped(en["ck.undoLoses"] ?? ""));
  });

  test("a waiting rollback is described with the volumes it replaced", () => {
    const html = markup.pending ?? "";
    expect(html).toContain(escaped(en["ck.pendingTitle"] ?? ""));
    expect(html).toContain("alpha-workspace-old");
    expect(html).toContain('data-action="ck-confirm"');
    expect(html).toContain('data-action="ck-undo"');
  });
});

describe("repository usage and the take form", () => {
  test("a repository past its limit says it is full, and shows the policy it keeps", () => {
    const html = markup.exceeded ?? "";
    expect(html).toContain('class="callout danger"');
    expect(html).toContain("The repository is full");
    expect(html).toContain("(100%)");
    expect(html).toContain("older than 7 days");
  });

  test("a repository near its limit warns with the share in use", () => {
    const html = markup.warning ?? "";
    expect(html).toContain('class="callout warn"');
    expect(html).toContain("90%");
  });

  test("without a limit the line shows no share and no warning", () => {
    const html = markup.unlimited ?? "";
    expect(html).toContain(escaped(en["ck.noLimit"] ?? ""));
    expect(html).not.toContain("callout");
  });

  test("the take form chooses a consistency with buttons, not a native select", () => {
    const html = markup.take ?? "";
    expect(html).not.toContain("<select");
    expect(html).toContain('data-hold="live" aria-pressed="true"');
    expect(html).toContain('data-hold="pause" aria-pressed="false"');
    expect(html).toContain('data-hold="stop" aria-pressed="false"');
  });
});

describe("the Chinese console", () => {
  test("renders the same rules in Chinese", () => {
    const rendered = runConsole<Markup>(
      "zh-CN",
      fixtures,
      `return {
      legacy: component.checkpointRowHtml(fixtures.legacy, {}),
      usage: component.usageHtml(fixtures.exceeded),
    };`,
    );
    expect(rendered.legacy).toContain(zh["ck.rollback"] ?? "\u0000");
    expect(rendered.legacy).toContain(escaped(zh["ck.reasonLegacy"] ?? ""));
    expect(rendered.usage).toContain(zh["ck.repository"] ?? "\u0000");
  });
});

const LIST = "/api/checkpoints";
const ROLLBACK = "/api/boxes/bx_alpha/rollback";
const USAGE = "/api/checkpoints/usage";
const ok = (body: unknown) => ({ status: 200, body });
const failure = (status: number, code: string) => ({ status, body: { error: { code, message: code } } });

describe("checkpoints of one box", () => {
  const mounted = runConsole<{
    normal: string;
    pending: string;
    clicked: string[];
    denied: string;
    failed: string;
  }>(
    "en",
    {
      box: BOX,
      routes: {
        normal: {
          [LIST]: ok({ checkpoints: [older, other, newer] }),
          [ROLLBACK]: ok({ rollback: null }),
          [USAGE]: ok(usage(1800, 2000, "warning")),
        },
        pending: {
          [LIST]: ok({ checkpoints: [older, other, newer, safety] }),
          [ROLLBACK]: ok({ rollback: pendingRollback }),
          [USAGE]: ok(usage(1800, 2000, "warning")),
        },
        usageDenied: {
          [LIST]: ok({ checkpoints: [older, newer] }),
          [ROLLBACK]: ok({ rollback: null }),
          [USAGE]: failure(403, "forbidden"),
        },
        listFails: {
          [LIST]: failure(500, "internal"),
          [ROLLBACK]: ok({ rollback: null }),
          [USAGE]: ok(usage(1800, 2000, "warning")),
        },
      },
    },
    `const calls = [];
    let routes = {};
    globalThis.EventSource = undefined;
    globalThis.fetch = async (path, init = {}) => {
      calls.push(\`\${init.method ?? "GET"} \${path}\`);
      const reply = routes[path] ?? { status: 404, body: { error: { code: "not_found", message: "not found" } } };
      return { ok: reply.status < 400, status: reply.status, text: async () => JSON.stringify(reply.body) };
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 25));
    const mount = async (name) => {
      routes = fixtures.routes[name];
      const listeners = [];
      const root = { innerHTML: "", addEventListener: (_type, fn) => listeners.push(fn), removeEventListener() {} };
      const dispose = component.mountCheckpoints(root, { box: () => fixtures.box, refreshBox: async () => {} });
      await settle();
      return { html: root.innerHTML, listeners, dispose };
    };
    const normal = await mount("normal");
    normal.dispose();
    const pending = await mount("pending");
    const before = calls.length;
    pending.listeners[0]({ target: { closest: () => ({ dataset: { action: "ck-rollback", id: "ck_new" }, disabled: true }) } });
    await settle();
    const clicked = calls.slice(before);
    pending.dispose();
    const denied = await mount("usageDenied");
    denied.dispose();
    const failed = await mount("listFails");
    failed.dispose();
    return { normal: normal.html, pending: pending.html, clicked, denied: denied.html, failed: failed.html };`,
  );

  test("the tab lists only this box's checkpoints, newest first, with the repository line", () => {
    const html = mounted.normal;
    expect(html).toContain('data-id="ck_new"');
    expect(html).toContain('data-id="ck_old"');
    expect(html.indexOf('data-id="ck_new"')).toBeLessThan(html.indexOf('data-id="ck_old"'));
    expect(html).not.toContain('data-id="ck_other"');
    expect(html).toContain("ck-usage");
  });

  test("a waiting rollback locks rollback on every row and keeps its safety checkpoint from deletion", () => {
    const html = mounted.pending;
    const rollbacks = buttonTags(html, "ck-rollback");
    expect(rollbacks.length).toBeGreaterThan(0);
    expect(rollbacks.every(isDisabled)).toBe(true);
    expect(titleOf(buttonFor(html, "ck-delete", "ck_safe"))).toBe(escaped(en["ck.reasonHeld"] ?? ""));
    expect(html).toContain('data-action="ck-confirm"');
    expect(html).toContain('data-action="ck-undo"');
  });

  test("pressing a disabled control sends no request", () => {
    expect(mounted.clicked).toEqual([]);
  });

  test("a failed usage read hides only the repository line", () => {
    expect(mounted.denied).toContain('data-id="ck_new"');
    expect(mounted.denied).not.toContain("ck-usage");
  });

  test("a failed list read says so", () => {
    expect(mounted.failed).toContain(escaped(en["ck.loadFailed"] ?? ""));
  });
});

function quotedKeys(path: string): string[] {
  return [...readFileSync(path, "utf8").matchAll(/["'`](ck\.[\w.]+)["'`]/g)].map((match) => match[1] ?? "");
}

describe("checkpoint translations", () => {
  const statuses = ["running", "succeeded", "failed", "cancelled", "interrupted"];
  const built = [
    ...HOLD_MODES.flatMap((mode) => [`ck.hold.${mode}`, `ck.holdHint.${mode}`]),
    ...KINDS.map((kind) => `ck.kind.${kind}`),
    ...REASON_KEYS,
    ...statuses.map((status) => `task.status.${status}`),
    "vol.roleWorkspace",
    "vol.roleHome",
  ];

  test("the keys the console builds from a value exist in both languages", () => {
    expect(built.filter((key) => !(key in en) || !(key in zh))).toEqual([]);
  });

  test("every async checkpoint operation has a task label in both languages", () => {
    const keys = checkpointOperations.filter((op) => op.async).map((op) => `task.op.${op.name}`);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((key) => !(key in en) || !(key in zh))).toEqual([]);
  });

  test("every checkpoint key in English is used by the console", () => {
    const used = new Set([...built, ...quotedKeys(COMPONENT), ...quotedKeys(STATE)]);
    const unused = Object.keys(en).filter((key) => key.startsWith("ck.") && !used.has(key));
    expect(unused).toEqual([]);
  });
});
