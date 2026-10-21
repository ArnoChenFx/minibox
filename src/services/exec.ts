import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";

import { OUTPUT_HEAD_TAIL_BYTES, type OutputStore } from "../events/outputs";
import type { AuditNote } from "../events/types";
import { ulid } from "../events/ulid";
import type { HostCtx } from "../host/registry";
import { AppError, conflict, notFound, toAppError } from "../lib/errors";
import { log } from "../lib/logger";
import { type MessageKey, msg } from "../lib/messages";
import { type Box, startBox } from "./boxes";
import { EdgeBuffer, EXEC_INLINE_EDGE_BYTES } from "./exec-buffer";

const MAX_LIVE = 200;

/** How long `exec_get` may wait. Stays under the server's 60s idle timeout. */
export const EXEC_WAIT_MAX_MS = 25_000;

export interface ExecRunInput {
  cmd?: string;
  argv?: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  stdin?: string;
  user: string;
  background: boolean;
}

export interface ExecRunResult {
  execId: string;
  background: boolean;
  woke: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  outputRef: string | null;
  timedOut: boolean;
}

export interface ExecGetResult extends ExecRunResult {
  status: "running" | "exited" | "killed";
}

export interface ExecKillResult {
  execId: string;
  status: "killed";
}

export interface ExecOutputResult {
  execId: string;
  stdout: string;
  stderr: string;
  truncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
}

/** The box an exec was started in, for the audit target. Absent when the id is not in memory. */
export interface ExecTarget {
  readonly id: string;
  readonly name: string;
}

export interface ExecService {
  run(host: HostCtx, box: Box, input: ExecRunInput, record?: (note: AuditNote) => void): Promise<ExecRunResult>;
  get(execId: string, waitMs: number): Promise<ExecGetResult>;
  kill(execId: string): Promise<ExecKillResult>;
  output(execId: string): Promise<ExecOutputResult>;
  lookup(execId: string): ExecTarget | undefined;
}

interface LiveExec {
  id: string;
  boxId: string;
  boxName: string;
  session: {
    stream: { write(chunk: string): void; end(): void };
    stdout: Readable;
    stderr: Readable;
    inspect(): Promise<{ running: boolean; exitCode: number | null; pid: number | null }>;
    kill(): Promise<void>;
  };
  stdout: EdgeBuffer;
  stderr: EdgeBuffer;
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  done: Promise<void>;
  resolveDone: () => void;
  forced: Promise<void>;
  force: () => void;
  settled: boolean;
  timedOut: boolean;
  killed: boolean;
  exitCode: number | null;
  woke: boolean;
  background: boolean;
  waiters: Array<() => void>;
  recorder?: (note: AuditNote) => void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function noop(): void {}

function collect(buffer: EdgeBuffer, stream: Readable): void {
  stream.on("data", (chunk: unknown) => {
    if (typeof chunk === "string") buffer.append(Buffer.from(chunk));
    else if (chunk instanceof Uint8Array) buffer.append(chunk);
  });
  stream.on("error", noop);
}

function unref(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer.unref === "function") timer.unref();
}

function commandDetail(input: ExecRunInput, woke: boolean): Record<string, unknown> {
  return {
    cmd: input.cmd,
    argv: input.argv,
    cwd: input.cwd,
    user: input.user,
    timeoutSec: input.timeoutSec,
    background: input.background,
    env: Object.keys(input.env),
    stdinBytes: input.stdin === undefined ? 0 : Buffer.byteLength(input.stdin),
    woke,
  };
}

/**
 * Runs commands in a box. A stopped box is started first. Output is kept in memory up to the stored head and tail,
 * and the same window is written under DATA_DIR/exec when the command ends. The in-memory map is lost on restart.
 */
export class ExecManager implements ExecService {
  private readonly live = new Map<string, LiveExec>();

  constructor(
    private readonly outputs: OutputStore,
    private readonly redact: (text: string) => string,
  ) {}

  lookup(execId: string): ExecTarget | undefined {
    const live = this.live.get(execId);
    return live ? { id: live.boxId, name: live.boxName } : undefined;
  }

  async run(host: HostCtx, box: Box, input: ExecRunInput, record?: (note: AuditNote) => void): Promise<ExecRunResult> {
    let current = box;
    let woke = false;
    if (!box.running) {
      try {
        current = await startBox(host, box.boxId);
        woke = true;
      } catch (e) {
        const err = toAppError(e);
        const message = err.key ? msg(err.key as MessageKey, err.params) : err.message;
        throw new AppError(err.status, err.code, message, err.details, {
          hint: msg("exec_wake_failed_hint"),
          retryable: err.retryable,
        });
      }
    }

    const argv = input.argv ?? (input.cmd !== undefined ? ["/bin/sh", "-c", input.cmd] : undefined);
    if (!argv) throw new AppError(500, "internal", "exec was called without cmd or argv");
    const session = await host.runtime.startExec(current.id, {
      cmd: argv,
      env: Object.entries(input.env).map(([key, value]) => `${key}=${value}`),
      workingDir: input.cwd,
      user: input.user,
      tty: false,
    });

    const live = this.create(current, session, input.background, woke, record);
    this.attach(live);
    this.writeStdin(live, input.stdin);
    live.recorder?.({
      op: "exec.start",
      kind: "write",
      status: "started",
      summary: `Exec started: ${current.name}`,
      target: this.target(live),
      detail: commandDetail(input, woke),
      ref: { execId: live.id },
    });
    const timer = setTimeout(() => void this.expire(live), input.timeoutSec * 1000);
    unref(timer);
    live.timer = timer;
    void this.capture(live);
    this.remember(live);

    if (input.background) {
      return {
        execId: live.id,
        background: true,
        woke,
        exitCode: null,
        stdout: "",
        stderr: "",
        truncated: false,
        durationMs: 0,
        outputRef: null,
        timedOut: false,
      };
    }
    await live.done;
    return this.view(live);
  }

  async get(execId: string, waitMs: number): Promise<ExecGetResult> {
    const live = this.live.get(execId);
    if (!live) throw notFound(msg("exec_not_found"), { hint: msg("exec_not_found_hint") });
    if (!live.settled && waitMs > 0) {
      await new Promise<void>((resolve) => {
        if (live.settled) return resolve();
        const timer = setTimeout(resolve, waitMs);
        unref(timer);
        live.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const status = !live.settled ? "running" : live.killed ? "killed" : "exited";
    return { ...this.view(live), status };
  }

  async kill(execId: string): Promise<ExecKillResult> {
    const live = this.live.get(execId);
    if (!live) throw notFound(msg("exec_not_found"), { hint: msg("exec_not_found_hint") });
    if (live.settled) throw conflict(msg("exec_not_running"), { hint: msg("exec_not_running_hint") });
    if (live.timer) {
      clearTimeout(live.timer);
      live.timer = null;
    }
    if (!live.killed) {
      live.killed = true;
      this.emitKilled(live, "client");
      await live.session.kill().catch(() => undefined);
      live.force();
    }
    await Promise.race([live.done, sleep(3000)]);
    return { execId, status: "killed" };
  }

  async output(execId: string): Promise<ExecOutputResult> {
    const live = this.live.get(execId);
    if (live) {
      const stdout = live.stdout.project(OUTPUT_HEAD_TAIL_BYTES);
      const stderr = live.stderr.project(OUTPUT_HEAD_TAIL_BYTES);
      return {
        execId,
        stdout: this.redact(stdout.text),
        stderr: this.redact(stderr.text),
        truncated: stdout.truncated || stderr.truncated,
        stdoutBytes: stdout.bytes,
        stderrBytes: stderr.bytes,
      };
    }
    const file = this.outputs.load(`exec/${execId}`);
    if (!file) throw notFound(msg("exec_output_missing"), { hint: msg("exec_output_missing_hint") });
    const stdoutBytes = file.stdoutBytes ?? Buffer.byteLength(file.stdout);
    const stderrBytes = file.stderrBytes ?? Buffer.byteLength(file.stderr);
    const truncated =
      file.truncated ?? (stdoutBytes > OUTPUT_HEAD_TAIL_BYTES * 2 || stderrBytes > OUTPUT_HEAD_TAIL_BYTES * 2);
    return { execId, stdout: file.stdout, stderr: file.stderr, truncated, stdoutBytes, stderrBytes };
  }

  private create(
    box: Box,
    session: LiveExec["session"],
    background: boolean,
    woke: boolean,
    recorder: ((note: AuditNote) => void) | undefined,
  ): LiveExec {
    let resolveDone: () => void = noop;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    let force: () => void = noop;
    const forced = new Promise<void>((resolve) => {
      force = resolve;
    });
    return {
      id: `ex_${ulid()}`,
      boxId: box.id,
      boxName: box.name,
      session,
      stdout: new EdgeBuffer(OUTPUT_HEAD_TAIL_BYTES),
      stderr: new EdgeBuffer(OUTPUT_HEAD_TAIL_BYTES),
      startedAt: Date.now(),
      timer: null,
      done,
      resolveDone,
      forced,
      force,
      settled: false,
      timedOut: false,
      killed: false,
      exitCode: null,
      woke,
      background,
      waiters: [],
      recorder,
    };
  }

  private attach(live: LiveExec): void {
    collect(live.stdout, live.session.stdout);
    collect(live.stderr, live.session.stderr);
  }

  private writeStdin(live: LiveExec, stdin: string | undefined): void {
    try {
      if (stdin !== undefined && stdin.length > 0) live.session.stream.write(stdin);
      live.session.stream.end();
    } catch {
      // The process can exit before stdin is attached.
    }
  }

  private remember(live: LiveExec): void {
    this.live.set(live.id, live);
    if (this.live.size <= MAX_LIVE) return;
    for (const [id, item] of this.live) {
      if (!item.settled) continue;
      this.live.delete(id);
      if (this.live.size <= MAX_LIVE) return;
    }
  }

  private async capture(live: LiveExec): Promise<void> {
    try {
      await Promise.race([
        Promise.all([
          finished(live.session.stdout, { cleanup: true }).catch(() => undefined),
          finished(live.session.stderr, { cleanup: true }).catch(() => undefined),
        ]),
        live.forced,
      ]);
      await this.finish(live);
    } catch (e) {
      log.error("exec.capture_failed", { execId: live.id, error: String(e) });
      if (!live.settled) {
        live.exitCode = live.exitCode ?? 1;
        live.settled = true;
        this.notify(live);
      }
    }
  }

  private async expire(live: LiveExec): Promise<void> {
    if (live.settled || live.killed) return;
    live.timedOut = true;
    live.killed = true;
    this.emitKilled(live, "timeout");
    await live.session.kill().catch(() => undefined);
    live.force();
  }

  private async finish(live: LiveExec): Promise<void> {
    if (live.settled) return;
    if (live.timer) {
      clearTimeout(live.timer);
      live.timer = null;
    }
    let status = await live.session.inspect().catch(() => null);
    const deadline = Date.now() + (live.killed ? 2000 : 200);
    while (status?.running && Date.now() < deadline) {
      await sleep(50);
      status = await live.session.inspect().catch(() => status);
    }
    live.exitCode = status && !status.running ? status.exitCode : null;
    if (live.killed && live.exitCode === null) live.exitCode = 137;
    live.settled = true;
    const durationMs = Math.max(0, Date.now() - live.startedAt);
    const stdout = live.stdout.project(OUTPUT_HEAD_TAIL_BYTES);
    const stderr = live.stderr.project(OUTPUT_HEAD_TAIL_BYTES);
    let outputRef = `exec/${live.id}`;
    try {
      outputRef = this.outputs.save(
        live.id,
        { stdout: stdout.text, stderr: stderr.text },
        {
          capped: true,
          stdoutBytes: stdout.bytes,
          stderrBytes: stderr.bytes,
          exitCode: live.exitCode,
          timedOut: live.timedOut,
          status: live.killed ? "killed" : "exited",
        },
      );
    } catch (e) {
      log.error("exec.output_failed", { execId: live.id, error: String(e) });
    }
    live.recorder?.({
      op: "exec.finish",
      kind: "write",
      status: "ok",
      summary: `Exec finished: ${live.boxName}`,
      target: this.target(live),
      detail: {
        execId: live.id,
        exitCode: live.exitCode,
        durationMs,
        stdoutBytes: live.stdout.byteLength,
        stderrBytes: live.stderr.byteLength,
        truncated: stdout.truncated || stderr.truncated,
        timedOut: live.timedOut,
        woke: live.woke,
        background: live.background,
      },
      ref: { execId: live.id, outputRef },
      durationMs,
    });
    this.notify(live);
  }

  private emitKilled(live: LiveExec, reason: "timeout" | "client"): void {
    live.recorder?.({
      op: "exec.killed",
      kind: "write",
      status: "ok",
      summary: `Exec killed: ${live.boxName}`,
      target: this.target(live),
      detail: { execId: live.id, reason },
      ref: { execId: live.id },
    });
  }

  private notify(live: LiveExec): void {
    const waiters = live.waiters;
    live.waiters = [];
    for (const waiter of waiters) waiter();
    live.resolveDone();
  }

  private view(live: LiveExec): ExecRunResult {
    const stdout = live.stdout.project(EXEC_INLINE_EDGE_BYTES);
    const stderr = live.stderr.project(EXEC_INLINE_EDGE_BYTES);
    const truncated = stdout.truncated || stderr.truncated;
    return {
      execId: live.id,
      background: live.background,
      woke: live.woke,
      exitCode: live.settled ? live.exitCode : null,
      stdout: this.redact(stdout.text),
      stderr: this.redact(stderr.text),
      truncated,
      durationMs: Math.max(0, Date.now() - live.startedAt),
      outputRef: truncated ? `exec/${live.id}` : null,
      timedOut: live.timedOut,
    };
  }

  private target(live: LiveExec): { kind: string; id: string; name: string } {
    return { kind: "box", id: live.boxId, name: live.boxName };
  }
}
