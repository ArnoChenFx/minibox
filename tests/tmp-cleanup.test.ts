import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A `bun test` run puts its temporary files in a directory of its own and removes it when the run is gone. Each case here
 * starts a real `bun test` of tests/fixtures/tmp-leak.fixture.ts, which makes the directories the suite makes, ends it in
 * a real way, and looks at what is left in the temporary directory the run was given.
 */
const ROOT = join(import.meta.dir, "..");
const FIXTURE = "./tests/fixtures/tmp-leak.fixture.ts";
const CASE_MS = 40_000;

type Ending = "hang" | "finish" | "fail";

function launch(env: Record<string, string>) {
  // The run outlasts every case, so a signal that did not land shows as a run still going, not as one that ended by itself.
  return Bun.spawn([process.execPath, "test", FIXTURE, "--timeout", "20000"], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: "ignore",
    stderr: "ignore",
    // A session of its own, so that a case can signal the whole group the way a process manager does.
    detached: true,
  });
}

type Child = ReturnType<typeof launch>;

interface Run {
  /** The temporary directory the run was given. Whatever the run leaves is in here. */
  base: string;
  child: Child;
  /** The directories the fixture made, as it reports them. */
  dirs: string[];
  /** Lets a fixture that waits go on. */
  proceed: () => void;
}

const started: Child[] = [];

afterAll(() => {
  for (const child of started) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

async function until(done: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (done()) return true;
    await Bun.sleep(25);
  }
  return done();
}

async function start(end: Ending): Promise<Run> {
  const control = mkdtempSync(join(tmpdir(), "tmp-cleanup-"));
  const base = join(control, "tmp");
  mkdirSync(base);
  const ready = join(control, "ready.json");
  const child = launch({ TMPDIR: base, TMP_FIXTURE_READY: ready, TMP_FIXTURE_END: end });
  started.push(child);
  if (!(await until(() => existsSync(ready), 30_000))) {
    throw new Error(`the fixture made no directories (exit code ${child.exitCode})`);
  }
  const dirs = JSON.parse(readFileSync(ready, "utf8")) as string[];
  return { base, child, dirs, proceed: () => writeFileSync(`${ready}.go`, "") };
}

/** The directories are there, and they are in the run's own directory, not loose in the temporary directory. */
function expectMadeInOwnRoot(run: Run): void {
  expect(run.dirs.length).toBeGreaterThan(1);
  for (const dir of run.dirs) {
    expect(dir.startsWith(join(run.base, "mbrun-"))).toBe(true);
    expect(existsSync(dir)).toBe(true);
  }
}

/** What is left in the temporary directory once the run has ended; the janitor needs a moment after the run is gone. */
async function leftovers(run: Run): Promise<string[]> {
  await until(() => readdirSync(run.base).length === 0, 10_000);
  return readdirSync(run.base);
}

describe("a bun test run leaves no temporary directory behind", () => {
  test(
    "when it finishes",
    async () => {
      const run = await start("finish");
      expectMadeInOwnRoot(run);
      run.proceed();
      expect(await run.child.exited).toBe(0);
      expect(await leftovers(run)).toEqual([]);
    },
    CASE_MS,
  );

  test(
    "when a test fails",
    async () => {
      const run = await start("fail");
      expectMadeInOwnRoot(run);
      run.proceed();
      expect(await run.child.exited).toBe(1);
      expect(await leftovers(run)).toEqual([]);
    },
    CASE_MS,
  );

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGKILL"] as const) {
    test(
      `when ${signal} stops it`,
      async () => {
        const run = await start("hang");
        expectMadeInOwnRoot(run);
        expect(run.child.exitCode).toBeNull();
        run.child.kill(signal);
        await run.child.exited;
        expect(run.child.signalCode).toBe(signal);
        expect(await leftovers(run)).toEqual([]);
      },
      CASE_MS,
    );
  }

  // What a process manager does when it stops a command: the signal goes to the whole group, and the janitor, which lives
  // in a group of its own, is not in it.
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    test(
      `when ${signal} reaches its whole process group`,
      async () => {
        const run = await start("hang");
        expectMadeInOwnRoot(run);
        expect(run.child.exitCode).toBeNull();
        process.kill(-run.child.pid, signal);
        await run.child.exited;
        expect(run.child.signalCode).toBe(signal);
        expect(await leftovers(run)).toEqual([]);
      },
      CASE_MS,
    );
  }
});
