import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";

import { childPids, killProcessTree } from "../src/docker/proc";

describe("process tree", () => {
  test("ignores pids that must not be signalled", () => {
    expect(childPids(0)).toEqual([]);
    expect(childPids(1)).toEqual([]);
    expect(childPids(Number.NaN)).toEqual([]);
    expect(() => killProcessTree(1)).not.toThrow();
    expect(() => killProcessTree(0)).not.toThrow();
    expect(() => killProcessTree(-4)).not.toThrow();
  });

  test("stops a process and the children it has already started", async () => {
    const child = spawn("sh", ["-c", "sleep 30 & sleep 30 & wait"], { stdio: "ignore" });
    const pid = child.pid;
    if (pid === undefined) throw new Error("spawn did not return a pid");
    try {
      let kids: number[] = [];
      for (let i = 0; i < 50 && kids.length === 0; i++) {
        await Bun.sleep(20);
        kids = childPids(pid);
      }
      expect(kids.length).toBeGreaterThan(0);
      killProcessTree(pid);
      const outcome = await new Promise<number | NodeJS.Signals | null>((resolve) => {
        child.once("exit", (status, signal) => resolve(signal ?? status));
      });
      expect(outcome).not.toBeNull();
      for (const kid of kids) {
        let alive = true;
        try {
          process.kill(kid, 0);
        } catch {
          alive = false;
        }
        expect(alive).toBe(false);
      }
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });
});
