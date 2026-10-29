import { BACKUP_SCHEDULE_VERSION, type BackupSchedule, type BackupScheduleRun } from "../backup/schedule";
import type { BackupScheduleStore } from "../backup/schedule-store";
import { firstRunAt, isDue, nextRunAfterRun, ruleOf, runZoneOf, type ScheduleRule } from "../checkpoints/schedule";
import { LOCAL_HOST_ID } from "../host/registry";
import { AppError, badRequest } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { OWNER } from "../operations/types";
import type { BackupService } from "./backup";
import type { RecordNote } from "./terminals";

const SCHEDULER_EVERY_MS = 60 * 1000;

/** A schedule as the API returns it: `timezoneUnknown` says its saved zone is not one this server knows, so it runs in UTC. */
export type BackupScheduleView = BackupSchedule & { timezoneUnknown: boolean };

/**
 * Makes backups of DATA_DIR on a schedule. It has the checkpoint scheduler's shape, with one schedule instead of one per
 * box: a `start()`/`stop()` interval, a record under DATA_DIR, a due check on every pass, and one log line per outcome.
 *
 * A pass makes at most one backup, through the same `BackupService.create` the manual path uses, so `BACKUP_KEEP` applies
 * afterwards exactly as it does to a backup made by hand. A schedule that fell due while MiniBox was down runs once when
 * it comes back, not once per missed slot: the next run is the first slot after now. A failed run is recorded on the
 * schedule and logged once, and nothing runs again until the next slot.
 *
 * The passphrase of a scheduled run is `BACKUP_PASSPHRASE`: a schedule runs inside MiniBox with nobody to ask, so the
 * operator sets it in the same file as the rest of the settings. Setting a schedule without one is refused; a schedule
 * that outlives the setting fails once at its next slot with a message saying so.
 */
export class BackupScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private passing = false;
  // Keep a consumed slot in memory even if persisting its result fails.
  private consumed: { updatedAt: string; slot: string; next: number } | null = null;

  constructor(
    private readonly store: BackupScheduleStore,
    private readonly backups: BackupService,
    private readonly passphrase: string | null,
    private readonly record: RecordNote,
    private readonly everyMs = SCHEDULER_EVERY_MS,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass at `now`. Returns the id of the backup it made, or null when none was due or the run failed. */
  async run(now = this.clock()): Promise<string | null> {
    if (this.passing) return null;
    const schedule = this.store.read();
    if (schedule === null || !isDue(schedule, now)) return null;
    if (
      this.consumed?.updatedAt === schedule.updatedAt &&
      this.consumed.slot === schedule.nextRunAt &&
      now.getTime() < this.consumed.next
    )
      return null;
    this.passing = true;
    try {
      return await this.runOne(schedule);
    } finally {
      this.passing = false;
    }
  }

  private async tick(): Promise<void> {
    try {
      await this.run();
    } catch (e) {
      log.error("backup.schedule_pass_failed", { error: String(e) });
    }
  }

  private async runOne(schedule: BackupSchedule): Promise<string | null> {
    const outcome = await this.attempt();
    const finished = this.clock();
    const run: BackupScheduleRun = { at: finished.toISOString(), ...outcome };
    const current = this.store.read();
    if (current !== null) {
      // A rule set while this ran has its own first run, so the run is recorded and that run is left as it is.
      const replaced = current.updatedAt !== schedule.updatedAt;
      const nextRunAt = replaced ? current.nextRunAt : nextRunAfterRun(current, finished).toISOString();
      this.consumed = { updatedAt: current.updatedAt, slot: current.nextRunAt, next: Date.parse(nextRunAt) };
      this.store.write({
        ...current,
        nextRunAt,
        lastRun: run,
      });
    }
    this.note(outcome);
    return outcome.status === "ok" ? outcome.backupId : null;
  }

  private async attempt(): Promise<Omit<BackupScheduleRun, "at">> {
    if (this.passphrase === null) return failure(msg("backup_schedule_passphrase_unset"));
    try {
      const record = await this.backups.create(this.passphrase, OWNER.id);
      return { status: "ok", backupId: record.id, bytes: record.bytes, error: null, errorKey: null, errorParams: null };
    } catch (e) {
      // A manual backup holds the folder. Its "wait, then try again" is no use to a schedule, which does not try again
      // until its next slot, so the run says that instead.
      if (e instanceof AppError && e.key === "backup_running") return failure(msg("backup_schedule_busy"));
      if (e instanceof AppError && e.key !== undefined)
        return failure({ key: e.key, params: e.params, text: e.message });
      return failure(messageOf(e));
    }
  }

  /** One audit event per run and one log line, so a failed run is reported once and does not repeat until its next slot. */
  private note(outcome: Omit<BackupScheduleRun, "at">): void {
    const ok = outcome.status === "ok";
    const name = outcome.backupId ?? "DATA_DIR";
    this.record(LOCAL_HOST_ID, "scheduler", OWNER, {
      op: "backup.scheduled",
      kind: "write",
      status: ok ? "ok" : "error",
      summary: ok ? `Scheduled backup ${name}` : "Scheduled backup failed",
      target: { kind: "backup", id: outcome.backupId ?? undefined, name },
      detail: { backupId: outcome.backupId, bytes: outcome.bytes, error: outcome.error },
      error: ok ? undefined : { code: "scheduled_failed", status: 500 },
    });
    if (ok) log.info("backup.scheduled", { id: outcome.backupId, bytes: outcome.bytes });
    else log.error("backup.scheduled_failed", { error: outcome.error });
  }
}

/** The rule a request names, or a 400 that says what a rule is. */
export function backupRuleOf(input: {
  everyHours?: number | null;
  at?: string | null;
  timezone?: string | null;
}): ScheduleRule {
  const rule = ruleOf(input);
  if (rule === null) throw badRequest(msg("schedule_rule_invalid"));
  return rule;
}

/** The saved schedule, or null when it is off, which is the default. */
export function readBackupSchedule(store: BackupScheduleStore): BackupScheduleView | null {
  const schedule = store.read();
  return schedule === null ? null : scheduleView(schedule);
}

/**
 * Sets the schedule. The first run is one interval, or the next daily time in the rule's zone, after `now`. Setting a rule
 * again replaces the rule and its next run, and keeps the last run and the creation time. Schedules are off until one is
 * set, and a set one survives a restart because it is a file.
 */
export function setBackupSchedule(
  store: BackupScheduleStore,
  rule: ScheduleRule,
  createdBy: string | null,
  now = new Date(),
): BackupScheduleView {
  const existing = store.read();
  const stamp = now.toISOString();
  const schedule: BackupSchedule = {
    version: BACKUP_SCHEDULE_VERSION,
    mode: rule.mode,
    everyHours: rule.everyHours,
    at: rule.at,
    timezone: rule.timezone,
    createdBy,
    createdAt: existing?.createdAt ?? stamp,
    updatedAt: stamp,
    nextRunAt: firstRunAt(rule, now).toISOString(),
    lastRun: existing?.lastRun ?? null,
  };
  store.write(schedule);
  return scheduleView(schedule);
}

/** Removes the schedule. Clearing a schedule that is already off is not an error. */
export function clearBackupSchedule(store: BackupScheduleStore): void {
  store.remove();
}

function scheduleView(schedule: BackupSchedule): BackupScheduleView {
  return { ...schedule, timezoneUnknown: runZoneOf(schedule).unknown !== null };
}

/** The message a failure came from: the English text, and the key and parameters a console translates it by. */
interface Reason {
  readonly key: string;
  readonly params?: Record<string, string | number>;
  readonly text: string;
}

/** A failed run. A keyed reason lets the console say it in its own language; a plain one is shown as it is. */
function failure(reason: string | Reason): Omit<BackupScheduleRun, "at"> {
  const plain = typeof reason === "string";
  return {
    status: "failed",
    backupId: null,
    bytes: null,
    error: plain ? reason : reason.text,
    errorKey: plain ? null : reason.key,
    errorParams: plain ? null : (reason.params ?? null),
  };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
