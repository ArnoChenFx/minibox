import { z } from "zod";

import { isBoxId } from "../specs/revision";

/** On-disk schema version of `DATA_DIR/checkpoints/schedules/<box id>.json`. */
export const SCHEDULE_VERSION = 1;
export const SCHEDULE_HOURS_MIN = 1;
/** Thirty days. A longer gap is better served by a manual checkpoint. */
export const SCHEDULE_HOURS_MAX = 720;

const HOUR_MS = 60 * 60 * 1000;
/** A daily time as `HH:MM` on the server's clock, such as `02:30`. */
export const SCHEDULE_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** Why a due run took no checkpoint. The console names each one, so a new reason needs a translation. */
export const SKIP_REASONS = ["sleeping", "stopped", "capacity", "gone"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export interface ScheduleRule {
  readonly mode: "interval" | "daily";
  readonly everyHours: number | null;
  readonly at: string | null;
}

/** A schedule's rule from the request: exactly one of `everyHours` and `at`. Anything else is null. */
export function ruleOf(input: { everyHours?: number | null; at?: string | null }): ScheduleRule | null {
  const hasHours = input.everyHours !== undefined && input.everyHours !== null;
  const hasTime = input.at !== undefined && input.at !== null;
  if (hasHours === hasTime) return null;
  if (hasHours) {
    const hours = input.everyHours ?? 0;
    if (!Number.isInteger(hours) || hours < SCHEDULE_HOURS_MIN || hours > SCHEDULE_HOURS_MAX) return null;
    return { mode: "interval", everyHours: hours, at: null };
  }
  if (!SCHEDULE_TIME_RE.test(input.at ?? "")) return null;
  return { mode: "daily", everyHours: null, at: input.at ?? null };
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
 * occurrence strictly after `from`, in the server's local time.
 */
export function firstRunAt(rule: ScheduleRule, from: Date): Date {
  if (rule.mode === "interval") return new Date(from.getTime() + (rule.everyHours ?? SCHEDULE_HOURS_MIN) * HOUR_MS);
  return nextDailyAfter(rule.at ?? "00:00", from);
}

function nextDailyAfter(at: string, from: Date): Date {
  const [hour = 0, minute = 0] = at.split(":").map(Number);
  const next = new Date(from);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

/**
 * The run after one at `now`, for a schedule that was due at `nextRunAt`. An interval stays on its own grid, so a run
 * that came late does not move the rest; a schedule that was down for days runs once and then waits for the next slot.
 */
export function nextRunAfterRun(schedule: BoxSchedule, now: Date): Date {
  if (schedule.mode === "daily") return nextDailyAfter(schedule.at ?? "00:00", now);
  const step = (schedule.everyHours ?? SCHEDULE_HOURS_MIN) * HOUR_MS;
  const due = Date.parse(schedule.nextRunAt);
  const steps = Math.max(1, Math.floor((now.getTime() - due) / step) + 1);
  return new Date(due + steps * step);
}

export function isDue(schedule: BoxSchedule, now: Date): boolean {
  return Date.parse(schedule.nextRunAt) <= now.getTime();
}
