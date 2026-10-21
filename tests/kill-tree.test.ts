import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { KILL_TREE_SCRIPT, RUN_WRAPPER } from "../src/docker/runtime";

/** The state letter, parent and session of a process from /proc, or null once it is gone. */
function procStat(pid: number): { state: string; ppid: number; sid: number } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0] ?? "", ppid: Number(fields[1]), sid: Number(fields[3]) };
  } catch {
    return null;
  }
}

function pidsOnHost(): number[] {
  return readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .map(Number);
}

/** Every process below `root`, found by following parent links in /proc. */
function descendantsOf(root: number): number[] {
  const children = new Map<number, number[]>();
  for (const pid of pidsOnHost()) {
    const stat = procStat(pid);
    if (stat) children.set(stat.ppid, [...(children.get(stat.ppid) ?? []), pid]);
  }
  const found: number[] = [];
  const queue = [root];
  for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
    for (const child of children.get(pid) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/** Every process in session `sid`, whatever its parent. */
function sessionOf(sid: number): number[] {
  return pidsOnHost().filter((pid) => procStat(pid)?.sid === sid);
}

function commandLine(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
  } catch {
    return "";
  }
}

function commandsBelow(root: number): string[] {
  return descendantsOf(root).map(commandLine);
}

/** A zombie has exited, so it counts as stopped. */
function alive(pid: number): boolean {
  const stat = procStat(pid);
  return stat !== null && stat.state !== "Z" && stat.state !== "X";
}

function markersOf(token: string): string[] {
  return readdirSync("/tmp").filter((name) => name.startsWith(`.minibox-exec-${token}.`));
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

async function runKill(token: string): Promise<number> {
  const kill = Bun.spawn(["/bin/sh", "-c", KILL_TREE_SCRIPT, "minibox-kill", token], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return kill.exited;
}

/** Kills what a failed test left running, so one failure does not leave sleeps or markers behind. */
function cleanUp(token: string, pids: number[]): void {
  for (const pid of pids) {
    if (alive(pid)) process.kill(pid, "SIGKILL");
  }
  for (const name of markersOf(token)) rmSync(`/tmp/${name}`, { force: true });
}

describe.skipIf(process.platform !== "linux")("the exec kill script on this host's /proc", () => {
  test("stops the wrapper and every process below it, and leaves a process that only a hint file names", async () => {
    const token = randomBytes(8).toString("hex");
    const wrapper = Bun.spawn(
      ["/bin/sh", "-c", RUN_WRAPPER, "minibox-exec", token, "sh", "-c", "sleep 317 & sleep 318 & wait"],
      { stdout: "ignore", stderr: "ignore" },
    );
    const decoy = Bun.spawn(["sleep", "319"], { stdout: "ignore", stderr: "ignore" });
    const decoyHint = `/tmp/.minibox-exec-${token}.${decoy.pid}`;
    writeFileSync(decoyHint, "");
    try {
      await waitFor(
        () => commandsBelow(wrapper.pid).includes("sleep 317") && commandsBelow(wrapper.pid).includes("sleep 318"),
        "the command to start its children",
      );
      const members = [wrapper.pid, ...descendantsOf(wrapper.pid)];

      expect(await runKill(token)).toBe(0);
      expect(members.filter(alive)).toEqual([]);
      expect(alive(decoy.pid)).toBe(true);
      expect(markersOf(token)).toEqual([]);
    } finally {
      cleanUp(token, [wrapper.pid, ...descendantsOf(wrapper.pid)]);
      decoy.kill();
      await decoy.exited;
      await wrapper.exited;
      rmSync(decoyHint, { force: true });
    }
  });

  test("still finds the wrapper through its command line after the command removed its marker", async () => {
    const token = randomBytes(8).toString("hex");
    const wrapper = Bun.spawn(
      [
        "/bin/sh",
        "-c",
        RUN_WRAPPER,
        "minibox-exec",
        token,
        "sh",
        "-c",
        `rm -f /tmp/.minibox-exec-${token}.*; sleep 317 & wait`,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    try {
      await waitFor(
        () => commandsBelow(wrapper.pid).includes("sleep 317") && markersOf(token).length === 0,
        "the command to remove its marker and start",
      );
      const members = [wrapper.pid, ...descendantsOf(wrapper.pid)];

      expect(await runKill(token)).toBe(0);
      expect(members.filter(alive)).toEqual([]);
    } finally {
      cleanUp(token, [wrapper.pid, ...descendantsOf(wrapper.pid)]);
      await wrapper.exited;
    }
  });

  test.skipIf(!Bun.which("setsid"))(
    "stops a process that was orphaned but still belongs to the wrapper's session",
    async () => {
      const token = randomBytes(8).toString("hex");
      const wrapper = Bun.spawn(
        ["setsid", "/bin/sh", "-c", RUN_WRAPPER, "minibox-exec", token, "sh", "-c", "(sleep 317 &); sleep 318"],
        { stdout: "ignore", stderr: "ignore" },
      );
      try {
        await waitFor(
          () =>
            commandsBelow(wrapper.pid).includes("sleep 318") &&
            sessionOf(wrapper.pid).some((pid) => commandLine(pid) === "sleep 317"),
          "the orphan to start",
        );
        expect(procStat(wrapper.pid)?.sid).toBe(wrapper.pid);
        expect(commandsBelow(wrapper.pid)).not.toContain("sleep 317");
        const session = sessionOf(wrapper.pid);

        expect(await runKill(token)).toBe(0);
        expect(session.filter(alive)).toEqual([]);
      } finally {
        cleanUp(token, [...sessionOf(wrapper.pid), ...descendantsOf(wrapper.pid)]);
        await wrapper.exited;
      }
    },
  );

  test("exits 2 when no process carries the token", async () => {
    expect(await runKill(randomBytes(8).toString("hex"))).toBe(2);
  });

  test("the wrapper passes on the command's exit code and removes its marker", async () => {
    const token = randomBytes(8).toString("hex");
    const run = Bun.spawn(["/bin/sh", "-c", RUN_WRAPPER, "minibox-exec", token, "sh", "-c", "exit 3"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await run.exited).toBe(3);
    expect(markersOf(token)).toEqual([]);
  });
});
