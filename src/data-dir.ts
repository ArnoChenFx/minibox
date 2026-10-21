import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
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
import { dirname, join, resolve } from "node:path";

import { log } from "./lib/logger";

/** Mode for DATA_DIR and every directory under it. */
export const DIR_MODE = 0o700;
/** Mode for files that hold secrets. */
export const SECRET_FILE_MODE = 0o600;
/** Subdirectories created under DATA_DIR at startup. Other paths in docs/design.md arrive with their features. */
export const DATA_SUBDIRS = ["boxes", "exec", "secrets", "volumes"] as const;

/** Unset means `<root>/data`. Relative paths resolve from `root`; a leading `~/` expands to `home`. */
export function resolveDataDir(value: string | undefined, root: string, home = homedir()): string {
  const raw = value?.trim();
  if (!raw) return join(root, "data");
  const expanded = raw === "~" || raw.startsWith("~/") ? join(home, raw.slice(1)) : raw;
  return resolve(root, expanded);
}

/** The auto-generated access key lives directly in DATA_DIR. It is never written to `.env`. */
export function accessKeyPath(dataDir: string): string {
  return join(dataDir, "access_key");
}

/** Browser sessions: token hashes and their metadata, never the tokens. */
export function sessionsPath(dataDir: string): string {
  return join(dataDir, "sessions.json");
}

/**
 * Replace `path` with `contents` so a reader sees either the old file or the new one, never a partial write.
 * The new file is flushed before the rename, and the temporary file is removed if any step fails.
 */
export function writeFileAtomic(path: string, contents: string, mode = SECRET_FILE_MODE): void {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const fd = openSync(tmp, "wx", mode);
    try {
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
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    enforceMode(dir, DIR_MODE);
  }
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
