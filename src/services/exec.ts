import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";

import { OUTPUT_HEAD_TAIL_BYTES, type OutputStore } from "../events/outputs";
import type { AuditNote } from "../events/types";
import { ulid } from "../events/ulid";
import type { HostCtx } from "../host/registry";
import { AppError, conflict, notFound, toAppError } from "../lib/errors";
import { log } from "../lib/logger";
import { type MessageKey, msg } from "../lib/messages";
import { type Box, ensureRunning } from "./boxes";
import { EdgeBuffer, EXEC_INLINE_EDGE_BYTES } from "./exec-buffer";

const MAX_LIVE = 200;

/** How long `exec_get` may wait. Stays under the server's 60s idle timeout. */
export const EXEC_WAIT_MAX_MS = 25_000;
/** Background execs that may run at once. Each holds a process and its output until it ends. */
export const EXEC_BACKGROUND_PER_BOX = 8;
export const EXEC_BACKGROUND_TOTAL = 64;

/** Root by name or by uid, optionally with a group. Recorded in the audit so privileged runs stand out. */
export function isPrivilegedUser(user: string): boolean {
  const [name] = user.split(":");
  return name === "root" || name === "0";
}

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

/** `killed` covers both `exec_kill` and a timeout. `running` after a timeout means the kill did not stop the process. */
export type ExecState = "running" | "exited" | "killed";

export interface ExecRunResult {
  execId: string;
  background: boolean;
  woke: boolean;
  status: ExecState;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  outputRef: string | null;
  timedOut: boolean;
}

export type ExecGetResult = ExecRunResult;

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
  /** Container id. The runtime and the run registry key on it. */
  boxId: string;
  /** Stable box id (`bx_…`). The activity heartbeat keys on it. */
  stableId: string;
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
  endedAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Resolves once the exec has ended and its result is recorded. */
  done: Promise<void>;
  resolveDone: () => void;
  /** Resolves when a foreground caller should stop waiting although the exec still runs (its kill failed). */
  released: Promise<void>;
  release: () => void;
  settled: boolean;
  timedOut: boolean;
  /** Set once the runtime has stopped every process of the exec. */
  killed: boolean;
  /** The stop in progress. A kill and a timeout that overlap share it instead of stopping the exec twice. */
  stopping: Promise<void> | null;
  exitCode: number | null;
  woke: boolean;
  background: boolean;
  waiters: Array<() => void>;
  recorder?: (note: AuditNote) => void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** How long `exec_kill` waits for the exec to record its end before it answers. */
const KILL_SETTLE_MS = 3000;
/** A timeout whose stop fails is tried again after 1 s, then 2 s, 4 s and so on, but not after more than this. */
const EXPIRE_RETRY_MS = 1000;
const EXPIRE_RETRY_MAX_MS = 30_000;

/** Resolves when `done` does or after `ms`, and never leaves the timer running. */
function settleWithin(done: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([done, limit]).finally(() => clearTimeout(timer));
}

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
    privileged: isPrivilegedUser(input.user),
    timeoutSec: input.timeoutSec,
    background: input.background,
    env: Object.keys(input.env),
    stdinBytes: input.stdin === undefined ? 0 : Buffer.byteLength(input.stdin),
    woke,
  };
}

function backgroundRefused(key: MessageKey, max: number): AppError {
  return new AppError(429, "too_many_requests", msg(key, { max }), undefined, {
    hint: msg("exec_background_limit_hint"),
  });
}

/**
 * Runs commands in a box. A stopped box is started first. Output is kept in memory up to the stored head and tail,
 * and the same window is written under DATA_DIR/exec when the command ends. The in-memory map is lost on restart.
 */
export class ExecManager implements ExecService {
  private readonly live = new Map<string, LiveExec>();
  /** Background execs whose start is in progress, by box. They count against the limits before they are live. */
  private readonly starting = new Map<string, number>();
  /** Runs in progress by container, from before the box is woken until the run returns. Foreground runs count too. */
  private readonly entering = new Map<string, number>();
  private onActivity: ((boxId: string) => void) | undefined;

  constructor(
    private readonly outputs: OutputStore,
    private readonly redact: (text: string) => string,
  ) {}

  /** Idle-sleep heartbeat (#12). `boxId` is the stable id. */
  setActivityHandler(handler: ((boxId: string) => void) | undefined): void {
    this.onActivity = handler;
  }

  /** True while an exec is starting or running on this container, foreground or background. Exempts the box from idle sleep. */
  hasRunning(containerId: string): boolean {
    if ((this.entering.get(containerId) ?? 0) > 0) return true;
    for (const item of this.live.values()) {
      if (item.boxId === containerId && !item.settled) return true;
    }
    return false;
  }

  lookup(execId: string): ExecTarget | undefined {
    const live = this.live.get(execId);
    return live ? { id: live.boxId, name: live.boxName } : undefined;
  }

  async run(host: HostCtx, box: Box, input: ExecRunInput, record?: (note: AuditNote) => void): Promise<ExecRunResult> {
    const releaseSlot = input.background ? this.reserveBackground(box.id) : noop;
    const leaveRun = this.enter(box.id);
    try {
      this.onActivity?.(box.boxId);
      let current: Box;
      let woke: boolean;
      try {
        ({ box: current, woke } = await ensureRunning(host, box.boxId, { record }));
      } catch (e) {
        const err = toAppError(e);
        // An expired TTL already says why and what to do; the generic wake hint would hide that.
        if (err.key === "box_ttl_expired") throw err;
        const message = err.key ? msg(err.key as MessageKey, err.params) : err.message;
        throw new AppError(err.status, err.code, message, err.details, {
          hint: msg("exec_wake_failed_hint"),
          retryable: err.retryable,
        });
      }

      const argv = input.argv ?? (input.cmd !== undefined ? ["/bin/sh", "-c", input.cmd] : undefined);
      if (!argv) throw new AppError(500, "internal", "exec was called without cmd or argv");
      const session = await host.runtime.startExec(current.id, {
        cmd: argv,
        env: Object.entries(input.env).map(([key, value]) => `${key}=${value}`),
        workingDir: input.cwd,
        user: input.user,
        // A setuid program the command starts runs as root and only root can stop it. The strict profile has no
        // escalation, so its exec user can stop the exec itself.
        stopAs: box.profile === "strict" ? input.user : "root",
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
      const timer = setTimeout(() => void this.expire(live, 0), input.timeoutSec * 1000);
      unref(timer);
      live.timer = timer;
      void this.capture(live);
      this.remember(live);

      if (!input.background) await Promise.race([live.done, live.released]);
      return this.view(live);
    } finally {
      leaveRun();
      releaseSlot();
    }
  }

  async get(execId: string, waitMs: number): Promise<ExecGetResult> {
    const live = this.live.get(execId);
    if (!live) throw notFound(msg("exec_not_found"), { hint: msg("exec_not_found_hint") });
    if (!live.settled && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        unref(timer);
        live.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.view(live);
  }

  async kill(execId: string): Promise<ExecKillResult> {
    const live = this.live.get(execId);
    if (!live) throw notFound(msg("exec_not_found"), { hint: msg("exec_not_found_hint") });
    if (live.settled) throw conflict(msg("exec_not_running"), { hint: msg("exec_not_running_hint") });
    if (!live.killed) {
      try {
        await this.stop(live, "client");
      } catch (e) {
        const err = toAppError(e);
        throw new AppError(err.status, err.code, msg("exec_kill_failed", { detail: err.message }), undefined, {
          hint: msg("exec_kill_failed_hint"),
        });
      }
    }
    await settleWithin(live.done, KILL_SETTLE_MS);
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

  /** Marks a run as in progress in this container. The returned function unmarks it. */
  private enter(containerId: string): () => void {
    this.entering.set(containerId, (this.entering.get(containerId) ?? 0) + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const left = (this.entering.get(containerId) ?? 1) - 1;
      if (left > 0) this.entering.set(containerId, left);
      else this.entering.delete(containerId);
    };
  }

  /**
   * Admits one background exec in `boxId`, or refuses with 429. The slot is taken before the box is woken, so a
   * refused request never starts a box. The returned function gives the slot back.
   */
  private reserveBackground(boxId: string): () => void {
    let inBox = this.starting.get(boxId) ?? 0;
    let total = 0;
    for (const count of this.starting.values()) total += count;
    for (const item of this.live.values()) {
      if (!item.background || item.settled) continue;
      total += 1;
      if (item.boxId === boxId) inBox += 1;
    }
    if (inBox >= EXEC_BACKGROUND_PER_BOX) throw backgroundRefused("exec_background_box_limit", EXEC_BACKGROUND_PER_BOX);
    if (total >= EXEC_BACKGROUND_TOTAL) throw backgroundRefused("exec_background_total_limit", EXEC_BACKGROUND_TOTAL);
    this.starting.set(boxId, (this.starting.get(boxId) ?? 0) + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const left = (this.starting.get(boxId) ?? 1) - 1;
      if (left > 0) this.starting.set(boxId, left);
      else this.starting.delete(boxId);
    };
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
    let release: () => void = noop;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      id: `ex_${ulid()}`,
      boxId: box.id,
      stableId: box.boxId,
      boxName: box.name,
      session,
      stdout: new EdgeBuffer(OUTPUT_HEAD_TAIL_BYTES),
      stderr: new EdgeBuffer(OUTPUT_HEAD_TAIL_BYTES),
      startedAt: Date.now(),
      endedAt: null,
      timer: null,
      done,
      resolveDone,
      released,
      release,
      settled: false,
      timedOut: false,
      killed: false,
      stopping: null,
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

  /** Waits for the output to close and for Docker to report the exit, then records the result. */
  private async capture(live: LiveExec): Promise<void> {
    try {
      await Promise.all([
        finished(live.session.stdout, { cleanup: true }).catch(() => undefined),
        finished(live.session.stderr, { cleanup: true }).catch(() => undefined),
      ]);
      await this.awaitExit(live);
    } catch (e) {
      log.error("exec.capture_failed", { execId: live.id, error: String(e) });
    }
    this.finalize(live);
  }

  /**
   * Polls until Docker reports the exec has ended, so a live process is never recorded as finished. There is no
   * deadline: the timeout or an explicit kill is what ends a command that keeps running. Only several failed reads
   * in a row give up, and the exit code is then left unknown.
   */
  private async awaitExit(live: LiveExec): Promise<void> {
    let delay = 20;
    let unreadable = 0;
    for (;;) {
      const status = await live.session.inspect().catch(() => null);
      if (status && !status.running) {
        live.exitCode = status.exitCode;
        return;
      }
      if (!status && ++unreadable >= 3) return;
      await sleep(delay);
      delay = Math.min(delay * 2, 1000);
    }
  }

  /**
   * Called on a timeout and again after each failed attempt. A failed stop leaves the exec running and releases a
   * foreground caller. The next attempt waits twice as long as the last, so an exec that cannot be stopped yet (its
   * box is paused, or a process is briefly unkillable) is stopped as soon as it can be.
   */
  private async expire(live: LiveExec, attempt: number): Promise<void> {
    live.timer = null;
    if (live.settled || live.killed) return;
    live.timedOut = true;
    try {
      await this.stop(live, "timeout");
    } catch {
      live.release();
      if (live.settled) return;
      const delay = Math.min(EXPIRE_RETRY_MS * 2 ** attempt, EXPIRE_RETRY_MAX_MS);
      live.timer = setTimeout(() => void this.expire(live, attempt + 1), delay);
      unref(live.timer);
    }
  }

  /**
   * Asks the runtime to stop every process of the exec. Stops that overlap share one attempt. A failure is recorded
   * and rethrown, and the exec stays in the running state so that a later kill or the timeout can try again.
   */
  private stop(live: LiveExec, reason: "client" | "timeout"): Promise<void> {
    live.stopping ??= this.attemptStop(live, reason).finally(() => {
      live.stopping = null;
    });
    return live.stopping;
  }

  private async attemptStop(live: LiveExec, reason: "client" | "timeout"): Promise<void> {
    try {
      await live.session.kill();
    } catch (e) {
      const err = toAppError(e);
      log.error("exec.kill_failed", { execId: live.id, reason, error: err.message });
      live.recorder?.({
        op: "exec.kill_failed",
        kind: "write",
        status: "error",
        summary: `Exec kill failed: ${live.boxName}`,
        target: this.target(live),
        detail: { execId: live.id, reason, error: err.message },
        ref: { execId: live.id },
        error: { code: err.code, status: err.status },
      });
      throw err;
    }
    live.killed = true;
    if (live.timer) {
      clearTimeout(live.timer);
      live.timer = null;
    }
    this.emitKilled(live, reason);
  }

  /** Records the end of the exec exactly once. Duration stops here, so a finished exec never gets longer. */
  private finalize(live: LiveExec): void {
    if (live.settled) return;
    if (live.timer) {
      clearTimeout(live.timer);
      live.timer = null;
    }
    live.settled = true;
    live.endedAt = Date.now();
    if (live.killed && live.exitCode === null) live.exitCode = 137;
    const durationMs = live.endedAt - live.startedAt;
    const state: Exclude<ExecState, "running"> = live.killed ? "killed" : "exited";
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
          status: state,
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
        status: state,
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
    this.onActivity?.(live.stableId);
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

  private stateOf(live: LiveExec): ExecState {
    if (live.killed) return "killed";
    return live.settled ? "exited" : "running";
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
      durationMs: Math.max(0, (live.endedAt ?? Date.now()) - live.startedAt),
      outputRef: truncated ? `exec/${live.id}` : null,
      timedOut: live.timedOut,
      status: this.stateOf(live),
    };
  }

  private target(live: LiveExec): { kind: string; id: string; name: string } {
    return { kind: "box", id: live.boxId, name: live.boxName };
  }
}
