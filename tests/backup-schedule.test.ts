import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { App } from "../src/app";
import { restoreArchive } from "../src/backup/restore";
import { BackupScheduleSchema } from "../src/backup/schedule";
import { BackupScheduleStore } from "../src/backup/schedule-store";
import { ruleOf } from "../src/checkpoints/schedule";
import { type Config, loadConfig } from "../src/config";
import { SECRET_FILE_MODE } from "../src/data-dir";
import { ulid } from "../src/events/ulid";
import { AppError } from "../src/lib/errors";
import { setLogSink } from "../src/lib/logger";
import { msg } from "../src/lib/messages";
import {
  readBackupSchedule,
  BackupScheduler,
  setBackupSchedule,
  clearBackupSchedule,
} from "../src/services/backup-schedule";
import { createTestApp, silenceLogs } from "./support/app";

const PASSPHRASE = "correct horse battery staple";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (date: Date): string => date.toISOString();

/** A rule as a request would send it. */
function rule(input: { everyHours?: number; at?: string; timezone?: string }) {
  const found = ruleOf(input);
  if (!found) throw new Error(`not a rule: ${JSON.stringify(input)}`);
  return found;
}

let restoreLogs: () => void;
let scratch: string;

beforeEach(() => {
  restoreLogs = silenceLogs();
  scratch = mkdtempSync(join(tmpdir(), "minibox-backup-schedule-"));
});

afterEach(() => {
  restoreLogs();
  rmSync(scratch, { recursive: true, force: true });
});

function schedulerOf(app: App, options: { passphrase?: string | null; clock?: () => Date; everyMs?: number } = {}) {
  const notes: { source: string; op: string; status: string }[] = [];
  const scheduler = new BackupScheduler(
    app.backupSchedule,
    app.backups,
    options.passphrase === undefined ? PASSPHRASE : options.passphrase,
    (_hostId, source, _principal, note) => notes.push({ source, op: note.op, status: note.status }),
    options.everyMs,
    options.clock,
  );
  return { scheduler, notes };
}

describe("the backup schedule record", () => {
  test("there is no schedule until one is set, and clearing one that is off is not an error", () => {
    const store = new BackupScheduleStore(scratch);
    expect(store.read()).toBeNull();
    clearBackupSchedule(store);
    expect(store.read()).toBeNull();
  });

  test("a set schedule survives a restart, because it is a file with mode 600", () => {
    const store = new BackupScheduleStore(scratch);
    const now = new Date(Date.UTC(2026, 9, 22, 10, 0));
    const set = setBackupSchedule(store, rule({ everyHours: 6 }), "owner", now);
    expect(set.nextRunAt).toBe(iso(new Date(now.getTime() + 6 * HOUR)));

    const reopened = new BackupScheduleStore(scratch);
    expect(reopened.read()).toMatchObject({ mode: "interval", everyHours: 6, nextRunAt: set.nextRunAt });
    expect(statSync(store.file()).mode & 0o777).toBe(SECRET_FILE_MODE);
  });

  test("setting a rule again replaces the rule and its next run, and keeps the creation time and the last run", () => {
    const store = new BackupScheduleStore(scratch);
    const first = new Date(Date.UTC(2026, 9, 22, 10, 0));
    setBackupSchedule(store, rule({ everyHours: 6 }), "owner", first);
    const second = new Date(first.getTime() + DAY);
    const replaced = setBackupSchedule(store, rule({ at: "02:30", timezone: "Asia/Shanghai" }), "owner", second);

    expect(replaced).toMatchObject({ mode: "daily", at: "02:30", timezone: "Asia/Shanghai", createdAt: iso(first) });
    expect(replaced.updatedAt).toBe(iso(second));
    expect(replaced.nextRunAt).toBe(iso(new Date(Date.UTC(2026, 9, 23, 18, 30))));
  });

  test("a saved zone the server does not know still reads, and says so", () => {
    const store = new BackupScheduleStore(scratch);
    setBackupSchedule(store, rule({ at: "02:30", timezone: "Asia/Shanghai" }), "owner");
    expect(readBackupSchedule(store)?.timezoneUnknown).toBe(false);

    const schedule = store.read();
    if (!schedule) throw new Error("the schedule was not written");
    store.write({ ...schedule, timezone: "Mars/Olympus" });
    expect(readBackupSchedule(store)).toMatchObject({ timezone: "Mars/Olympus", timezoneUnknown: true });
  });

  test("a file that is not a schedule reads as no schedule instead of stopping the server", () => {
    const store = new BackupScheduleStore(scratch);
    store.write({ ...setBackupSchedule(store, rule({ everyHours: 1 }), "owner"), everyHours: 0 } as never);
    // A file that no longer matches the format is read as no schedule, so the operator can set it again.
    expect(store.read()).toBeNull();
  });
});

describe("a due backup schedule over the scheduler", () => {
  let app: App;
  let clock: Date;

  function setup(overrides: Partial<Config> = {}): void {
    const created = createTestApp({ labelPrefix: "mbtest", ...overrides });
    app = created.app;
  }

  beforeEach(() => {
    clock = new Date(Date.UTC(2026, 9, 22, 10, 0));
    setup();
  });

  test("a completed slot is not repeated when saving its result fails", async () => {
    setBackupSchedule(app.backupSchedule, rule({ everyHours: 1 }), "owner", clock);
    const { scheduler, notes } = schedulerOf(app, { clock: () => clock });
    clock = new Date(clock.getTime() + HOUR);
    app.backupSchedule.write = () => {
      throw new Error("schedule is read-only");
    };
    await expect(scheduler.run()).rejects.toThrow("read-only");
    expect(app.backups.list()).toHaveLength(1);
    // The backup was made, so it is reported although the schedule could not say so.
    expect(notes).toEqual([{ source: "scheduler", op: "backup.scheduled", status: "ok" }]);
    for (let pass = 0; pass < 3; pass++) {
      clock = new Date(clock.getTime() + 60_000);
      expect(await scheduler.run()).toBeNull();
    }
    expect(app.backups.list()).toHaveLength(1);
  });

  test("a scheduled archive restores with the exact literal passphrase from config", async () => {
    const literal = "hunter2hunter2$xyz#end";
    const cfg = loadConfig({ BACKUP_PASSPHRASE: literal, DATA_DIR: scratch }, { envFile: join(scratch, "absent.env") });
    setBackupSchedule(app.backupSchedule, rule({ everyHours: 1 }), "owner", clock);
    const { scheduler } = schedulerOf(app, { passphrase: cfg.backupPassphrase, clock: () => clock });
    clock = new Date(clock.getTime() + HOUR);
    const id = await scheduler.run();
    expect(id).not.toBeNull();
    const destination = join(scratch, "restored");
    expect(await restoreArchive(app.backups.store.pathFor(id!), destination, literal)).toBeGreaterThan(0);
  });

  test("the startup refusal says what works, and does not send anyone to escape the dollar sign", () => {
    const file = join(scratch, ".env");
    writeFileSync(file, "BACKUP_PASSPHRASE=hunter2hunter2\\$xyz\n");
    // Bun takes the backslash away, so the environment holds a string the file does not say, and escaping is refused too.
    let message = "";
    try {
      loadConfig({ BACKUP_PASSPHRASE: "hunter2hunter2$xyz", DATA_DIR: scratch }, { envFile: file });
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain("BACKUP_PASSPHRASE differs");
    expect(message).toContain("process environment");
    expect(message).toContain("does not help");
    // The advice it replaced was a backslash before the dollar sign, which Bun reads and MiniBox's own parser does not.
    expect(message).not.toContain("\\$");
  });

  test("the backup passphrase is masked in recorded events, like the access key", () => {
    const secret = "a passphrase only the redactor knows";
    const { app: sealed } = createTestApp({ backupPassphrase: secret });
    const { event } = sealed.events.append({
      id: ulid(),
      ts: Date.now(),
      durationMs: 1,
      status: "error",
      op: "backup.scheduled",
      kind: "write",
      principal: { type: "owner", id: "owner", name: "owner" },
      source: "rest",
      hostId: "local",
      summary: `Scheduled backup failed while sealing with ${secret}`,
      detail: { note: `sealed with ${secret}` },
    });
    expect(JSON.stringify(event)).not.toContain(secret);
  });

  test("Bun-expanded dotenv passphrases are refused at startup", () => {
    const file = join(scratch, ".env");
    writeFileSync(file, "BACKUP_PASSPHRASE='hunter2hunter2$xyz'\n");
    const run = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `import { loadConfig } from ${JSON.stringify(join(import.meta.dir, "../src/config.ts"))}; loadConfig(process.env, { envFile: ${JSON.stringify(file)} });`,
      ],
      { cwd: scratch, env: { PATH: process.env.PATH ?? "", DATA_DIR: scratch }, stdout: "pipe", stderr: "pipe" },
    );
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("BACKUP_PASSPHRASE differs");
  });

  test("a scheduled run cannot overlap a manual backup and the service unlocks afterwards", async () => {
    setBackupSchedule(app.backupSchedule, rule({ everyHours: 1 }), "owner", clock);
    const { scheduler } = schedulerOf(app, { clock: () => clock });
    clock = new Date(clock.getTime() + HOUR);
    const manual = app.backups.create(PASSPHRASE, "owner");
    expect(await scheduler.run()).toBeNull();
    expect(app.backupSchedule.read()?.lastRun?.status).toBe("skipped");
    await manual;
    expect(app.backups.list()).toHaveLength(1);
    await app.backups.create(PASSPHRASE, "owner");
    expect(app.backups.list()).toHaveLength(2);
  });

  test("a run with no passphrase fails with a reason the console can translate", async () => {
    setBackupSchedule(app.backupSchedule, rule({ everyHours: 1 }), "owner", clock);
    const { scheduler } = schedulerOf(app, { passphrase: null, clock: () => clock });
    clock = new Date(clock.getTime() + HOUR);
    expect(await scheduler.run()).toBeNull();
    const run = app.backupSchedule.read()?.lastRun;
    expect(run).toMatchObject({ status: "failed", errorKey: "backup_schedule_passphrase_unset" });
    expect(run?.error).toContain("BACKUP_PASSPHRASE");
  });

  test("a run that meets a manual backup is skipped, not failed: it says why, and waits for its next slot", async () => {
    setBackupSchedule(app.backupSchedule, rule({ everyHours: 1 }), "owner", clock);
    const lines: string[] = [];
    const restore = setLogSink((_level, line) => lines.push(line));
    const { scheduler, notes } = schedulerOf(app, { clock: () => clock });
    clock = new Date(clock.getTime() + HOUR);
    const manual = app.backups.create(PASSPHRASE, "owner");
    try {
      expect(await scheduler.run()).toBeNull();
    } finally {
      restore();
    }
    const schedule = app.backupSchedule.read();
    expect(schedule?.lastRun).toMatchObject({
      status: "skipped",
      reason: "busy",
      backupId: null,
      error: null,
      errorKey: null,
    });
    // The schedule moved on to its next slot, as it does after any run, and the manual backup was left alone.
    expect(Date.parse(schedule?.nextRunAt ?? "")).toBeGreaterThan(clock.getTime());
    await manual;
    expect(app.backups.list()).toHaveLength(1);
    // Nothing failed and nothing was made, so there is no audit event and no error line; the log says it was skipped.
    expect(notes).toEqual([]);
    expect(lines.filter((line) => line.includes('"level":"error"'))).toEqual([]);
    expect(lines.filter((line) => line.includes("backup.scheduled_skipped"))).toHaveLength(1);
  });

  test("a failure with a message of its own keeps its key and parameters", async () => {
    setBackupSchedule(app.backupSchedule, rule({ everyHours: 1 }), "owner", clock);
    const { scheduler } = schedulerOf(app, { clock: () => clock });
    clock = new Date(clock.getTime() + HOUR);
    app.backups.create = async () => {
      throw new AppError(409, "conflict", msg("backup_exists", { id: "bk_sample" }));
    };
    expect(await scheduler.run()).toBeNull();
    expect(app.backupSchedule.read()?.lastRun).toMatchObject({
      status: "failed",
      errorKey: "backup_exists",
      errorParams: { id: "bk_sample" },
    });
  });

  test("a damaged schedule file is named once, however often the scheduler reads it", () => {
    const lines: string[] = [];
    const restore = setLogSink((_level, line) => lines.push(line));
    try {
      writeFileSync(app.backupSchedule.file(), "{ not json");
      for (let pass = 0; pass < 5; pass++) expect(app.backupSchedule.read()).toBeNull();
      expect(lines.filter((line) => line.includes("backup.schedule_unreadable"))).toHaveLength(1);
      // Setting it again mends the file, so the next break is news again.
      setBackupSchedule(app.backupSchedule, rule({ everyHours: 1 }), "owner", clock);
      writeFileSync(app.backupSchedule.file(), "{ not json");
      app.backupSchedule.read();
      expect(lines.filter((line) => line.includes("backup.schedule_unreadable"))).toHaveLength(2);
    } finally {
      restore();
    }
  });

  test("an unreadable backup record is named once, however often the backups are listed", () => {
    const store = app.backups.store;
    store.ensureDir();
    const id = store.allocateId();
    writeFileSync(join(store.dir(), `${id}.json`), "{ not json");
    const lines: string[] = [];
    const restore = setLogSink((_level, line) => lines.push(line));
    try {
      for (let pass = 0; pass < 4; pass++) store.list();
      expect(lines.filter((line) => line.includes("backup.record_unreadable"))).toHaveLength(1);
    } finally {
      restore();
    }
  });

  test("the schedule is off by default, and a pass over it makes nothing", async () => {
    const { scheduler } = schedulerOf(app, { clock: () => clock });
    expect(readBackupSchedule(app.backupSchedule)).toBeNull();
    clock = new Date(clock.getTime() + 30 * DAY);
    expect(await scheduler.run()).toBeNull();
    expect(app.backups.list()).toEqual([]);
  });

  test("a due run makes one backup through the same service the manual path uses, and moves the next run on", async () => {
    setBackupSchedule(app.backupSchedule, rule({ everyHours: 2 }), "owner", clock);
    const { scheduler, notes } = schedulerOf(app, { clock: () => clock });

    expect(await scheduler.run()).toBeNull();
    clock = new Date(clock.getTime() + 2 * HOUR);
    const made = await scheduler.run();
    expect(made).not.toBeNull();

    const backups = app.backups.list();
    expect(backups).toHaveLength(1);
    expect(backups[0]?.id).toBe(made ?? "");
    expect(backups[0]?.createdBy).toBe("owner");

    const after = readBackupSchedule(app.backupSchedule);
    expect(after?.lastRun).toMatchObject({ status: "ok", backupId: made, bytes: backups[0]?.bytes });
    expect(after?.nextRunAt).toBe(iso(new Date(clock.getTime() + 2 * HOUR)));
    expect(notes).toEqual([{ source: "scheduler", op: "backup.scheduled", status: "ok" }]);
  });

  test("BACKUP_KEEP applies to a scheduled backup, so with it set a schedule cannot fill the disk on its own", async () => {
    setup({ backupKeep: 2 });
    setBackupSchedule(app.backupSchedule, rule({ everyHours: 1 }), "owner", clock);
    const { scheduler } = schedulerOf(app, { clock: () => clock });

    for (let run = 1; run <= 4; run++) {
      clock = new Date(clock.getTime() + HOUR);
      await scheduler.run();
      expect(app.backups.list()).toHaveLength(Math.min(run, 2));
    }
  });

  test("a failed run is recorded and logged once, and does not spin: the next run waits for its slot", async () => {
    const store = new BackupScheduleStore(app.cfg.dataDir);
    const lines: string[] = [];
    const restoreSink = setLogSink((_level, line) => lines.push(line), "debug");
    try {
      setBackupSchedule(app.backupSchedule, rule({ everyHours: 1 }), "owner", clock);
      const { scheduler } = schedulerOf(app, { passphrase: null, clock: () => clock });
      clock = new Date(clock.getTime() + HOUR);

      const first = await scheduler.run();
      expect(first).toBeNull();
      expect(lines.filter((line) => line.includes("backup.scheduled_failed"))).toHaveLength(1);
      const after = readBackupSchedule(app.backupSchedule);
      expect(after?.lastRun).toMatchObject({ status: "failed", backupId: null });
      expect(typeof after?.lastRun?.error).toBe("string");
      expect(after?.nextRunAt).toBe(iso(new Date(clock.getTime() + HOUR)));

      // The same instant does not run again, so a pass every minute cannot repeat a failed run.
      expect(await scheduler.run()).toBeNull();
      expect(lines.filter((line) => line.includes("backup.scheduled_failed"))).toHaveLength(1);
      expect(store.read()).not.toBeNull();
    } finally {
      restoreSink();
    }
  });

  test("a schedule that fell due while MiniBox was down runs once when it comes back, not once per missed slot", async () => {
    const due = new Date(Date.UTC(2026, 9, 22, 10, 0));
    setBackupSchedule(app.backupSchedule, rule({ everyHours: 2 }), "owner", due);
    const { scheduler } = schedulerOf(app, { clock: () => clock });
    clock = new Date(due.getTime() + 10 * DAY);

    expect(await scheduler.run()).not.toBeNull();
    expect(app.backups.list()).toHaveLength(1);
    const after = readBackupSchedule(app.backupSchedule);
    expect(Date.parse(after?.nextRunAt ?? "")).toBeGreaterThan(clock.getTime());
    expect(Date.parse(after?.nextRunAt ?? "")).toBeLessThanOrEqual(clock.getTime() + 2 * HOUR);
    // Nothing else is due, so the following pass makes no second backup.
    expect(await scheduler.run()).toBeNull();
    expect(app.backups.list()).toHaveLength(1);
  });

  test("a pass that starts while another is running does nothing, and the schedule runs once", async () => {
    setBackupSchedule(app.backupSchedule, rule({ everyHours: 1 }), "owner", clock);
    const { scheduler } = schedulerOf(app, { clock: () => clock });
    clock = new Date(clock.getTime() + HOUR);

    const [first, second] = await Promise.all([scheduler.run(), scheduler.run()]);
    const made = [first, second].filter((id) => id !== null);
    expect(made).toHaveLength(1);
    expect(app.backups.list()).toHaveLength(1);
  });

  test("a rule set while its run was in progress keeps its own first run, even one the old run outlasted", async () => {
    setBackupSchedule(app.backupSchedule, rule({ everyHours: 1 }), "owner", clock);
    const { scheduler } = schedulerOf(app, { clock: () => clock });
    clock = new Date(clock.getTime() + HOUR);

    // Replace the rule while the backup is writing, with a daily time half an hour away, and let the backup outlast it.
    // The scheduler reads the file again before it records the run, and must not move the new rule's first run on.
    const pass = scheduler.run();
    const replacement = setBackupSchedule(
      app.backupSchedule,
      rule({ at: "11:30", timezone: "UTC" }),
      "owner",
      new Date(clock.getTime() + 5 * 60 * 1000),
    );
    clock = new Date(clock.getTime() + 40 * 60 * 1000);
    await pass;
    expect(Date.parse(replacement.nextRunAt)).toBeLessThan(clock.getTime());

    const current = readBackupSchedule(app.backupSchedule);
    expect(current).toMatchObject({ mode: "daily", at: "11:30", nextRunAt: replacement.nextRunAt });
    expect(current?.lastRun).toMatchObject({ status: "ok" });
    expect(app.backups.list()).toHaveLength(1);
    // That first run is overdue, so the next pass makes it.
    expect(await scheduler.run()).not.toBeNull();
    expect(app.backups.list()).toHaveLength(2);
  });

  test("a cleared schedule runs nothing, and the archive it already made is kept", async () => {
    setBackupSchedule(app.backupSchedule, rule({ everyHours: 1 }), "owner", clock);
    const { scheduler } = schedulerOf(app, { clock: () => clock });
    clock = new Date(clock.getTime() + HOUR);
    await scheduler.run();
    clearBackupSchedule(app.backupSchedule);

    clock = new Date(clock.getTime() + DAY);
    expect(await scheduler.run()).toBeNull();
    expect(app.backups.list()).toHaveLength(1);
  });

  test("a backup that fails after its archive was written is recorded as failed, and the archive is not left behind", async () => {
    setBackupSchedule(app.backupSchedule, rule({ everyHours: 1 }), "owner", clock);
    const { scheduler, notes } = schedulerOf(app, { clock: () => clock });
    clock = new Date(clock.getTime() + HOUR);
    // The archive is whole and in place when the record that names it cannot be saved.
    app.backups.store.write = () => {
      throw new Error("the record cannot be saved");
    };

    expect(await scheduler.run()).toBeNull();
    expect(readBackupSchedule(app.backupSchedule)?.lastRun).toMatchObject({
      status: "failed",
      backupId: null,
      error: "the record cannot be saved",
    });
    expect(notes).toEqual([{ source: "scheduler", op: "backup.scheduled", status: "error" }]);
    expect(readdirSync(app.cfg.backupDir)).toEqual([]);
    // The folder is free again: a second try meets the same failure, not a backup that is still running.
    await expect(app.backups.create(PASSPHRASE, null)).rejects.toThrow("the record cannot be saved");
  });

  test("a backup folder that cannot be used is recorded as failed, and nothing is made in it", async () => {
    const blocked = join(scratch, "blocked");
    // A file where the backup folder should be makes every write fail.
    (await import("node:fs")).writeFileSync(blocked, "not a folder");
    setup({ backupDir: blocked });
    setBackupSchedule(app.backupSchedule, rule({ everyHours: 1 }), "owner", clock);
    const { scheduler, notes } = schedulerOf(app, { clock: () => clock });
    clock = new Date(clock.getTime() + HOUR);

    expect(await scheduler.run()).toBeNull();
    const after = readBackupSchedule(app.backupSchedule);
    expect(after?.lastRun).toMatchObject({ status: "failed", backupId: null });
    expect(notes).toEqual([{ source: "scheduler", op: "backup.scheduled", status: "error" }]);
    // Nothing was written into the folder that refused to be one.
    expect(existsSync(join(blocked, "backups"))).toBe(false);
  });
});

describe("the backup schedule settings", () => {
  test("BACKUP_PASSPHRASE is read at startup, and blank leaves a schedule with nothing to seal with", () => {
    const env = { ACCESS_KEY: "k".repeat(64), DATA_DIR: scratch };
    expect(loadConfig(env, { envFile: join(scratch, "missing.env") }).backupPassphrase).toBeNull();
    expect(
      loadConfig({ ...env, BACKUP_PASSPHRASE: "" }, { envFile: join(scratch, "missing.env") }).backupPassphrase,
    ).toBeNull();
    expect(
      loadConfig({ ...env, BACKUP_PASSPHRASE: PASSPHRASE }, { envFile: join(scratch, "missing.env") }).backupPassphrase,
    ).toBe(PASSPHRASE);
  });

  test("an invalid BACKUP_PASSPHRASE stops startup rather than leaving every run failed", () => {
    const env = { ACCESS_KEY: "k".repeat(64), DATA_DIR: scratch };
    for (const value of [
      "short",
      `${"x".repeat(1025)}`,
      " correct horse battery staple",
      "correct horse battery ",
      "line\nbreak passphrase",
    ]) {
      expect(() => loadConfig({ ...env, BACKUP_PASSPHRASE: value }, { envFile: join(scratch, "missing.env") })).toThrow(
        /BACKUP_PASSPHRASE/,
      );
    }
  });

  test("the schedule file is written where the docs say, and holds no passphrase", () => {
    const store = new BackupScheduleStore(scratch);
    setBackupSchedule(store, rule({ everyHours: 6 }), "owner");
    const text = readFileSync(join(scratch, "backup-schedule.json"), "utf8");
    expect(BackupScheduleSchema.safeParse(JSON.parse(text)).success).toBe(true);
    expect(text).not.toContain(PASSPHRASE);
  });
});
