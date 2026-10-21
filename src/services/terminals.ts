import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";

import type { AuditNote, EventTarget, Source } from "../events/types";
import type { HostCtx } from "../host/registry";
import { AppError, badRequest, conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import type { ExecSession } from "../runtime";
import {
  appendedLines,
  classifyTmuxFailure,
  hexBytes,
  isSessionName,
  LIST_SESSIONS_FORMAT,
  ORIGIN_OPTION,
  paneLines,
  paneTarget,
  parseSessionList,
  type SessionOrigin,
  sessionTarget,
} from "../tmux/format";
import { type Box, startBox } from "./boxes";

/** The most a single `session_read` returns. Each line is at most a pane row, so this bounds the response. */
export const READ_LINES_MAX = 2000;

const TMUX_TIMEOUT_MS = 10_000;
const TMUX_ENV = ["TERM=xterm-256color", "LANG=C.UTF-8"];
const WORKDIR = "/workspace";
/** A login shell: bash when the box has it, otherwise sh. Starts in the workspace. */
const SHELL_COMMAND = "command -v bash >/dev/null && exec bash -l || exec sh -l";

export type Controller = "agent" | "human";

export interface SessionInfo {
  readonly name: string;
  readonly origin: SessionOrigin;
  readonly controller: Controller;
  readonly takenOver: boolean;
}

export interface ListedSession extends SessionInfo {
  readonly createdAt: number;
  readonly attached: number;
}

/** What one viewer may do with a session. Only the console (`ui`) may type, take over or hand back. */
export interface SessionView extends SessionInfo {
  readonly canType: boolean;
  readonly canTakeOver: boolean;
  readonly canRelease: boolean;
}

export interface ReadOptions {
  readonly lines: number;
  /** The cursor the previous read of this session returned. Absent reads the current window. */
  readonly since?: string;
}

export interface ReadResult {
  readonly session: string;
  readonly cursor: string;
  /** True when `since` could not be continued, so `lines` is the current window rather than what is new. */
  readonly reset: boolean;
  readonly truncated: boolean;
  readonly lines: string[];
  readonly controller: Controller;
}

/** Exactly one of `keys` (tmux key names) or `text` (literal bytes) is set. */
export interface SendInput {
  readonly keys?: readonly string[];
  readonly text?: string;
}

export interface SendResult {
  readonly keys: number;
  readonly bytes: number;
}

export interface StartResult {
  readonly session: SessionInfo;
  /** False when a session with that name already existed. */
  readonly created: boolean;
  /** True when the box was stopped and this call started it. */
  readonly woke: boolean;
}

export interface AttachOptions {
  readonly source: Source;
  readonly onChange?: (view: SessionView) => void;
}

/** Writes one audit event for the session. The service never builds events itself; the app supplies the recorder. */
export type RecordNote = (hostId: string, source: Source, note: AuditNote) => void;

export interface TerminalServiceOptions {
  readonly record: RecordNote;
  /** Milliseconds without human input before a takeover returns the session to the agent. 0 keeps it until released. */
  readonly takeoverIdleMs: number;
}

interface Snapshot {
  readonly epoch: string;
  readonly seq: number;
  readonly lines: readonly string[];
}

/** What MiniBox knows about one tmux session in one box. Lives as long as the session does. */
interface Tracked {
  readonly key: string;
  readonly containerId: string;
  readonly name: string;
  readonly origin: SessionOrigin;
  controller: Controller;
  takenOver: boolean;
  lastInputAt: number;
  hostId: string;
  target: EventTarget;
  readonly attachments: Set<Attachment>;
  snapshot: Snapshot | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

interface TmuxRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * A terminal opened on a session. The WebSocket side forwards bytes both ways and calls `close` when the socket goes.
 * Closing ends the attach process inside the box; the tmux session keeps running.
 */
export class Attachment {
  private bytesIn = 0;
  private bytesOut = 0;
  private closed = false;
  private readonly startedAt = Date.now();

  constructor(
    readonly exec: ExecSession,
    readonly tracked: Tracked,
    readonly source: Source,
    private readonly where: { readonly hostId: string; readonly box: EventTarget },
    private readonly record: RecordNote,
    private readonly onChange?: (view: SessionView) => void,
  ) {}

  get name(): string {
    return this.tracked.name;
  }

  get canType(): boolean {
    return this.source === "ui" && this.tracked.controller === "human";
  }

  view(): SessionView {
    return viewOf(this.tracked, this.source);
  }

  /** Forwards input to the session. Returns false, and forwards nothing, unless this viewer may type right now. */
  write(data: string | Uint8Array): boolean {
    if (this.closed || !this.canType) return false;
    this.bytesIn += typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    this.tracked.lastInputAt = Date.now();
    this.exec.stream.write(data);
    return true;
  }

  resize(size: { cols: number; rows: number }): void {
    this.exec.resize(size).catch(() => undefined);
  }

  /** Counts output the caller has passed on, for the close record. */
  sent(bytes: number): void {
    this.bytesOut += bytes;
  }

  notify(): void {
    this.onChange?.(this.view());
  }

  /** Ends the attach process inside the box, then the stream, and records the close. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.tracked.attachments.delete(this);
    const durationMs = Date.now() - this.startedAt;
    let failure: string | undefined;
    try {
      await this.exec.kill();
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
      log.error("terminal.kill_failed", { session: this.tracked.name, error: failure });
    }
    this.exec.stream.destroy();
    this.record(this.where.hostId, this.source, {
      op: "terminal.close",
      kind: "write",
      status: failure ? "error" : "ok",
      summary: `Close a terminal session: ${this.tracked.name}`,
      target: this.where.box,
      detail: { session: this.tracked.name, bytesIn: this.bytesIn, bytesOut: this.bytesOut, durationMs },
      durationMs,
      error: failure ? { code: "internal", status: 500 } : undefined,
    });
  }
}

/**
 * Sessions of the boxes, through tmux. Every tmux command is a short `dev` exec in the box, so a session is only a tmux
 * session. This service adds what tmux does not have: who may type, the takeover lock, and the cursor `session_read` uses.
 *
 * Takeover is a hard lock. A session whose controller is `human` refuses agent input with `taken_over`; reads still work.
 * An agent's session comes back to the agent when the human releases it or goes idle for `takeoverIdleMs`.
 */
export class TerminalService {
  private readonly tracked = new Map<string, Tracked>();
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly options: TerminalServiceOptions) {}

  async list(host: HostCtx, box: Box): Promise<ListedSession[]> {
    if (!box.running) {
      this.forgetBox(box.id, new Set());
      return [];
    }
    const run = await runTmux(host, box.id, ["list-sessions", "-F", LIST_SESSIONS_FORMAT]);
    if (classifyTmuxFailure(run.code, run.stderr) === "no_server") {
      this.forgetBox(box.id, new Set());
      return [];
    }
    if (run.code !== 0) throw this.failure(run, box.id, "");
    const listed = parseSessionList(run.stdout);
    this.forgetBox(box.id, new Set(listed.map((session) => session.name)));
    return listed.map((session) => {
      const tracked = this.track(host.host.id, box, session.name, session.origin);
      return { ...infoOf(tracked), createdAt: session.createdAt, attached: session.attached };
    });
  }

  async start(host: HostCtx, box: Box, name: string, source: Source): Promise<StartResult> {
    assertName(name);
    let current = box;
    let woke = false;
    if (!box.running) {
      current = await startBox(host, box.boxId);
      woke = true;
    }
    return this.serialized(keyOf(current.id, name), async () => {
      const run = await runTmux(host, current.id, [
        "new-session",
        "-d",
        "-s",
        name,
        "-c",
        WORKDIR,
        "--",
        "sh",
        "-c",
        SHELL_COMMAND,
      ]);
      const created = run.code === 0;
      if (!created && classifyTmuxFailure(run.code, run.stderr) !== "duplicate") {
        throw this.failure(run, current.id, name);
      }
      if (created) {
        this.forget(current.id, name);
        await this.mark(host, current.id, name, source === "ui" ? "human" : "agent");
      }
      const origin = await this.probe(host, current, name);
      return { session: infoOf(this.track(host.host.id, current, name, origin)), created, woke };
    });
  }

  async read(host: HostCtx, box: Box, name: string, options: ReadOptions): Promise<ReadResult> {
    assertName(name);
    if (!box.running) throw this.stopped(box.id);
    return this.serialized(keyOf(box.id, name), async () => {
      const origin = await this.probe(host, box, name);
      const tracked = this.track(host.host.id, box, name, origin);
      const run = await runTmux(host, box.id, ["capture-pane", "-p", "-J", "-S", "-", "-t", paneTarget(name)]);
      if (run.code !== 0) throw this.failure(run, box.id, name);
      const current = paneLines(run.stdout);
      const previous = tracked.snapshot;
      const { since } = options;
      const appended =
        since !== undefined && previous && since === cursorOf(previous)
          ? appendedLines(previous.lines, current)
          : undefined;
      const window = appended ?? current;
      const lines = window.slice(Math.max(0, window.length - options.lines));
      const epoch = previous?.epoch ?? randomBytes(6).toString("hex");
      const seq = (previous?.seq ?? 0) + 1;
      tracked.snapshot = { epoch, seq, lines: current };
      return {
        session: name,
        cursor: `${epoch}.${seq}`,
        reset: since !== undefined && appended === undefined,
        truncated: lines.length < window.length,
        lines,
        controller: tracked.controller,
      };
    });
  }

  async send(host: HostCtx, box: Box, name: string, input: SendInput): Promise<SendResult> {
    assertName(name);
    if (!box.running) throw this.stopped(box.id);
    const keys = input.keys ?? [];
    const text = input.text ?? "";
    return this.serialized(keyOf(box.id, name), async () => {
      const origin = await this.probe(host, box, name);
      const tracked = this.track(host.host.id, box, name, origin);
      if (tracked.controller === "human") throw takenOverError(name);
      if (keys.length === 0 && text.length === 0) return { keys: 0, bytes: 0 };
      const args = keys.length > 0 ? [...keys] : ["-H", ...hexBytes(text)];
      const run = await runTmux(host, box.id, ["send-keys", "-t", paneTarget(name), ...args]);
      if (run.code !== 0) throw this.failure(run, box.id, name);
      return { keys: keys.length, bytes: Buffer.byteLength(text) };
    });
  }

  async close(host: HostCtx, box: Box, name: string): Promise<void> {
    assertName(name);
    if (!box.running) throw this.stopped(box.id);
    await this.serialized(keyOf(box.id, name), async () => {
      const run = await runTmux(host, box.id, ["kill-session", "-t", sessionTarget(name)]);
      if (run.code === 0) this.forget(box.id, name);
      else throw this.failure(run, box.id, name);
    });
  }

  /** Opens a terminal on the session. The box must be running; the WebSocket layer checks that before upgrading. */
  async attach(host: HostCtx, box: Box, name: string, options: AttachOptions): Promise<Attachment> {
    assertName(name);
    if (!box.running) throw this.stopped(box.id);
    const origin = await this.probe(host, box, name);
    const tracked = this.track(host.host.id, box, name, origin);
    const exec = await host.runtime.startExec(box.id, {
      cmd: ["tmux", "-u", "attach-session", "-t", sessionTarget(name)],
      env: TMUX_ENV,
      workingDir: WORKDIR,
      user: "dev",
      tty: true,
    });
    const attachment = new Attachment(
      exec,
      tracked,
      options.source,
      { hostId: host.host.id, box: tracked.target },
      this.options.record,
      options.onChange,
    );
    tracked.attachments.add(attachment);
    this.options.record(host.host.id, options.source, {
      op: "terminal.open",
      kind: "write",
      status: "ok",
      summary: `Open a terminal session: ${name}`,
      target: tracked.target,
      detail: { session: name },
    });
    return attachment;
  }

  /** The viewer takes the session. Only the console can, and only from the agent's side. Returns whether it changed. */
  takeOver(attachment: Attachment): boolean {
    const { tracked } = attachment;
    if (attachment.source !== "ui" || tracked.controller === "human") return false;
    tracked.controller = "human";
    tracked.takenOver = true;
    tracked.lastInputAt = Date.now();
    this.arm(tracked, this.options.takeoverIdleMs);
    this.options.record(tracked.hostId, attachment.source, {
      op: "session.takeover",
      kind: "write",
      status: "ok",
      summary: `Take over a session: ${tracked.name}`,
      target: tracked.target,
      detail: { session: tracked.name },
    });
    this.broadcast(tracked);
    return true;
  }

  /** The viewer hands the session back to the agent. Returns whether it changed. */
  release(attachment: Attachment): boolean {
    const { tracked } = attachment;
    if (attachment.source !== "ui" || tracked.controller === "agent") return false;
    this.handBack(tracked, attachment.source, "manual");
    return true;
  }

  shutdown(): void {
    for (const tracked of this.tracked.values()) this.disarm(tracked);
  }

  private async probe(host: HostCtx, box: Box, name: string): Promise<SessionOrigin> {
    const run = await runTmux(host, box.id, ["display-message", "-p", "-t", paneTarget(name), `#{${ORIGIN_OPTION}}`]);
    if (run.code !== 0) throw this.failure(run, box.id, name);
    return run.stdout.trim() === "human" ? "human" : "agent";
  }

  private async mark(host: HostCtx, containerId: string, name: string, origin: SessionOrigin): Promise<void> {
    const marked = await runTmux(host, containerId, ["set-option", "-t", paneTarget(name), ORIGIN_OPTION, origin]);
    if (marked.code !== 0) throw this.failure(marked, containerId, name);
    const hidden = await runTmux(host, containerId, ["set-option", "-t", paneTarget(name), "status", "off"]);
    if (hidden.code !== 0) throw this.failure(hidden, containerId, name);
  }

  /** Returns the tracked session for this name, replacing one that was made for an earlier session of the same name. */
  private track(hostId: string, box: Box, name: string, origin: SessionOrigin): Tracked {
    const key = keyOf(box.id, name);
    const existing = this.tracked.get(key);
    const target: EventTarget = { kind: "box", id: box.id, name: box.name };
    if (existing && existing.origin === origin) {
      existing.hostId = hostId;
      existing.target = target;
      return existing;
    }
    if (existing) this.drop(existing);
    const controller: Controller = origin === "human" ? "human" : "agent";
    const tracked: Tracked = {
      key,
      containerId: box.id,
      name,
      origin,
      controller,
      takenOver: false,
      lastInputAt: Date.now(),
      hostId,
      target,
      attachments: new Set(),
      snapshot: null,
      idleTimer: null,
    };
    this.tracked.set(key, tracked);
    return tracked;
  }

  private forget(containerId: string, name: string): void {
    const tracked = this.tracked.get(keyOf(containerId, name));
    if (tracked) this.drop(tracked);
  }

  private forgetBox(containerId: string, keep: ReadonlySet<string>): void {
    for (const tracked of this.tracked.values()) {
      if (tracked.containerId === containerId && !keep.has(tracked.name)) this.drop(tracked);
    }
  }

  private drop(tracked: Tracked): void {
    this.disarm(tracked);
    this.tracked.delete(tracked.key);
  }

  private failure(run: TmuxRun, containerId: string, name: string): AppError {
    const kind = classifyTmuxFailure(run.code, run.stderr);
    if (kind === "not_found" || kind === "no_server") {
      this.forget(containerId, name);
      return notFound(msg("session_not_found"), { hint: msg("session_not_found_hint") });
    }
    if (kind === "missing") {
      return conflict(msg("session_tmux_missing"), { hint: msg("session_tmux_missing_hint") });
    }
    const detail = run.stderr.trim().split("\n")[0] || `exit status ${run.code}`;
    return new AppError(502, "docker_error", msg("session_tmux_failed", { detail }));
  }

  private stopped(containerId: string): AppError {
    this.forgetBox(containerId, new Set());
    return notFound(msg("session_not_found"), { hint: msg("session_box_stopped_hint") });
  }

  private serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.chains.set(key, next);
    return next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
  }

  private arm(tracked: Tracked, after: number): void {
    this.disarm(tracked);
    if (this.options.takeoverIdleMs <= 0) return;
    const timer = setTimeout(() => this.idle(tracked), after);
    if (typeof timer.unref === "function") timer.unref();
    tracked.idleTimer = timer;
  }

  private disarm(tracked: Tracked): void {
    if (tracked.idleTimer) clearTimeout(tracked.idleTimer);
    tracked.idleTimer = null;
  }

  private idle(tracked: Tracked): void {
    tracked.idleTimer = null;
    if (!tracked.takenOver) return;
    const remaining = tracked.lastInputAt + this.options.takeoverIdleMs - Date.now();
    if (remaining > 0) {
      this.arm(tracked, remaining);
      return;
    }
    this.handBack(tracked, "system", "idle");
  }

  private handBack(tracked: Tracked, source: Source, by: "manual" | "idle"): void {
    tracked.controller = "agent";
    tracked.takenOver = false;
    this.disarm(tracked);
    this.options.record(tracked.hostId, source, {
      op: "session.release",
      kind: "write",
      status: "ok",
      summary: `Return a session to the agent: ${tracked.name}`,
      target: tracked.target,
      detail: { session: tracked.name, by },
    });
    this.broadcast(tracked);
  }

  private broadcast(tracked: Tracked): void {
    for (const attachment of tracked.attachments) attachment.notify();
  }
}

function assertName(name: string): void {
  if (!isSessionName(name)) throw badRequest(msg("session_name_invalid"), { field: "name" });
}

function keyOf(containerId: string, name: string): string {
  return `${containerId}\0${name}`;
}

function cursorOf(snapshot: Snapshot): string {
  return `${snapshot.epoch}.${snapshot.seq}`;
}

function infoOf(tracked: Tracked): SessionInfo {
  return {
    name: tracked.name,
    origin: tracked.origin,
    controller: tracked.controller,
    takenOver: tracked.takenOver,
  };
}

function viewOf(tracked: Tracked, source: Source): SessionView {
  const browser = source === "ui";
  return {
    ...infoOf(tracked),
    canType: browser && tracked.controller === "human",
    canTakeOver: browser && tracked.controller === "agent",
    canRelease: browser && tracked.controller === "human",
  };
}

function takenOverError(name: string): AppError {
  return new AppError(
    409,
    "taken_over",
    msg("session_taken_over", { name }),
    { session: name },
    {
      hint: msg("session_taken_over_hint"),
      retryable: true,
    },
  );
}

/** Runs `tmux` in the box as `dev`, collects what it prints, and returns its status. */
async function runTmux(host: HostCtx, containerId: string, args: readonly string[]): Promise<TmuxRun> {
  const session = await host.runtime.startExec(containerId, {
    cmd: ["tmux", "-u", ...args],
    env: TMUX_ENV,
    workingDir: "/",
    user: "dev",
    tty: false,
  });
  const stdout = collectText(session.stdout);
  const stderr = collectText(session.stderr);
  const closed = await within(
    Promise.all([finished(session.stdout), finished(session.stderr)]).then(
      () => true,
      () => true,
    ),
    TMUX_TIMEOUT_MS,
  );
  if (closed === undefined) {
    await session.kill().catch(() => undefined);
    throw new AppError(502, "docker_error", msg("session_tmux_timeout", { max: TMUX_TIMEOUT_MS / 1000 }));
  }
  return { code: await exitCodeOf(session), stdout: stdout(), stderr: stderr() };
}

function collectText(stream: Readable): () => string {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: unknown) => {
    if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
    else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
  });
  stream.on("error", () => undefined);
  return () => Buffer.concat(chunks).toString("utf8");
}

async function exitCodeOf(session: ExecSession): Promise<number> {
  const deadline = Date.now() + TMUX_TIMEOUT_MS;
  for (let delay = 5; ; delay = Math.min(delay * 2, 200)) {
    const status = await session.inspect();
    if (!status.running) return status.exitCode ?? 1;
    if (Date.now() >= deadline) {
      await session.kill().catch(() => undefined);
      throw new AppError(502, "docker_error", msg("session_tmux_timeout", { max: TMUX_TIMEOUT_MS / 1000 }));
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}
