import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "../src/config";
import en from "../web/js/i18n/en.js";
import zh from "../web/js/i18n/zh-CN.js";
import { browserTimezone } from "../web/js/lib/checkpoint-state.js";
import { SETTINGS_SECTIONS } from "../web/js/lib/settings-sections.js";

const WEB = join(ROOT, "web");
const CARD = join(WEB, "js", "components", "settings-backups.js");
const SCHEDULE_UI = join(WEB, "js", "lib", "schedule-ui.js");
const SETTINGS_PAGE = join(WEB, "js", "pages", "settings.js");

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 20, 10, minutes)).toISOString();

const escaped = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The labels the backup card passes to the shared markup, copied here so a test can check them without a browser. The
 * component's own labels are read from the source below, so the two cannot drift.
 */
const SOURCE = readFileSync(CARD, "utf8");
const LABELS = Object.fromEntries(
  [...SOURCE.matchAll(/^\s{2}(\w+): "([\w.]+)",?$/gm)].map((match) => [match[1] ?? "", match[2] ?? ""]),
);

const IDS = { hours: "stBackupHours", at: "stBackupAt", error: "stBackupErr" };

const intervalSchedule = {
  mode: "interval",
  everyHours: 6,
  at: null,
  timezone: null,
  timezoneUnknown: false,
  nextRunAt: at(60),
  lastRun: { at: at(0), status: "ok", backupId: "bk_sample", bytes: 4096, error: null },
};

const dailySchedule = {
  mode: "daily",
  everyHours: null,
  at: "02:30",
  timezone: "Asia/Shanghai",
  timezoneUnknown: false,
  nextRunAt: at(90),
  lastRun: { at: at(0), status: "failed", backupId: null, bytes: null, error: "<b>boom</b>" },
};

/** A run that failed for a reason the server has a message for, and one it only has the English text of. */
const keyedFailure = {
  ...intervalSchedule,
  lastRun: {
    at: at(0),
    status: "failed",
    backupId: null,
    bytes: null,
    error: "A backup was already running when this one was due, so it was skipped.",
    errorKey: "backup_schedule_busy",
    errorParams: null,
  },
};
const unkeyedFailure = {
  ...intervalSchedule,
  lastRun: { ...keyedFailure.lastRun, error: "ENOSPC: no space left on device", errorKey: null },
};

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

/** Runs `body` in a fresh process with the browser globals the console modules read at import. */
function runConsole<T>(language: string, body: string): T {
  const script = [
    ...browserGlobals(language),
    `const ui = await import(${JSON.stringify(SCHEDULE_UI)});`,
    `const result = await (async () => {`,
    body,
    `})();`,
    `console.log(JSON.stringify(result));`,
  ].join("\n");
  const run = Bun.spawnSync(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  return JSON.parse(run.stdout.toString().trim().split("\n").at(-1) ?? "null") as T;
}

const markup = runConsole<Markup>(
  "en",
  `return {
    off: ui.scheduleCardHtml(null, { labels: ${JSON.stringify(LABELS)}, action: "st-backup-schedule" }),
    on: ui.scheduleCardHtml(${JSON.stringify(intervalSchedule)}, { labels: ${JSON.stringify(LABELS)}, action: "st-backup-schedule" }),
    daily: ui.scheduleCardHtml(${JSON.stringify(dailySchedule)}, { labels: ${JSON.stringify(LABELS)}, action: "st-backup-schedule" }),
    unknown: ui.scheduleCardHtml(${JSON.stringify({ ...dailySchedule, timezone: "Mars/Olympus", timezoneUnknown: true })}, { labels: ${JSON.stringify(LABELS)}, action: "st-backup-schedule" }),
    fields: ui.scheduleFieldsHtml(${JSON.stringify(dailySchedule)}, { ids: ${JSON.stringify(IDS)}, help: "st.backupScheduleHelp" }),
    fieldsOff: ui.scheduleFieldsHtml(null, { ids: ${JSON.stringify(IDS)}, help: "st.backupScheduleHelp" }),
  };`,
);

const failures = (language: string) =>
  runConsole<Markup>(
    language,
    `return {
      keyed: ui.scheduleCardHtml(${JSON.stringify(keyedFailure)}, { labels: ${JSON.stringify(LABELS)}, action: "a" }),
      unkeyed: ui.scheduleCardHtml(${JSON.stringify(unkeyedFailure)}, { labels: ${JSON.stringify(LABELS)}, action: "a" }),
      zoned: ui.zonedTime(${JSON.stringify(at(60))}, "Asia/Shanghai"),
    };`,
  );

describe("a failed scheduled run is said in the console's language", () => {
  test("a reason the server has a message for is translated, in each language", () => {
    expect(failures("en").keyed).toContain(escaped(en["err.backup_schedule_busy"] ?? ""));
    expect(failures("zh-CN").keyed).toContain(escaped(zh["err.backup_schedule_busy"] ?? ""));
    expect(failures("zh-CN").keyed).not.toContain("was already running");
  });

  test("a reason that has only the server's English text is shown as it is", () => {
    expect(failures("zh-CN").unkeyed).toContain("ENOSPC: no space left on device");
  });

  test("a time is shown with the zone it is in, which the saved toast uses too", () => {
    expect(failures("en").zoned).toContain("Asia/Shanghai");
    expect(SOURCE).toContain("zonedTime(saved.schedule.nextRunAt, browserTimezone())");
  });
});

describe("the backup schedule card", () => {
  test("a schedule that is off says so, and offers to set one", () => {
    expect(markup.off).toContain(escaped(en["ck.scheduleOff"] ?? ""));
    expect(markup.off).toContain(escaped(en["st.backupScheduleOffHelp"] ?? ""));
    expect(markup.off).toContain('data-action="st-backup-schedule"');
    expect(markup.off).not.toContain('data-action="st-backup-schedule-off"');
  });

  test("a set schedule names its rule, its next and last run, and can be changed or turned off", () => {
    expect(markup.on).toContain("Every 6 hours");
    expect(markup.on).toContain(escaped(en["st.backupRunOk"] ?? "").replace("{time}", ""));
    expect(markup.on).toContain('data-action="st-backup-schedule"');
    expect(markup.on).toContain('data-action="st-backup-schedule-off"');
    expect(markup.on).toContain(escaped(en["st.backupScheduleNote"] ?? ""));
  });

  test("a daily schedule names its time and zone, and a failed run shows its error escaped", () => {
    expect(markup.daily).toContain("Every day at 02:30 (Asia/Shanghai)");
    expect(markup.daily).toContain("&lt;b&gt;boom&lt;/b&gt;");
    expect(markup.daily).not.toContain("<b>boom</b>");
  });

  test("a schedule whose saved zone the server does not know says it runs in UTC", () => {
    expect(markup.unknown).toContain("Every day at 02:30 (UTC)");
    expect(markup.unknown).toContain("The saved time zone Mars/Olympus is not one the server knows");
  });

  test("the dialog offers both ways of setting a rule, in the browser's zone", () => {
    expect(markup.fields).toContain(`id="${IDS.hours}"`);
    expect(markup.fields).toContain(`id="${IDS.at}"`);
    expect(markup.fields).toContain(`id="${IDS.error}"`);
    expect(markup.fields).toContain("HH:MM in your time zone");
    expect(markup.fields).toContain(escaped(en["st.backupScheduleHelp"] ?? ""));
    expect(markup.fieldsOff).toContain('data-mode="interval" aria-pressed="true"');
    expect(markup.fieldsOff).toContain('data-mode="daily" aria-pressed="false"');
    // The backup dialog's ids differ from the checkpoint dialog's, so the two never collide.
    expect(markup.fieldsOff).not.toContain("ckHours");
  });

  test("the browser's zone is what the dialog names", () => {
    expect(browserTimezone().length).toBeGreaterThan(0);
  });
});

describe("the settings page", () => {
  test("Backups is its own category, labelled in both languages", () => {
    const section = SETTINGS_SECTIONS.find((item) => item.id === "backups");
    expect(section?.label).toBe("st.backups");
    expect("st.backups" in en && "st.backups" in zh).toBe(true);
    expect(en["st.backups"]).not.toBe(zh["st.backups"]);
  });

  test("the category mounts the card and loads it", () => {
    const page = readFileSync(SETTINGS_PAGE, "utf8");
    expect(page).toContain('import { loadBackups } from "../components/settings-backups.js"');
    expect(page).toMatch(/backups: \{[\s\S]*?id="stBackups"[\s\S]*?load: loadBackups/);
  });

  test("the card reads and changes the schedule through the backup operations' routes", () => {
    for (const route of ['"/api/backups/schedule"']) expect(SOURCE).toContain(route);
    expect(SOURCE).toContain('method: "PUT"');
    expect(SOURCE).toContain('method: "DELETE"');
    expect(SOURCE).toContain('api("/api/backups/schedule")');
  });

  test("every string the card uses is translated in both languages", () => {
    const keys = [...SOURCE.matchAll(/(?:t|help:)\s*\(\s*"([\w.]+)"/g)].map((match) => match[1] ?? "");
    keys.push(...[...SOURCE.matchAll(/: "(\w+)",?$/gm)].map((match) => match[1] ?? ""));
    const missing = [...new Set(keys)].filter((key) => key.includes(".")).filter((key) => !(key in en) || !(key in zh));
    expect(missing).toEqual([]);
  });

  test("the backup card's own words differ from the checkpoint card's", () => {
    for (const key of ["st.backupScheduleNote", "st.backupScheduleOffHelp", "st.backupScheduleHelp"]) {
      expect(en[key]).not.toBe(zh[key]);
    }
  });
});
