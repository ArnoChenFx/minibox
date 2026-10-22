import { z } from "zod";

import { type ByteStream, isByteStream } from "../lib/body";
import { type BackupService, backupView } from "../services/backup";
import { defineOperation } from "./define";
import { BackupSchema, OkSchema } from "./schemas";
import { passphrase } from "./validation";

function backupsOf(backups: BackupService | undefined): BackupService {
  if (!backups) throw new Error("the backup service is not running");
  return backups;
}

const backupId = () => z.string().meta({ description: "Backup id (bk_…), as the backup list shows it." });

const backupTarget = (id: string) => ({ kind: "backup", id, name: id });

export const backupCreate = defineOperation({
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

export const backupList = defineOperation({
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

export const backupDownload = defineOperation({
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

export const backupDelete = defineOperation({
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

export const backupOperations = [backupCreate, backupList, backupDownload, backupDelete];
