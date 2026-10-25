import type { AuditNote } from "../events/types";
import type { HostCtx, HostRegistry } from "../host/registry";
import { AppError } from "../lib/errors";
import { JSON_BODY_MAX_BYTES, limitedBody } from "../lib/http";
import { msg } from "../lib/messages";
import type { ActivityPulse } from "../services/activity-pulse";
import { type Box, hostOfSpecRef, locateBox, wakeIfSleeping } from "../services/boxes";
import { filterRequestHeaders, filterResponseHeaders, type PreviewIsolation } from "./headers";
import { type PreviewTarget, parsePreviewPath } from "./path";
import type { PreviewBridge, PreviewRelay } from "./relay";
import type { PreviewSocketUpstream } from "./ws";

export interface PreviewResolve {
  readonly box: Box;
  readonly host: HostCtx;
  readonly target: PreviewTarget;
  readonly upstreamOrigin: string;
  /** The exec relay this preview runs through, whether the box is local or on another host. */
  readonly bridge: PreviewBridge;
  /** Ends the hold that keeps the box awake while this request is served. Safe to call more than once. */
  readonly release: () => void;
}

export interface PreviewDeps {
  readonly pulse: ActivityPulse;
  /** Audits a wake that this request caused, under the host the box lives on. */
  readonly audit: (hostId: string, note: AuditNote) => void;
  readonly relay: PreviewRelay;
}

/**
 * Resolves a path-mode preview request to a box and its container IP. Does not check auth, the caller does.
 */
export async function resolvePreview(hosts: HostRegistry, url: URL, deps: PreviewDeps): Promise<PreviewResolve> {
  const target = parsePreviewPath(url.pathname, url.search);
  if (!target) throw new AppError(404, "not_found", msg("preview_path_invalid"));
  return resolveTarget(hosts, target, deps);
}

/**
 * Resolves a preview target to a box and the relay that reaches its port. A box asleep for idle or TTL is woken; a
 * box a person stopped is refused with 409. The box is held awake until `release` is called, so an idle sweep cannot
 * stop it while the response is streaming (#12).
 *
 * Every box is reached through the exec relay, local and remote alike: the relay runs in the box and connects to its
 * own loopback, so the preview never depends on where the MiniBox server itself sits — a containerized install cannot
 * reach a box's bridge address even when it shares the host's engine, and box isolation (ICC off) would drop it there
 * anyway (#223). This also lets a box's service answer on 127.0.0.1 alone.
 */
export async function resolveTarget(
  hosts: HostRegistry,
  target: PreviewTarget,
  deps: PreviewDeps,
): Promise<PreviewResolve> {
  const named = hostOfSpecRef(hosts, target.ref);
  if (named?.host.transport === "agent") {
    throw new AppError(501, "unsupported", msg("preview_agent_unsupported"));
  }
  const { host, box: found } = await locateBox(hosts, target.ref);
  const release = deps.pulse.hold(found.boxId);
  try {
    deps.pulse.touch(found.boxId, "preview");
    const box = await wakeIfSleeping(host, found.boxId, { record: (note) => deps.audit(host.host.id, note) });
    if (!box.running) throw new AppError(409, "conflict", msg("preview_box_stopped"));
    const bridge = await deps.relay.bridge(host, box, target.port);
    return { box, host, target, upstreamOrigin: `http://${bridge.address}`, bridge, release };
  } catch (e) {
    release();
    throw e;
  }
}

/** The WebSocket address of the box for a preview request, with the same path and query as the request. */
export function upstreamSocketUrl(resolved: PreviewResolve): string {
  const { forwardPath } = resolved.target;
  const path = forwardPath.startsWith("/") ? forwardPath : `/${forwardPath}`;
  return `ws://${resolved.bridge.dialHost}:${resolved.target.port}${path}`;
}

/**
 * Where a preview socket connects: through the relay's proxy, with a grant for this one connection, so the grant is
 * made when the socket is. The dial name keeps env `NO_PROXY` from bypassing the proxy, and the `host` header keeps
 * the box seeing its own loopback address.
 */
export function upstreamSocket(resolved: PreviewResolve): PreviewSocketUpstream {
  const url = upstreamSocketUrl(resolved);
  return {
    url,
    host: resolved.bridge.address,
    proxy: { url: resolved.bridge.proxyUrl, token: resolved.bridge.grant() },
  };
}

/** Forwards an HTTP (non-upgrade) preview request to the box and returns the filtered response. */
export async function proxyHttp(
  req: Request,
  resolved: PreviewResolve,
  isolation: PreviewIsolation = "path",
): Promise<Response> {
  const { target, upstreamOrigin } = resolved;
  const path = target.forwardPath.startsWith("/") ? target.forwardPath : `/${target.forwardPath}`;
  const upstreamUrl = `${upstreamOrigin}${path}`;
  const headers = filterRequestHeaders(req.headers, new URL(upstreamOrigin).host, isolation);
  headers.set("x-forwarded-prefix", target.prefix);

  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(60_000),
  };
  if (resolved.bridge) (init as RequestInit & { unix: string }).unix = resolved.bridge.httpSocket;
  if (req.method !== "GET" && req.method !== "HEAD") {
    // The server's body limit is sized for checkpoint packages; a preview keeps the ceiling every other route has.
    init.body = req.body ? limitedBody(req.body, JSON_BODY_MAX_BYTES) : null;
    // Bun requires duplex when streaming a request body.
    (init as RequestInit & { duplex: string }).duplex = "half";
  }

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, init);
  } catch (e) {
    resolved.release();
    const detail = e instanceof Error ? e.message : String(e);
    throw new AppError(502, "bad_gateway", msg("preview_upstream_failed", { detail }));
  }

  return new Response(holdUntilDone(upstream.body, resolved.release), {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: filterResponseHeaders(upstream.headers, target.prefix, isolation),
  });
}

/**
 * The body as it streams, with `done` called once it has been read to the end, has failed, or the client has
 * cancelled it. A body that is still streaming keeps the box awake.
 */
function holdUntilDone(body: ReadableStream<Uint8Array> | null, done: () => void): ReadableStream<Uint8Array> | null {
  if (!body) {
    done();
    return null;
  }
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          done();
          return;
        }
        controller.enqueue(next.value);
      } catch (e) {
        done();
        controller.error(e);
      }
    },
    cancel(reason) {
      done();
      return reader.cancel(reason);
    },
  });
}
