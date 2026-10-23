import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SKIP_REASONS } from "../src/checkpoints/schedule";
import { ROOT } from "../src/config";
import { checkpointPackageOperations } from "../src/operations/checkpoint-packages";
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
  passphraseOk,
  REASON_KEYS,
  rowActions,
  SKIP_REASON_KEYS,
  browserTimezone,
  scheduleBody,
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
    expect(actions.map((action) => action.allowed)).toEqual([true, true, true, true, true]);
  });

  test("a legacy snapshot is read-only: it can be forked or deleted, and nothing else", () => {
    const actions = rowActions(row({ legacy: true, data: [] }));
    expect(actions.fork.allowed).toBe(true);
    expect(actions.delete.allowed).toBe(true);
    expect(actions.rollback).toEqual({ allowed: false, reason: "ck.reasonLegacy" });
    expect(actions.pin).toEqual({ allowed: false, reason: "ck.reasonLegacy" });
    expect(actions.export).toEqual({ allowed: false, reason: "ck.reasonLegacy" });
  });

  test("a checkpoint with no owned volume data cannot be rolled back", () => {
    const actions = rowActions(row({ data: [{ role: "cache", ownership: "independent" }] }));
    expect(actions.rollback).toEqual({ allowed: false, reason: "ck.reasonNoData" });
    expect(actions.fork.allowed).toBe(true);
  });

  test("while a rollback waits for its confirm or undo, no checkpoint of the box can be rolled back", () => {
    expect(rowActions(row(), { pending: true }).rollback).toEqual({ allowed: false, reason: "ck.reasonPending" });
  });

  test("a checkpoint kept on another host cannot be rolled back to from here, and its other actions stay", () => {
    const actions = rowActions(row(), { elsewhere: true });
    expect(actions.rollback).toEqual({ allowed: false, reason: "ck.reasonOtherHost" });
    expect([actions.fork.allowed, actions.export.allowed, actions.pin.allowed, actions.delete.allowed]).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  test("a waiting rollback is the reason shown first, even for a checkpoint on another host", () => {
    expect(rowActions(row(), { pending: true, elsewhere: true }).rollback.reason).toBe("ck.reasonPending");
  });

  test("the safety checkpoint of a waiting rollback cannot be deleted", () => {
    expect(rowActions(row(), { held: true, pending: true }).delete).toEqual({
      allowed: false,
      reason: "ck.reasonHeld",
    });
  });

  test("a checkpoint with volume data can be exported, even while a rollback waits, but one with none cannot", () => {
    expect(rowActions(row(), { pending: true }).export.allowed).toBe(true);
    expect(rowActions(row({ data: [] })).export).toEqual({ allowed: false, reason: "ck.reasonEmpty" });
  });

  test("a checkpoint with a system layer cannot be exported, because a package does not carry the image", () => {
    const withSystem = row({ system: { image: "minibox-checkpoint:ck_x", imageId: "sha256:x" } });
    expect(rowActions(withSystem).export).toEqual({ allowed: false, reason: "ck.reasonSystem" });
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

describe("passphrase and schedule rules", () => {
  test("a passphrase is 12 to 1024 characters, counted as the server counts them, with no edge spaces or line breaks", () => {
    expect(passphraseOk("x".repeat(11))).toBe(false);
    expect(passphraseOk("x".repeat(12))).toBe(true);
    expect(passphraseOk("x".repeat(1024))).toBe(true);
    expect(passphraseOk("x".repeat(1025))).toBe(false);
    expect(passphraseOk(` ${"x".repeat(12)}`)).toBe(false);
    expect(passphraseOk(`${"x".repeat(12)}\n`)).toBe(false);
    expect(passphraseOk("🔑".repeat(12))).toBe(true);
    expect(passphraseOk("🔑".repeat(11))).toBe(false);
  });

  test("a schedule is a whole number of hours from 1 to 720, or a time of day, and nothing else", () => {
    expect(scheduleBody("interval", { hours: "6" })).toEqual({ everyHours: 6 });
    expect(scheduleBody("interval", { hours: 720 })).toEqual({ everyHours: 720 });
    for (const hours of ["0", "721", "2.5", "", "abc"]) {
      expect(scheduleBody("interval", { hours })).toBeNull();
    }
    expect(scheduleBody("daily", { at: "02:30", timezone: "Asia/Shanghai" })).toEqual({
      at: "02:30",
      timezone: "Asia/Shanghai",
    });
    expect(scheduleBody("daily", { at: "02:30" })).toEqual({ at: "02:30", timezone: browserTimezone() });
    for (const at of ["24:00", "2:30", "12:60", ""]) {
      expect(scheduleBody("daily", { at })).toBeNull();
    }
  });

  test("every reason a scheduled run can be skipped for is translated in both languages", () => {
    expect(Object.keys(SKIP_REASON_KEYS).toSorted()).toEqual([...SKIP_REASONS].toSorted());
    for (const key of Object.values(SKIP_REASON_KEYS)) {
      expect([key, key in en && key in zh]).toEqual([key, true]);
    }
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
  schedule: {
    version: 1,
    hostId: "host_1",
    boxId: "bx_alpha",
    mode: "interval",
    everyHours: 6,
    at: null,
    createdBy: "owner",
    createdAt: at(0),
    updatedAt: at(0),
    nextRunAt: at(60),
    lastRun: { at: at(0), status: "skipped", reason: "sleeping", checkpointId: null, error: null },
  },
  dailySchedule: {
    version: 1,
    hostId: "host_1",
    boxId: "bx_alpha",
    mode: "daily",
    everyHours: null,
    at: "02:30",
    timezone: "Asia/Shanghai",
    createdBy: "owner",
    createdAt: at(0),
    updatedAt: at(0),
    nextRunAt: at(90),
    lastRun: { at: at(0), status: "failed", reason: null, checkpointId: null, error: "<b>boom</b>" },
  },
  hosts: [
    { id: "local", name: "Local" },
    { id: "host_b", name: "Host B" },
  ],
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
    exportForm: component.exportFormHtml(),
    importMulti: component.importFormHtml({ hosts: fixtures.hosts, host: "host_b" }),
    importSingle: component.importFormHtml({ hosts: [], host: "local" }),
    scheduleForm: component.scheduleFormHtml(null),
    scheduleOff: component.scheduleHtml(null),
    scheduleOn: component.scheduleHtml(fixtures.schedule),
    scheduleDaily: component.scheduleHtml(fixtures.dailySchedule),
    scheduleLegacy: component.scheduleHtml({ ...fixtures.dailySchedule, timezone: undefined }),
    scheduleZoned: component.scheduleHtml(fixtures.dailySchedule, "Europe/Berlin"),
    scheduleUnknown: component.scheduleHtml({ ...fixtures.dailySchedule, timezone: "Mars/Olympus", timezoneUnknown: true }, "Asia/Shanghai"),
    scheduleFormHere: component.scheduleFormHtml(fixtures.dailySchedule, "Asia/Shanghai"),
    scheduleFormMoved: component.scheduleFormHtml(fixtures.dailySchedule, "Europe/Berlin"),
    cardScheduled: component.checkpointCardHtml({ rows: [], pending: null, usage: null, schedule: fixtures.schedule }),
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

describe("export and import controls", () => {
  test("an ordinary checkpoint offers export, and a legacy snapshot shows why it cannot be exported", () => {
    expect(isDisabled(buttonFor(markup.manual ?? "", "ck-export", "ck_manual"))).toBe(false);
    const legacyExport = buttonFor(markup.legacy ?? "", "ck-export", "img_1");
    expect(isDisabled(legacyExport)).toBe(true);
    expect(titleOf(legacyExport)).toBe(escaped(en["ck.reasonLegacy"] ?? ""));
  });

  test("the passphrase fields are password fields, and the export asks for the passphrase twice", () => {
    const html = markup.exportForm ?? "";
    expect(html.match(/type="password"/g)?.length).toBe(2);
    expect(html).toContain(escaped(en["ck.passphraseHelp"] ?? ""));
    expect(html).toContain(escaped(en["ck.exportHow"] ?? ""));
  });

  test("the card offers import beside create, and the file input takes only packages", () => {
    expect(markup.card).toContain('data-action="ck-import"');
    expect(markup.card).toContain('data-action="ck-take"');
    expect(markup.importMulti).toContain('accept=".mbckpt"');
    // The native file input is hidden; a styled button opens it and the chosen name is shown beside it.
    expect(markup.importMulti).toContain('class="sr-only" id="ckImportFile" type="file"');
    expect(markup.importMulti).toContain('id="ckImportPick"');
    expect(markup.importMulti).toContain(escaped(en["ck.importNoneChosen"] ?? ""));
  });

  test("the host of an import is chosen only where there is more than one host, and defaults to the host given", () => {
    expect(markup.importMulti).toContain('id="ckImportHost"');
    expect(markup.importMulti).toContain('<option value="host_b" selected>Host B</option>');
    expect(markup.importSingle).not.toContain("ckImportHost");
  });

  test("the card hides the schedule line when the schedule could not be read", () => {
    expect(markup.empty).not.toContain("ck-schedule");
    expect(markup.cardScheduled).toContain('data-action="ck-schedule-off"');
  });
});

describe("checkpoint schedule", () => {
  test("a box with no schedule says it is off, and offers to set one", () => {
    const html = markup.scheduleOff ?? "";
    expect(html).toContain(escaped(en["ck.scheduleOff"] ?? ""));
    expect(html).toContain('data-action="ck-schedule"');
    expect(html).not.toContain("ck-schedule-off");
  });

  test("an every-N-hours schedule names its rule, its next and last run, and can be changed or turned off", () => {
    const html = markup.scheduleOn ?? "";
    expect(html).toContain("Every 6 hours");
    expect(html).toContain(`${escaped(en["ck.lastRun"] ?? "")}: `);
    expect(html).toContain(escaped(en["ck.skip.sleeping"] ?? ""));
    expect(html).toContain('data-action="ck-schedule"');
    expect(html).toContain('data-action="ck-schedule-off"');
  });

  test("a daily schedule names its time, and a failed run shows its error escaped", () => {
    const html = markup.scheduleDaily ?? "";
    expect(html).toContain("Every day at 02:30 (Asia/Shanghai)");
    expect(html).toContain("&lt;b&gt;boom&lt;/b&gt;");
    expect(html).not.toContain("<b>boom</b>");
  });

  test("the next and the last run name the browser's zone they are shown in", () => {
    const html = markup.scheduleZoned ?? "";
    expect(html).toMatch(/Next run: [^<]*\d{2}:\d{2} \(Europe\/Berlin\)<\/div>/);
    expect(html).toMatch(/Last run: [^<]*\d{2}:\d{2} \(Europe\/Berlin\), failed: /);
    expect(html).not.toContain("local time");
  });

  test("a schedule whose saved zone the server does not know says it runs in UTC, and asks for it to be set again", () => {
    const html = markup.scheduleUnknown ?? "";
    expect(html).toContain("Every day at 02:30 (UTC)");
    expect(html).toContain("callout");
    expect(html).toContain("The saved time zone Mars/Olympus is not one the server knows");
    expect(markup.scheduleDaily ?? "").not.toContain("is not one the server knows");
  });

  test("a daily schedule saved before time zones says it runs in UTC", () => {
    expect(markup.scheduleLegacy ?? "").toContain("Every day at 02:30 (UTC)");
  });

  test("the form names the browser's zone, and says so when saving moves a schedule to it", () => {
    const here = markup.scheduleFormHere ?? "";
    expect(here).toContain("HH:MM in your time zone, Asia/Shanghai");
    expect(here).not.toContain("Saving it here");
    const moved = markup.scheduleFormMoved ?? "";
    expect(moved).toContain("HH:MM in your time zone, Europe/Berlin");
    expect(moved).toContain("This schedule runs in Asia/Shanghai. Saving it here sets it to Europe/Berlin.");
  });

  test("the form offers both ways of setting a rule, and shows the hours field first", () => {
    const html = markup.scheduleForm ?? "";
    expect(html).toContain('data-mode="interval" aria-pressed="true"');
    expect(html).toContain('data-mode="daily" aria-pressed="false"');
    expect(html).toContain('data-field="interval"');
    // A custom-styled text field, not the browser's native time picker.
    expect(html).toContain('id="ckAt" type="text"');
    expect(html).not.toContain('type="time"');
    expect(html).toMatch(/<div class="field hidden" data-field="daily">/);
  });
});

describe("checkpoints kept on several hosts", () => {
  const hosts = [
    { id: "local", name: "Local" },
    { id: "host_b", name: "Host B" },
  ];
  const onB = checkpoint({ id: "ck_b", hostId: "host_b", label: "kept on B" });
  const here = checkpoint({ id: "ck_here", hostId: "local", label: "kept here" });
  const several = runConsole<Markup>(
    "en",
    { hosts, onB, here },
    `return {
      away: component.checkpointRowHtml(fixtures.onB, { hosts: fixtures.hosts, boxHostId: "local" }),
      local: component.checkpointRowHtml(fixtures.here, { hosts: fixtures.hosts, boxHostId: "local" }),
      single: component.checkpointRowHtml(fixtures.here, { hosts: [fixtures.hosts[0]], boxHostId: "local" }),
      card: component.checkpointCardHtml({ rows: [fixtures.onB, fixtures.here], pending: null, usage: null, hosts: fixtures.hosts, boxHostId: "local" }),
    };`,
  );

  test("a checkpoint kept on another host names that host, and cannot be rolled back to from the box's host", () => {
    const html = several.away ?? "";
    expect(html).toContain("Stored on Host B");
    expect(isDisabled(buttonFor(html, "ck-rollback", "ck_b"))).toBe(true);
    expect(titleOf(buttonFor(html, "ck-rollback", "ck_b"))).toBe(escaped(en["ck.reasonOtherHost"] ?? ""));
    expect(isDisabled(buttonFor(html, "ck-fork", "ck_b"))).toBe(false);
    expect(isDisabled(buttonFor(html, "ck-delete", "ck_b"))).toBe(false);
  });

  test("a checkpoint kept on the box's own host can be rolled back to, and still names its host", () => {
    const html = several.local ?? "";
    expect(html).toContain("Stored on Local");
    expect(isDisabled(buttonFor(html, "ck-rollback", "ck_here"))).toBe(false);
  });

  test("with one host there is no host line", () => {
    expect(several.single ?? "").not.toContain("Stored on");
  });

  test("the card names the host of each of its checkpoints", () => {
    const html = several.card ?? "";
    expect(html).toContain("Stored on Host B");
    expect(html).toContain("Stored on Local");
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
      daily: component.scheduleHtml(fixtures.dailySchedule, "Asia/Shanghai"),
      unknown: component.scheduleHtml({ ...fixtures.dailySchedule, timezone: "Mars/Olympus", timezoneUnknown: true }, "Asia/Shanghai"),
      form: component.scheduleFormHtml(fixtures.dailySchedule, "Asia/Shanghai"),
    };`,
    );
    expect(rendered.daily).toContain("每天 02:30（Asia/Shanghai）");
    expect(rendered.daily).toMatch(/下次运行: [^<]*\d{2}:\d{2}（Asia\/Shanghai）<\/div>/);
    expect(rendered.daily).toMatch(/上次运行: [^<]*\d{2}:\d{2}（Asia\/Shanghai），失败：/);
    expect(rendered.daily).not.toContain("本地时间");
    expect(rendered.unknown).toContain("保存的时区 Mars/Olympus 服务器无法识别，此计划暂按 UTC 运行");
    expect(rendered.form).toContain("你所在时区（Asia/Shanghai）的 HH:MM");
    expect(rendered.legacy).toContain(zh["ck.rollback"] ?? "\u0000");
    expect(rendered.legacy).toContain(escaped(zh["ck.reasonLegacy"] ?? ""));
    expect(rendered.usage).toContain(zh["ck.repository"] ?? "\u0000");
  });
});

const LIST = "/api/checkpoints";
const ROLLBACK = "/api/boxes/bx_alpha/rollback";
const USAGE = "/api/checkpoints/usage";
const SCHEDULE = "/api/boxes/bx_alpha/checkpoint-schedule";
const ok = (body: unknown) => ({ status: 200, body });
const failure = (status: number, code: string) => ({ status, body: { error: { code, message: code } } });

describe("checkpoints of one box", () => {
  const mounted = runConsole<{
    normal: string;
    pending: string;
    clicked: string[];
    denied: string;
    failed: string;
    scheduled: string;
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
        scheduled: {
          [LIST]: ok({ checkpoints: [older, newer] }),
          [ROLLBACK]: ok({ rollback: null }),
          [USAGE]: ok(usage(1800, 2000, "warning")),
          [SCHEDULE]: ok({ schedule: fixtures.schedule }),
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
    const scheduled = await mount("scheduled");
    scheduled.dispose();
    return {
      normal: normal.html,
      pending: pending.html,
      clicked,
      denied: denied.html,
      failed: failed.html,
      scheduled: scheduled.html,
    };`,
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

  test("a box with a schedule shows its next and last run, and the schedule line is absent without a read", () => {
    expect(mounted.scheduled).toContain('data-action="ck-schedule-off"');
    expect(mounted.scheduled).toContain(escaped(en["ck.skip.sleeping"] ?? ""));
    expect(mounted.normal).not.toContain("ck-schedule");
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
    ...Object.values(SKIP_REASON_KEYS),
    ...statuses.map((status) => `task.status.${status}`),
    "vol.roleWorkspace",
    "vol.roleHome",
  ];

  test("the keys the console builds from a value exist in both languages", () => {
    expect(built.filter((key) => !(key in en) || !(key in zh))).toEqual([]);
  });

  test("every async checkpoint operation has a task label in both languages", () => {
    const operations = [...checkpointOperations, ...checkpointPackageOperations];
    const keys = operations.filter((op) => op.async).map((op) => `task.op.${op.name}`);
    expect(keys).toEqual(expect.arrayContaining(["task.op.checkpoint.export", "task.op.checkpoint.import"]));
    expect(keys.filter((key) => !(key in en) || !(key in zh))).toEqual([]);
  });

  test("every checkpoint key in English is used by the console", () => {
    const used = new Set([...built, ...quotedKeys(COMPONENT), ...quotedKeys(STATE)]);
    const unused = Object.keys(en).filter((key) => key.startsWith("ck.") && !used.has(key));
    expect(unused).toEqual([]);
  });
});
