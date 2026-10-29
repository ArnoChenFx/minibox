import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ruleOf, type ScheduleRule } from "../src/checkpoints/schedule";
import { runCli } from "../src/cli";
import { AppError } from "../src/lib/errors";
import type { OperationContext, Principal } from "../src/operations/types";
import { startServer } from "../src/server";
import { BackupScheduler, readBackupSchedule, setBackupSchedule } from "../src/services/backup-schedule";
import { createTestApp, silenceLogs, TEST_KEY } from "./support/app";
import { rejectionOf } from "./support/app";

const OWNER: Principal = { type: "owner", id: "owner", name: "owner" };
const PASSPHRASE = "correct horse battery staple";

interface Io {
  out: string;
  err: string;
  stdout(text: string): void;
  stderr(text: string): void;
  stdoutBytes(bytes: Uint8Array): void;
  stdinBytes(): AsyncIterable<Uint8Array>;
}

function io(): Io {
  const sink: Io = {
    out: "",
    err: "",
    stdout(text) {
      sink.out += text;
    },
    stderr(text) {
      sink.err += text;
    },
    stdoutBytes() {},
    stdinBytes: async function* () {},
  };
  return sink;
}

let restoreLogs: () => void;
let scratch: string;

beforeEach(() => {
  restoreLogs = silenceLogs();
  scratch = mkdtempSync(join(tmpdir(), "minibox-backup-schedule-api-"));
});

afterEach(() => {
  restoreLogs();
  rmSync(scratch, { recursive: true, force: true });
});

function ctxOf(app: ReturnType<typeof createTestApp>["app"]): OperationContext {
  return {
    host: app.hosts.get(),
    principal: OWNER,
    source: "rest",
    events: app.events,
    tokens: app.tokens,
    execs: app.execs,
    terminals: app.terminals,
  };
}

describe("the backup schedule operations", () => {
  test("the schedule can be read, set, changed and cleared, and each answer names its next run", async () => {
    const { app } = createTestApp();
    const ctx = ctxOf(app);

    const empty = (await app.operations.run("backup.schedule.get", ctx, {})) as { schedule: unknown };
    expect(empty.schedule).toBeNull();

    const set = (await app.operations.run("backup.schedule.set", ctx, { everyHours: 6 })) as {
      schedule: { mode: string; everyHours: number; nextRunAt: string };
    };
    expect(set.schedule).toMatchObject({ mode: "interval", everyHours: 6 });
    expect(Date.parse(set.schedule.nextRunAt)).toBeGreaterThan(Date.now());

    const read = (await app.operations.run("backup.schedule.get", ctx, {})) as { schedule: { everyHours: number } };
    expect(read.schedule).toMatchObject({ everyHours: 6 });

    const changed = (await app.operations.run("backup.schedule.set", ctx, {
      at: "02:30",
      timezone: "Asia/Shanghai",
    })) as {
      schedule: { mode: string; at: string; timezone: string };
    };
    expect(changed.schedule).toMatchObject({ mode: "daily", at: "02:30", timezone: "Asia/Shanghai" });

    await app.operations.run("backup.schedule.clear", ctx, {});
    expect(readBackupSchedule(app.backupSchedule)).toBeNull();
    // Clearing again is not an error.
    await app.operations.run("backup.schedule.clear", ctx, {});
  });

  test("the schedule survives a restart, because it is a file under DATA_DIR", async () => {
    const dataDir = mkdtempSync(join(scratch, "restart-"));
    const first = createTestApp({ dataDir });
    await first.app.operations.run("backup.schedule.set", ctxOf(first.app), { everyHours: 4 });

    const second = createTestApp({ dataDir });
    const read = (await second.app.operations.run("backup.schedule.get", ctxOf(second.app), {})) as {
      schedule: { everyHours: number } | null;
    };
    expect(read.schedule).toMatchObject({ everyHours: 4 });
  });

  test("a rule that is not one is refused, and so is a zone this server does not know", async () => {
    const { app } = createTestApp();
    const ctx = ctxOf(app);
    for (const input of [{}, { everyHours: 6, at: "02:30" }, { everyHours: 0 }, { everyHours: 721 }, { at: "24:00" }]) {
      const refusal = await rejectionOf(app.operations.run("backup.schedule.set", ctx, input));
      expect(refusal).toBeInstanceOf(AppError);
      expect((refusal as AppError).status).toBe(400);
    }
    const zone = await rejectionOf(
      app.operations.run("backup.schedule.set", ctx, { at: "02:30", timezone: "Mars/Olympus" }),
    );
    expect((zone as AppError).status).toBe(400);
  });

  test("a schedule is refused without a passphrase on the server, and nothing is saved", async () => {
    const { app } = createTestApp({ backupPassphrase: null });
    const refusal = await rejectionOf(app.operations.run("backup.schedule.set", ctxOf(app), { everyHours: 6 }));
    expect(refusal).toBeInstanceOf(AppError);
    expect(refusal).toMatchObject({ status: 409, key: "backup_schedule_passphrase_unset" });
    expect(readBackupSchedule(app.backupSchedule)).toBeNull();
  });

  test("the read says whether the server has a passphrase, which is what a schedule needs", async () => {
    const withOne = createTestApp().app;
    const sealed = (await withOne.operations.run("backup.schedule.get", ctxOf(withOne), {})) as {
      passphraseSet: boolean;
    };
    expect(sealed.passphraseSet).toBe(true);
    const without = createTestApp({ backupPassphrase: null }).app;
    const bare = (await without.operations.run("backup.schedule.get", ctxOf(without), {})) as {
      schedule: unknown;
      passphraseSet: boolean;
    };
    expect(bare).toEqual({ schedule: null, passphraseSet: false });
  });

  test("setting a schedule records an activity entry, and clearing it records another", async () => {
    const { app } = createTestApp();
    const ctx = ctxOf(app);
    await app.operations.run("backup.schedule.set", ctx, { everyHours: 6 });
    await app.operations.run("backup.schedule.clear", ctx, {});
    expect(app.activity.list(2).map((entry) => entry.action)).toEqual(["backup.schedule.clear", "backup.schedule"]);
  });

  test("a token cannot reach the schedule: it is owner only", async () => {
    const operation = await import("../src/operations/registry");
    const schedule = operation.OPERATIONS.filter((op) => op.name.startsWith("backup.schedule."));
    expect(schedule.map((op) => op.scope)).toEqual(["backup:manage", "backup:manage", "backup:manage"]);
  });

  test("the REST route reads the schedule rather than a backup called 'schedule'", async () => {
    const { app } = createTestApp();
    const server = startServer(app);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const headers = { authorization: `Bearer ${TEST_KEY}`, "content-type": "application/json" };
      const put = await fetch(`${base}/api/backups/schedule`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ everyHours: 6 }),
      });
      expect(put.status).toBe(200);
      const read = await fetch(`${base}/api/backups/schedule`, { headers });
      expect(read.status).toBe(200);
      expect((await read.json()) as unknown).toMatchObject({ schedule: { everyHours: 6 } });
      const clear = await fetch(`${base}/api/backups/schedule`, { method: "DELETE", headers });
      expect(clear.status).toBe(200);
      expect((await clear.json()) as unknown).toEqual({ ok: true });
    } finally {
      server.stop(true);
      app.throttle.stop();
    }
  });
});

/** A served app with its own DATA_DIR, so each CLI case starts from a clean instance. */
function serve(dataDir: string) {
  const { app } = createTestApp({ dataDir });
  const server = startServer(app);
  return {
    app,
    env: { MINIBOX_URL: `http://127.0.0.1:${server.port}`, MINIBOX_ACCESS_KEY: TEST_KEY },
    stop: () => {
      server.stop(true);
      app.throttle.stop();
    },
  };
}

describe("minibox backup schedule", () => {
  test("set, get and clear, each printing the schedule in words", async () => {
    const served = serve(mkdtempSync(join(scratch, "app-")));
    try {
      const set = io();
      expect(await runCli(["backup", "schedule", "set", "--every-hours", "6"], served.env, set)).toBe(0);
      expect(set.out).toContain("Backup every 6 hours");
      expect(set.out).toContain("Next run:");

      const get = io();
      expect(await runCli(["backup", "schedule", "get"], served.env, get)).toBe(0);
      expect(get.out).toContain("Backup every 6 hours");

      const daily = io();
      expect(
        await runCli(["backup", "schedule", "set", "--at", "02:30", "--timezone", "Asia/Shanghai"], served.env, daily),
      ).toBe(0);
      expect(daily.out).toContain("every day at 02:30 (Asia/Shanghai)");

      const clear = io();
      expect(await runCli(["backup", "schedule", "clear"], served.env, clear)).toBe(0);
      expect(clear.out).toContain("Backup schedule cleared.");

      const none = io();
      expect(await runCli(["backup", "schedule", "get"], served.env, none)).toBe(0);
      expect(none.out).toContain("No backup schedule is set.");
    } finally {
      served.stop();
    }
  });

  test("get says up front that the server cannot seal a schedule, and what to do", async () => {
    const dataDir = mkdtempSync(join(scratch, "app-"));
    const { app } = createTestApp({ dataDir, backupPassphrase: null });
    const server = startServer(app);
    const env = { MINIBOX_URL: `http://127.0.0.1:${server.port}`, MINIBOX_ACCESS_KEY: TEST_KEY };
    try {
      const none = io();
      expect(await runCli(["backup", "schedule", "get"], env, none)).toBe(0);
      expect(none.out).toContain("No backup schedule is set.");
      expect(none.out).toContain("The server has no BACKUP_PASSPHRASE");
      expect(none.out).toContain("a schedule cannot be saved");

      // A schedule that was saved before the passphrase went missing is still read, with the same warning.
      const store = app.backupSchedule;
      setBackupSchedule(store, ruleOf({ everyHours: 6 }) as ScheduleRule, "owner");
      const kept = io();
      expect(await runCli(["backup", "schedule", "get"], env, kept)).toBe(0);
      expect(kept.out).toContain("Backup every 6 hours");
      expect(kept.out).toContain("this schedule's runs fail and it cannot be changed");

      const json = io();
      expect(await runCli(["backup", "schedule", "get", "--json"], env, json)).toBe(0);
      expect(JSON.parse(json.out)).toMatchObject({ passphraseSet: false });
    } finally {
      server.stop(true);
      app.throttle.stop();
    }
  });

  test("get prints a skipped run as skipped, with the reason in words", async () => {
    const served = serve(mkdtempSync(join(scratch, "app-")));
    try {
      const rule = ruleOf({ everyHours: 6 }) as ScheduleRule;
      const set = setBackupSchedule(served.app.backupSchedule, rule, "owner");
      const { timezoneUnknown: _view, ...record } = set;
      served.app.backupSchedule.write({
        ...record,
        lastRun: {
          at: "2026-10-29T10:00:00.000Z",
          status: "skipped",
          backupId: null,
          bytes: null,
          reason: "busy",
          error: null,
          errorKey: null,
          errorParams: null,
        },
      });
      const get = io();
      expect(await runCli(["backup", "schedule", "get"], served.env, get)).toBe(0);
      expect(get.out).toContain("Last run: 2026-10-29T10:00:00.000Z, skipped: another backup was already running");
      expect(get.out).not.toContain("failed");
    } finally {
      served.stop();
    }
  });

  test("--json prints the schedule as the server sent it", async () => {
    const served = serve(mkdtempSync(join(scratch, "app-")));
    try {
      const set = io();
      expect(await runCli(["backup", "schedule", "set", "--every-hours", "2", "--json"], served.env, set)).toBe(0);
      const json = JSON.parse(set.out) as { schedule: { mode: string; everyHours: number } };
      expect(json.schedule).toMatchObject({ mode: "interval", everyHours: 2 });
    } finally {
      served.stop();
    }
  });

  test("a rule that is not one is refused with the server's message and exit 1", async () => {
    const served = serve(mkdtempSync(join(scratch, "app-")));
    try {
      const refused = io();
      expect(
        await runCli(["backup", "schedule", "set", "--at", "02:30", "--every-hours", "6"], served.env, refused),
      ).toBe(2);
      expect(refused.err).toContain("not both");
      const bad = io();
      expect(await runCli(["backup", "schedule", "set", "--every-hours", "0"], served.env, bad)).toBe(1);
      expect(bad.err).toContain("A schedule runs every 1 to 720 hours");
    } finally {
      served.stop();
    }
  });

  test("a schedule set with the CLI is the one the server's scheduler runs, through the manual service", async () => {
    const served = serve(mkdtempSync(join(scratch, "app-")));
    try {
      const set = io();
      expect(await runCli(["backup", "schedule", "set", "--every-hours", "1"], served.env, set)).toBe(0);

      const schedule = readBackupSchedule(served.app.backupSchedule);
      if (!schedule) throw new Error("the CLI did not set a schedule");
      // The same pass the server runs on its timer, with a clock past the next run, and a passphrase to seal with.
      const scheduler = new BackupScheduler(served.app.backupSchedule, served.app.backups, PASSPHRASE, () => {});
      const made = await scheduler.run(new Date(Date.parse(schedule.nextRunAt)));
      expect(made).not.toBeNull();

      const listed = served.app.backups.list();
      expect(listed.map((record) => record.id)).toEqual([made ?? ""]);
      // A manual backup lands in the same folder, from the same service, so the two are interchangeable.
      const manual = await served.app.backups.create(PASSPHRASE, OWNER.id);
      expect(served.app.backups.list().map((record) => record.id)).toContain(manual.id);
      expect(served.app.backups.list().map((record) => record.origin)).toEqual(["create", "create"]);
    } finally {
      served.stop();
    }
  });
});
