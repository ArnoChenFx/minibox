import type { ServerWebSocket } from "bun";

import { isPreviewSocket, type PreviewSocketData, previewWsHandlers } from "../preview/ws";
import type { ActivityPulse } from "../services/activity-pulse";
import type { TerminalService } from "../services/terminals";
import type { SessionStore } from "../sessions";
import type { TokenStore } from "../tokens/store";
import { type TerminalData, terminalHandlers } from "./terminal";

export type SocketData = TerminalData | PreviewSocketData;

export function socketHandlers(deps: {
  sessions: SessionStore;
  tokens: TokenStore;
  terminals: TerminalService;
  pulse: ActivityPulse;
}) {
  const term = terminalHandlers(deps);
  const preview = previewWsHandlers(deps.pulse);
  return {
    open(ws: ServerWebSocket<SocketData>) {
      if (isPreviewSocket(ws.data)) return preview.open(ws as ServerWebSocket<PreviewSocketData>);
      return term.open(ws as ServerWebSocket<TerminalData>);
    },
    message(ws: ServerWebSocket<SocketData>, message: string | Buffer) {
      if (isPreviewSocket(ws.data)) return preview.message(ws as ServerWebSocket<PreviewSocketData>, message);
      return term.message(ws as ServerWebSocket<TerminalData>, message);
    },
    drain(ws: ServerWebSocket<SocketData>) {
      if (isPreviewSocket(ws.data)) return preview.drain(ws as ServerWebSocket<PreviewSocketData>);
      return term.drain(ws as ServerWebSocket<TerminalData>);
    },
    close(ws: ServerWebSocket<SocketData>) {
      if (isPreviewSocket(ws.data)) return preview.close(ws as ServerWebSocket<PreviewSocketData>);
      return term.close(ws as ServerWebSocket<TerminalData>);
    },
  };
}
