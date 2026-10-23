import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { TREE_SWEEP_SCRIPT } from "../src/startup/command";

/** Whether a process still runs. A zombie has ended, though its pid is still listed until something reaps it. */
function alive(pid: number): boolean {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return false;
  }
  const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
  return state !== "Z" && state !== "X";
}

/** The process ids a shell prints, one per line, read until `count` of them have come. */
async function printedPids(stream: ReadableStream<Uint8Array>, count: number): Promise<number[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (text.split("\n").filter(Boolean).length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => Number(line.trim()));
}

async function sweep(anchor: number): Promise<number> {
  const proc = Bun.spawn(["sh", "-c", TREE_SWEEP_SCRIPT, "minibox-sweep", String(anchor)], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return proc.exited;
}

/** A process that stands in for a run's pane: a session leader whose command names the runner, as tmux starts it. */
const RUN_SCRIPT = [
  "sleep 300 & echo $!",
  "setsid sleep 301 & echo $!",
  "sh -c 'sleep 302 & echo $!; wait' & echo $!",
  "wait",
].join("\n");

const killed: { kill(): void }[] = [];

function track<T extends { kill(): void }>(proc: T): T {
  killed.push(proc);
  return proc;
}

describe.skipIf(process.platform !== "linux")("the run sweep, on real processes", () => {
  test("ends the run's processes, its children, its session members and its grandchildren, and nothing else", async () => {
    const run = track(
      Bun.spawn(["setsid", "sh", "-c", RUN_SCRIPT, "minibox-startup"], { stdout: "pipe", stderr: "ignore" }),
    );
    const members = await printedPids(run.stdout as ReadableStream<Uint8Array>, 4);
    expect(members).toHaveLength(4);
    const bystander = track(Bun.spawn(["sleep", "330"], { stdout: "ignore", stderr: "ignore" }));
    for (const pid of [run.pid, ...members]) expect(alive(pid)).toBe(true);

    try {
      expect(await sweep(run.pid)).toBe(0);
      for (const pid of [run.pid, ...members]) expect(alive(pid)).toBe(false);
      expect(alive(bystander.pid)).toBe(true);
    } finally {
      bystander.kill();
    }
  }, 15_000);

  test("leaves a process alone when the pid it was given runs something other than the runner", async () => {
    const other = track(
      Bun.spawn(["setsid", "sh", "-c", "sleep 340 & echo $!; wait", "not-the-runner"], {
        stdout: "pipe",
        stderr: "ignore",
      }),
    );
    const [child] = await printedPids(other.stdout as ReadableStream<Uint8Array>, 1);

    try {
      expect(await sweep(other.pid)).toBe(0);
      expect(alive(other.pid)).toBe(true);
      expect(alive(child ?? 0)).toBe(true);
    } finally {
      other.kill();
      if (child !== undefined) process.kill(child, "SIGKILL");
    }
  }, 15_000);

  test("exits cleanly when the pid it was given is gone", async () => {
    const gone = track(Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" }));
    await gone.exited;
    expect(await sweep(gone.pid)).toBe(0);
  }, 15_000);
});

process.on("exit", () => {
  for (const proc of killed) proc.kill();
});
