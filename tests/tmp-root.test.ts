import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestRoot, startJanitor, SWEEP_AFTER_MS, sweepStaleRoots } from "./support/tmp-root";

const HOUR = 3_600_000;
const bases: string[] = [];

afterAll(() => {
  for (const base of bases) rmSync(base, { recursive: true, force: true });
});

/** A temporary directory to build the cases in. The run's own directory removes it in the end, if this does not. */
function freshBase(): string {
  const base = mkdtempSync(join(tmpdir(), "tmp-root-"));
  bases.push(base);
  return base;
}

/** A directory shaped like a run's, with one file three levels down, and everything in it last changed `hours` ago. */
function leftover(base: string, name: string, hours: number): string {
  const root = join(base, name);
  const deep = join(root, "minibox-test-data-x", "app-x");
  mkdirSync(deep, { recursive: true });
  const file = join(deep, "state.json");
  writeFileSync(file, "{}");
  age([file, deep, join(root, "minibox-test-data-x"), root], hours);
  return root;
}

/** Sets the times of the paths, children before parents, since a parent's changes when an entry is added to it. */
function age(paths: string[], hours: number): void {
  const then = new Date(Date.now() - hours * HOUR);
  for (const path of paths) utimesSync(path, then, then);
}

const gone = () => false;
const nothingOpen = () => [];

describe("createTestRoot", () => {
  test("makes a directory below the base that names the process, which others can enter", () => {
    const base = freshBase();
    const root = createTestRoot(base, 4242);
    expect(root.startsWith(`${base}/mbrun-4242-`)).toBe(true);
    expect(statSync(root).mode & 0o777).toBe(0o755);
    expect(createTestRoot(base, 4242)).not.toBe(root);
  });

  test("names the process that runs by default", () => {
    expect(createTestRoot(freshBase())).toMatch(new RegExp(`/mbrun-${process.pid}-[A-Za-z0-9]{6}$`));
  });

  test("leaves the preview relay's socket paths inside the 103 bytes macOS allows", () => {
    const tmp = "/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T";
    const name = createTestRoot(freshBase(), 4_194_304).split("/").pop() ?? "";
    expect(join(tmp, name, "mbp-AbCdEf", "0123456789abcdef.sock").length).toBeLessThanOrEqual(103);
  });
});

describe("sweepStaleRoots", () => {
  test("removes the directory of a run that is gone and has been left alone for long enough", () => {
    const base = freshBase();
    const root = leftover(base, "mbrun-4242-AbCdEf", 3);
    expect(sweepStaleRoots(base, { isAlive: gone, openPaths: nothingOpen })).toEqual(["mbrun-4242-AbCdEf"]);
    expect(existsSync(root)).toBe(false);
  });

  test("asks about the process the name gives, and keeps the directory of one that still runs", () => {
    const base = freshBase();
    const root = leftover(base, "mbrun-4242-AbCdEf", 3);
    const asked: number[] = [];
    const removed = sweepStaleRoots(base, {
      isAlive: (pid) => {
        asked.push(pid);
        return true;
      },
      openPaths: nothingOpen,
    });
    expect(removed).toEqual([]);
    expect(asked).toEqual([4242]);
    expect(existsSync(root)).toBe(true);
  });

  test("keeps a directory that was written to recently, though its own time is old", () => {
    const base = freshBase();
    const root = leftover(base, "mbrun-4242-AbCdEf", 3);
    // A file deep in the tree changes without touching the time of any directory above it.
    const file = join(root, "minibox-test-data-x", "app-x", "state.json");
    utimesSync(file, new Date(), new Date());
    expect(sweepStaleRoots(base, { isAlive: gone, openPaths: nothingOpen })).toEqual([]);
    expect(existsSync(root)).toBe(true);
    age([file], 3);
    expect(sweepStaleRoots(base, { isAlive: gone, openPaths: nothingOpen })).toEqual(["mbrun-4242-AbCdEf"]);
  });

  test("keeps a directory until it has been left alone for the whole limit", () => {
    const base = freshBase();
    leftover(base, "mbrun-4242-AbCdEf", SWEEP_AFTER_MS / HOUR - 0.5);
    expect(sweepStaleRoots(base, { isAlive: gone, openPaths: nothingOpen })).toEqual([]);
    expect(sweepStaleRoots(base, { isAlive: gone, openPaths: nothingOpen, now: Date.now() + HOUR })).toEqual([
      "mbrun-4242-AbCdEf",
    ]);
  });

  test("keeps a directory a process has open or as its working directory, and nothing next to it", () => {
    const base = freshBase();
    const root = leftover(base, "mbrun-4242-AbCdEf", 3);
    const file = join(root, "minibox-test-data-x", "app-x", "state.json");
    const sweep = (open: string[] | null) => sweepStaleRoots(base, { isAlive: gone, openPaths: () => open });
    expect(sweep([root])).toEqual([]);
    expect(sweep([file])).toEqual([]);
    expect(sweep([`${root}-other`, join(base, "mbrun-4242-AbCdEf2", "x")])).toEqual(["mbrun-4242-AbCdEf"]);
    const second = leftover(base, "mbrun-4243-AbCdEf", 3);
    expect(sweep(null)).toEqual(["mbrun-4243-AbCdEf"]);
    expect(existsSync(second)).toBe(false);
  });

  test("takes the directories earlier runs left directly in the temporary directory, which name no process", () => {
    const base = freshBase();
    leftover(base, "minibox-test-data-AbCdEf", 3);
    const recent = leftover(base, "minibox-test-data-GhIjKl", 1);
    const asked: number[] = [];
    const removed = sweepStaleRoots(base, {
      isAlive: (pid) => {
        asked.push(pid);
        return true;
      },
      openPaths: nothingOpen,
    });
    expect(removed).toEqual(["minibox-test-data-AbCdEf"]);
    expect(asked).toEqual([]);
    expect(existsSync(recent)).toBe(true);
  });

  test("does not touch anything that is not a directory of this suite", () => {
    const base = freshBase();
    const decoys = [
      "rovloom-e2e-AbCdEf",
      "pw",
      "mbrun-abc-AbCdEf",
      "mbrun-4242-AbCd",
      "mbrun-4242-AbCdEfG",
      "mbrun-4242-AbCdEf.tar",
      "minibox-test-data",
      "minibox-test-data-AbCdEf.bak",
      "minibox-test-4242-AbCdEf",
      "mbt-pki-AbCdEf",
    ];
    for (const name of decoys) leftover(base, name, 100);
    // A file named like a run's directory, and a link named like one that points at a directory worth keeping, both old.
    writeFileSync(join(base, "mbrun-9999-AbCdEf"), "not a directory");
    const victim = leftover(base, "victim", 100);
    symlinkSync(victim, join(base, "mbrun-9998-AbCdEf"));
    age([join(base, "mbrun-9999-AbCdEf")], 100);
    const longAgo = new Date(Date.now() - 100 * HOUR);
    lutimesSync(join(base, "mbrun-9998-AbCdEf"), longAgo, longAgo);
    expect(sweepStaleRoots(base, { isAlive: gone, openPaths: nothingOpen })).toEqual([]);
    for (const name of [...decoys, "mbrun-9999-AbCdEf", "mbrun-9998-AbCdEf", "victim"]) {
      expect(existsSync(join(base, name))).toBe(true);
    }
    expect(existsSync(join(victim, "minibox-test-data-x", "app-x", "state.json"))).toBe(true);
  });

  test("does not touch a directory that belongs to another user", () => {
    const base = freshBase();
    const root = leftover(base, "mbrun-4242-AbCdEf", 3);
    const other = (process.getuid?.() ?? 0) + 1;
    expect(sweepStaleRoots(base, { uid: other, isAlive: gone, openPaths: nothingOpen })).toEqual([]);
    expect(existsSync(root)).toBe(true);
  });

  test("goes on with the others when one cannot be removed", () => {
    const base = freshBase();
    leftover(base, "mbrun-4242-AbCdEf", 3);
    const second = leftover(base, "mbrun-4243-AbCdEf", 3);
    const attempts: string[] = [];
    const removed = sweepStaleRoots(base, {
      isAlive: gone,
      openPaths: nothingOpen,
      remove: (path) => {
        attempts.push(path);
        if (path.endsWith("mbrun-4242-AbCdEf")) throw new Error("busy");
        rmSync(path, { recursive: true, force: true });
      },
    });
    expect(attempts).toHaveLength(2);
    expect(removed).toEqual(["mbrun-4243-AbCdEf"]);
    expect(existsSync(second)).toBe(false);
  });

  test("returns nothing when the temporary directory cannot be read", () => {
    expect(sweepStaleRoots(join(freshBase(), "missing"))).toEqual([]);
  });

  test.skipIf(process.getuid?.() === 0)("removes a directory a test left unreadable", () => {
    const base = freshBase();
    const root = leftover(base, "mbrun-4242-AbCdEf", 3);
    const locked = join(root, "minibox-test-data-x", "app-x");
    chmodSync(locked, 0o000);
    try {
      expect(sweepStaleRoots(base, { isAlive: gone, openPaths: nothingOpen })).toEqual(["mbrun-4242-AbCdEf"]);
      expect(existsSync(root)).toBe(false);
    } finally {
      if (existsSync(locked)) chmodSync(locked, 0o700);
    }
  });

  // The default look at the processes, on real ones: a shell that stands in a directory, and one that holds a file open.
  describe.skipIf(process.platform !== "linux")("on real processes", () => {
    test("keeps a directory that is a process's working directory until the process ends", async () => {
      const base = freshBase();
      const root = leftover(base, "mbrun-4242-AbCdEf", 3);
      const holder = Bun.spawn(["sleep", "30"], { cwd: join(root, "minibox-test-data-x"), stdout: "ignore" });
      try {
        expect(sweepStaleRoots(base, { isAlive: gone })).toEqual([]);
        expect(existsSync(root)).toBe(true);
      } finally {
        holder.kill();
        await holder.exited;
      }
      expect(sweepStaleRoots(base, { isAlive: gone })).toEqual(["mbrun-4242-AbCdEf"]);
    });

    test("keeps a directory a process holds a file of open until the process ends", async () => {
      const base = freshBase();
      const root = leftover(base, "mbrun-4242-AbCdEf", 3);
      const file = join(root, "minibox-test-data-x", "app-x", "state.json");
      const holder = Bun.spawn(["sh", "-c", 'exec 3<"$1"; echo open; exec sleep 30', "holder", file], {
        cwd: tmpdir(),
        stdout: "pipe",
      });
      try {
        await holder.stdout.getReader().read();
        expect(sweepStaleRoots(base, { isAlive: gone })).toEqual([]);
        expect(existsSync(root)).toBe(true);
      } finally {
        holder.kill();
        await holder.exited;
      }
      expect(sweepStaleRoots(base, { isAlive: gone })).toEqual(["mbrun-4242-AbCdEf"]);
    });
  });

  test("asks the system about the process the name gives", async () => {
    const base = freshBase();
    // The process that runs this is one that runs; one that has ended and been reaped is not.
    const ended = Bun.spawn(["true"], { stdout: "ignore" });
    await ended.exited;
    leftover(base, `mbrun-${process.pid}-AbCdEf`, 3);
    leftover(base, `mbrun-${ended.pid}-AbCdEf`, 3);
    expect(sweepStaleRoots(base, { openPaths: nothingOpen })).toEqual([`mbrun-${ended.pid}-AbCdEf`]);
  });
});

describe("startJanitor", () => {
  test("removes the directory once its input ends, and not before", async () => {
    const root = createTestRoot(freshBase());
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "file"), "x");
    const janitor = startJanitor(root);
    expect(janitor).not.toBeNull();
    if (!janitor) return;
    await Bun.sleep(300);
    expect(existsSync(root)).toBe(true);
    janitor.stdin.end();
    await janitor.exited;
    expect(existsSync(root)).toBe(false);
  });

  test("removes what a test left unreadable", async () => {
    const root = createTestRoot(freshBase());
    mkdirSync(join(root, "locked"));
    writeFileSync(join(root, "locked", "file"), "x");
    chmodSync(join(root, "locked"), 0o000);
    try {
      const janitor = startJanitor(root);
      if (!janitor) throw new Error("no janitor");
      janitor.stdin.end();
      await janitor.exited;
      expect(existsSync(root)).toBe(false);
    } finally {
      if (existsSync(join(root, "locked"))) chmodSync(join(root, "locked"), 0o700);
    }
  });

  test("removes only a directory of this suite", async () => {
    const keep = join(freshBase(), "keep-me");
    mkdirSync(keep);
    const janitor = startJanitor(keep);
    if (!janitor) throw new Error("no janitor");
    janitor.stdin.end();
    await janitor.exited;
    expect(existsSync(keep)).toBe(true);
  });
});
