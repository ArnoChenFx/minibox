import type { ServerWebSocket } from "bun";

import type { HostCtx } from "../host/registry";
import { log } from "../lib/logger";
import type { ExecSession } from "../runtime";

export interface TerminalData {
  boxId: string;
  host: HostCtx;
  exec?: ExecSession;
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

export function terminalHandlers() {
  return {
    async open(ws: ServerWebSocket<TerminalData>) {
      try {
        const exec = await ws.data.host.runtime.startExec(ws.data.boxId, {
          cmd: ["/bin/sh", "-c", "command -v bash >/dev/null && exec bash -l || exec sh -l"],
          env: ["TERM=xterm-256color", "LANG=C.UTF-8"],
          workingDir: "/workspace",
        });
        ws.data.exec = exec;
        exec.stream.on("data", (chunk: Buffer) => ws.send(chunk));
        exec.stream.on("end", () => ws.close(1000, "session ended"));
        exec.stream.on("error", () => ws.close(1011, "stream error"));
        log.info("terminal.open", { box: ws.data.boxId.slice(0, 12) });
      } catch (e) {
        ws.send(`\r\nFailed to start terminal: ${e instanceof Error ? e.message : String(e)}\r\n`);
        ws.close(1011, "exec failed");
      }
    },
    message(ws: ServerWebSocket<TerminalData>, message: string | Buffer) {
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
      ws.data.exec?.stream.end();
      ws.data.exec?.stream.destroy();
      log.info("terminal.close", { box: ws.data.boxId.slice(0, 12) });
    },
  };
}
