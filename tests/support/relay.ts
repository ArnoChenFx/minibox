import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import type { ExecSession, ExecSpec } from "../../src/runtime";
import type { FakeRuntime } from "./fake-runtime";

/**
 * Spawns a command on this machine. A preview relay runs in the box and connects to the box's loopback; a fake engine
 * has no loopback of its own, so the tests that need a working preview run the relay's `python3` here, where it
 * reaches the test's upstream on 127.0.0.1 the way the box's own service would answer it.
 */
export function localExec(command: string, args: string[]): ExecSession {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessByStdio<
    Writable,
    Readable,
    Readable
  >;
  return {
    id: `local-${child.pid ?? 0}`,
    stream: child.stdin as unknown as ExecSession["stream"],
    stdout: child.stdout,
    stderr: child.stderr,
    resize: async () => {},
    inspect: async () => ({
      running: child.exitCode === null && child.signalCode === null,
      exitCode: child.exitCode,
      pid: child.pid ?? null,
    }),
    kill: async () => {
      child.kill("SIGKILL");
    },
  };
}

/** Routes a fake engine's preview relay to this machine's python3, and records each relay it started. */
export function relayOnLoopback(runtime: FakeRuntime, relays?: string[][]): void {
  const fake = runtime.startExec.bind(runtime);
  runtime.startExec = async (containerId: string, spec: ExecSpec) => {
    if (spec.cmd[0] !== "python3") return fake(containerId, spec);
    relays?.push(spec.cmd);
    return localExec("python3", spec.cmd.slice(1));
  };
}
