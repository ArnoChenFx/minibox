import type { ServerWebSocket } from "bun";

import type { HostCtx } from "../host/registry";
import { log } from "../lib/logger";
import type { ExecSession } from "../runtime";
import type { SessionStore } from "../sessions";
import type { TokenStore } from "../tokens/store";

export interface TerminalData {
  boxId: string;
  host: HostCtx;
  /** The browser session that opened the socket, or `null` for a bearer request. */
  sessionId: string | null;
  /** Set when an agent API token opened the socket. Revoking that token closes it. */
  tokenId: string | null;
  exec?: ExecSession;
  stopWatching?: () => void;
  closed?: boolean;
}

/** Client → server control frame. Anything else is treated as stdin bytes. */
export function parseControl(data: string): { type: "resize"; cols: number; rows: number } | null {
  if (!data.startsWith("{")) return null;
  try {
    const msg = JSON.parse(data) as { type?: unknown; cols?: unknown; rows?: unknown };
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

/**
 * The socket closes with 1008 when its browser session or agent token ends, so a revoked credential cannot keep a
 * shell open. Typing counts as use of the session, so an active terminal is not signed out by sliding renewal.
 */
export function terminalHandlers(sessions: SessionStore, tokens: TokenStore) {
  return {
    async open(ws: ServerWebSocket<TerminalData>) {
      const data = ws.data;
      const stops: (() => void)[] = [];
      const end = (reason: string) => {
        data.closed = true;
        ws.close(1008, reason);
      };
      if (data.sessionId) stops.push(sessions.watch(data.sessionId, () => end("signed out")));
      if (data.tokenId) stops.push(tokens.watch(data.tokenId, () => end("revoked")));
      if (stops.length > 0)
        data.stopWatching = () => {
          for (const stop of stops) stop();
        };
      if (data.closed) return;
      try {
        const exec = await data.host.runtime.startExec(data.boxId, {
          cmd: ["/bin/sh", "-c", "command -v bash >/dev/null && exec bash -l || exec sh -l"],
          env: ["TERM=xterm-256color", "LANG=C.UTF-8"],
          workingDir: "/workspace",
        });
        if (data.closed) {
          exec.stream.destroy();
          return;
        }
        data.exec = exec;
        exec.stream.on("data", (chunk: Buffer) => ws.send(chunk));
        exec.stream.on("end", () => ws.close(1000, "session ended"));
        exec.stream.on("error", () => ws.close(1011, "stream error"));
        log.info("terminal.open", { box: data.boxId.slice(0, 12) });
      } catch (e) {
        if (data.closed) return;
        ws.send(`\r\nFailed to start terminal: ${e instanceof Error ? e.message : String(e)}\r\n`);
        ws.close(1011, "exec failed");
      }
    },
    message(ws: ServerWebSocket<TerminalData>, message: string | Buffer) {
      if (ws.data.sessionId) sessions.touchId(ws.data.sessionId);
      const exec = ws.data.exec;
      if (!exec) return;
      const text = typeof message === "string" ? message : message.toString("utf8");
      const ctrl = parseControl(text);
      if (ctrl) {
        exec.resize({ cols: ctrl.cols, rows: ctrl.rows }).catch(() => {});
        return;
      }
      exec.stream.write(message);
    },
    close(ws: ServerWebSocket<TerminalData>) {
      ws.data.closed = true;
      ws.data.stopWatching?.();
      ws.data.exec?.stream.end();
      ws.data.exec?.stream.destroy();
      log.info("terminal.close", { box: ws.data.boxId.slice(0, 12) });
    },
  };
}
