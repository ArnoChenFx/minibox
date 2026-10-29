import { z } from "zod";

import { SCHEDULE_HOURS_MAX, SCHEDULE_HOURS_MIN, SCHEDULE_TIME_RE } from "../checkpoints/schedule";
import { isBackupId } from "./store";

/**
 * The backup schedule: one record for the whole instance, kept in `DATA_DIR/backup-schedule.json`. It says how often a
 * backup is made and when the next one is due. It is off until an operator sets one, and clearing it removes the file.
 *
 * The rule is the checkpoint schedule's rule, read by the checkpoint module's helpers (`src/checkpoints/schedule.ts`),
 * so an operator who knows one knows the other: an interval of whole hours, or a daily time in an IANA zone.
 */

/** On-disk schema version of `DATA_DIR/backup-schedule.json`. */
export const BACKUP_SCHEDULE_VERSION = 1;
/** Thirty days, the same bound as a checkpoint schedule. A longer gap is better served by a manual backup. */
export const BACKUP_SCHEDULE_HOURS_MAX = SCHEDULE_HOURS_MAX;
const TIMEZONE_MAX = 64;

/**
 * One scheduled run. `ok` means an archive was made and `failed` means the run did not make one, such as a missing
 * passphrase or another backup holding the folder. `error` is the English text; `errorKey` and `errorParams` are the
 * message it came from, so a console can say the reason in its own language instead of showing the English.
 */
const BackupScheduleRunSchema = z.strictObject({
  at: z.iso.datetime(),
  status: z.enum(["ok", "failed"]),
  backupId: z.string().refine(isBackupId, "not a backup id").nullable(),
  bytes: z.number().int().min(0).nullable(),
  error: z.string().nullable(),
  errorKey: z.string().nullable().default(null),
  errorParams: z
    .record(z.string(), z.union([z.string(), z.number()]))
    .nullable()
    .default(null),
});

export type BackupScheduleRun = z.infer<typeof BackupScheduleRunSchema>;

export const BackupScheduleSchema = z
  .strictObject({
    version: z.literal(BACKUP_SCHEDULE_VERSION),
    mode: z.enum(["interval", "daily"]),
    everyHours: z.number().int().min(SCHEDULE_HOURS_MIN).max(BACKUP_SCHEDULE_HOURS_MAX).nullable(),
    at: z.string().regex(SCHEDULE_TIME_RE).nullable(),
    /** The IANA zone of a daily time. Null for an interval, and for a daily time saved before zones, which runs in UTC. */
    timezone: z.string().min(1).max(TIMEZONE_MAX).nullable().default(null),
    createdBy: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    nextRunAt: z.iso.datetime(),
    lastRun: BackupScheduleRunSchema.nullable(),
  })
  .refine(
    (schedule) =>
      schedule.mode === "interval"
        ? schedule.everyHours !== null && schedule.at === null
        : schedule.at !== null && schedule.everyHours === null,
    { message: "the rule does not match its mode" },
  );

export type BackupSchedule = z.infer<typeof BackupScheduleSchema>;
