import {
  type BoxSchedule,
  firstRunAt,
  isDue,
  nextRunAfterRun,
  type ScheduleRule,
  type ScheduleRun,
  SCHEDULE_VERSION,
  type SkipReason,
} from "../checkpoints/schedule";
import type { HostCtx, HostRegistry } from "../host/registry";
import { AppError } from "../lib/errors";
import { log } from "../lib/logger";
import { OWNER } from "../operations/types";
import { type Box, getBox } from "./boxes";
import { assertAutomaticAllowed } from "./checkpoint-capacity";
import { backupBox, underBox } from "./checkpoints";
import type { RecordNote } from "./terminals";

export const SCHEDULER_EVERY_MS = 60 * 1000;

type Outcome = Pick<ScheduleRun, "status" | "reason" | "checkpointId" | "error">;

const skipped = (reason: SkipReason): Outcome => ({ status: "skipped", reason, checkpointId: null, error: null });

/**
 * Takes the checkpoints that box schedules are due for. A pass runs the due schedules one after another, so a backup
 * never competes with another on the same engine. A stopped or sleeping box is skipped, not woken, and a box the
 * capacity limit refuses is skipped until the repository has room. Each run is recorded on its schedule, so the UI
 * shows the last and next run, and the schedule is read again from disk on every pass, so a restart loses nothing.
 */
export class CheckpointScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private passing = false;

  constructor(
    private readonly hosts: HostRegistry,
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

  /** One pass at `now`. Returns the ids of the boxes whose schedule was due and ran. A pass already running returns none. */
  async run(now = this.clock()): Promise<string[]> {
    if (this.passing) return [];
    this.passing = true;
    const ran: string[] = [];
    try {
      for (const host of this.hosts.list()) {
        if (host.host.transport !== "local" && host.host.status !== "online") continue;
        for (const schedule of host.checkpoints.schedules()) {
          if (schedule.hostId !== host.host.id) continue;
          if (!host.specs.read(schedule.boxId)) {
            await this.drop(host, schedule.boxId);
            continue;
          }
          if (!isDue(schedule, now)) continue;
          ran.push(schedule.boxId);
          await this.runOne(host, schedule).catch((e: unknown) => {
            log.error("checkpoint.schedule_failed", { host: host.host.id, box: schedule.boxId, error: String(e) });
          });
        }
      }
    } finally {
      this.passing = false;
    }
    return ran;
  }

  private async tick(): Promise<void> {
    try {
      const ran = await this.run();
      if (ran.length > 0) log.info("checkpoint.schedules_ran", { count: ran.length });
    } catch (e) {
      log.error("checkpoint.schedule_pass_failed", { error: String(e) });
    }
  }

  /** A schedule whose box no longer exists is removed, so it is never due again. */
  private async drop(host: HostCtx, boxId: string): Promise<void> {
    await host.checkpoints.exclusive(async () => host.checkpoints.removeSchedule(boxId));
    log.info("checkpoint.schedule_removed", { host: host.host.id, box: boxId });
  }

  private async runOne(host: HostCtx, schedule: BoxSchedule): Promise<void> {
    const outcome = await this.attempt(host, schedule.boxId);
    const finished = this.clock();
    const run: ScheduleRun = { at: finished.toISOString(), ...outcome };
    await host.checkpoints.exclusive(async () => {
      const current = host.checkpoints.readSchedule(schedule.boxId);
      if (!current) return;
      // A rule set while this ran has its own first run, so the run is recorded and that run is left as it is.
      const replaced = current.updatedAt !== schedule.updatedAt;
      host.checkpoints.writeSchedule({
        ...current,
        nextRunAt: replaced ? current.nextRunAt : nextRunAfterRun(current, finished).toISOString(),
        lastRun: run,
      });
    });
    if (outcome.status !== "skipped") this.note(host, schedule.boxId, outcome);
  }

  private async attempt(host: HostCtx, boxId: string): Promise<Outcome> {
    try {
      return await underBox(host, boxId, (box) => this.take(host, box));
    } catch (e) {
      if (e instanceof AppError && e.status === 404) return skipped("gone");
      return { status: "failed", reason: null, checkpointId: null, error: messageOf(e) };
    }
  }

  private async take(host: HostCtx, box: Box): Promise<Outcome> {
    if (box.sleeping) return skipped("sleeping");
    if (!box.running) return skipped("stopped");
    try {
      await assertAutomaticAllowed(host);
    } catch (e) {
      if (e instanceof AppError && e.status === 409) return skipped("capacity");
      throw e;
    }
    const checkpoint = await backupBox(
      host,
      box,
      {
        pinned: false,
        include: { system: false, volumes: [] },
        consistency: "live",
        reason: "Taken on a schedule",
      },
      null,
      undefined,
      true,
    );
    return { status: "ok", reason: null, checkpointId: checkpoint.id, error: null };
  }

  private note(host: HostCtx, boxId: string, outcome: Outcome): void {
    const spec = host.specs.read(boxId);
    const name = spec?.name ?? boxId;
    const ok = outcome.status === "ok";
    this.record(host.host.id, "scheduler", OWNER, {
      op: "checkpoint.scheduled",
      kind: "write",
      status: ok ? "ok" : "error",
      summary: ok ? `Scheduled checkpoint of ${name}` : `Scheduled checkpoint of ${name} failed`,
      target: spec ? { kind: "box", id: spec.containerId, name: spec.name } : undefined,
      detail: { boxId, checkpointId: outcome.checkpointId, error: outcome.error },
      error: ok ? undefined : { code: "scheduled_failed", status: 500 },
    });
    if (ok) log.info("checkpoint.scheduled", { host: host.host.id, box: boxId, id: outcome.checkpointId });
    else log.error("checkpoint.scheduled_failed", { host: host.host.id, box: boxId, error: outcome.error });
  }
}

/** The schedule of a box, or null when it has none. Schedules are off until one is set. */
export async function scheduleOf(host: HostCtx, boxRef: string): Promise<BoxSchedule | null> {
  const { boxId } = await getBox(host, boxRef);
  return host.checkpoints.readSchedule(boxId);
}

/**
 * Sets a box's schedule. The first run is one interval, or the next daily time, after `now`. Setting a rule again
 * replaces the rule and its next run, and keeps the last run and the creation time.
 */
export async function setSchedule(
  host: HostCtx,
  boxRef: string,
  rule: ScheduleRule,
  createdBy: string | null,
  now = new Date(),
): Promise<BoxSchedule> {
  const { boxId } = await getBox(host, boxRef);
  return host.checkpoints.exclusive(async () => {
    const existing = host.checkpoints.readSchedule(boxId);
    const stamp = now.toISOString();
    const schedule: BoxSchedule = {
      version: SCHEDULE_VERSION,
      hostId: host.host.id,
      boxId,
      mode: rule.mode,
      everyHours: rule.everyHours,
      at: rule.at,
      createdBy,
      createdAt: existing?.createdAt ?? stamp,
      updatedAt: stamp,
      nextRunAt: firstRunAt(rule, now).toISOString(),
      lastRun: existing?.lastRun ?? null,
    };
    host.checkpoints.writeSchedule(schedule);
    return schedule;
  });
}

/** Removes a box's schedule. Clearing a box with none is not an error. */
export async function clearSchedule(host: HostCtx, boxRef: string): Promise<void> {
  const { boxId } = await getBox(host, boxRef);
  await host.checkpoints.exclusive(async () => host.checkpoints.removeSchedule(boxId));
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
