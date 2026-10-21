import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";

import type { AuditNote, EventTarget, Source } from "../events/types";
import type { HostCtx } from "../host/registry";
import { AppError, badRequest, conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { type Msg, msg } from "../lib/messages";
import { OWNER, type Principal } from "../operations/types";
import { type ExecSession, type ExecSpec, RuntimeError } from "../runtime";
import {
  acceptsIgnoreSize,
  appendedLines,
  classifyTmuxFailure,
  hexBytes,
  isSessionName,
  isUnrunnableExec,
  LIST_SESSIONS_FORMAT,
  ORIGIN_OPTION,
  PROBE_FORMAT,
  paneLines,
  paneTarget,
  parseProbe,
  parseSessionList,
  parseTmuxVersion,
  type SessionIdentity,
  type SessionOrigin,
  sessionTarget,
  type TmuxSession,
} from "../tmux/format";
import { type Box, startBox } from "./boxes";

/** The most a single `session_read` returns. Each line is at most a pane row, so this bounds the response. */
export const READ_LINES_MAX = 2000;
/** Rows of history a read captures: twice what it can return, so a reader can follow a burst of output across two reads. */
const HISTORY_LINES = READ_LINES_MAX * 2;
/** The most output one tmux command is read for. Past it the oldest bytes are dropped, so the newest screen still shows. */
const OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
/** Sessions one box may hold. Each is a tmux session with an entry here, so this bounds both. */
export const SESSIONS_PER_BOX_MAX = 16;
/** Terminals one session may have open at once, from the console and viewers together. Each is a tmux client and an exec. */
export const ATTACHES_PER_SESSION_MAX = 8;
/** Terminals a session keeps free for the console, so viewers cannot fill it and lock the person out. */
const CONSOLE_ATTACHES_RESERVED = 2;
/** Terminals viewers (every caller but the console) may hold on one session at once. */
export const VIEWER_ATTACHES_MAX = ATTACHES_PER_SESSION_MAX - CONSOLE_ATTACHES_RESERVED;

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
  /** Seconds without human input after which a takeover returns to the agent. 0 keeps it until released. */
  readonly idleReturnSec: number;
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
  /** Who opens the terminal. Its events and its close are recorded for this principal. */
  readonly principal: Principal;
  readonly onChange?: (view: SessionView) => void;
}

/** Writes one audit event for the session. The service never builds events itself; the app supplies the recorder. */
export type RecordNote = (hostId: string, source: Source, principal: Principal, note: AuditNote) => void;

export interface TerminalServiceOptions {
  readonly record: RecordNote;
  /** Milliseconds without human input before a takeover returns the session to the agent. 0 keeps it until released. */
  readonly takeoverIdleMs: number;
  /** Idle-sleep heartbeat (#12). Called with the stable box id. */
  readonly onActivity?: (boxId: string, kind: "terminal" | "session") => void;
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
  readonly boxId: string;
  readonly name: string;
  /** tmux's id and creation time of the session this entry follows. A different pair is a different session. */
  readonly sessionId: string;
  readonly createdAt: number;
  readonly origin: SessionOrigin;
  controller: Controller;
  takenOver: boolean;
  /** Who holds the takeover. Only the console takes a session over, so this is the owner unless it says otherwise. */
  takenBy: Principal;
  lastInputAt: number;
  hostId: string;
  target: EventTarget;
  readonly attachments: Set<Attachment>;
  /** Attaches that are starting, by kind. They count against the caps before they are in `attachments`. */
  opening: Record<AttachKind, number>;
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
    readonly principal: Principal,
    private readonly where: { readonly hostId: string; readonly box: EventTarget },
    private readonly record: RecordNote,
    private readonly onChange: ((view: SessionView) => void) | undefined,
    private readonly idleReturnSec: number,
  ) {}

  get name(): string {
    return this.tracked.name;
  }

  get canType(): boolean {
    return this.source === "ui" && this.tracked.controller === "human";
  }

  view(): SessionView {
    return viewOf(this.tracked, this.source, this.idleReturnSec);
  }

  /** Forwards input to the session. Returns false, and forwards nothing, unless this viewer may type right now. */
  write(data: string | Uint8Array): boolean {
    if (this.closed || !this.canType) return false;
    this.bytesIn += typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    this.tracked.lastInputAt = Date.now();
    // Activity for idle sleep is recorded by the service via onActivity when the attach is opened; keystrokes
    // keep the takeover timer fresh. The open attach itself already exempts the box from idle sleep.
    this.exec.stream.write(data);
    return true;
  }

  /** Only the console resizes. A Bearer viewer attaches with `ignore-size`, so its size is not used and its frames are dropped. */
  resize(size: { cols: number; rows: number }): void {
    if (this.source !== "ui") return;
    this.exec.resize(size).catch(() => undefined);
  }

  /** Stops reading output from tmux until the socket has drained, so a slow client does not buffer without limit. */
  pause(): void {
    if (!this.closed) this.exec.stream.pause();
  }

  resume(): void {
    if (!this.closed) this.exec.stream.resume();
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
    this.record(this.where.hostId, this.source, this.principal, {
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
 * Takeover is a hard lock. A session whose controller is `human` refuses agent input and an agent's close with
 * `taken_over`; reads still work, and only the console may close it. An agent's session comes back to the agent when the
 * human releases it or goes idle for `takeoverIdleMs`.
 */
export class TerminalService {
  private readonly tracked = new Map<string, Tracked>();
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly options: TerminalServiceOptions) {}

  /** True when any WebSocket (or other) attach is open on this container. Exempts the box from idle sleep. */
  hasOpenAttachment(containerId: string): boolean {
    for (const tracked of this.tracked.values()) {
      if (
        tracked.containerId === containerId &&
        (tracked.attachments.size > 0 || tracked.opening.console + tracked.opening.viewer > 0)
      ) {
        return true;
      }
    }
    return false;
  }

  async list(host: HostCtx, box: Box): Promise<ListedSession[]> {
    if (!box.running) {
      this.forgetBox(box.id, new Set());
      return [];
    }
    return this.serialized(boxKey(box.id), async () => {
      const listed = await this.listTmux(host, box.id);
      this.forgetBox(box.id, new Set(listed.map((session) => session.name)));
      return listed.map((session) => {
        const tracked = this.track(host.host.id, box, session);
        return { ...infoOf(tracked), createdAt: session.createdAt, attached: session.attached };
      });
    });
  }

  async start(host: HostCtx, box: Box, name: string, source: Source): Promise<StartResult> {
    assertName(name);
    let current = box;
    let woke = false;
    if (!box.running) {
      current = await startBox(host, box.boxId, this.options.record);
      woke = true;
    }
    return this.serialized(boxKey(current.id), () =>
      this.serialized(keyOf(current.id, name), async () => {
        const listed = await this.listTmux(host, current.id);
        if (listed.length >= SESSIONS_PER_BOX_MAX && !listed.some((session) => session.name === name)) {
          throw sessionLimitError();
        }
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
          await this.tuneServer(host, current.id);
          await this.mark(host, current.id, name, source === "ui" ? "human" : "agent");
        }
        const found = await this.probe(host, current, name);
        this.options.onActivity?.(current.boxId, "session");
        return { session: infoOf(this.track(host.host.id, current, found)), created, woke };
      }),
    );
  }

  async read(host: HostCtx, box: Box, name: string, options: ReadOptions): Promise<ReadResult> {
    assertName(name);
    if (!box.running) throw this.stopped(box.id);
    this.options.onActivity?.(box.boxId, "session");
    return this.serialized(keyOf(box.id, name), async () => {
      const tracked = this.track(host.host.id, box, await this.probe(host, box, name));
      const run = await runTmux(host, box.id, [
        "capture-pane",
        "-p",
        "-J",
        "-S",
        `-${HISTORY_LINES}`,
        "-t",
        paneTarget(name),
      ]);
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
    this.options.onActivity?.(box.boxId, "session");
    const keys = input.keys ?? [];
    const text = input.text ?? "";
    return this.serialized(keyOf(box.id, name), async () => {
      const tracked = this.track(host.host.id, box, await this.probe(host, box, name));
      if (tracked.controller === "human") throw takenOverError(name);
      if (keys.length === 0 && text.length === 0) return { keys: 0, bytes: 0 };
      const args = keys.length > 0 ? [...keys] : ["-H", ...hexBytes(text)];
      const run = await runTmux(host, box.id, ["send-keys", "-t", paneTarget(name), ...args]);
      if (run.code !== 0) throw this.failure(run, box.id, name);
      return { keys: keys.length, bytes: Buffer.byteLength(text) };
    });
  }

  /** Kills the session. While a person holds it, only the console may close it, as it may type into it. */
  async close(host: HostCtx, box: Box, name: string, source: Source): Promise<void> {
    assertName(name);
    if (!box.running) throw this.stopped(box.id);
    await this.serialized(keyOf(box.id, name), async () => {
      const tracked = this.track(host.host.id, box, await this.probe(host, box, name));
      if (tracked.controller === "human" && source !== "ui") throw takenOverError(name);
      const run = await runTmux(host, box.id, ["kill-session", "-t", sessionTarget(name)]);
      if (run.code === 0) this.forget(box.id, name);
      else throw this.failure(run, box.id, name);
    });
  }

  /** Opens a terminal on the session. The box must be running; the WebSocket layer checks that before upgrading. */
  async attach(host: HostCtx, box: Box, name: string, options: AttachOptions): Promise<Attachment> {
    assertName(name);
    if (!box.running) throw this.stopped(box.id);
    const tracked = this.track(host.host.id, box, await this.probe(host, box, name));
    const kind = kindOf(options.source);
    if (kind === "viewer") await this.requireViewerSupport(host, box.id);
    checkRoom(tracked, kind);
    tracked.opening[kind] += 1;
    let exec: ExecSession;
    try {
      exec = await startInBox(host, box.id, {
        cmd: attachCommand(name, options.source),
        env: TMUX_ENV,
        workingDir: WORKDIR,
        user: "dev",
        tty: true,
      });
    } finally {
      tracked.opening[kind] -= 1;
    }
    const attachment = new Attachment(
      exec,
      tracked,
      options.source,
      options.principal,
      { hostId: host.host.id, box: tracked.target },
      this.options.record,
      options.onChange,
      this.options.takeoverIdleMs / 1000,
    );
    tracked.attachments.add(attachment);
    this.options.onActivity?.(box.boxId, "terminal");
    this.options.record(host.host.id, options.source, options.principal, {
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
    tracked.takenBy = attachment.principal;
    tracked.lastInputAt = Date.now();
    this.arm(tracked, this.options.takeoverIdleMs);
    this.options.record(tracked.hostId, attachment.source, attachment.principal, {
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
    this.handBack(tracked, attachment.source, attachment.principal, "manual");
    return true;
  }

  shutdown(): void {
    for (const tracked of this.tracked.values()) this.disarm(tracked);
  }

  /**
   * A viewer attaches with `-f ignore-size`, which tmux 3.2 added. Older tmux rejects the flag, and attaching without it
   * would let the viewer's size shrink the console's window, so such a box refuses viewers. An unreadable version is
   * not refused.
   */
  private async requireViewerSupport(host: HostCtx, containerId: string): Promise<void> {
    const run = await runTmux(host, containerId, ["-V"]);
    if (run.code !== 0) throw this.failure(run, containerId, "");
    const version = parseTmuxVersion(run.stdout);
    if (version && !acceptsIgnoreSize(version)) {
      throw conflict(msg("session_viewer_tmux_old", { version: version.text }), {
        hint: msg("session_viewer_tmux_old_hint"),
      });
    }
  }

  private async probe(host: HostCtx, box: Box, name: string): Promise<SessionIdentity> {
    const run = await runTmux(host, box.id, ["display-message", "-p", "-t", paneTarget(name), PROBE_FORMAT]);
    if (run.code !== 0) throw this.failure(run, box.id, name);
    const probed = parseProbe(run.stdout);
    if (!probed || probed.name !== name) throw this.missingSession(box.id, name);
    return probed;
  }

  private async listTmux(host: HostCtx, containerId: string): Promise<TmuxSession[]> {
    const run = await runTmux(host, containerId, ["list-sessions", "-F", LIST_SESSIONS_FORMAT]);
    if (classifyTmuxFailure(run.code, run.stderr) === "no_server") return [];
    if (run.code !== 0) throw this.failure(run, containerId, "");
    return parseSessionList(run.stdout);
  }

  private async mark(host: HostCtx, containerId: string, name: string, origin: SessionOrigin): Promise<void> {
    const marked = await runTmux(host, containerId, ["set-option", "-t", paneTarget(name), ORIGIN_OPTION, origin]);
    if (marked.code !== 0) throw this.failure(marked, containerId, name);
    const hidden = await runTmux(host, containerId, ["set-option", "-t", paneTarget(name), "status", "off"]);
    if (hidden.code !== 0) throw this.failure(hidden, containerId, name);
  }

  /** Server-wide settings, applied once the first session starts. A short escape time keeps Esc responsive in vim. */
  private async tuneServer(host: HostCtx, containerId: string): Promise<void> {
    const run = await runTmux(host, containerId, ["set-option", "-s", "escape-time", "10"]);
    if (run.code !== 0) throw this.failure(run, containerId, "");
  }

  /**
   * Returns the tracked session for this name. An entry follows tmux's session id and creation time, not the origin
   * option, so an agent that rewrites the option cannot reset a takeover. A different id or creation time is a new
   * session under the same name, and its entry is made again.
   */
  private track(hostId: string, box: Box, found: SessionIdentity): Tracked {
    const key = keyOf(box.id, found.name);
    const existing = this.tracked.get(key);
    const target: EventTarget = { kind: "box", id: box.id, name: box.name };
    if (existing && existing.sessionId === found.id && existing.createdAt === found.createdAt) {
      existing.hostId = hostId;
      existing.target = target;
      return existing;
    }
    if (existing) this.drop(existing);
    const tracked: Tracked = {
      key,
      containerId: box.id,
      boxId: box.boxId,
      name: found.name,
      sessionId: found.id,
      createdAt: found.createdAt,
      origin: found.origin,
      controller: found.origin === "human" ? "human" : "agent",
      takenOver: false,
      takenBy: OWNER,
      lastInputAt: Date.now(),
      hostId,
      target,
      attachments: new Set(),
      opening: { console: 0, viewer: 0 },
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
    if (kind === "not_found" || kind === "no_server") return this.missingSession(containerId, name);
    if (kind === "unrunnable") return unsupportedImage();
    const detail = run.stderr.trim().split("\n")[0] || `exit status ${run.code}`;
    return new AppError(502, "docker_error", msg("session_tmux_failed", { detail }));
  }

  private missingSession(containerId: string, name: string): AppError {
    this.forget(containerId, name);
    return notFound(msg("session_not_found"), { hint: msg("session_not_found_hint") });
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
    this.handBack(tracked, "system", tracked.takenBy, "idle");
  }

  private handBack(tracked: Tracked, source: Source, principal: Principal, by: "manual" | "idle"): void {
    tracked.controller = "agent";
    tracked.takenOver = false;
    this.disarm(tracked);
    this.options.record(tracked.hostId, source, principal, {
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

/** The lock that serializes what changes a box's set of sessions. Session names cannot hold NUL, so it never clashes with `keyOf`. */
function boxKey(containerId: string): string {
  return `${containerId}\0`;
}

/** The console attaches writable, and the takeover lock still decides what it may type. Every other viewer is read-only. */
function attachCommand(name: string, source: Source): string[] {
  const viewer = source === "ui" ? [] : ["-r", "-f", "ignore-size"];
  return ["tmux", "-u", "attach-session", ...viewer, "-t", sessionTarget(name)];
}

function sessionLimitError(): AppError {
  return new AppError(429, "too_many_requests", msg("session_box_limit", { max: SESSIONS_PER_BOX_MAX }), undefined, {
    hint: msg("session_box_limit_hint"),
  });
}

/** The console is the only caller that may type. Every other caller attaches as a viewer, and shares only part of the session. */
type AttachKind = "console" | "viewer";

function kindOf(source: Source): AttachKind {
  return source === "ui" ? "console" : "viewer";
}

/** Refuses a terminal that would pass the session's total, or the share of it that viewers may hold. */
function checkRoom(tracked: Tracked, kind: AttachKind): void {
  const held = { ...tracked.opening };
  for (const attachment of tracked.attachments) held[kindOf(attachment.source)] += 1;
  if (held.console + held.viewer >= ATTACHES_PER_SESSION_MAX) {
    throw attachLimitError(msg("session_attach_limit", { max: ATTACHES_PER_SESSION_MAX }));
  }
  if (kind === "viewer" && held.viewer >= VIEWER_ATTACHES_MAX) {
    throw attachLimitError(
      msg("session_viewer_attach_limit", { max: VIEWER_ATTACHES_MAX, reserved: CONSOLE_ATTACHES_RESERVED }),
    );
  }
}

function attachLimitError(message: Msg): AppError {
  return new AppError(429, "too_many_requests", message, undefined, { hint: msg("session_attach_limit_hint") });
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

function viewOf(tracked: Tracked, source: Source, idleReturnSec: number): SessionView {
  const browser = source === "ui";
  return {
    ...infoOf(tracked),
    canType: browser && tracked.controller === "human",
    canTakeOver: browser && tracked.controller === "agent",
    canRelease: browser && tracked.controller === "human",
    idleReturnSec,
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

/** The box's image cannot run sessions. Rebuilding onto the current base template is the fix, so this is a conflict. */
function unsupportedImage(): AppError {
  return conflict(msg("session_image_unsupported"), { hint: msg("session_image_unsupported_hint") });
}

/**
 * Starts a command in the box. When the engine refuses to start it because the image lacks the program, the shell or
 * the user, the error says what to do about the image rather than passing the engine's message on.
 */
async function startInBox(host: HostCtx, containerId: string, spec: ExecSpec): Promise<ExecSession> {
  try {
    return await host.runtime.startExec(containerId, spec);
  } catch (e) {
    if (
      e instanceof RuntimeError &&
      (e.kind === "engine" || e.kind === "invalid") &&
      [e.message, e.detail].some(isUnrunnableExec)
    ) {
      throw unsupportedImage();
    }
    throw e;
  }
}

/** Runs `tmux` in the box as `dev`, collects what it prints, and returns its status. */
async function runTmux(host: HostCtx, containerId: string, args: readonly string[]): Promise<TmuxRun> {
  const session = await startInBox(host, containerId, {
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

/**
 * Collects a command's output as text and keeps only its newest `limit` bytes. The buffer is trimmed once it holds twice
 * that, so the copying stays proportional to the output. A trimmed text starts mid-line, so its first line is dropped. If
 * no line break is left, it starts at the first whole character instead of a cut one.
 */
export function collectText(stream: Readable, limit = OUTPUT_LIMIT_BYTES): () => string {
  let chunks: Buffer[] = [];
  let size = 0;
  let trimmed = false;
  const trim = () => {
    if (size <= limit) return;
    const kept = Buffer.concat(chunks).subarray(size - limit);
    chunks = [kept];
    size = kept.byteLength;
    trimmed = true;
  };
  stream.on("data", (chunk: unknown) => {
    let bytes: Buffer | null = null;
    if (typeof chunk === "string") bytes = Buffer.from(chunk);
    else if (chunk instanceof Uint8Array) bytes = Buffer.from(chunk);
    if (!bytes) return;
    chunks.push(bytes);
    size += bytes.byteLength;
    if (size > 2 * limit) trim();
  });
  stream.on("error", () => undefined);
  return () => {
    trim();
    const bytes = Buffer.concat(chunks);
    if (!trimmed) return bytes.toString("utf8");
    const lineBreak = bytes.indexOf("\n");
    if (lineBreak !== -1) return bytes.subarray(lineBreak + 1).toString("utf8");
    return bytes.subarray(wholeCharacterAt(bytes)).toString("utf8");
  };
}

/** A cut can leave up to three bytes of a split character at the front, since a character is at most four bytes. */
function wholeCharacterAt(bytes: Buffer): number {
  let start = 0;
  while (start < 3 && start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return start;
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
