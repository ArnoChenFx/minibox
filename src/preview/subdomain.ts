import type { Server } from "bun";

import type { HostRegistry } from "../host/registry";
import { AppError } from "../lib/errors";
import { errorResponse } from "../lib/http";
import { msg } from "../lib/messages";
import { OWNER } from "../operations/types";
import type { ActivityPulse } from "../services/activity-pulse";
import type { RecordNote } from "../services/terminals";
import type { SpecStore } from "../specs/store";
import type { SocketData } from "../ws/socket";
import { boxLabel, inPreviewNamespace, parsePreviewHost, type PreviewHost } from "./domain";
import { type PreviewGrant, type PreviewGrants, previewCookie, previewToken, TICKET_PARAM } from "./grants";
import { boxCookies } from "./headers";
import type { PreviewTarget } from "./path";
import { proxyHttp, resolveTarget, upstreamSocket } from "./proxy";
import type { PreviewRelay } from "./relay";
import type { PreviewSocketData } from "./ws";

export interface PreviewHostDeps {
  readonly base: string;
  readonly hosts: HostRegistry;
  readonly grants: PreviewGrants;
  readonly pulse: ActivityPulse;
  readonly record: RecordNote;
  readonly relay: PreviewRelay;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * A request to the base domain or to a host under it. Nothing in that namespace is the console, so all of it is checked
 * here, and a name that is not a preview is refused.
 */
export function isPreviewHostRequest(url: URL, base: string): boolean {
  // A trailing dot names the same host in DNS. It is matched here, so such a name is refused rather than served the
  // console, and the exact-name checks below refuse it.
  const hostname = url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname;
  return hostname === base || inPreviewNamespace(hostname, base);
}

/**
 * Serves a request to a preview host. Everything on a preview host belongs to the box, so this runs before the console's
 * own guard: a box's app may send JSON or plain text without the console's rules applying. Returns undefined when the
 * request became a WebSocket.
 */
export async function servePreviewHost(
  req: Request,
  url: URL,
  server: Server<SocketData>,
  deps: PreviewHostDeps,
): Promise<Response | undefined> {
  const parsed = parsePreviewHost(url.hostname, deps.base);
  if (!parsed) return previewNotFound();
  if (url.searchParams.has(TICKET_PARAM) && (req.method === "GET" || req.method === "HEAD")) {
    return exchangeTicket(url, parsed, deps);
  }
  const upgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
  if ((upgrade || !SAFE_METHODS.has(req.method)) && !sameOrigin(req)) {
    throw new AppError(403, "forbidden", msg("origin_forbidden"));
  }
  const grant = grantFor(req, url, parsed, deps);
  const target: PreviewTarget = {
    ref: grant.boxId,
    port: parsed.port,
    forwardPath: `${url.pathname}${url.search}`,
    prefix: "",
  };
  const resolved = await resolveTarget(deps.hosts, target, {
    pulse: deps.pulse,
    audit: (hostId, note) => deps.record(hostId, "ui", OWNER, note),
    relay: deps.relay,
  });
  if (!upgrade) return proxyHttp(req, resolved, "subdomain");
  const cookie = boxCookies(req.headers.get("cookie") ?? "");
  const data: PreviewSocketData = {
    kind: "preview",
    boxId: resolved.box.boxId,
    pendingUpstream: upstreamSocket(resolved),
    pendingHeaders: req.headers,
    release: resolved.release,
    sessionId: grant.sessionId,
    expiresAt: grant.expiresAt,
    ...(cookie ? { cookie } : {}),
  };
  if (server.upgrade(req, { data })) return undefined;
  resolved.release();
  throw new AppError(400, "bad_request", msg("ws_upgrade_failed"));
}

/**
 * Spends the ticket in the URL and sends the browser back to the same address without it, with the grant cookie. The
 * ticket is refused unless it was minted for this preview, and the box it names is still the one this label names.
 */
function exchangeTicket(url: URL, parsed: PreviewHost, deps: PreviewHostDeps): Response {
  const boxId = boxIdForLabel(deps.hosts.get().specs, parsed.label);
  const ticket = url.searchParams.get(TICKET_PARAM) ?? "";
  const token =
    boxId === null ? null : deps.grants.redeemTicket(ticket, { hostname: url.hostname, boxId, port: parsed.port });
  if (token === null) throw new AppError(401, "unauthorized", msg("preview_grant_required"));
  url.searchParams.delete(TICKET_PARAM);
  return new Response(null, {
    status: 302,
    headers: {
      // Leading slashes are collapsed, so a path such as `//evil.example` cannot become a protocol-relative redirect.
      location: `/${url.pathname.replace(/^\/+/, "")}${url.search}`,
      "set-cookie": previewCookie(token),
      "cache-control": "no-store",
    },
  });
}

/** The grant a request's cookie opens for this preview. A grant whose box was renamed or deleted is refused. */
function grantFor(req: Request, url: URL, parsed: PreviewHost, deps: PreviewHostDeps): PreviewGrant {
  const token = previewToken(req.headers.get("cookie"));
  const grant = token === undefined ? null : deps.grants.authorize(token, url.hostname);
  if (!grant || grant.port !== parsed.port || !boxStillNamed(deps.hosts.get().specs, grant.boxId, parsed.label)) {
    throw new AppError(401, "unauthorized", msg("preview_grant_required"));
  }
  return grant;
}

function boxStillNamed(specs: SpecStore, boxId: string, label: string): boolean {
  const spec = specs.read(boxId);
  return spec !== null && boxLabel(spec.name, spec.id) === label;
}

function boxIdForLabel(specs: SpecStore, label: string): string | null {
  const matches = specs.list().filter((spec) => boxLabel(spec.name, spec.id) === label);
  return matches.length === 1 ? (matches[0]?.id ?? null) : null;
}

/**
 * A write or a socket on a preview must come from that preview. Its grant cookie is host-only, but a sibling preview under
 * the same base domain is same-site, so without this check one box's page could act on another box's preview.
 */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) {
    const site = req.headers.get("sec-fetch-site");
    return site === null || site === "same-origin" || site === "none";
  }
  try {
    return new URL(origin).host === (req.headers.get("host") ?? "").toLowerCase();
  } catch {
    return false;
  }
}

/** The marker lets the self-check tell MiniBox apart from another server that answers under the base domain. */
function previewNotFound(): Response {
  const res = errorResponse(new AppError(404, "not_found", msg("preview_host_unknown")));
  res.headers.set("x-minibox-preview", "1");
  return res;
}
