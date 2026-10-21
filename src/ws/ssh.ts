import type { ServerWebSocket } from "bun";

import type { SshConnection } from "../ssh/connection";
import type { SshGateway, SshLease } from "../ssh/gateway";
import type { TokenStore } from "../tokens/store";

export interface SshSocketData {
  readonly kind: "ssh";
  readonly lease: SshLease;
  connection?: SshConnection;
  stopWatching?: () => void;
}

export function isSshSocket(data: object): data is SshSocketData {
  return "kind" in data && (data as { kind?: unknown }).kind === "ssh";
}

/**
 * Carries one SSH connection over a WebSocket. Binary frames are SSH bytes in either direction. The socket closes with
 * 1008 when the token that opened it is revoked or expires, so a revoked credential cannot keep a shell open.
 */
export function sshHandlers(deps: { tokens: TokenStore; ssh: SshGateway }) {
  const { tokens, ssh } = deps;
  return {
    open(ws: ServerWebSocket<SshSocketData>) {
      const data = ws.data;
      data.connection = ssh.connect(data.lease, {
        send: (bytes) => ws.send(bytes),
        close: (code, reason) => ws.close(code, reason),
      });
      const stops: (() => void)[] = [];
      const principal = data.lease.target.principal;
      if (principal.type === "token") {
        stops.push(tokens.watch(principal.id, () => ws.close(1008, "token revoked")));
      }
      data.stopWatching = () => {
        for (const stop of stops) stop();
      };
    },
    message(ws: ServerWebSocket<SshSocketData>, message: string | Buffer) {
      if (typeof message === "string") {
        ws.close(1003, "ssh frames are binary");
        return;
      }
      ws.data.connection?.receive(message);
    },
    drain(ws: ServerWebSocket<SshSocketData>) {
      ws.data.connection?.drained();
    },
    close(ws: ServerWebSocket<SshSocketData>) {
      ws.data.stopWatching?.();
      ws.data.connection?.close();
      ws.data.lease.release();
    },
  };
}
