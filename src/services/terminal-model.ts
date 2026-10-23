import type { Source, AuditNote } from "../events/types";
import type { Principal } from "../operations/types";
import type { SessionOrigin } from "../tmux/format";

/** The most a single `session_read` returns. Each line is at most a pane row, so this bounds the response. */
export const READ_LINES_MAX = 2000;

/** Rows of history a read captures: twice what it can return, so a reader can follow a burst of output across two reads. */
export const HISTORY_LINES = READ_LINES_MAX * 2;

/**
 * Tmux sessions one box may hold. Every session tmux lists counts, including one made outside MiniBox and one whose name
 * MiniBox cannot use, since those are the ones the list hides.
 */
export const SESSIONS_PER_BOX_MAX = 16;

/** Terminals one session may have open at once, from the console and viewers together. Each is a tmux client and an exec. */
export const ATTACHES_PER_SESSION_MAX = 8;

/** Terminals a session keeps free for the console, so viewers cannot fill it and lock the person out. */
export const CONSOLE_ATTACHES_RESERVED = 2;

/** Terminals viewers (every caller but the console) may hold on one session at once. */
export const VIEWER_ATTACHES_MAX = ATTACHES_PER_SESSION_MAX - CONSOLE_ATTACHES_RESERVED;

export const WORKDIR = "/workspace";

/** A login shell: bash when the box has it, otherwise sh. Starts in the workspace. */
export const SHELL_COMMAND = "command -v bash >/dev/null && exec bash -l || exec sh -l";

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
  /** Keeps the box awake while an attach is being set up (#12). Returns the release. */
  readonly hold?: (boxId: string) => () => void;
}

export interface Snapshot {
  readonly epoch: string;
  readonly seq: number;
  readonly lines: readonly string[];
}

/** The console is the only caller that may type. Every other caller attaches as a viewer, and shares only part of the session. */
export type AttachKind = "console" | "viewer";
