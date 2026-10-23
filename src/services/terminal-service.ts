import { randomBytes } from "node:crypto";

import type { Source, AuditNote, EventTarget } from "../events/types";
import type { HostCtx } from "../host/registry";
import { AppError, conflict, notFound, badRequest } from "../lib/errors";
import { msg } from "../lib/messages";
import { OWNER, type Principal } from "../operations/types";
import type { ExecSession } from "../runtime";
import {
  isSessionName,
  classifyTmuxFailure,
  paneTarget,
  paneLines,
  appendedLines,
  hexBytes,
  sessionTarget,
  parseTmuxVersion,
  acceptsIgnoreSize,
  type SessionIdentity,
  PROBE_FORMAT,
  parseProbe,
  type TmuxSession,
  LIST_SESSIONS_FORMAT,
  parseSessionList,
  type SessionOrigin,
  ORIGIN_OPTION,
} from "../tmux/format";
import { type Box, ensureRunning } from "./boxes";
import { type Tracked, infoOf, cursorOf, takenOverError, Attachment, kindOf, checkRoom } from "./terminal-attachment";
import {
  type TerminalServiceOptions,
  type ListedSession,
  type StartResult,
  SESSIONS_PER_BOX_MAX,
  WORKDIR,
  SHELL_COMMAND,
  type ReadOptions,
  type ReadResult,
  HISTORY_LINES,
  type SendInput,
  type SendResult,
  type AttachOptions,
} from "./terminal-model";
import { runTmux, startInBox, TMUX_ENV, type BoxRun, unsupportedImage } from "./tmux-exec";

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

  /**
   * True when MiniBox itself has a terminal open, or being opened, on this container. The idle check also asks
   * `hasAttachedClient`, which sees terminals MiniBox did not open.
   */
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

  /** True when a person has taken over a session in this container, so the box's agent is locked out of it for now. */
  humanHolds(containerId: string): boolean {
    for (const tracked of this.tracked.values()) {
      if (tracked.containerId === containerId && tracked.controller === "human") return true;
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
      return listed
        .filter((session) => isSessionName(session.name))
        .map((session) => {
          const tracked = this.track(host.host.id, box, session);
          return { ...infoOf(tracked), createdAt: session.createdAt, attached: session.attached };
        });
    });
  }

  /**
   * True when a tmux client is attached to a session in the box: an open terminal, whoever opened it. That is MiniBox's
   * console or viewer, or another client such as `docker exec -it <box> tmux attach` (#12). A box with no tmux, or no
   * tmux server, has no client.
   */
  async hasAttachedClient(host: HostCtx, containerId: string): Promise<boolean> {
    try {
      return (await this.listTmux(host, containerId)).some((session) => session.attached > 0);
    } catch (e) {
      if (e instanceof AppError && e.key === "session_image_unsupported") return false;
      throw e;
    }
  }

  async start(
    host: HostCtx,
    box: Box,
    name: string,
    source: Source,
    record?: (note: AuditNote) => void,
  ): Promise<StartResult> {
    assertName(name);
    const audit = record ?? ((note: AuditNote) => this.options.record(host.host.id, source, OWNER, note));
    const { box: current, woke } = await ensureRunning(host, box.boxId, { record: audit });
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
    this.options.onActivity?.(box.boxId, "session");
    await this.serialized(keyOf(box.id, name), async () => {
      const tracked = this.track(host.host.id, box, await this.probe(host, box, name));
      if (tracked.controller === "human" && source !== "ui") throw takenOverError(name);
      const run = await runTmux(host, box.id, ["kill-session", "-t", sessionTarget(name)]);
      if (run.code === 0) this.forget(box.id, name);
      else throw this.failure(run, box.id, name);
    });
  }

  /**
   * Opens a terminal on the session. The box must be running; the WebSocket layer wakes a sleeping box before it calls
   * this. The box is held awake from the first call until the attach is registered, so the idle sweep cannot stop it in
   * between.
   */
  async attach(host: HostCtx, box: Box, name: string, options: AttachOptions): Promise<Attachment> {
    const release = this.options.hold?.(box.boxId) ?? (() => undefined);
    try {
      return await this.openAttach(host, box, name, options);
    } finally {
      release();
    }
  }

  private async openAttach(host: HostCtx, box: Box, name: string, options: AttachOptions): Promise<Attachment> {
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
        // The attach names its session, so its own directory is not used, and a stuck volume there must not hold it.
        workingDir: "/",
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
      () => this.options.onActivity?.(box.boxId, "terminal"),
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

  private failure(run: BoxRun, containerId: string, name: string): AppError {
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
