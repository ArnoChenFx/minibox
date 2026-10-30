import { lstatSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { Subprocess } from "bun";

type Janitor = Subprocess<"pipe", "ignore", "ignore">;

/**
 * A `bun test` run keeps its temporary files in one directory of its own, named for the process that made it. This is
 * the part `tests/support/preload.ts` is built from, kept apart so that the tests can run it on directories of their own.
 *
 * The name is short on purpose. The preview relay's Unix sockets sit two levels below the temporary directory, and macOS
 * allows 103 bytes for a socket path, of which `/var/folders/…/T` already takes about half.
 */
const ROOT_NAME = /^mbrun-(\d+)-[A-Za-z0-9]{6}$/;
/** Before the runs had a directory each, `tests/support/app.ts` made one of these in the temporary directory and never removed it. */
const LEGACY_NAME = /^minibox-test-data-[A-Za-z0-9]{6}$/;

/** How long a directory must have gone untouched, in every file in it, before a later run takes it for a leftover. */
export const SWEEP_AFTER_MS = 2 * 60 * 60 * 1000;
/** A directory with more entries than this is not worth judging by its files; it is left alone. */
const SWEEP_ENTRY_LIMIT = 200_000;

/** Makes the directory for the run of `pid` in `base`. Like any `mkdtemp` directory it is private to the user. */
export function createTestRoot(base: string, pid: number = process.pid): string {
  return mkdtempSync(join(base, `mbrun-${pid}-`));
}

/**
 * Waits for the end of its input, then removes the directory it was given. The input is a pipe whose other end is this
 * process, so the end of this process ends it, whether the run finished, failed, was stopped by a signal or was killed.
 *
 * Nothing in the process can do that: Bun never emits `exit` when a test run ends, a signal handler waits for the event
 * loop and does not run in a busy test, and SIGKILL cannot be caught at all.
 *
 * It starts a session of its own, so a signal sent to the whole process group, or the terminal's hangup, does not reach it,
 * and it ignores the three signals that stop a run in case it is reached all the same.
 */
const JANITOR_SCRIPT = [
  'trap "" HUP INT TERM',
  "cat >/dev/null",
  // A test that failed halfway can leave a directory it made unreadable; give the owner access back, then remove it.
  'case "${1##*/}" in mbrun-*) chmod -R u+rwX -- "$1" 2>/dev/null; rm -rf -- "$1";; esac',
].join("\n");

/** What `startJanitor` keeps: a collected process object would close its pipe, which the janitor reads as the end of the run. */
const janitors: Janitor[] = [];

/** Starts the process that removes `root` once this one is gone. Null when it cannot be started; a later run sweeps instead. */
export function startJanitor(root: string): Janitor | null {
  try {
    const janitor = Bun.spawn(["sh", "-c", JANITOR_SCRIPT, "minibox-test-janitor", root], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    janitor.unref();
    janitors.push(janitor);
    return janitor;
  } catch {
    return null;
  }
}

export interface SweepDeps {
  /** The time to judge by. */
  now: number;
  /** How long a directory must have been left alone to count as a leftover. */
  idleMs: number;
  /** The user the directories must belong to; null where the system has none. */
  uid: number | null;
  isAlive: (pid: number) => boolean;
  /** Every path a process of this machine has as its working directory or an open file; null when that cannot be told. */
  openPaths: () => string[] | null;
  remove: (path: string) => void;
}

/**
 * Removes the directories earlier runs left behind, for a run whose janitor did not do it: one that was killed with the
 * janitor, or on a machine without `sh`. It takes a directory only when all of these hold: its name is one of this suite's
 * and it is a real directory of the current user; the process its name gives is gone (the old `minibox-test-data-*`
 * name none); nothing in it has been written for `idleMs`; and no process has it open or as its working directory, which
 * only /proc can tell. Without /proc a directory that names its process is judged by the first three, and one that does
 * not is left. Anything else in the directory is not looked at.
 *
 * Returns the names it removed.
 */
export function sweepStaleRoots(base: string, overrides: Partial<SweepDeps> = {}): string[] {
  const deps: SweepDeps = {
    now: Date.now(),
    idleMs: SWEEP_AFTER_MS,
    uid: process.getuid?.() ?? null,
    isAlive: processExists,
    openPaths: openPathsOfProcesses,
    remove: removeTree,
    ...overrides,
  };
  // The processes' working directories and files come from /proc by their real paths, so the base is taken by its real path.
  let dir: string;
  let names: string[];
  try {
    dir = realpathSync(base);
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  // Read once, and only when a directory gets as far as needing it: it walks every process.
  let open: string[] | null = null;
  let opened = false;
  for (const name of names) {
    const owner = ROOT_NAME.exec(name);
    if (!owner && !LEGACY_NAME.test(name)) continue;
    const path = join(dir, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || (deps.uid !== null && stat.uid !== deps.uid)) continue;
      if (owner && deps.isAlive(Number(owner[1]))) continue;
      if (touchedSince(path, deps.now - deps.idleMs)) continue;
      if (!opened) {
        open = deps.openPaths();
        opened = true;
      }
      if (open === null && !owner) continue;
      if (open?.some((held) => held === path || held.startsWith(`${path}/`))) continue;
      deps.remove(path);
      removed.push(name);
    } catch {
      // One that cannot be judged or removed stays for the next run, and does not hold up the others.
    }
  }
  return removed;
}

/** Whether anything in the tree, the directory itself included, was changed at or after `cutoff`. The directory's own time says only when an entry was added or removed. */
function touchedSince(dir: string, cutoff: number): boolean {
  const pending = [dir];
  let seen = 0;
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      continue; // gone meanwhile
    }
    if (stat.mtimeMs >= cutoff) return true;
    if (++seen > SWEEP_ENTRY_LIMIT) return true;
    if (!stat.isDirectory()) continue;
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      continue; // unreadable: its own time has to do
    }
    for (const name of names) pending.push(join(current, name));
  }
  return false;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists and belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The working directory and the open files of every process this user may look at, from /proc; null where there is none. */
function openPathsOfProcesses(): string[] | null {
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return null;
  }
  const paths: string[] = [];
  for (const pid of pids) {
    try {
      paths.push(readlinkSync(`/proc/${pid}/cwd`));
    } catch {
      // another user's process, or one that ended meanwhile
    }
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        paths.push(readlinkSync(`/proc/${pid}/fd/${fd}`));
      } catch {
        // closed meanwhile
      }
    }
  }
  return paths;
}

function removeTree(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // A directory a test left unreadable cannot be walked: give its owner access back and try once more.
    Bun.spawnSync(["chmod", "-R", "u+rwX", "--", path], { stdout: "ignore", stderr: "ignore" });
    rmSync(path, { recursive: true, force: true });
  }
}
