import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { isWithinDir } from "../data-dir";
import { log } from "../lib/logger";

/** Top-level folders a backup leaves out: exec output, staged packages, the regenerable CLI cache and backups themselves. */
export const EXCLUDED_FOLDERS: ReadonlySet<string> = new Set(["backups", "cli", "exec", "packages"]);
/** The SQLite stores. Each is copied from a snapshot, so the live file and its journals are never read directly. */
export const DATABASE_FILES = ["events.db", "tasks.db"] as const;
const SQLITE_JOURNAL = /^(events|tasks)\.db-(wal|shm|journal)$/;
const MAX_DEPTH = 16;

export interface ListOptions {
  /**
   * Folders under DATA_DIR that are left out, with everything in them. Used for a `BACKUP_DIR` that sits inside DATA_DIR,
   * so an archive never archives the archives beside it.
   */
  readonly exclude?: readonly string[];
}

export interface ArchiveEntry {
  /** The path inside the archive, relative to DATA_DIR, with `/` between parts. */
  readonly rel: string;
  readonly abs: string;
  readonly kind: "dir" | "file";
}

/**
 * Whether a path under DATA_DIR belongs in a backup. Dot-prefixed names are temporary files and staging folders, which a
 * write may leave half done, so they never go in. The database files come from snapshots, not from the live files.
 */
export function includedEntry(rel: string): boolean {
  const parts = rel.split("/");
  if (parts.some((part) => part.startsWith("."))) return false;
  const [top = ""] = parts;
  if (EXCLUDED_FOLDERS.has(top)) return false;
  if (parts.length > 1) return true;
  return !SQLITE_JOURNAL.test(top) && !(DATABASE_FILES as readonly string[]).includes(top);
}

/** Every directory and regular file under DATA_DIR that a backup includes, in archive order: parents before children. */
export async function listEntries(dataDir: string, options: ListOptions = {}): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) throw new Error(`${rel} is nested too deeply to back up`);
    const dir = rel === "" ? dataDir : join(dataDir, rel);
    for (const dirent of await readdir(dir, { withFileTypes: true })) {
      const child = rel === "" ? dirent.name : `${rel}/${dirent.name}`;
      if (!includedEntry(child)) continue;
      const abs = join(dataDir, child);
      if (options.exclude?.some((path) => isWithinDir(abs, path))) continue;
      const info = dirent.isSymbolicLink() ? await stat(abs).catch(() => null) : dirent;
      if (info === null) {
        log.warn("backup.entry_skipped", { path: child, reason: "dangling link" });
        continue;
      }
      if (info.isDirectory()) {
        entries.push({ rel: child, abs, kind: "dir" });
        await walk(child, depth + 1);
      } else if (info.isFile()) {
        entries.push({ rel: child, abs, kind: "file" });
      } else {
        log.warn("backup.entry_skipped", { path: child, reason: "not a regular file" });
      }
    }
  };
  await walk("", 0);
  return entries.toSorted((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}
