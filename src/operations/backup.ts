import { z } from "zod";

import type { BackupScheduleStore } from "../backup/schedule-store";
import { DEFAULT_TIMEZONE, ruleOf } from "../checkpoints/schedule";
import { type ByteStream, isByteStream } from "../lib/body";
import { conflict } from "../lib/errors";
import { msg } from "../lib/messages";
import { type BackupService, backupView } from "../services/backup";
import { backupRuleOf, clearBackupSchedule, readBackupSchedule, setBackupSchedule } from "../services/backup-schedule";
import { defineOperation } from "./define";
import { BackupSchema, BackupScheduleSchema, OkSchema } from "./schemas";
import { addFailure, passphrase, scheduleAt, scheduleEveryHours, scheduleTimezone } from "./validation";

function backupsOf(backups: BackupService | undefined): BackupService {
  if (!backups) throw new Error("the backup service is not running");
  return backups;
}

const backupId = () => z.string().meta({ description: "Backup id (bk_…), as the backup list shows it." });

const backupTarget = (id: string) => ({ kind: "backup", id, name: id });

const backupCreate = defineOperation({
  name: "backup.create",
  tag: "backups",
  summary: "Create a backup of DATA_DIR",
  kind: "write",
  scope: "backup:manage",
  async: true,
  conflicts: true,
  input: z.object({ passphrase: passphrase("backup") }),
  output: z.object({ backup: BackupSchema }),
  rest: [{ method: "POST", path: "/api/backups", body: true, status: 202 }],
  cli: "backup",
  mcp: {
    toolset: "storage",
    name: "create_backup",
    description:
      "Back up MiniBox's data directory: settings, boxes, tokens, secrets and the event log, sealed with a passphrase that MiniBox never stores. Checkpoint data in Docker volumes is not included. Returns a task id; the finished task holds the backup id. Owner only.",
  },
  exclusive: () => "backup",
  activity: { action: () => "backup.create", target: () => "DATA_DIR" },
  audit: {
    target: (_input, _resolved, result) => (result ? backupTarget(result.backup.id) : undefined),
    detail: (_input, _resolved, result) => ({
      backup: result?.backup.id ?? null,
      bytes: result?.backup.bytes ?? null,
    }),
  },
  run: async ({ backups, principal, task }, input) => {
    const record = await backupsOf(backups).create(input.passphrase, principal.id, (line) => task?.log(line));
    return { backup: backupView(record) };
  },
});

const backupList = defineOperation({
  name: "backup.list",
  tag: "backups",
  summary: "List backups",
  kind: "read",
  scope: "backup:manage",
  async: false,
  input: z.object({}),
  output: z.object({ backups: z.array(BackupSchema) }),
  rest: [{ method: "GET", path: "/api/backups" }],
  cli: "backup ls",
  mcp: {
    toolset: "storage",
    name: "list_backups",
    description:
      "List the backups kept on this instance, newest first, with their size, checksum and origin. Owner only.",
  },
  run: async ({ backups }) => ({ backups: backupsOf(backups).list().map(backupView) }),
});

const backupDownload = defineOperation({
  name: "backup.download",
  tag: "backups",
  summary: "Download a backup archive",
  kind: "read",
  scope: "backup:manage",
  async: false,
  input: z.object({ id: backupId() }),
  output: z.custom<ByteStream>(isByteStream),
  rest: [{ method: "GET", path: "/api/backups/:id/download", stream: true }],
  audit: { target: ({ id }) => backupTarget(id) },
  run: async ({ backups }, input) => {
    const service = backupsOf(backups);
    return service.open(service.stored(input.id));
  },
});

const backupDelete = defineOperation({
  name: "backup.delete",
  tag: "backups",
  summary: "Delete a backup",
  kind: "destructive",
  scope: "backup:manage",
  async: false,
  input: z.object({ id: backupId() }),
  output: OkSchema,
  rest: [{ method: "DELETE", path: "/api/backups/:id" }],
  cli: "backup rm",
  mcp: {
    toolset: "storage",
    name: "delete_backup",
    description:
      "Delete a stored backup. Its archive cannot be recovered afterwards, so keep a copy first. Owner only.",
  },
  activity: { action: () => "backup.delete", target: ({ id }) => id },
  audit: { target: ({ id }) => backupTarget(id) },
  run: async ({ backups }, input) => {
    backupsOf(backups).remove(input.id);
    return { ok: true as const };
  },
});

function scheduleStoreOf(store: BackupScheduleStore | undefined): BackupScheduleStore {
  if (!store) throw new Error("the backup schedule store is not running");
  return store;
}

/**
 * The rule a request names. Exactly one of `everyHours` and `at`, as a checkpoint schedule is, so the two read the same
 * way; the fields refuse a value out of range on their own, and this refuses a request that sends both or neither.
 */
const scheduleInput = z
  .object({
    everyHours: scheduleEveryHours("backup"),
    at: scheduleAt("backup"),
    timezone: scheduleTimezone("backup"),
  })
  .superRefine((input, ctx) => {
    if (ruleOf(input) === null) addFailure(ctx, { message: msg("schedule_rule_invalid") });
  });

const backupScheduleGet = defineOperation({
  name: "backup.schedule.get",
  tag: "backups",
  summary: "Read the backup schedule",
  kind: "read",
  scope: "backup:manage",
  async: false,
  input: z.object({}),
  output: z.object({
    schedule: BackupScheduleSchema.nullable(),
    passphraseSet: z.boolean().meta({
      description:
        "Whether the server has a BACKUP_PASSPHRASE. Without one a schedule cannot be saved, and one saved before it went missing fails at its next time.",
    }),
  }),
  rest: [{ method: "GET", path: "/api/backups/schedule" }],
  cli: "backup schedule get",
  mcp: {
    toolset: "storage",
    name: "get_backup_schedule",
    description:
      "Read the backup schedule of this instance, with its next and last run (a run is ok, skipped with a reason such as busy, or failed with an error). A null schedule means none is set, which is the default. passphraseSet says whether the server has a BACKUP_PASSPHRASE: without one a schedule cannot be saved. Owner only.",
  },
  run: async ({ backupSchedule, backupPassphraseSet }) => ({
    schedule: readBackupSchedule(scheduleStoreOf(backupSchedule)),
    passphraseSet: backupPassphraseSet !== false,
  }),
});

const backupScheduleSet = defineOperation({
  name: "backup.schedule.set",
  tag: "backups",
  summary: "Set the backup schedule",
  kind: "write",
  scope: "backup:manage",
  async: false,
  input: scheduleInput,
  output: z.object({ schedule: BackupScheduleSchema }),
  rest: [{ method: "PUT", path: "/api/backups/schedule", body: true }],
  cli: "backup schedule set",
  mcp: {
    toolset: "storage",
    name: "set_backup_schedule",
    description:
      "Set the backup schedule of this instance. Send everyHours (1 to 720) or at (HH:MM), not both. With at, send timezone, an IANA zone such as Asia/Shanghai; without it the time is UTC. A due run makes one backup with the passphrase in BACKUP_PASSPHRASE, and BACKUP_KEEP then applies. A run that fell due while MiniBox was down happens once when it comes back. Replaces any schedule the instance has. Refused with 409 when the server has no BACKUP_PASSPHRASE, since a schedule nobody can seal would only fail. Owner only.",
  },
  activity: { action: () => "backup.schedule", target: () => "DATA_DIR" },
  audit: {
    detail: (input) => ({
      everyHours: input.everyHours ?? null,
      at: input.at ?? null,
      timezone: input.at ? (input.timezone ?? DEFAULT_TIMEZONE) : null,
    }),
  },
  run: async ({ backupSchedule, backupPassphraseSet, principal }, input) => {
    // A schedule nobody can seal would only fail at its first slot, so it is refused now, where it can be seen.
    if (backupPassphraseSet === false) throw conflict(msg("backup_schedule_passphrase_unset"));
    return { schedule: setBackupSchedule(scheduleStoreOf(backupSchedule), backupRuleOf(input), principal.id) };
  },
});

const backupScheduleClear = defineOperation({
  name: "backup.schedule.clear",
  tag: "backups",
  summary: "Remove the backup schedule",
  kind: "write",
  scope: "backup:manage",
  async: false,
  input: z.object({}),
  output: OkSchema,
  rest: [{ method: "DELETE", path: "/api/backups/schedule" }],
  cli: "backup schedule clear",
  mcp: {
    toolset: "storage",
    name: "clear_backup_schedule",
    description:
      "Remove the backup schedule. Backups already made are kept. Clearing a schedule that is off is not an error. Owner only.",
  },
  activity: { action: () => "backup.schedule.clear", target: () => "DATA_DIR" },
  run: async ({ backupSchedule }) => {
    clearBackupSchedule(scheduleStoreOf(backupSchedule));
    return { ok: true as const };
  },
});

/**
 * The schedule operations come before `DELETE /api/backups/{id}`, because the router answers with the first binding that
 * matches, and `/api/backups/schedule` would otherwise be read as a backup id.
 */
export const backupOperations = [
  backupCreate,
  backupList,
  backupScheduleGet,
  backupScheduleSet,
  backupScheduleClear,
  backupDownload,
  backupDelete,
];
