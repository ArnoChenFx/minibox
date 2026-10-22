import { lastListValue } from "./auth";
import type { Config } from "./config";
import { AppError } from "./lib/errors";
import { msg } from "./lib/messages";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Reads of the event log, which also need the origin check: they are the audit trail, not public data. */
const CHECKED_READS = new Set(["/api/events", "/api/events/stream"]);
/** A box's log stream needs the origin check too: its lines are read as the audit trail reads are, and may hold secrets. */
const CHECKED_BOX_LOG_STREAM = /^\/api\/boxes\/[^/]+\/logs\/stream$/;
/** A package download leaves the instance, so a page on another site may not start one with the owner's cookies. */
const CHECKED_PACKAGE_DOWNLOAD = /^\/api\/packages\/[^/]+\/download$/;
/** A package is uploaded as a raw stream, which the JSON body check would refuse. The route checks its own type. */
const PACKAGE_UPLOAD = "/api/packages";

export type GuardPolicy = Pick<Config, "allowedOrigins" | "trustProxy">;

/**
 * Whether a request is same-origin with MiniBox. Requests without an Origin header (CLIs, scripts
 * with a Bearer token) are allowed unless the browser's Fetch Metadata says they came from another site.
 */
export function isSameOriginRequest(req: Request, policy: GuardPolicy): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) {
    const site = req.headers.get("sec-fetch-site");
    return site === null || site === "same-origin" || site === "none";
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (policy.allowedOrigins.includes(parsed.origin)) return true;
  // Hosts are compared, not schemes: a TLS-terminating proxy hands MiniBox plain http for an https origin.
  return requestHosts(req, policy.trustProxy).includes(parsed.host.toLowerCase());
}

function requestHosts(req: Request, trustProxy: boolean): string[] {
  const hosts = [(req.headers.get("host") ?? new URL(req.url).host).toLowerCase()];
  const forwarded = trustProxy ? lastListValue(req.headers.get("x-forwarded-host")) : null;
  if (forwarded) hosts.push(forwarded.toLowerCase());
  return hosts;
}

/**
 * Refuses cross-site WebSocket upgrades, API writes, and reads of the event log and of box log streams, which a
 * third-party page could trigger with the browser's cookies.
 */
export function guardRequest(req: Request, policy: GuardPolicy): void {
  const { pathname } = new URL(req.url);
  const websocket = req.headers.get("upgrade")?.toLowerCase() === "websocket";
  const apiWrite = pathname.startsWith("/api/") && !SAFE_METHODS.has(req.method);
  const checkedRead =
    req.method === "GET" &&
    (CHECKED_READS.has(pathname) || CHECKED_BOX_LOG_STREAM.test(pathname) || CHECKED_PACKAGE_DOWNLOAD.test(pathname));
  if (!websocket && !apiWrite && !checkedRead) return;
  if (!isSameOriginRequest(req, policy)) throw new AppError(403, "forbidden", msg("origin_forbidden"));
  if (apiWrite && !(req.method === "POST" && pathname === PACKAGE_UPLOAD)) requireJsonBody(req);
}

/**
 * A plain HTML form can only send urlencoded or multipart bodies without a CORS preflight, so any declared
 * type other than JSON is refused, even with an empty body. Writes that send neither a body nor a
 * Content-Type (the console's buttons, simple scripts) are still accepted.
 */
export function requireJsonBody(req: Request): void {
  const declared = req.headers.get("content-type");
  if (declared === null && !hasBody(req)) return;
  const type = declared?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    throw new AppError(415, "unsupported_media_type", msg("unsupported_media_type"));
  }
}

function hasBody(req: Request): boolean {
  if (req.headers.has("transfer-encoding")) return true;
  return Number(req.headers.get("content-length") ?? 0) > 0;
}
