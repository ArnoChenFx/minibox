import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { ROOT } from "../src/config";
import {
  idleModeOf,
  type LifetimeForm,
  LIFETIME_UNITS,
  lifetimeDraft,
  lifetimePatch,
  lifetimeSeconds,
  MAX_LIFETIME_SEC,
  ttlModeOf,
} from "../web/js/lib/lifetime.js";

const CARD = join(ROOT, "web", "js", "components", "lifecycle-card.js");

/** The browser globals the card's modules read when they load. `language` picks the dictionary the card renders with. */
function stubs(language: "en-US" | "zh-CN"): string[] {
  return [
    `Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {} } });`,
    `Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: [${JSON.stringify(language)}], language: ${JSON.stringify(language)} } });`,
    `const stub = { documentElement: {}, body: {}, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };`,
    `Object.defineProperty(globalThis, "document", { configurable: true, value: stub });`,
    `Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) } });`,
    `Object.defineProperty(globalThis, "location", { configurable: true, value: { hash: "", search: "", pathname: "/", origin: "http://localhost" } });`,
  ];
}

/** Renders one card model in a fresh process, so the markup comes from the module as the page loads it. */
function cardMarkup<T>(language: "en-US" | "zh-CN", expression: string): T {
  const script = [
    ...stubs(language),
    `const card = await import(${JSON.stringify(CARD)});`,
    `console.log(JSON.stringify(await (async () => (${expression}))()));`,
  ].join("\n");
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000 });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout) as T;
}

const BOX = {
  name: "dev",
  revision: 4,
  desired: "running",
  sleeping: false,
  stopReason: null,
  lastActivityAt: "2026-10-22T10:00:00Z",
  idleTimeoutSec: null,
  ttlSec: null,
};

describe("lifetime rules in the browser", () => {
  test("a lifetime is a whole number of seconds from 1 to the cap, whatever unit it is entered in", () => {
    expect(lifetimeSeconds("2", "hours")).toBe(7200);
    expect(lifetimeSeconds(" 90 ", "minutes")).toBe(5400);
    expect(lifetimeSeconds("365", "days")).toBe(MAX_LIFETIME_SEC);
    for (const [value, unit] of [
      ["366", "days"],
      ["0", "seconds"],
      ["", "hours"],
      ["1.5", "hours"],
      ["-1", "hours"],
      ["2h", "hours"],
    ] as const) {
      expect([value, unit, lifetimeSeconds(value, unit)]).toEqual([value, unit, null]);
    }
  });

  test("the cap is the server's, so the form refuses exactly what the server refuses", () => {
    // 365 days, as `MAX_LIFETIME_SEC` holds it in src/operations/validation.ts.
    expect(MAX_LIFETIME_SEC).toBe(365 * 86_400);
    expect(lifetimeSeconds(String(MAX_LIFETIME_SEC), "seconds")).toBe(MAX_LIFETIME_SEC);
    expect(lifetimeSeconds(String(MAX_LIFETIME_SEC + 1), "seconds")).toBeNull();
  });

  test("a stored lifetime reads in the largest unit that divides it, so the form starts from what the box has", () => {
    expect(lifetimeDraft(7200)).toEqual({ value: 2, unit: "hours" });
    expect(lifetimeDraft(5400)).toEqual({ value: 90, unit: "minutes" });
    expect(lifetimeDraft(86_400)).toEqual({ value: 1, unit: "days" });
    expect(lifetimeDraft(90)).toEqual({ value: 90, unit: "seconds" });
    expect(lifetimeDraft(null)).toEqual({ value: 1, unit: "hours" });
    expect(lifetimeDraft(0)).toEqual({ value: 1, unit: "hours" });
    expect(lifetimeDraft(null, 86_400)).toEqual({ value: 1, unit: "days" });
    // Every unit it picks divides the seconds exactly, so showing a value and saving it again changes nothing.
    for (const seconds of [1, 59, 60, 3600, 7200, 5401, 86_400, MAX_LIFETIME_SEC]) {
      const draft = lifetimeDraft(seconds);
      expect([seconds, lifetimeSeconds(String(draft.value), draft.unit)]).toEqual([seconds, seconds]);
    }
    expect(LIFETIME_UNITS.map((unit) => unit.id)).toEqual(["days", "hours", "minutes", "seconds"]);
  });

  test("the modes name what the box holds: null inherits, 0 never sleeps, a number is its own, and a TTL is set or not", () => {
    expect([null, 0, 30].map(idleModeOf)).toEqual(["inherit", "never", "custom"]);
    expect([null, 3600].map(ttlModeOf)).toEqual(["none", "set"]);
  });
});

const form = (over: Partial<LifetimeForm> = {}): LifetimeForm => ({
  idleMode: "custom",
  idleValue: "30",
  idleUnit: "minutes",
  ttlMode: "none",
  ttlValue: "1",
  ttlUnit: "days",
  ...over,
});

describe("the PATCH a lifecycle form sends", () => {
  test("only the fields whose value changed are sent, and null is a value", () => {
    expect(lifetimePatch({ idleTimeoutSec: null, ttlSec: null }, form())).toEqual({
      patch: { idleTimeoutSec: 1800 },
    });
    expect(lifetimePatch({ idleTimeoutSec: 1800, ttlSec: null }, form())).toEqual({ patch: {} });
    expect(lifetimePatch({ idleTimeoutSec: 0, ttlSec: 86_400 }, form({ idleMode: "inherit", ttlMode: "set" }))).toEqual(
      { patch: { idleTimeoutSec: null } },
    );
    expect(
      lifetimePatch(
        { idleTimeoutSec: 0, ttlSec: 3600 },
        form({ idleMode: "never", ttlMode: "set", ttlValue: "1", ttlUnit: "hours" }),
      ),
    ).toEqual({ patch: {} });
    // A TTL the form clears is sent as null, and the idle timeout keeps its own value.
    expect(lifetimePatch({ idleTimeoutSec: 0, ttlSec: 3600 }, form({ idleMode: "never" }))).toEqual({
      patch: { ttlSec: null },
    });
    expect(lifetimePatch({ idleTimeoutSec: null, ttlSec: 60 }, form({ idleMode: "never", ttlMode: "set" }))).toEqual({
      patch: { idleTimeoutSec: 0, ttlSec: 86_400 },
    });
  });

  test("a custom number that cannot be sent is named, and nothing else is sent with it", () => {
    expect(
      lifetimePatch({ idleTimeoutSec: null, ttlSec: null }, form({ idleValue: "0", idleUnit: "seconds" })),
    ).toEqual({
      problem: "idle",
    });
    expect(
      lifetimePatch({ idleTimeoutSec: null, ttlSec: null }, form({ ttlMode: "set", ttlValue: "", ttlUnit: "days" })),
    ).toEqual({ problem: "ttl" });
  });
});

describe("the Lifecycle card's markup", () => {
  test("the card reads the box's state and offers the edit button, which opens the form", () => {
    const html = cardMarkup<string>("en-US", `card.lifecycleCardHtml(${JSON.stringify(BOX)})`);
    expect(html).toContain("Lifecycle");
    expect(html).toContain('data-lc-action="edit"');
    expect(html).toContain("Global default");
    expect(html).toContain("None");
    expect(html).toContain("The idle timeout and the TTL apply at once when they are changed, without a rebuild.");
  });

  test("the form starts from the box's values, in the largest unit that divides each one", () => {
    const box = { ...BOX, idleTimeoutSec: 0, ttlSec: 7200 };
    const html = cardMarkup<string>("en-US", `card.lifetimeFormHtml(${JSON.stringify(box)})`);
    expect(html).toContain('data-lc-idle-mode="never"');
    expect(html).toContain('data-lc-ttl-mode="set"');
    expect(html).toContain('id="lc-ttl" type="number" min="1" max="31536000" step="1" inputmode="numeric" value="2"');
    expect(html).toContain('<option value="hours" selected>hours</option>');
    expect(html).toContain('data-lc-action="save"');
  });

  test("the form is Chinese in zh-CN, and its units are too", () => {
    const html = cardMarkup<string>("zh-CN", `card.lifetimeFormHtml(${JSON.stringify(BOX)})`);
    expect(html).toContain("跟随全局默认");
    expect(html).toContain("永不休眠");
    expect(html).toContain("无 TTL");
    expect(html).toContain('<option value="hours" selected>小时</option>');
  });

  test("a box name never reaches the card's markup as HTML, and neither does a stop reason", () => {
    const box = { ...BOX, name: '<img src=x onerror="alert(1)">', stopReason: "idle" };
    const html = cardMarkup<string>("en-US", `card.lifecycleCardHtml(${JSON.stringify(box)})`);
    expect(html).not.toContain("<img");
    expect(html).toContain("(idle)");
  });
});
