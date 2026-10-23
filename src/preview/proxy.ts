import type { AuditNote } from "../events/types";
import type { HostCtx, HostRegistry } from "../host/registry";
import { AppError } from "../lib/errors";
import { JSON_BODY_MAX_BYTES, limitedBody } from "../lib/http";
import { msg } from "../lib/messages";
import type { ActivityPulse } from "../services/activity-pulse";
import { type Box, hostOfSpecRef, locateBox, wakeIfSleeping } from "../services/boxes";
import { filterRequestHeaders, filterResponseHeaders, type PreviewIsolation } from "./headers";
import { type PreviewTarget, parsePreviewPath } from "./path";

export interface PreviewResolve {
  readonly box: Box;
  readonly host: HostCtx;
  readonly target: PreviewTarget;
  readonly upstreamOrigin: string;
  /** Ends the hold that keeps the box awake while this request is served. Safe to call more than once. */
  readonly release: () => void;
}

export interface PreviewDeps {
  readonly pulse: ActivityPulse;
  /** Audits a wake that this request caused, under the host the box lives on. */
  readonly audit: (hostId: string, note: AuditNote) => void;
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
 * Resolves a preview target to a box and its container IP. A box asleep for idle or TTL is woken; a box a person
 * stopped is refused with 409. The box is held awake until `release` is called, so an idle sweep cannot stop it while
 * the response is streaming (#12).
 */
export async function resolveTarget(
  hosts: HostRegistry,
  target: PreviewTarget,
  deps: PreviewDeps,
): Promise<PreviewResolve> {
  const named = hostOfSpecRef(hosts, target.ref);
  if (named && named.host.transport !== "local") {
    throw new AppError(501, "unsupported", msg("preview_agent_unsupported"));
  }
  const { host, box: found } = await locateBox(hosts, target.ref);
  const release = deps.pulse.hold(found.boxId);
  try {
    deps.pulse.touch(found.boxId, "preview");
    const box = await wakeIfSleeping(host, found.boxId, { record: (note) => deps.audit(host.host.id, note) });
    if (!box.running) throw new AppError(409, "conflict", msg("preview_box_stopped"));
    const info = await host.runtime.inspectContainer(box.id);
    const ip = info.ipAddress;
    if (!ip) throw new AppError(502, "bad_gateway", msg("preview_no_ip"));
    return { box, host, target, upstreamOrigin: `http://${ip}:${target.port}`, release };
  } catch (e) {
    release();
    throw e;
  }
}

/** The WebSocket address of the box for a preview request, with the same path and query as the request. */
export function upstreamSocketUrl(resolved: PreviewResolve): string {
  const { forwardPath } = resolved.target;
  const path = forwardPath.startsWith("/") ? forwardPath : `/${forwardPath}`;
  return resolved.upstreamOrigin.replace(/^http/, "ws") + path;
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
