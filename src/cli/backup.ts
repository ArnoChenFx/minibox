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
  return await backupCreateCommand(argv, env, io);
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
