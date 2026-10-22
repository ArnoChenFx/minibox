import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { App } from "../src/app";
import {
  type BoxSchedule,
  BoxScheduleSchema,
  canonicalTimezone,
  firstRunAt,
  isDue,
  nextDailyAfter,
  nextRunAfterRun,
  ruleOf,
  runZoneOf,
  SCHEDULE_HOURS_MAX,
  type ScheduleRule,
} from "../src/checkpoints/schedule";
import type { Config } from "../src/config";
import type { HostMetrics } from "../src/host/metrics";
import type { HostCtx } from "../src/host/registry";
import { log } from "../src/lib/logger";
import * as boxes from "../src/services/boxes";
import { applyRetention } from "../src/services/checkpoint-retention";
import { CheckpointScheduler, clearSchedule, scheduleOf, setSchedule } from "../src/services/checkpoint-schedule";
import { newBoxId } from "../src/specs/revision";
import { createTestApp, silenceLogs } from "./support/app";
import type { FakeRuntime } from "./support/fake-runtime";
import type { FakeCheckpointEngine } from "./support/fake-snapshots";
import { call, type Reply, refused, startHarness, mint, type Harness } from "./support/tokens";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MB = 1024 * 1024;

const iso = (date: Date): string => date.toISOString();
const utc = (...parts: [number, number, number, number, number]) => new Date(Date.UTC(...parts));

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !check(); i++) await Bun.sleep(2);
  if (!check()) throw new Error("the condition was not reached");
}

const pathOf = (boxId: string): string => `/api/boxes/${boxId}/checkpoint-schedule`;
const bodyOf = (reply: Reply) => (reply.json as unknown as { schedule: BoxSchedule | null }).schedule;

type RuleInput = { everyHours?: number; at?: string; timezone?: string };

function rule(input: RuleInput): ScheduleRule {
  const found = ruleOf(input);
  if (!found) throw new Error(`not a schedule rule: ${JSON.stringify(input)}`);
  return found;
}

function scheduleWith(input: RuleInput, nextRunAt: Date): BoxSchedule {
  const found = rule(input);
  return {
    version: 1,
    hostId: "local",
    boxId: newBoxId(),
    mode: found.mode,
    everyHours: found.everyHours,
    at: found.at,
    timezone: found.timezone,
    createdBy: "owner",
    createdAt: iso(nextRunAt),
    updatedAt: iso(nextRunAt),
    nextRunAt: iso(nextRunAt),
    lastRun: null,
  };
}

describe("schedule rules", () => {
  test("a rule is an interval of whole hours or a daily time, and never both or neither", () => {
    expect(ruleOf({ everyHours: 6 })).toEqual({ mode: "interval", everyHours: 6, at: null, timezone: null });
    expect(ruleOf({ at: "02:30" })).toEqual({ mode: "daily", everyHours: null, at: "02:30", timezone: "UTC" });
    expect(ruleOf({})).toBeNull();
    expect(ruleOf({ everyHours: 6, at: "02:30" })).toBeNull();
  });

  test("an interval is between 1 and 720 hours, and a whole number", () => {
    for (const everyHours of [0, -1, 1.5, SCHEDULE_HOURS_MAX + 1]) expect(ruleOf({ everyHours })).toBeNull();
    expect(ruleOf({ everyHours: 1 })?.everyHours).toBe(1);
    expect(ruleOf({ everyHours: SCHEDULE_HOURS_MAX })?.everyHours).toBe(SCHEDULE_HOURS_MAX);
  });

  test("a daily time is HH:MM on a 24-hour clock", () => {
    for (const at of ["24:00", "9:00", "12:60", "12:5", "noon", ""]) expect(ruleOf({ at })).toBeNull();
    expect(ruleOf({ at: "00:00" })?.at).toBe("00:00");
    expect(ruleOf({ at: "23:59" })?.at).toBe("23:59");
  });

  test("the first run of an interval is one interval after the rule is set", () => {
    const from = new Date(2026, 9, 22, 10, 0);
    expect(firstRunAt(rule({ everyHours: 6 }), from)).toEqual(new Date(2026, 9, 22, 16, 0));
  });

  test("a daily time runs at its next occurrence, strictly after the moment it is set, in UTC when no zone is named", () => {
    const from = new Date(Date.UTC(2026, 9, 22, 10, 0));
    expect(firstRunAt(rule({ at: "02:30" }), from)).toEqual(new Date(Date.UTC(2026, 9, 23, 2, 30)));
    expect(firstRunAt(rule({ at: "23:00" }), from)).toEqual(new Date(Date.UTC(2026, 9, 22, 23, 0)));
    expect(firstRunAt(rule({ at: "10:00" }), from)).toEqual(new Date(Date.UTC(2026, 9, 23, 10, 0)));
  });

  test("a late interval run stays on the grid of its first run", () => {
    const due = new Date(2026, 9, 22, 10, 0);
    const schedule = scheduleWith({ everyHours: 2 }, due);
    expect(nextRunAfterRun(schedule, new Date(2026, 9, 22, 10, 30))).toEqual(new Date(2026, 9, 22, 12, 0));
    expect(nextRunAfterRun(schedule, new Date(2026, 9, 22, 13, 0))).toEqual(new Date(2026, 9, 22, 14, 0));
  });

  test("after a long outage an interval runs once, and its next run is the first grid point after now", () => {
    const due = new Date(2026, 9, 22, 10, 0);
    const now = new Date(due.getTime() + 10 * DAY);
    const next = nextRunAfterRun(scheduleWith({ everyHours: 2 }, due), now);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(next.getTime()).toBeLessThanOrEqual(now.getTime() + 2 * HOUR);
    expect((next.getTime() - due.getTime()) % (2 * HOUR)).toBe(0);
  });

  test("a daily schedule's next run is the next occurrence of its time after the run", () => {
    const schedule = scheduleWith({ at: "02:30" }, new Date(Date.UTC(2026, 9, 22, 2, 30)));
    expect(nextRunAfterRun(schedule, new Date(Date.UTC(2026, 9, 22, 2, 31)))).toEqual(
      new Date(Date.UTC(2026, 9, 23, 2, 30)),
    );
  });

  test("a schedule is due once its next run has come", () => {
    const schedule = scheduleWith({ everyHours: 1 }, new Date(2026, 9, 22, 10, 0));
    expect(isDue(schedule, new Date(2026, 9, 22, 9, 59))).toBe(false);
    expect(isDue(schedule, new Date(2026, 9, 22, 10, 0))).toBe(true);
  });
});

describe("schedule time zones", () => {
  test("a zone is an IANA name, and is kept in its canonical spelling", () => {
    expect(canonicalTimezone("Asia/Shanghai")).toBe("Asia/Shanghai");
    expect(canonicalTimezone("America/New_York")).toBe("America/New_York");
    expect(canonicalTimezone("utc")).toBe("UTC");
    for (const name of ["Mars/Olympus", "", "Asia/Shanghai; rm -rf /", "x".repeat(65), 8, null]) {
      expect(canonicalTimezone(name)).toBeNull();
    }
    expect(ruleOf({ at: "03:00", timezone: "asia/shanghai" })?.timezone).toBe("Asia/Shanghai");
    expect(ruleOf({ at: "03:00", timezone: "Mars/Olympus" })).toBeNull();
    expect(ruleOf({ everyHours: 6, timezone: "Asia/Shanghai" })?.timezone).toBeNull();
  });

  test("a UTC offset is not a zone name, although Intl takes one, so it is refused like an unknown zone", () => {
    for (const name of ["+08:00", "-05:00", "+0800", "+08", " +08:00", "-00:00"]) {
      expect(canonicalTimezone(name)).toBeNull();
      expect(ruleOf({ at: "03:00", timezone: name })).toBeNull();
    }
    // The Etc zones are IANA names, even though they read like offsets.
    expect(canonicalTimezone("Etc/GMT-8")).toBe("Etc/GMT-8");
  });

  test("a daily time runs at that time on the zone's clock", () => {
    const shanghai = rule({ at: "03:00", timezone: "Asia/Shanghai" });
    // 21:30 in Shanghai on the 22nd is 13:30 UTC; 03:00 the next morning there is 19:00 UTC on the 22nd.
    expect(firstRunAt(shanghai, utc(2026, 9, 22, 13, 30))).toEqual(utc(2026, 9, 22, 19, 0));
    // Set at 02:00 Shanghai, the same morning's 03:00 is still ahead.
    expect(firstRunAt(shanghai, utc(2026, 9, 21, 18, 0))).toEqual(utc(2026, 9, 21, 19, 0));
    const kolkata = rule({ at: "00:15", timezone: "Asia/Kolkata" });
    expect(firstRunAt(kolkata, utc(2026, 9, 22, 18, 0))).toEqual(utc(2026, 9, 22, 18, 45));
    const auckland = rule({ at: "23:59", timezone: "Pacific/Auckland" });
    expect(firstRunAt(auckland, utc(2026, 11, 31, 11, 0))).toEqual(utc(2026, 11, 31, 10, 59 + 24 * 60));
  });

  test("a daily time keeps to the zone's clock across a daylight saving change", () => {
    // New York moves from EDT (UTC-4) to EST (UTC-5) on 1 November 2026.
    const before = scheduleWith({ at: "03:00", timezone: "America/New_York" }, utc(2026, 9, 31, 7, 0));
    expect(nextRunAfterRun(before, utc(2026, 9, 31, 7, 1))).toEqual(utc(2026, 10, 1, 8, 0));
    // And back to EDT on 8 March 2026.
    expect(nextDailyAfter("03:00", "America/New_York", utc(2026, 2, 7, 8, 1))).toEqual(utc(2026, 2, 8, 7, 0));
    // London: BST ends on 25 October 2026.
    expect(nextDailyAfter("09:00", "Europe/London", utc(2026, 9, 24, 8, 1))).toEqual(utc(2026, 9, 25, 9, 0));
  });

  test("a time the clocks skip runs an hour later, and a time that happens twice runs once, the first time", () => {
    // 02:30 does not exist in New York on 8 March 2026: it runs at 03:30 EDT, 07:30 UTC.
    expect(nextDailyAfter("02:30", "America/New_York", utc(2026, 2, 7, 12, 0))).toEqual(utc(2026, 2, 8, 7, 30));
    expect(nextDailyAfter("02:30", "America/New_York", utc(2026, 2, 8, 7, 31))).toEqual(utc(2026, 2, 9, 6, 30));
    // 01:30 happens twice on 1 November 2026: first at 05:30 UTC (EDT), again at 06:30 UTC (EST).
    const first = nextDailyAfter("01:30", "America/New_York", utc(2026, 9, 31, 12, 0));
    expect(first).toEqual(utc(2026, 10, 1, 5, 30));
    const after = nextDailyAfter("01:30", "America/New_York", new Date(first.getTime() + MINUTE));
    expect(after).toEqual(utc(2026, 10, 2, 6, 30));
  });

  test("a schedule saved before time zones reads back without one and runs in UTC", () => {
    const saved = {
      version: 1,
      hostId: "local",
      boxId: newBoxId(),
      mode: "daily",
      everyHours: null,
      at: "03:00",
      createdBy: "owner",
      createdAt: iso(utc(2026, 9, 21, 0, 0)),
      updatedAt: iso(utc(2026, 9, 21, 0, 0)),
      nextRunAt: iso(utc(2026, 9, 22, 3, 0)),
      lastRun: null,
    };
    const parsed = BoxScheduleSchema.parse(saved);
    expect(parsed.timezone).toBeNull();
    expect(nextRunAfterRun(parsed, utc(2026, 9, 22, 3, 1))).toEqual(utc(2026, 9, 23, 3, 0));
    expect(runZoneOf(parsed)).toEqual({ zone: "UTC", unknown: null });
  });

  test("a saved zone the runtime does not know keeps the schedule, which runs in UTC and names the zone it lost", () => {
    const known = scheduleWith({ at: "03:00", timezone: "Asia/Shanghai" }, utc(2026, 9, 22, 19, 0));
    expect(runZoneOf(known)).toEqual({ zone: "Asia/Shanghai", unknown: null });
    for (const lost of ["Mars/Olympus", "+08:00"]) {
      const parsed = BoxScheduleSchema.parse({ ...known, timezone: lost });
      expect(parsed.timezone).toBe(lost);
      expect(runZoneOf(parsed)).toEqual({ zone: "UTC", unknown: lost });
      expect(nextRunAfterRun(parsed, utc(2026, 9, 22, 19, 1))).toEqual(utc(2026, 9, 23, 3, 0));
    }
    // An interval has no zone to lose.
    expect(runZoneOf({ mode: "interval", timezone: null })).toEqual({ zone: "UTC", unknown: null });
  });
});

describe("checkpoint schedules over the scheduler", () => {
  let restoreLogs: () => void;
  let app: App;
  let runtime: FakeRuntime;
  let engine: FakeCheckpointEngine;
  let host: HostCtx;
  let scheduler: CheckpointScheduler;
  let clock: Date;
  let notes: { source: string; op: string; status: string }[];

  function setup(overrides: Partial<Config> = {}): void {
    const created = createTestApp({ labelPrefix: "mbtest", ...overrides });
    runtime = created.runtime;
    engine = created.checkpoints;
    app = created.app;
    host = app.hosts.get();
    runtime.seedImage(host.baseTemplateTag, { [host.keys.template]: "true", [host.keys.templateName]: "base" });
    notes = [];
    scheduler = new CheckpointScheduler(
      app.hosts,
      (_hostId, source, _principal, note) => notes.push({ source, op: note.op, status: note.status }),
      undefined,
      () => clock,
    );
  }

  const advance = (ms: number): void => {
    clock = new Date(clock.getTime() + ms);
  };

  const makeBox = (name: string) => boxes.createBox(host, { name, cpus: 1, memoryMb: 256, createdBy: "owner" });

  const lastRunOf = async (boxId: string) => (await scheduleOf(host, boxId))?.lastRun;

  beforeEach(() => {
    restoreLogs = silenceLogs();
    clock = new Date(2026, 9, 22, 10, 0);
    setup();
  });

  afterEach(() => {
    restoreLogs();
  });

  test("a due interval takes an automatic checkpoint, records the run, and moves the next run one interval on", async () => {
    const box = await makeBox("alpha");
    expect(box.running).toBe(true);
    const set = await setSchedule(host, box.boxId, rule({ everyHours: 2 }), "owner", clock);
    expect(set.nextRunAt).toBe(iso(new Date(clock.getTime() + 2 * HOUR)));

    expect(await scheduler.run()).toEqual([]);
    advance(2 * HOUR);
    expect(await scheduler.run()).toEqual([box.boxId]);

    const [taken] = host.checkpoints.list();
    expect(taken).toMatchObject({ boxId: box.boxId, auto: true, pinned: false, reason: "Taken on a schedule" });
    const after = await scheduleOf(host, box.boxId);
    expect(after?.lastRun).toEqual({
      at: iso(clock),
      status: "ok",
      reason: null,
      checkpointId: taken?.id ?? null,
      error: null,
    });
    expect(after?.nextRunAt).toBe(iso(new Date(clock.getTime() + 2 * HOUR)));
    expect(notes).toEqual([{ source: "scheduler", op: "checkpoint.scheduled", status: "ok" }]);
  });

  test("a scheduled checkpoint is not activity: the box's idle clock is where it was, and no hold is left", async () => {
    const box = await makeBox("idle");
    await setSchedule(host, box.boxId, rule({ everyHours: 1 }), "owner", clock);
    const before = host.pulse.lastAt(box.boxId);
    advance(HOUR);

    expect(await scheduler.run()).toEqual([box.boxId]);
    expect(host.checkpoints.list()).toHaveLength(1);
    expect(host.pulse.lastAt(box.boxId)).toBe(before);
    expect(host.pulse.isHeld(box.boxId)).toBe(false);
  });

  test("a schedule whose saved zone is unknown is kept: it runs in UTC, is flagged, and is warned about once", async () => {
    const box = await makeBox("lost-zone");
    const set = await setSchedule(host, box.boxId, rule({ at: "03:00", timezone: "Asia/Shanghai" }), "owner", clock);
    expect(set.timezoneUnknown).toBe(false);
    const saved = host.checkpoints.readSchedule(box.boxId);
    if (!saved) throw new Error("the schedule was not saved");
    host.checkpoints.writeSchedule({ ...saved, timezone: "Mars/Olympus", nextRunAt: iso(clock) });
    const warnings = spyOn(log, "warn").mockImplementation(() => {});
    try {
      const read = await scheduleOf(host, box.boxId);
      expect(read).toMatchObject({ mode: "daily", at: "03:00", timezone: "Mars/Olympus", timezoneUnknown: true });

      expect(await scheduler.run()).toEqual([box.boxId]);
      expect(await scheduler.run()).toEqual([]);
      const after = await scheduleOf(host, box.boxId);
      expect(after?.lastRun).toMatchObject({ status: "ok" });
      // The next 03:00 in UTC, and the saved name is left on disk as it was.
      const next = new Date(clock);
      next.setUTCHours(3, 0, 0, 0);
      if (next <= clock) next.setUTCDate(next.getUTCDate() + 1);
      expect(after).toMatchObject({ nextRunAt: iso(next), timezone: "Mars/Olympus", timezoneUnknown: true });

      const warned = warnings.mock.calls.filter(([message]) => message === "checkpoint.schedule_timezone_unknown");
      expect(warned).toHaveLength(1);
      expect(warned[0]?.[1]).toMatchObject({ box: box.boxId, timezone: "Mars/Olympus", fallback: "UTC" });
    } finally {
      warnings.mockRestore();
    }
  });

  test("a stopped box is skipped: nothing is taken, the box stays stopped, and the skip is the last run", async () => {
    const box = await makeBox("beta");
    await boxes.stopBox(host, box.boxId);
    await setSchedule(host, box.boxId, rule({ everyHours: 1 }), "owner", clock);
    advance(HOUR);

    expect(await scheduler.run()).toEqual([box.boxId]);
    expect(host.checkpoints.list()).toEqual([]);
    expect((await boxes.getBox(host, box.boxId)).running).toBe(false);
    expect(await lastRunOf(box.boxId)).toMatchObject({ status: "skipped", reason: "stopped", checkpointId: null });
    expect(notes).toEqual([]);
  });

  test("a sleeping box is skipped, and its schedule does not wake it", async () => {
    const box = await makeBox("gamma");
    expect(await boxes.sleepBox(host, box.boxId, "idle")).toBe(true);
    await setSchedule(host, box.boxId, rule({ everyHours: 1 }), "owner", clock);
    advance(HOUR);

    expect(await scheduler.run()).toEqual([box.boxId]);
    expect(await boxes.getBox(host, box.boxId)).toMatchObject({ running: false, sleeping: true });
    expect(host.checkpoints.list()).toEqual([]);
    expect(await lastRunOf(box.boxId)).toMatchObject({ status: "skipped", reason: "sleeping" });
  });

  test("a repository at its limit skips the box as capacity, and the checkpoint is taken once there is room", async () => {
    setup({ checkpointCapacityMb: 1 });
    const box = await makeBox("delta");
    engine.reportedBytes = 5 * MB;
    await setSchedule(host, box.boxId, rule({ everyHours: 1 }), "owner", clock);
    advance(HOUR);

    await scheduler.run();
    expect(await lastRunOf(box.boxId)).toMatchObject({ status: "skipped", reason: "capacity" });
    expect(host.checkpoints.list()).toEqual([]);

    engine.reportedBytes = 0;
    advance(HOUR);
    await scheduler.run();
    expect(await lastRunOf(box.boxId)).toMatchObject({ status: "ok" });
    expect(host.checkpoints.list()).toHaveLength(1);
  });

  test("a failed backup is recorded as failed with its error, and the schedule still moves to its next run", async () => {
    const box = await makeBox("epsilon");
    for (const mount of host.specs.read(box.boxId)?.mounts ?? []) engine.failBackupOf.add(mount.volume);
    await setSchedule(host, box.boxId, rule({ everyHours: 1 }), "owner", clock);
    advance(HOUR);

    await scheduler.run();
    const failed = await scheduleOf(host, box.boxId);
    expect(failed?.lastRun).toMatchObject({ status: "failed", checkpointId: null });
    expect(typeof failed?.lastRun?.error).toBe("string");
    expect(failed?.nextRunAt).toBe(iso(new Date(clock.getTime() + HOUR)));
    expect(host.checkpoints.list()).toEqual([]);
    expect(notes).toEqual([{ source: "scheduler", op: "checkpoint.scheduled", status: "error" }]);

    engine.failBackupOf.clear();
    advance(HOUR);
    await scheduler.run();
    expect(await lastRunOf(box.boxId)).toMatchObject({ status: "ok" });
    expect(host.checkpoints.list()).toHaveLength(1);
  });

  test("a pass that starts while another is running does nothing, and the schedule runs once", async () => {
    const box = await makeBox("zeta");
    await setSchedule(host, box.boxId, rule({ everyHours: 1 }), "owner", clock);
    advance(HOUR);

    const gate = engine.hold("backup");
    const first = scheduler.run();
    await until(() => gate.blocked() === 1);
    expect(await scheduler.run()).toEqual([]);
    gate.release();

    expect(await first).toEqual([box.boxId]);
    expect(host.checkpoints.list()).toHaveLength(1);
  });

  test("a rule set while its run was in progress keeps its own next run, and the finished run is still recorded", async () => {
    const box = await makeBox("eta");
    await setSchedule(host, box.boxId, rule({ everyHours: 1 }), "owner", clock);
    advance(HOUR);

    const gate = engine.hold("backup");
    const pass = scheduler.run();
    await until(() => gate.blocked() === 1);
    advance(10 * MINUTE);
    const replacement = await setSchedule(host, box.boxId, rule({ at: "09:00" }), "owner", clock);
    gate.release();
    await pass;

    const current = await scheduleOf(host, box.boxId);
    expect(current).toMatchObject({ mode: "daily", at: "09:00", nextRunAt: replacement.nextRunAt });
    expect(current?.lastRun).toMatchObject({ status: "ok" });
    expect(host.checkpoints.list()).toHaveLength(1);
  });

  test("a schedule whose box was deleted is dropped on the next pass, and never runs", async () => {
    const box = await makeBox("theta");
    await setSchedule(host, box.boxId, rule({ everyHours: 1 }), "owner", clock);
    await boxes.deleteBox(host, box.boxId, false);
    advance(HOUR);

    expect(await scheduler.run()).toEqual([]);
    expect(host.checkpoints.schedules()).toEqual([]);
  });

  test("schedules are off by default: a new box has none, and passes over it take nothing", async () => {
    const box = await makeBox("iota");
    expect(await scheduleOf(host, box.boxId)).toBeNull();
    advance(30 * DAY);

    expect(await scheduler.run()).toEqual([]);
    expect(host.checkpoints.list()).toEqual([]);
    expect(notes).toEqual([]);
  });

  test("a schedule overdue when the process comes back runs once, and its next run is on the grid after now", async () => {
    const box = await makeBox("kappa");
    await setSchedule(host, box.boxId, rule({ everyHours: 2 }), "owner", clock);
    advance(10 * DAY);

    expect(await scheduler.run()).toEqual([box.boxId]);
    expect(host.checkpoints.list()).toHaveLength(1);
    const next = Date.parse((await scheduleOf(host, box.boxId))?.nextRunAt ?? "");
    expect(next).toBeGreaterThan(clock.getTime());
    expect(next).toBeLessThanOrEqual(clock.getTime() + 2 * HOUR);
    expect(await scheduler.run()).toEqual([]);
  });

  test("a daily time runs once at its time in its zone, and its next run is the following day", async () => {
    const box = await makeBox("lambda");
    // 09:00 in Shanghai is 01:00 UTC, whatever zone the server runs in.
    clock = new Date(Date.UTC(2026, 9, 22, 10, 0));
    await setSchedule(host, box.boxId, rule({ at: "09:00", timezone: "Asia/Shanghai" }), "owner", clock);
    clock = new Date(Date.UTC(2026, 9, 23, 0, 59));
    expect(await scheduler.run()).toEqual([]);
    advance(MINUTE);

    expect(await scheduler.run()).toEqual([box.boxId]);
    advance(MINUTE);
    expect(await scheduler.run()).toEqual([]);
    expect((await scheduleOf(host, box.boxId))?.nextRunAt).toBe(iso(new Date(Date.UTC(2026, 9, 24, 1, 0))));
  });

  test("retention keeps the newest automatic checkpoints of a scheduled box, as it does for any automatic one", async () => {
    setup({ checkpointKeepLast: 2, checkpointKeepDays: 0 });
    const box = await makeBox("mu");
    await setSchedule(host, box.boxId, rule({ everyHours: 1 }), "owner", clock);
    for (let i = 0; i < 4; i++) {
      advance(HOUR);
      expect(await scheduler.run()).toEqual([box.boxId]);
    }
    expect(host.checkpoints.list()).toHaveLength(4);

    await applyRetention(host, clock.getTime());
    expect(host.checkpoints.list()).toHaveLength(2);
  });

  test("a schedule survives a restart: a new process on the same data directory takes the checkpoint when it is due", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mbsched-"));
    const shared = runtime;
    const first = createTestApp({ labelPrefix: "mbtest", dataDir }, shared);
    const firstHost = first.app.hosts.get();
    const box = await boxes.createBox(firstHost, { name: "restart", cpus: 1, memoryMb: 256, createdBy: "owner" });
    await setSchedule(firstHost, box.boxId, rule({ everyHours: 2 }), "owner", clock);

    const second = createTestApp({ labelPrefix: "mbtest", dataDir }, shared);
    const secondHost = second.app.hosts.get();
    const restarted = new CheckpointScheduler(
      second.app.hosts,
      () => {},
      undefined,
      () => clock,
    );
    advance(2 * HOUR);

    expect(await restarted.run()).toEqual([box.boxId]);
    expect(secondHost.checkpoints.list()).toHaveLength(1);
  });

  test("clearing a schedule stops its runs, and the checkpoints it took are kept", async () => {
    const box = await makeBox("nu");
    await setSchedule(host, box.boxId, rule({ everyHours: 1 }), "owner", clock);
    advance(HOUR);
    await scheduler.run();
    expect(host.checkpoints.list()).toHaveLength(1);

    await clearSchedule(host, box.boxId);
    advance(HOUR);
    expect(await scheduler.run()).toEqual([]);
    expect(await scheduleOf(host, box.boxId)).toBeNull();
    expect(host.checkpoints.list()).toHaveLength(1);
  });
});

describe("the schedule routes", () => {
  let harness: Harness;
  let restoreLogs: () => void;
  const ROOMY_HOST = { cpu: { cores: 64 }, memory: { total: 64 * 1024 ** 3 } } as unknown as HostMetrics;

  beforeEach(() => {
    restoreLogs = silenceLogs();
    harness = startHarness();
    harness.app.monitor.snapshot = async () => ROOMY_HOST;
  });

  afterEach(() => {
    harness.stop();
    restoreLogs();
  });

  async function makeBox(name: string): Promise<string> {
    const reply = await call(harness.base, "/api/boxes", { body: { name, cpus: 1, memoryMb: 256 } });
    expect(reply.status).toBe(201);
    return reply.json.box?.boxId ?? "";
  }

  test("a box has no schedule until one is set, and the one set reads back with its next run", async () => {
    const boxId = await makeBox("alpha");
    expect(bodyOf(await call(harness.base, pathOf(boxId)))).toBeNull();

    const before = Date.now();
    const put = await call(harness.base, pathOf(boxId), { method: "PUT", body: { everyHours: 6 } });
    expect(put.status).toBe(200);
    expect(bodyOf(put)).toMatchObject({ mode: "interval", everyHours: 6, at: null, lastRun: null });
    const due = Date.parse(bodyOf(put)?.nextRunAt ?? "");
    expect(Math.abs(due - (before + 6 * HOUR))).toBeLessThan(MINUTE);

    const read = await call(harness.base, pathOf(boxId));
    expect(bodyOf(read)).toMatchObject({ mode: "interval", everyHours: 6 });
  });

  test("a daily time replaces an interval, and a rule that is neither or both is refused, leaving the schedule as it was", async () => {
    const boxId = await makeBox("beta");
    const daily = await call(harness.base, pathOf(boxId), { method: "PUT", body: { at: "02:30" } });
    expect(bodyOf(daily)).toMatchObject({ mode: "daily", everyHours: null, at: "02:30", timezone: "UTC" });

    expect(refused(await call(harness.base, pathOf(boxId), { method: "PUT", body: {} }))).toEqual({
      status: 400,
      key: "schedule_rule_invalid",
    });
    expect(
      refused(await call(harness.base, pathOf(boxId), { method: "PUT", body: { everyHours: 6, at: "02:30" } })),
    ).toEqual({ status: 400, key: "schedule_rule_invalid" });
    expect((await call(harness.base, pathOf(boxId), { method: "PUT", body: { everyHours: 0 } })).status).toBe(400);

    expect(bodyOf(await call(harness.base, pathOf(boxId)))).toMatchObject({ mode: "daily", at: "02:30" });
  });

  test("a daily time is set in the zone it names, and a zone that is not one is refused", async () => {
    const boxId = await makeBox("zoned");
    const before = Date.now();
    const put = await call(harness.base, pathOf(boxId), {
      method: "PUT",
      body: { at: "03:00", timezone: "Asia/Shanghai" },
    });
    expect(put.status).toBe(200);
    const saved = bodyOf(put);
    expect(saved).toMatchObject({ mode: "daily", at: "03:00", timezone: "Asia/Shanghai" });
    const next = Date.parse(saved?.nextRunAt ?? "");
    expect(next).toBeGreaterThan(before);
    expect(next - before).toBeLessThanOrEqual(DAY);
    expect(new Date(next).getUTCHours()).toBe(19);
    expect(new Date(next).getUTCMinutes()).toBe(0);
    expect(bodyOf(await call(harness.base, pathOf(boxId)))).toMatchObject({ timezone: "Asia/Shanghai" });

    expect(
      refused(
        await call(harness.base, pathOf(boxId), { method: "PUT", body: { at: "03:00", timezone: "Mars/Olympus" } }),
      ),
    ).toEqual({ status: 400, key: "schedule_timezone_invalid" });
    expect(
      refused(await call(harness.base, pathOf(boxId), { method: "PUT", body: { at: "03:00", timezone: "+08:00" } })),
    ).toEqual({ status: 400, key: "schedule_timezone_invalid" });
    expect(bodyOf(await call(harness.base, pathOf(boxId)))).toMatchObject({
      timezone: "Asia/Shanghai",
      timezoneUnknown: false,
    });

    const interval = await call(harness.base, pathOf(boxId), {
      method: "PUT",
      body: { everyHours: 6, timezone: "Asia/Shanghai" },
    });
    expect(bodyOf(interval)).toMatchObject({ mode: "interval", timezone: null });
  });

  test("clearing removes the schedule, and clearing a box with none is not an error", async () => {
    const boxId = await makeBox("gamma");
    await call(harness.base, pathOf(boxId), { method: "PUT", body: { everyHours: 3 } });

    const cleared = await call(harness.base, pathOf(boxId), { method: "DELETE" });
    expect(cleared.status).toBe(200);
    expect(bodyOf(await call(harness.base, pathOf(boxId)))).toBeNull();
    expect((await call(harness.base, pathOf(boxId), { method: "DELETE" })).status).toBe(200);
  });

  test("a token is refused: schedules are owner only, for reading as well as for writing", async () => {
    const boxId = await makeBox("delta");
    const admin = mint(harness.app, { name: "admin", preset: "admin" });
    const denied = { status: 403, key: "operation_forbidden" };

    expect(refused(await call(harness.base, pathOf(boxId), { token: admin.secret }))).toEqual(denied);
    expect(
      refused(await call(harness.base, pathOf(boxId), { method: "PUT", body: { everyHours: 1 }, token: admin.secret })),
    ).toEqual(denied);
    expect(refused(await call(harness.base, pathOf(boxId), { method: "DELETE", token: admin.secret }))).toEqual(denied);
  });
});
