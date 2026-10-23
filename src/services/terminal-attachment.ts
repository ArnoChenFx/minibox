import type { EventTarget, Source } from "../events/types";
import { AppError } from "../lib/errors";
import { log } from "../lib/logger";
import { msg, type Msg } from "../lib/messages";
import type { Principal } from "../operations/types";
import type { ExecSession } from "../runtime";
import type { SessionOrigin } from "../tmux/format";
import {
  type Controller,
  type AttachKind,
  type Snapshot,
  type RecordNote,
  type SessionView,
  ATTACHES_PER_SESSION_MAX,
  VIEWER_ATTACHES_MAX,
  CONSOLE_ATTACHES_RESERVED,
  type SessionInfo,
} from "./terminal-model";

/** What MiniBox knows about one tmux session in one box. Lives as long as the session does. */
export interface Tracked {
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
    /** Refreshes the box's activity heartbeat. Typing, output and close all count as use of the terminal. */
    private readonly touch: () => void,
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
    this.touch();
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
    this.touch();
  }

  notify(): void {
    this.onChange?.(this.view());
  }

  /** Ends the attach process inside the box, then the stream, and records the close. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.tracked.attachments.delete(this);
    this.touch();
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

export function kindOf(source: Source): AttachKind {
  return source === "ui" ? "console" : "viewer";
}

/** Refuses a terminal that would pass the session's total, or the share of it that viewers may hold. */
export function checkRoom(tracked: Tracked, kind: AttachKind): void {
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

export function cursorOf(snapshot: Snapshot): string {
  return `${snapshot.epoch}.${snapshot.seq}`;
}

export function infoOf(tracked: Tracked): SessionInfo {
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

export function takenOverError(name: string): AppError {
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
