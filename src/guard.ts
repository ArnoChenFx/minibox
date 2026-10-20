import { lastListValue } from "./auth";
import type { Config } from "./config";
import { AppError } from "./lib/errors";
import { msg } from "./lib/messages";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

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
 * Refuses cross-site WebSocket upgrades and API writes, which a third-party page could trigger
 * with the browser's cookies.
 */
export function guardRequest(req: Request, policy: GuardPolicy): void {
  const websocket = req.headers.get("upgrade")?.toLowerCase() === "websocket";
  const apiWrite = new URL(req.url).pathname.startsWith("/api/") && !SAFE_METHODS.has(req.method);
  if (!websocket && !apiWrite) return;
  if (!isSameOriginRequest(req, policy)) throw new AppError(403, "forbidden", msg("origin_forbidden"));
  if (apiWrite) requireJsonBody(req);
}

/**
 * A plain HTML form can only send urlencoded or multipart bodies without a CORS preflight, so requiring
 * JSON for every body makes cross-site form posts fail even if they bypass the Origin check.
 */
export function requireJsonBody(req: Request): void {
  if (!hasBody(req)) return;
  const type = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    throw new AppError(415, "unsupported_media_type", msg("unsupported_media_type"));
  }
}

function hasBody(req: Request): boolean {
  if (req.headers.has("transfer-encoding")) return true;
  return Number(req.headers.get("content-length") ?? 0) > 0;
}
