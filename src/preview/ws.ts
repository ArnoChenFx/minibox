import type { ServerWebSocket } from "bun";

import { log } from "../lib/logger";
import type { ActivityPulse } from "../services/activity-pulse";

/**
 * Where a preview socket connects. A box on another host is reached through the relay's proxy, and each connection carries
 * its own single-use token.
 */
export interface PreviewSocketUpstream {
  readonly url: string;
  readonly proxy?: { readonly url: string; readonly token: string };
}

export interface PreviewSocketData {
  readonly kind: "preview";
  readonly boxId: string;
  /** Set on the upgrade data before Bun calls `open`; cleared after the upstream is attached. */
  pendingUpstream?: PreviewSocketUpstream;
  pendingHeaders?: Headers;
  upstream?: WebSocket;
  closed?: boolean;
  /** Keeps the box awake for as long as the socket is open (#12). Called once, when the socket closes. */
  release?: () => void;
  /** The console sign-in the preview runs under. Ending it closes the socket. */
  sessionId?: string;
  /** Epoch milliseconds when the preview's grant runs out. Absent when the preview has no grant. */
  expiresAt?: number;
  /** The box's own cookies, sent to the box when the socket opens. Only a subdomain preview sets it. */
  cookie?: string;
  /** Stops watching the sign-in and the grant expiry. Set by `watchPreviewSocket`. */
  endWatch?: () => void;
}

export interface PreviewSocketLife {
  readonly watch: (sessionId: string, listener: () => void) => () => void;
  readonly now?: () => number;
  /** Calls `fn` after `ms`, and returns the function that cancels it. Tests replace it to fire the timer at once. */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
}

const scheduleOnce = (fn: () => void, ms: number): (() => void) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

/**
 * Closes a preview socket when its console sign-in ends, or when its grant runs out. A socket outlives the request that
 * opened it, so the sign-in is watched for the whole life of the socket. Returns false when the socket was closed here
 * because its sign-in had already ended, in which case nothing should be attached to it.
 */
export function watchPreviewSocket(ws: ServerWebSocket<PreviewSocketData>, life: PreviewSocketLife): boolean {
  const { sessionId, expiresAt } = ws.data;
  if (sessionId === undefined) return true;
  let ended = false;
  const stops: (() => void)[] = [
    life.watch(sessionId, () => {
      ended = true;
      ws.close(1008, "session ended");
    }),
  ];
  if (ended) return false;
  if (expiresAt !== undefined) {
    const now = life.now ?? Date.now;
    const delay = Math.max(0, expiresAt - now());
    stops.push((life.schedule ?? scheduleOnce)(() => ws.close(1008, "preview expired"), delay));
  }
  ws.data.endWatch = () => {
    for (const stop of stops) stop();
  };
  return true;
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
  target: PreviewSocketUpstream,
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
        ...(ws.data.cookie ? { cookie: ws.data.cookie } : {}),
      },
      ...(target.proxy
        ? { proxy: { url: target.proxy.url, headers: { "proxy-authorization": target.proxy.token } } }
        : {}),
    };
    upstream = new WebSocket(target.url, options as unknown as ConstructorParameters<typeof WebSocket>[1]);
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
      ws.data.endWatch?.();
      ws.data.endWatch = undefined;
      ws.data.release?.();
      ws.data.release = undefined;
    },
  };
}
