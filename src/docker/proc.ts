import { readFileSync } from "node:fs";

/** Direct children of a process, from the kernel's children list. An unreadable pid yields none. */
export function childPids(pid: number): number[] {
  if (!Number.isInteger(pid) || pid <= 1) return [];
  try {
    const text = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
    if (!text) return [];
    return text
      .split(/\s+/)
      .map((part) => Number(part))
      .filter((child) => Number.isInteger(child) && child > 1);
  } catch {
    return [];
  }
}

/**
 * Stops a process and its descendants. Children go first, then the process, and the walk runs twice so a child
 * forked during the first pass is still stopped. Pids at or below 1 are ignored, and a pid that is already gone
 * is not an error.
 */
export function killProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  const once = (current: number): void => {
    if (current <= 1) return;
    for (const child of childPids(current)) once(child);
    try {
      process.kill(current, "SIGKILL");
    } catch {
      // already gone
    }
  };
  once(pid);
  once(pid);
}
