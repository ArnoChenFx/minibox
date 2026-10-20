import type { Duplex } from "node:stream";
import type { ServerWebSocket } from "bun";
import type { App } from "../app";
import { log } from "../lib/logger";

export interface TerminalData {
  boxId: string;
  execId?: string;
  stream?: Duplex;
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

export function terminalHandlers(app: App) {
  return {
    async open(ws: ServerWebSocket<TerminalData>) {
      try {
        const container = app.docker.docker.getContainer(ws.data.boxId);
        const exec = await container.exec({
          Cmd: ["/bin/sh", "-c", "command -v bash >/dev/null && exec bash -l || exec sh -l"],
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
          Tty: true,
          Env: ["TERM=xterm-256color", "LANG=C.UTF-8"],
          WorkingDir: "/workspace",
        });
        ws.data.execId = exec.id;
        const stream = (await exec.start({ hijack: true, stdin: true, Tty: true })) as Duplex;
        ws.data.stream = stream;
        stream.on("data", (chunk: Buffer) => ws.send(chunk));
        stream.on("end", () => ws.close(1000, "session ended"));
        stream.on("error", () => ws.close(1011, "stream error"));
        log.info("terminal.open", { box: ws.data.boxId.slice(0, 12) });
      } catch (e) {
        ws.send(`\r\n终端启动失败：${e instanceof Error ? e.message : String(e)}\r\n`);
        ws.close(1011, "exec failed");
      }
    },
    message(ws: ServerWebSocket<TerminalData>, message: string | Buffer) {
      const stream = ws.data.stream;
      if (!stream) return;
      const text = typeof message === "string" ? message : message.toString("utf8");
      const ctrl = parseControl(text);
      if (ctrl && ws.data.execId) {
        app.docker.docker
          .getExec(ws.data.execId)
          .resize({ h: ctrl.rows, w: ctrl.cols })
          .catch(() => {});
        return;
      }
      stream.write(message);
    },
    close(ws: ServerWebSocket<TerminalData>) {
      ws.data.stream?.end();
      ws.data.stream?.destroy();
      log.info("terminal.close", { box: ws.data.boxId.slice(0, 12) });
    },
  };
}
