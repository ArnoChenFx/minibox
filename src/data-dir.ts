import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

import { log } from "./lib/logger";

/** Mode for DATA_DIR and every directory under it. */
export const DIR_MODE = 0o700;
/** Mode for files that hold secrets. */
export const SECRET_FILE_MODE = 0o600;
/** Subdirectories created under DATA_DIR at startup. */
export const DATA_SUBDIRS = ["boxes", "checkpoints", "exec", "secrets", "template-recipes", "volumes"] as const;

/** Unset means `<root>/data`. Relative paths resolve from `root`; a leading `~/` expands to `home`. */
export function resolveDataDir(value: string | undefined, root: string, home = homedir()): string {
  const raw = value?.trim();
  if (!raw) return join(root, "data");
  return resolvePath(raw, root, home);
}

/**
 * A folder from a setting, resolved the way `DATA_DIR` is: a leading `~/` expands to `home`, and a relative path resolves
 * from `root`. Unset or blank means `fallback`.
 */
export function resolvePath(value: string | undefined, root: string, home = homedir(), fallback = ""): string {
  const raw = value?.trim() || fallback;
  const expanded = raw === "~" || raw.startsWith("~/") ? join(home, raw.slice(1)) : raw;
  return resolve(root, expanded);
}

/**
 * The folder that holds the backup archives: `BACKUP_DIR` when it is set, `DATA_DIR/backups` otherwise. A relative value
 * resolves from the project root, as `DATA_DIR` does, and a leading `~/` expands to the home directory.
 */
export function resolveBackupDir(value: string | undefined, dataDir: string, root: string, home = homedir()): string {
  return resolvePath(value, root, home, join(dataDir, "backups"));
}

/** Whether `path` is `dir` or sits under it, compared on resolved paths so `..` and symlinks cannot slip out. */
export function isWithinDir(path: string, dir: string): boolean {
  const target = resolve(path);
  const base = resolve(dir);
  return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

/**
 * Why `dir` cannot hold the archives of `dataDir`, or `null` when it can.
 *
 * The archives of a folder inside DATA_DIR are left out of the backup, so that a backup never contains backups. That rule
 * turns into a trap for a folder that *holds* DATA_DIR instead: everything in the data directory counts as "inside the
 * backup folder", and the backup comes out empty while reporting success. So a folder that is DATA_DIR itself, or a
 * folder above it, is refused rather than silently producing empty archives.
 */
export function backupDirRefusal(dir: string, dataDir: string): string | null {
  if (!isWithinDir(dataDir, dir)) return null;
  return resolve(dir) === resolve(dataDir) ? "it is the data directory itself" : "it holds the data directory";
}

/** The auto-generated access key lives directly in DATA_DIR. It is never written to `.env`. */
export function accessKeyPath(dataDir: string): string {
  return join(dataDir, "access_key");
}

/** Browser sessions: token hashes and their metadata, never the tokens. */
export function sessionsPath(dataDir: string): string {
  return join(dataDir, "sessions.json");
}

/** Agent API tokens: hashes and policy, never the tokens. Separate from browser sessions. */
export function tokensPath(dataDir: string): string {
  return join(dataDir, "tokens.json");
}

/** The `self` tokens of boxes: hashes and box ids, never the tokens. Mode 600. */
export function selfTokensPath(dataDir: string): string {
  return join(dataDir, "self-tokens.json");
}

/** Questions a box's agent asked a person, with their options and answers. Mode 600. */
export function questionsPath(dataDir: string): string {
  return join(dataDir, "questions.json");
}

/** Remote hosts: their ids, names and endpoints, never a credential. Mode 600. Credentials live under `hosts/<id>`. */
export function hostsPath(dataDir: string): string {
  return join(dataDir, "hosts.json");
}

/** Notification channels: their settings, never a secret. Mode 600. Secrets live under `secrets/notify`. */
export function notifyPath(dataDir: string): string {
  return join(dataDir, "notify.json");
}

/** Off-site targets: their places and last syncs, never a credential. Mode 600. Credentials live under `secrets/env`. */
export function targetsPath(dataDir: string): string {
  return join(dataDir, "targets.json");
}

/** The owner's SSH public keys for direct SSH logins. Mode 600, since the file decides who gets a shell. */
export function sshKeysPath(dataDir: string): string {
  return join(dataDir, "ssh_keys.json");
}

/** Paired host agents: ids, public keys and revocation, never a private key. Mode 600. */
export function agentsPath(dataDir: string): string {
  return join(dataDir, "agents.json");
}

/**
 * Replace `path` with `contents` so a reader sees either the old file or the new one, never a partial write.
 * The new file is flushed before the rename, and the temporary file is removed if any step fails. `mode` is applied
 * exactly: the umask only narrows the mode passed to open, so the chmod is what makes 0644 hold under any umask.
 */
export function writeFileAtomic(path: string, contents: string, mode = SECRET_FILE_MODE): void {
  // A dot-prefixed temporary name cannot be taken for a record: a listing that filters on the name never sees one.
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const fd = openSync(tmp, "wx", mode);
    try {
      fchmodSync(fd, mode);
      writeFileSync(fd, contents);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  syncDirectory(dirname(path));
}

/**
 * Without this, a power cut right after the rename can bring back the file it replaced, and with it sessions that
 * were revoked a moment earlier. Some filesystems cannot sync a directory; the rename has already happened by then.
 */
function syncDirectory(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    return;
  }
}

/** Create DATA_DIR and its documented subdirectories, enforcing mode 700 on each. Idempotent. */
export function ensureDataDir(dataDir: string): void {
  for (const dir of [dataDir, ...DATA_SUBDIRS.map((name) => join(dataDir, name))]) {
    ensurePrivateDir(dir);
  }
}

/**
 * Create `dir`, and every folder above it, with mode 700. An existing folder is tightened to 700 when the filesystem
 * allows it, since a backup folder holds archives that carry secrets. Idempotent.
 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  enforceMode(dir, DIR_MODE);
}

/** Trimmed contents of a secret file, or `null` when it is missing or blank. A looser mode is tightened to 600. */
export function readSecretFile(path: string): string | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (isErrno(e, "ENOENT")) return null;
    throw e;
  }
  enforceMode(path, SECRET_FILE_MODE);
  return text.trim() || null;
}

/** Create a new secret file with mode 600. Returns `false`, leaving the file alone, if it already exists. */
export function createSecretFile(path: string, value: string): boolean {
  try {
    writeFileSync(path, `${value}\n`, { flag: "wx", mode: SECRET_FILE_MODE });
    return true;
  } catch (e) {
    if (isErrno(e, "EEXIST")) return false;
    throw e;
  }
}

/** Best effort: a bind mount owned by another user may refuse chmod, which must not stop the server. */
function enforceMode(path: string, mode: number): void {
  if ((statSync(path).mode & 0o777) === mode) return;
  try {
    chmodSync(path, mode);
  } catch (e) {
    log.warn("data_dir.chmod_failed", { path, mode: mode.toString(8), error: String(e) });
  }
}

function isErrno(e: unknown, code: string): boolean {
  return typeof e === "object" && e !== null && "code" in e && e.code === code;
}
