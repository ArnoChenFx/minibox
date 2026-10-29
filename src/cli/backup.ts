import { createHash, randomBytes } from "node:crypto";
import { open, rename, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { writeAll } from "../backup/io";
import { restoreArchive, RestoreRefused } from "../backup/restore";
import { type ArchiveRejection, ArchiveRejected } from "../backup/seal";
import { type CliIo, fail, parseOptions, printJson, readStdinText, request, serverOf, type Options } from "./shared";
import { followTask } from "./task";

type Env = Record<string, string | undefined>;

/** A backup as the server lists and creates it. */
interface BackupRow {
  id: string;
  origin: string;
  createdAt: string;
  bytes: number;
  sha256: string;
}

const BACKUP_PASSPHRASE_HINT =
  "Set MINIBOX_BACKUP_PASSPHRASE, or pass --passphrase-stdin to read it from stdin. A passphrase is never an argument.";

const ARCHIVE_MESSAGES: Record<ArchiveRejection, string> = {
  passphrase: "The passphrase does not open this backup. Check it and try again. Nothing was restored.",
  not_backup: "This file is not a MiniBox backup. Nothing was restored.",
  invalid: "This backup is damaged or incomplete. Nothing was restored.",
};

/** An answer the server refused. The command prints its message and exits 1, as the other commands do. */
class ApiRefusal extends Error {
  constructor(
    readonly status: number,
    readonly json: unknown,
    readonly text: string,
  ) {
    super(`HTTP ${status}`);
  }
}

/** A backup or restore that cannot finish for a reason the caller can act on. Exit 1. */
class CommandFailure extends Error {}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** The passphrase that seals or opens an archive: the environment, or the first line of stdin. */
async function backupPassphrase(options: Options, env: Env, io: CliIo): Promise<string> {
  const passphrase = options.switches.has("--passphrase-stdin")
    ? (await readStdinText(io)).split(/\r?\n/, 1)[0]
    : env.MINIBOX_BACKUP_PASSPHRASE;
  if (!passphrase) throw new Error(BACKUP_PASSPHRASE_HINT);
  return passphrase;
}

/** Ends a command that failed on the server or on this machine. Anything else is a bug, and is raised. */
function commandFailed(io: CliIo, e: unknown): number {
  if (e instanceof ApiRefusal) return fail(io, e.status, e.json, e.text);
  if (e instanceof CommandFailure) {
    io.stderr(`${e.message}\n`);
    return 1;
  }
  throw e;
}

async function refuseExisting(path: string, overwrite: boolean): Promise<void> {
  if (!overwrite && (await stat(path).catch(() => null)) !== null) {
    throw new CommandFailure(`${path} already exists. Pass --overwrite to replace it.`);
  }
}

/** `minibox backup` creates, lists and deletes sealed archives of DATA_DIR. */
export async function backupCommand(argv: string[], env: Env, io: CliIo): Promise<number> {
  if (argv[0] === "ls") return await backupListCommand(argv.slice(1), env, io);
  if (argv[0] === "rm") return await backupRemoveCommand(argv.slice(1), env, io);
  if (argv[0] === "schedule") return await backupScheduleCommand(argv.slice(1), env, io);
  return await backupCreateCommand(argv, env, io);
}

/** A backup schedule as the server returns it. */
interface ScheduleRow {
  mode: "interval" | "daily";
  everyHours: number | null;
  at: string | null;
  timezone: string | null;
  timezoneUnknown: boolean;
  nextRunAt: string;
  lastRun: {
    at: string;
    status: string;
    backupId: string | null;
    bytes: number | null;
    reason?: string | null;
    error: string | null;
  } | null;
}

/** What a skipped run says for each reason the server names. */
const SKIP_REASONS: Record<string, string> = {
  busy: "another backup was already running; the schedule runs again at its next time",
};

/** Said under the schedule when the server cannot seal a scheduled backup, since the console says the same. */
const NO_PASSPHRASE =
  "The server has no BACKUP_PASSPHRASE. Set it in .env (12 to 1024 characters) and restart MiniBox.";

const SCHEDULE_HINT =
  "minibox backup schedule takes get, set or clear. set takes --every-hours N or --at HH:MM with --timezone ZONE.";

/** The rule in words, as the console says it. */
function ruleText(schedule: ScheduleRow): string {
  if (schedule.mode === "daily") {
    return `every day at ${schedule.at ?? "?"} (${schedule.timezoneUnknown ? "UTC" : (schedule.timezone ?? "UTC")})`;
  }
  return schedule.everyHours === 1 ? "every hour" : `every ${schedule.everyHours} hours`;
}

function lastRunText(schedule: ScheduleRow): string {
  const run = schedule.lastRun;
  if (!run) return "none yet";
  if (run.status === "ok") return `${run.at}, backup ${run.backupId ?? ""}`.trimEnd();
  if (run.status === "skipped") return `${run.at}, skipped: ${SKIP_REASONS[run.reason ?? ""] ?? run.reason ?? ""}`;
  return `${run.at}, failed: ${run.error ?? ""}`;
}

/** `minibox backup schedule` reads, sets or clears the one backup schedule of the instance. */
async function backupScheduleCommand(argv: string[], env: Env, io: CliIo): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "get") return await backupScheduleGetCommand(rest, env, io);
  if (sub === "set") return await backupScheduleSetCommand(rest, env, io);
  if (sub === "clear") return await backupScheduleClearCommand(rest, env, io);
  throw new Error(SCHEDULE_HINT);
}

async function backupScheduleGetCommand(argv: string[], env: Env, io: CliIo): Promise<number> {
  const options = parseOptions(argv, [], ["--json"]);
  if (options.positional.length > 0) throw new Error("minibox backup schedule get takes no argument");
  const res = await request(env, "GET", "/api/backups/schedule");
  if (res.status >= 400) return fail(io, res.status, res.json, res.text);
  if (options.switches.has("--json")) return printJson(io, res.json);
  const body = res.json as { schedule?: ScheduleRow | null; passphraseSet?: boolean } | null;
  const schedule = body?.schedule ?? null;
  const sealed = body?.passphraseSet !== false;
  if (!schedule) {
    io.stdout("No backup schedule is set.\n");
    if (!sealed) io.stdout(`${NO_PASSPHRASE} Until then a schedule cannot be saved.\n`);
    return 0;
  }
  io.stdout(`Backup ${ruleText(schedule)}\n`);
  io.stdout(`Next run: ${schedule.nextRunAt}\n`);
  io.stdout(`Last run: ${lastRunText(schedule)}\n`);
  if (!sealed) io.stdout(`${NO_PASSPHRASE} Until then this schedule's runs fail and it cannot be changed.\n`);
  return 0;
}

async function backupScheduleSetCommand(argv: string[], env: Env, io: CliIo): Promise<number> {
  const options = parseOptions(argv, ["--every-hours", "--at", "--timezone"], ["--json"]);
  if (options.positional.length > 0) throw new Error("minibox backup schedule set takes no argument");
  const hours = options.values.get("--every-hours");
  const at = options.values.get("--at");
  const timezone = options.values.get("--timezone");
  if (hours === undefined && at === undefined) throw new Error(SCHEDULE_HINT);
  if (hours !== undefined && at !== undefined)
    throw new Error("minibox backup schedule set takes --every-hours or --at, not both");
  if (timezone !== undefined && at === undefined)
    throw new Error("minibox backup schedule set takes --timezone only with --at");
  const body: Record<string, unknown> = {};
  if (hours !== undefined) body.everyHours = Number(hours);
  if (at !== undefined) {
    body.at = at;
    if (timezone !== undefined) body.timezone = timezone;
  }
  const res = await request(env, "PUT", "/api/backups/schedule", body);
  if (res.status >= 400) return fail(io, res.status, res.json, res.text);
  if (options.switches.has("--json")) return printJson(io, res.json);
  const schedule = (res.json as { schedule: ScheduleRow }).schedule;
  io.stdout(`Backup ${ruleText(schedule)}\nNext run: ${schedule.nextRunAt}\n`);
  return 0;
}

async function backupScheduleClearCommand(argv: string[], env: Env, io: CliIo): Promise<number> {
  const options = parseOptions(argv, [], ["--json"]);
  if (options.positional.length > 0) throw new Error("minibox backup schedule clear takes no argument");
  const res = await request(env, "DELETE", "/api/backups/schedule");
  if (res.status >= 400) return fail(io, res.status, res.json, res.text);
  if (options.switches.has("--json")) return printJson(io, res.json);
  io.stdout("Backup schedule cleared.\n");
  return 0;
}

async function backupCreateCommand(argv: string[], env: Env, io: CliIo): Promise<number> {
  const options = parseOptions(argv, ["--out"], ["--json", "--overwrite", "--passphrase-stdin"]);
  if (options.positional.length > 0) {
    throw new Error("minibox backup takes no argument. Use --out FILE to save the archive on this machine.");
  }
  const out = options.values.get("--out");
  const overwrite = options.switches.has("--overwrite");
  if (overwrite && out === undefined) throw new Error("minibox backup takes --overwrite only with --out");
  const passphrase = await backupPassphrase(options, env, io);
  try {
    if (out !== undefined) await refuseExisting(resolve(out), overwrite);
    const res = await request(env, "POST", "/api/backups", { passphrase });
    if (res.status >= 400) return fail(io, res.status, res.json, res.text);
    const task = await followTask(env, io, (res.json as { taskId: string }).taskId);
    if (!task) return 1;
    if (task.status !== "succeeded") {
      io.stderr(`${task.error?.message ?? `The task ended as ${task.status}`}\n`);
      return 1;
    }
    const backup = (task.result as { backup?: BackupRow } | undefined)?.backup;
    if (!backup) throw new CommandFailure("The backup finished without a result.");
    if (out !== undefined) await downloadBackup(env, backup, resolve(out), overwrite);
    if (options.switches.has("--json")) return printJson(io, backup);
    io.stdout(`${backup.id}\n`);
    return 0;
  } catch (e) {
    return commandFailed(io, e);
  }
}

/** Writes a backup's archive to `dest` under a temporary name. It is kept only when its size and checksum match. */
async function downloadBackup(env: Env, backup: BackupRow, dest: string, overwrite: boolean): Promise<void> {
  const { base, headers } = serverOf(env);
  const res = await fetch(`${base}/api/backups/${encodeURIComponent(backup.id)}/download`, {
    headers: { ...headers, accept: "application/octet-stream" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiRefusal(res.status, parseJson(text), text);
  }
  const part = `${dest}.${randomBytes(6).toString("hex")}.part`;
  try {
    await writeChecked(res, part, backup);
    await refuseExisting(dest, overwrite);
    await rename(part, dest);
  } catch (e) {
    await rm(part, { force: true });
    throw e;
  }
}

async function writeChecked(res: Response, part: string, backup: BackupRow): Promise<void> {
  if (res.body === null) throw new CommandFailure("The server sent no archive.");
  const reader = res.body.getReader();
  const handle = await open(part, "wx", 0o600);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      bytes += value.byteLength;
      await writeAll(handle, value);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (bytes !== backup.bytes || hash.digest("hex") !== backup.sha256) {
    throw new CommandFailure("The download does not match the backup's size and checksum, so nothing was saved.");
  }
}

async function backupListCommand(argv: string[], env: Env, io: CliIo): Promise<number> {
  const options = parseOptions(argv, [], ["--json"]);
  if (options.positional.length > 0) throw new Error("minibox backup ls takes no argument");
  const res = await request(env, "GET", "/api/backups");
  if (res.status >= 400) return fail(io, res.status, res.json, res.text);
  if (options.switches.has("--json")) return printJson(io, res.json);
  const backups = (res.json as { backups?: BackupRow[] } | null)?.backups ?? [];
  io.stdout("ID  CREATED  ORIGIN  BYTES  SHA256\n");
  for (const backup of backups) {
    io.stdout(`${backup.id}  ${backup.createdAt}  ${backup.origin}  ${backup.bytes}  ${backup.sha256.slice(0, 12)}\n`);
  }
  return 0;
}

async function backupRemoveCommand(argv: string[], env: Env, io: CliIo): Promise<number> {
  const options = parseOptions(argv, [], ["--json"]);
  const [id, ...more] = options.positional;
  if (!id || more.length > 0) throw new Error("minibox backup rm needs one backup id");
  const res = await request(env, "DELETE", `/api/backups/${encodeURIComponent(id)}`);
  if (res.status >= 400) return fail(io, res.status, res.json, res.text);
  if (options.switches.has("--json")) return printJson(io, res.json);
  io.stdout(`Deleted ${id}\n`);
  return 0;
}

/** Restores an archive into a DATA_DIR that is missing or empty. It runs here, without the server, which must be stopped. */
export async function restoreCommand(argv: string[], env: Env, io: CliIo): Promise<number> {
  const options = parseOptions(argv, ["--data-dir"], ["--passphrase-stdin"]);
  const [file, ...more] = options.positional;
  const dataDir = options.values.get("--data-dir") ?? env.DATA_DIR;
  if (!file || more.length > 0) throw new Error("minibox restore needs one archive file and --data-dir DIR");
  if (!dataDir) throw new Error("minibox restore needs --data-dir DIR, or DATA_DIR set to the folder to restore into");
  const source = resolve(file);
  const target = resolve(dataDir);
  try {
    if ((await stat(source).catch(() => null)) === null) throw new CommandFailure(`${source} does not exist.`);
    const passphrase = await backupPassphrase(options, env, io);
    const entries = await restoreArchive(source, target, passphrase).catch(restoreFailure);
    io.stdout(`Restored ${entries} entries into ${target}. Start MiniBox with DATA_DIR set to it.\n`);
    return 0;
  } catch (e) {
    return commandFailed(io, e);
  }
}

function restoreFailure(e: unknown): never {
  if (e instanceof RestoreRefused) throw new CommandFailure(e.message);
  if (e instanceof ArchiveRejected) throw new CommandFailure(ARCHIVE_MESSAGES[e.reason]);
  throw e;
}
