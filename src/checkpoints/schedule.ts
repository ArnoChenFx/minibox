import { z } from "zod";

import { isBoxId } from "../specs/revision";

/** On-disk schema version of `DATA_DIR/checkpoints/schedules/<box id>.json`. */
export const SCHEDULE_VERSION = 1;
export const SCHEDULE_HOURS_MIN = 1;
/** Thirty days. A longer gap is better served by a manual checkpoint. */
export const SCHEDULE_HOURS_MAX = 720;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A daily time as `HH:MM`, such as `02:30`, in the schedule's time zone. */
export const SCHEDULE_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** Why a due run took no checkpoint. The console names each one, so a new reason needs a translation. */
export const SKIP_REASONS = ["sleeping", "stopped", "capacity", "gone"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];
/** The zone of a daily time that names none, as schedules set before time zones did. */
export const DEFAULT_TIMEZONE = "UTC";
const TIMEZONE_MAX = 64;

export interface ScheduleRule {
  readonly mode: "interval" | "daily";
  readonly everyHours: number | null;
  readonly at: string | null;
  /** The IANA time zone of a daily time, such as `Asia/Shanghai`. Null for an interval. */
  readonly timezone: string | null;
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();

/** The canonical name of an IANA time zone, such as `Asia/Shanghai` or `UTC`, or null when this runtime knows no such zone. */
export function canonicalTimezone(name: unknown): string | null {
  if (typeof name !== "string" || name.length === 0 || name.length > TIMEZONE_MAX) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function zoneFormat(timezone: string): Intl.DateTimeFormat {
  let format = zoneFormats.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    zoneFormats.set(timezone, format);
  }
  return format;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClock(timezone: string, ms: number): WallClock {
  const parts: Record<string, number> = {};
  for (const part of zoneFormat(timezone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year ?? 1970,
    month: parts.month ?? 1,
    day: parts.day ?? 1,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

/** How far the zone's clock is ahead of UTC at `ms`, in milliseconds. */
function offsetAt(timezone: string, ms: number): number {
  const wall = wallClock(timezone, ms);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a wall-clock time in a zone names. A time the clocks skip, in the hour a zone moves forward, is read
 * with the offset before the change, so it runs that much later. A time that happens twice, when the clocks go
 * back, is the first of the two. `day` may run past the month, as with Date.UTC.
 */
export function zonedInstant(
  timezone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const before = offsetAt(timezone, wall - DAY_MS);
  const after = offsetAt(timezone, wall + DAY_MS);
  const fits = [wall - before, wall - after].filter((ms) => wall - offsetAt(timezone, ms) === ms);
  if (fits.length === 0) return wall - before;
  return Math.min(...fits);
}

/** A schedule's rule from the request: exactly one of `everyHours` and `at`. Anything else is null. */
export function ruleOf(input: {
  everyHours?: number | null;
  at?: string | null;
  timezone?: string | null;
}): ScheduleRule | null {
  const hasHours = input.everyHours !== undefined && input.everyHours !== null;
  const hasTime = input.at !== undefined && input.at !== null;
  if (hasHours === hasTime) return null;
  if (hasHours) {
    const hours = input.everyHours ?? 0;
    if (!Number.isInteger(hours) || hours < SCHEDULE_HOURS_MIN || hours > SCHEDULE_HOURS_MAX) return null;
    return { mode: "interval", everyHours: hours, at: null, timezone: null };
  }
  if (!SCHEDULE_TIME_RE.test(input.at ?? "")) return null;
  const timezone =
    input.timezone === undefined || input.timezone === null ? DEFAULT_TIMEZONE : canonicalTimezone(input.timezone);
  if (!timezone) return null;
  return { mode: "daily", everyHours: null, at: input.at ?? null, timezone };
}

export const ScheduleRunSchema = z.strictObject({
  at: z.iso.datetime(),
  status: z.enum(["ok", "skipped", "failed"]),
  reason: z.string().nullable(),
  checkpointId: z.string().nullable(),
  error: z.string().nullable(),
});

export type ScheduleRun = z.infer<typeof ScheduleRunSchema>;

export const BoxScheduleSchema = z
  .strictObject({
    version: z.literal(SCHEDULE_VERSION),
    hostId: z.string().min(1),
    boxId: z.string().refine(isBoxId, "not a box id"),
    mode: z.enum(["interval", "daily"]),
    everyHours: z.number().int().min(SCHEDULE_HOURS_MIN).max(SCHEDULE_HOURS_MAX).nullable(),
    at: z.string().regex(SCHEDULE_TIME_RE).nullable(),
    /** Absent on a schedule saved before time zones, which reads as UTC. */
    timezone: z
      .string()
      .refine((name) => canonicalTimezone(name) !== null, "not a time zone")
      .nullable()
      .default(null),
    createdBy: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    nextRunAt: z.iso.datetime(),
    lastRun: ScheduleRunSchema.nullable(),
  })
  .refine(
    (schedule) =>
      schedule.mode === "interval"
        ? schedule.everyHours !== null && schedule.at === null
        : schedule.at !== null && schedule.everyHours === null,
    { message: "the rule does not match its mode" },
  );

export type BoxSchedule = z.infer<typeof BoxScheduleSchema>;

/**
 * The first run for a rule set at `from`. An interval runs that many hours later. A daily time runs at its next
 * occurrence strictly after `from`, in its time zone.
 */
export function firstRunAt(rule: ScheduleRule, from: Date): Date {
  if (rule.mode === "interval") return new Date(from.getTime() + (rule.everyHours ?? SCHEDULE_HOURS_MIN) * HOUR_MS);
  return nextDailyAfter(rule.at ?? "00:00", rule.timezone ?? DEFAULT_TIMEZONE, from);
}

/** The next time the zone's clocks read `at`, strictly after `from`. */
export function nextDailyAfter(at: string, timezone: string, from: Date): Date {
  const [hour = 0, minute = 0] = at.split(":").map(Number);
  const today = wallClock(timezone, from.getTime());
  for (let ahead = 0; ahead <= 2; ahead++) {
    const next = zonedInstant(timezone, today.year, today.month, today.day + ahead, hour, minute);
    if (next > from.getTime()) return new Date(next);
  }
  return new Date(zonedInstant(timezone, today.year, today.month, today.day + 3, hour, minute));
}

/**
 * The run after one at `now`, for a schedule that was due at `nextRunAt`. An interval stays on its own grid, so a run
 * that came late does not move the rest; a schedule that was down for days runs once and then waits for the next slot.
 */
export function nextRunAfterRun(schedule: BoxSchedule, now: Date): Date {
  if (schedule.mode === "daily") {
    return nextDailyAfter(schedule.at ?? "00:00", schedule.timezone ?? DEFAULT_TIMEZONE, now);
  }
  const step = (schedule.everyHours ?? SCHEDULE_HOURS_MIN) * HOUR_MS;
  const due = Date.parse(schedule.nextRunAt);
  const steps = Math.max(1, Math.floor((now.getTime() - due) / step) + 1);
  return new Date(due + steps * step);
}

export function isDue(schedule: BoxSchedule, now: Date): boolean {
  return Date.parse(schedule.nextRunAt) <= now.getTime();
}
