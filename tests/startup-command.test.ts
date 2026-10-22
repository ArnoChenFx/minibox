import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { msg } from "../src/lib/messages";
import {
  digestOf,
  encodeCommand,
  INIT_SESSION,
  LOG_TAIL_LINES,
  logTail,
  markersOf,
  type PaneState,
  RUNNER_SCRIPT,
  STARTUP_COMMAND_MAX_BYTES,
  startupCommandProblem,
  SWEEP_SCRIPT,
  viewOf,
} from "../src/startup/command";

const STARTED = (digest: string, at = "2026-10-22T12:00:00Z") =>
  `[minibox] startup command started at ${at} (digest ${digest})`;
const EXITED = (code: number, at = "2026-10-22T12:00:03Z") =>
  `[minibox] startup command exited with code ${code} at ${at}`;
const DEAD = "Pane is dead (status 3, Thu Oct 22 12:00:03 2026)";

const DIGEST = digestOf("npm run dev");

function pane(lines: string[], dead = false, deadStatus: number | null = null): PaneState {
  return { dead, deadStatus, lines };
}

describe("startupCommandProblem", () => {
  test("refuses a command that is empty or only white space", () => {
    expect(startupCommandProblem("")).toBe("empty");
    expect(startupCommandProblem("  \n\t \r\n")).toBe("empty");
  });

  test("accepts a command as typed, including a multi-line script and the space around it", () => {
    expect(startupCommandProblem("npm run dev")).toBeNull();
    expect(startupCommandProblem("  cd app && make\n")).toBeNull();
    expect(startupCommandProblem("a\tb\nc\r\n")).toBeNull();
  });

  test("counts the limit in UTF-8 bytes, so the limit is the same for ASCII and for other scripts", () => {
    expect(startupCommandProblem("x".repeat(STARTUP_COMMAND_MAX_BYTES))).toBeNull();
    expect(startupCommandProblem("x".repeat(STARTUP_COMMAND_MAX_BYTES + 1))).toBe("too_long");
    expect(Buffer.byteLength("界")).toBe(3);
    expect(startupCommandProblem("界".repeat(Math.floor(STARTUP_COMMAND_MAX_BYTES / 3)))).toBeNull();
    expect(startupCommandProblem("界".repeat(Math.floor(STARTUP_COMMAND_MAX_BYTES / 3) + 1))).toBe("too_long");
  });

  test("refuses control characters, which a shell script has no use for and a terminal would render badly", () => {
    expect(startupCommandProblem("echo\u0000hi")).toBe("control");
    expect(startupCommandProblem("echo \u001b[31mred")).toBe("control");
    expect(startupCommandProblem("echo\u007f")).toBe("control");
  });
});

describe("digestOf and encodeCommand", () => {
  test("the digest is twelve hex characters, stable for one text and different for another", () => {
    expect(DIGEST).toMatch(/^[0-9a-f]{12}$/);
    expect(digestOf("npm run dev")).toBe(DIGEST);
    expect(digestOf("npm run dev ")).not.toBe(DIGEST);
  });

  test("the encoded form decodes to the exact text, including a trailing semicolon and newline", () => {
    const text = "echo one; echo two;\n";
    expect(Buffer.from(encodeCommand(text), "base64").toString("utf8")).toBe(text);
    expect(encodeCommand(text)).not.toContain(";");
  });
});

describe("markersOf", () => {
  test("reads the start and the exit of the latest run", () => {
    expect(markersOf([STARTED(DIGEST), "hi", EXITED(0)])).toEqual({
      startedAt: "2026-10-22T12:00:00Z",
      digest: DIGEST,
      exitCode: 0,
      exitedAt: "2026-10-22T12:00:03Z",
    });
  });

  test("an exit marker from before the latest start does not count", () => {
    const markers = markersOf([EXITED(5, "2026-10-22T11:00:00Z"), STARTED(DIGEST), "still going"]);
    expect(markers.exitCode).toBeNull();
    expect(markers.exitedAt).toBeNull();
    expect(markers.digest).toBe(DIGEST);
  });

  test("without any start marker, nothing is read", () => {
    expect(markersOf(["plain output"])).toEqual({ startedAt: null, digest: null, exitCode: null, exitedAt: null });
  });
});

describe("logTail", () => {
  test("keeps the newest lines and leaves out the line tmux adds to a dead pane", () => {
    const lines = Array.from({ length: LOG_TAIL_LINES + 10 }, (_, i) => `line ${i}`);
    const tail = logTail([...lines, DEAD]);
    expect(tail).toHaveLength(LOG_TAIL_LINES);
    expect(tail.at(-1)).toBe(`line ${LOG_TAIL_LINES + 9}`);
    expect(tail.some((line) => line.startsWith("Pane is dead"))).toBe(false);
  });

  test("cuts a long line short without splitting a character", () => {
    const [line = ""] = logTail(["界".repeat(600)]);
    expect([...line]).toHaveLength(501);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("viewOf", () => {
  test("no command is 'none', whatever the pane says", () => {
    expect(viewOf(null, pane([STARTED(DIGEST)]))).toMatchObject({ status: "none", log: [], stale: false });
  });

  test("a command with no session is 'waiting' until a start runs it", () => {
    expect(viewOf("npm run dev", null)).toMatchObject({ status: "waiting", log: [], error: null });
  });

  test("a launch that failed with no session is 'failed', with the reason", () => {
    expect(viewOf("npm run dev", null, msg("session_image_unsupported"))).toMatchObject({
      status: "failed",
      error: { key: "session_image_unsupported" },
    });
  });

  test("a live pane is 'running', with its start time and log", () => {
    const view = viewOf("npm run dev", pane([STARTED(DIGEST), "ready on 3000"], false));
    expect(view).toMatchObject({
      status: "running",
      exitCode: null,
      startedAt: "2026-10-22T12:00:00Z",
      exitedAt: null,
      stale: false,
      log: [STARTED(DIGEST), "ready on 3000"],
    });
  });

  test("a dead pane is 'exited' with the code and the time of the exit marker", () => {
    const view = viewOf("npm run dev", pane([STARTED(DIGEST), "boom", EXITED(2), DEAD], true, 2));
    expect(view).toMatchObject({ status: "exited", exitCode: 2, exitedAt: "2026-10-22T12:00:03Z" });
    expect(view.log.some((line) => line.startsWith("Pane is dead"))).toBe(false);
  });

  test("a dead pane without an exit marker reports the status tmux kept", () => {
    expect(viewOf("npm run dev", pane([STARTED(DIGEST)], true, 137))).toMatchObject({
      status: "exited",
      exitCode: 137,
      exitedAt: null,
    });
  });

  test("a run that used an earlier text of the command is stale", () => {
    const old = digestOf("npm start");
    expect(viewOf("npm run dev", pane([STARTED(old), "x"]))).toMatchObject({ status: "running", stale: true });
    expect(viewOf("npm run dev", pane([STARTED(DIGEST), "x"]))).toMatchObject({ status: "running", stale: false });
  });
});

function runWith(command: string, cwd: string) {
  const result = spawnSync("sh", ["-c", RUNNER_SCRIPT, "minibox-startup", encodeCommand(command), DIGEST], {
    cwd,
    encoding: "utf8",
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

describe("RUNNER_SCRIPT", () => {
  test("prints a start marker, runs the command in the directory it starts in, and exits with its status", () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-runner-"));
    try {
      const { code, out } = runWith("echo hello from $PWD > marker.txt; echo done; exit 3", dir);
      expect(code).toBe(3);
      const lines = out.split("\n");
      expect(lines[0]).toMatch(/^\[minibox\] startup command started at \S+ \(digest [0-9a-f]{12}\)$/);
      expect(lines[0]).toContain(DIGEST);
      expect(lines).toContain("done");
      expect(lines.at(-2)).toMatch(/^\[minibox\] startup command exited with code 3 at \S+$/);
      expect(readFileSync(join(dir, "marker.txt"), "utf8")).toContain(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the command runs under bash with the run's digest in its environment", () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-runner-"));
    try {
      const { code, out } = runWith('[[ -n "$BASH_VERSION" ]] && echo bash:$MINIBOX_STARTUP_RUN', dir);
      expect(code).toBe(0);
      expect(out).toContain(`bash:${DIGEST}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps a trailing semicolon and the trailing newline the text was typed with", () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-runner-"));
    try {
      const { code, out } = runWith("printf 'a;'; printf 'b\\n'\n\n", dir);
      expect(code).toBe(0);
      expect(out).toContain("a;b");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a command that does not run reports its status, and the runner does not hide it", () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-runner-"));
    try {
      const { code, out } = runWith("definitely-not-a-program-xyz", dir);
      expect(code).not.toBe(0);
      expect(out).toMatch(/exited with code [1-9]\d* at/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SWEEP_SCRIPT", () => {
  test.skipIf(process.platform !== "linux")(
    "ends a process of an earlier run, even one that left the session, and leaves other processes alone",
    async () => {
      const run = spawn("sleep", ["300"], {
        env: { ...process.env, MINIBOX_STARTUP_RUN: DIGEST },
        stdio: "ignore",
      });
      const bystander = spawn("sleep", ["300"], { stdio: "ignore" });
      try {
        const exited = new Promise<void>((resolve) => run.once("exit", () => resolve()));
        const result = spawnSync("sh", ["-c", SWEEP_SCRIPT], { encoding: "utf8" });
        expect(result.status).toBe(0);
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
        expect(run.exitCode !== null || run.signalCode !== null).toBe(true);
        expect(bystander.exitCode).toBeNull();
        expect(bystander.signalCode).toBeNull();
      } finally {
        bystander.kill("SIGKILL");
        run.kill("SIGKILL");
      }
    },
    15_000,
  );

  test("exits cleanly when no run is left", () => {
    expect(spawnSync("sh", ["-c", SWEEP_SCRIPT], { encoding: "utf8" }).status).toBe(0);
  });
});

describe("the init session", () => {
  test("has a name a box can list and attach to", () => {
    expect(INIT_SESSION).toBe("minibox-init");
  });
});
