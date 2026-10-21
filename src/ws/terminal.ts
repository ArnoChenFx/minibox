import type { ServerWebSocket } from "bun";

import type { Source } from "../events/types";
import type { HostCtx } from "../host/registry";
import { forbidden } from "../lib/errors";
import { type ErrorBody, errorBody } from "../lib/http";
import { msg } from "../lib/messages";
import type { Box } from "../services/boxes";
import { type Attachment, type SessionView, type TerminalService } from "../services/terminals";
import type { SessionStore } from "../sessions";

/** Seconds of silence after which Bun closes a terminal socket. Bun pings each client, and browsers answer on their own. */
export const HEARTBEAT_SEC = 30;

/**
 * Bytes a client may leave unread. Output pauses as soon as the socket reports backpressure, so this only bounds what
 * was already in flight; a client that stays past it is closed instead of buffering without limit.
 */
export const BACKPRESSURE_LIMIT_BYTES = 4 * 1024 * 1024;

export interface TerminalData {
  readonly boxId: string;
  readonly box: Box;
  readonly host: HostCtx;
  /** The tmux session this socket attaches to. */
  readonly name: string;
  /** `ui` for a browser session, `rest` for a Bearer request. Only `ui` may type or take over. */
  readonly source: Source;
  /** The browser session that opened the socket, or `null` for a bearer request. */
  readonly sessionId: string | null;
  attachment?: Attachment;
  stopWatching?: () => void;
  closed?: boolean;
}

export type Control = { type: "resize"; cols: number; rows: number } | { type: "takeover" } | { type: "release" };

/** Server → client text frames. Output is binary and never carries a frame. */
type ServerFrame = ({ type: "state" } & SessionView) | { type: "error"; error: ErrorBody };

/**
 * Client → server control frame, sent as text. Binary frames are always typed input, so text pasted into the terminal
 * never reads as a control frame. Any other text is input too.
 */
export function parseControl(data: string): Control | null {
  if (!data.startsWith("{")) return null;
  try {
    const msg = JSON.parse(data) as { type?: unknown; cols?: unknown; rows?: unknown };
    if (msg.type === "takeover" || msg.type === "release") return { type: msg.type };
    if (msg.type === "resize" && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
      const cols = Math.min(500, Math.max(10, msg.cols as number));
      const rows = Math.min(200, Math.max(5, msg.rows as number));
      return { type: "resize", cols, rows };
    }
  } catch {
    // not a control frame
  }
  return null;
}

function send(ws: ServerWebSocket<TerminalData>, frame: ServerFrame): void {
  ws.send(JSON.stringify(frame));
}

function refuse(ws: ServerWebSocket<TerminalData>): void {
  send(ws, { type: "error", error: errorBody(forbidden(msg("terminal_read_only"))).error });
}

/**
 * The socket attaches a viewer to one tmux session. It closes with 1008 when its browser session ends, so a revoked or
 * expired session cannot keep a terminal open. Typing counts as use of the session, so an active terminal is not signed
 * out by sliding renewal. When the attach process ends, the socket closes with 1000. However the socket goes, the
 * attach is torn down inside the box, so no exec is left behind.
 */
export function terminalHandlers(deps: { sessions: SessionStore; terminals: TerminalService }) {
  const { sessions, terminals } = deps;
  return {
    async open(ws: ServerWebSocket<TerminalData>) {
      const data = ws.data;
      if (data.sessionId) {
        data.stopWatching = sessions.watch(data.sessionId, () => {
          data.closed = true;
          ws.close(1008, "signed out");
        });
      }
      if (data.closed) return;
      try {
        const attachment = await terminals.attach(data.host, data.box, data.name, {
          source: data.source,
          onChange: (view) => send(ws, { type: "state", ...view }),
        });
        if (data.closed) {
          await attachment.close();
          return;
        }
        data.attachment = attachment;
        const stream = attachment.exec.stream;
        stream.on("data", (chunk: Buffer) => forward(ws, attachment, chunk));
        stream.on("end", () => ws.close(1000, "session ended"));
        stream.on("error", () => ws.close(1011, "stream error"));
        send(ws, { type: "state", ...attachment.view() });
      } catch (e) {
        if (data.closed) return;
        send(ws, { type: "error", error: errorBody(e).error });
        ws.close(1011, "attach failed");
      }
    },
    message(ws: ServerWebSocket<TerminalData>, message: string | Buffer) {
      if (ws.data.sessionId) sessions.touchId(ws.data.sessionId);
      const attachment = ws.data.attachment;
      if (!attachment) return;
      const control = typeof message === "string" ? parseControl(message) : null;
      if (control) {
        handleControl(ws, attachment, terminals, control);
        return;
      }
      if (!attachment.write(message)) refuse(ws);
    },
    drain(ws: ServerWebSocket<TerminalData>) {
      ws.data.attachment?.resume();
    },
    async close(ws: ServerWebSocket<TerminalData>) {
      const data = ws.data;
      data.closed = true;
      data.stopWatching?.();
      await data.attachment?.close();
    },
  };
}

function forward(ws: ServerWebSocket<TerminalData>, attachment: Attachment, chunk: Buffer): void {
  attachment.sent(chunk.byteLength);
  if (ws.send(chunk) === -1) attachment.pause();
}

function handleControl(
  ws: ServerWebSocket<TerminalData>,
  attachment: Attachment,
  terminals: TerminalService,
  control: Control,
): void {
  if (control.type === "resize") {
    attachment.resize({ cols: control.cols, rows: control.rows });
    return;
  }
  if (attachment.source !== "ui") {
    refuse(ws);
    return;
  }
  if (control.type === "takeover") terminals.takeOver(attachment);
  else terminals.release(attachment);
}
