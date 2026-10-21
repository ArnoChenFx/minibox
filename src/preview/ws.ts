import type { ServerWebSocket } from "bun";

import { log } from "../lib/logger";
import type { ActivityPulse } from "../services/activity-pulse";

export interface PreviewSocketData {
  readonly kind: "preview";
  readonly boxId: string;
  /** Set on the upgrade data before Bun calls `open`; cleared after the upstream is attached. */
  pendingUpstream?: string;
  pendingHeaders?: Headers;
  upstream?: WebSocket;
  closed?: boolean;
}

export function isPreviewSocket(data: object): data is PreviewSocketData {
  return "kind" in data && (data as { kind?: string }).kind === "preview";
}

/**
 * After Bun upgrades the browser socket, open a WebSocket to the box and pipe both ways.
 * Binary and text frames are forwarded as-is for Vite HMR and similar clients.
 */
export async function attachPreviewUpstream(
  ws: ServerWebSocket<PreviewSocketData>,
  upstreamUrl: string,
  pulse: ActivityPulse,
  requestHeaders: Headers,
): Promise<void> {
  pulse.touch(ws.data.boxId, "preview");
  const protocols = requestHeaders.get("sec-websocket-protocol");
  let upstream: WebSocket;
  try {
    const options = {
      protocols: protocols ? protocols.split(",").map((part) => part.trim()) : undefined,
      headers: {
        origin: requestHeaders.get("origin") ?? "",
        "user-agent": requestHeaders.get("user-agent") ?? "MiniBox-preview",
      },
    };
    upstream = new WebSocket(upstreamUrl, options as unknown as ConstructorParameters<typeof WebSocket>[1]);
  } catch (e) {
    log.warn("preview.ws_open_failed", { boxId: ws.data.boxId, error: String(e) });
    ws.close(1011, "upstream open failed");
    return;
  }

  ws.data.upstream = upstream;

  upstream.binaryType = "arraybuffer";

  upstream.addEventListener("open", () => {
    pulse.touch(ws.data.boxId, "preview");
  });

  upstream.addEventListener("message", (event) => {
    if (ws.data.closed) return;
    pulse.touch(ws.data.boxId, "preview");
    try {
      if (typeof event.data === "string") ws.send(event.data);
      else ws.send(event.data instanceof ArrayBuffer ? event.data : new Uint8Array(event.data as ArrayBuffer));
    } catch {
      // client gone
    }
  });

  upstream.addEventListener("close", (event) => {
    if (ws.data.closed) return;
    ws.close(event.code || 1000, event.reason || "upstream closed");
  });

  upstream.addEventListener("error", () => {
    if (ws.data.closed) return;
    ws.close(1011, "upstream error");
  });
}

export function previewWsHandlers(pulse: ActivityPulse) {
  return {
    open(_ws: ServerWebSocket<PreviewSocketData>) {
      // Upstream is attached from fetch after upgrade; open may fire first with no upstream yet.
    },
    message(ws: ServerWebSocket<PreviewSocketData>, message: string | Buffer) {
      const upstream = ws.data.upstream;
      if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
      pulse.touch(ws.data.boxId, "preview");
      if (typeof message === "string") upstream.send(message);
      else upstream.send(message);
    },
    drain(_ws: ServerWebSocket<PreviewSocketData>) {},
    close(ws: ServerWebSocket<PreviewSocketData>) {
      ws.data.closed = true;
      const upstream = ws.data.upstream;
      if (upstream && upstream.readyState === WebSocket.OPEN) upstream.close(1000, "client closed");
      ws.data.upstream = undefined;
    },
  };
}
