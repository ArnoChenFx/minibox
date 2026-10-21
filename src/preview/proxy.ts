import type { HostCtx } from "../host/registry";
import { AppError } from "../lib/errors";
import { msg } from "../lib/messages";
import type { ActivityPulse } from "../services/activity-pulse";
import { type Box, getBox } from "../services/boxes";
import { filterRequestHeaders, filterResponseHeaders } from "./headers";
import { type PreviewTarget, parsePreviewPath } from "./path";

export interface PreviewResolve {
  readonly box: Box;
  readonly host: HostCtx;
  readonly target: PreviewTarget;
  readonly upstreamOrigin: string;
}

/**
 * Resolves a preview request to a running box and its container IP. Does not check auth — the
 * caller does. Fails when the box is stopped or has no reachable IP on its network.
 */
export async function resolvePreview(host: HostCtx, url: URL): Promise<PreviewResolve> {
  const target = parsePreviewPath(url.pathname, url.search);
  if (!target) throw new AppError(404, "not_found", msg("preview_path_invalid"));
  const box = await getBox(host, target.ref);
  if (!box.running) throw new AppError(409, "conflict", msg("preview_box_stopped"));
  const info = await host.runtime.inspectContainer(box.id);
  const ip = info.ipAddress;
  if (!ip) throw new AppError(502, "bad_gateway", msg("preview_no_ip"));
  return {
    box,
    host,
    target,
    upstreamOrigin: `http://${ip}:${target.port}`,
  };
}

/** Forwards an HTTP (non-upgrade) preview request to the box and returns the filtered response. */
export async function proxyHttp(req: Request, resolved: PreviewResolve, pulse: ActivityPulse): Promise<Response> {
  const { target, upstreamOrigin, box } = resolved;
  pulse.touch(box.boxId, "preview");
  const path = target.forwardPath.startsWith("/") ? target.forwardPath : `/${target.forwardPath}`;
  const upstreamUrl = `${upstreamOrigin}${path}`;
  const headers = filterRequestHeaders(req.headers, new URL(upstreamOrigin).host);
  headers.set("x-forwarded-prefix", target.prefix);

  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(60_000),
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body;
    // Bun requires duplex when streaming a request body.
    (init as RequestInit & { duplex: string }).duplex = "half";
  }

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, init);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new AppError(502, "bad_gateway", msg("preview_upstream_failed", { detail }));
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: filterResponseHeaders(upstream.headers, target.prefix),
  });
}
