import type { ServerWebSocket } from "bun";

import type { AgentHub, AgentSession } from "../host/agent/hub";

/** A socket an agent dialed in on. The session is the hub's end of it, set when the socket opens. */
export interface AgentSocketData {
  readonly kind: "agent";
  session?: AgentSession;
}

export function isAgentSocket(data: object): data is AgentSocketData {
  return "kind" in data && (data as { kind?: unknown }).kind === "agent";
}

/** Passes an agent socket's frames to the hub. Agent frames are JSON text; anything binary is refused. */
export function agentHandlers(hub: AgentHub) {
  return {
    open(ws: ServerWebSocket<AgentSocketData>) {
      ws.data.session = hub.attach({
        send: (text) => {
          ws.send(text);
        },
        close: (code, reason) => {
          ws.close(code, reason);
        },
      });
    },
    message(ws: ServerWebSocket<AgentSocketData>, message: string | Buffer) {
      if (typeof message !== "string") {
        ws.close(1003, "agent frames are text");
        return;
      }
      ws.data.session?.receive(message);
    },
    close(ws: ServerWebSocket<AgentSocketData>) {
      ws.data.session?.detach();
    },
  };
}
