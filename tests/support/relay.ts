import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

import { RELAY_PATHS } from "../../src/preview/relay-binary";
import { RELAY_BINARIES } from "../../src/preview/relay-binary.generated";
import type { ExecSession, ExecSpec } from "../../src/runtime";
import type { FakeRuntime } from "./fake-runtime";

/** The relay binary for this machine's architecture, written out once, so tests run the real thing. */
let relayBin: string | null | undefined;

function relayBinary(): string | null {
  if (relayBin !== undefined) return relayBin;
  const entry = RELAY_BINARIES[process.arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl"];
  if (!entry) {
    relayBin = null;
    return relayBin;
  }
  const bytes = Buffer.from(entry.base64, "base64");
  if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error("embedded relay is corrupt");
  // Below the run's own temporary directory (tests/support/preload.ts), which goes when the run does.
  const dir = mkdtempSync(join(tmpdir(), "mb-relay-"));
  const path = join(dir, "minibox-relay");
  writeFileSync(path, bytes, { mode: 0o755 });
  chmodSync(path, 0o755);
  relayBin = path;
  return path;
}

/**
 * Spawns a command on this machine. A preview relay runs in the box and connects to the box's loopback; a fake engine
 * has no loopback of its own, so the tests that need a working preview run the relay here, where it reaches the test's
 * upstream on 127.0.0.1 the way the box's own service would answer it.
 */
function localExec(command: string, args: string[]): ExecSession {
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

/** The session of a relay command on this machine: the placed binary, or python3 for the script. */
export function relayCommand(cmd: string[], relays?: string[][]): ExecSession {
  const head = cmd[0] ?? "";
  relays?.push(cmd);
  if (RELAY_PATHS.includes(head)) {
    const bin = relayBinary();
    if (bin) return localExec(bin, cmd.slice(1));
  }
  return localExec("python3", cmd.slice(1));
}

/** Routes a fake engine's preview relay to this machine, and records each relay it started. */
export function relayOnLoopback(runtime: FakeRuntime, relays?: string[][]): void {
  const fake = runtime.startExec.bind(runtime);
  runtime.startExec = async (containerId: string, spec: ExecSpec) => {
    const head = spec.cmd[0] ?? "";
    if (head !== "python3" && !RELAY_PATHS.includes(head)) return fake(containerId, spec);
    return relayCommand(spec.cmd, relays);
  };
}
