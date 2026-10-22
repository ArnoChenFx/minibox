import type { ServerWebSocket } from "bun";

import type { AgentHub } from "../host/agent/hub";
import { isPreviewSocket, type PreviewSocketData, previewWsHandlers } from "../preview/ws";
import type { ActivityPulse } from "../services/activity-pulse";
import type { TerminalService } from "../services/terminals";
import type { SessionStore } from "../sessions";
import type { SshGateway } from "../ssh/gateway";
import type { TokenStore } from "../tokens/store";
import { type AgentSocketData, agentHandlers, isAgentSocket } from "./agent";
import { isSshSocket, type SshSocketData, sshHandlers } from "./ssh";
import { type TerminalData, terminalHandlers } from "./terminal";

export type SocketData = TerminalData | PreviewSocketData | SshSocketData | AgentSocketData;

export function socketHandlers(deps: {
  sessions: SessionStore;
  tokens: TokenStore;
  terminals: TerminalService;
  pulse: ActivityPulse;
  ssh: SshGateway;
  agents: AgentHub;
}) {
  const term = terminalHandlers(deps);
  const preview = previewWsHandlers(deps.pulse);
  const ssh = sshHandlers(deps);
  const agent = agentHandlers(deps.agents);
  return {
    open(ws: ServerWebSocket<SocketData>) {
      if (isPreviewSocket(ws.data)) return preview.open(ws as ServerWebSocket<PreviewSocketData>);
      if (isSshSocket(ws.data)) return ssh.open(ws as ServerWebSocket<SshSocketData>);
      if (isAgentSocket(ws.data)) return agent.open(ws as ServerWebSocket<AgentSocketData>);
      return term.open(ws as ServerWebSocket<TerminalData>);
    },
    message(ws: ServerWebSocket<SocketData>, message: string | Buffer) {
      if (isPreviewSocket(ws.data)) return preview.message(ws as ServerWebSocket<PreviewSocketData>, message);
      if (isSshSocket(ws.data)) return ssh.message(ws as ServerWebSocket<SshSocketData>, message);
      if (isAgentSocket(ws.data)) return agent.message(ws as ServerWebSocket<AgentSocketData>, message);
      return term.message(ws as ServerWebSocket<TerminalData>, message);
    },
    drain(ws: ServerWebSocket<SocketData>) {
      if (isPreviewSocket(ws.data)) return preview.drain(ws as ServerWebSocket<PreviewSocketData>);
      if (isSshSocket(ws.data)) return ssh.drain(ws as ServerWebSocket<SshSocketData>);
      if (isAgentSocket(ws.data)) return;
      return term.drain(ws as ServerWebSocket<TerminalData>);
    },
    close(ws: ServerWebSocket<SocketData>) {
      if (isPreviewSocket(ws.data)) return preview.close(ws as ServerWebSocket<PreviewSocketData>);
      if (isSshSocket(ws.data)) return ssh.close(ws as ServerWebSocket<SshSocketData>);
      if (isAgentSocket(ws.data)) return agent.close(ws as ServerWebSocket<AgentSocketData>);
      return term.close(ws as ServerWebSocket<TerminalData>);
    },
  };
}
