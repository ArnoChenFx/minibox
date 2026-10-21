/**
 * Path-mode preview URLs: `/box/<name-or-id>/<port>/...`.
 * Subdomain mode (`<port>-<name>.<BASE_DOMAIN>`) is deferred.
 */

export interface PreviewTarget {
  /** Box name or stable id from the URL. */
  readonly ref: string;
  /** Container port to reach. */
  readonly port: number;
  /** Path + query forwarded to the box (`/` when the preview root was requested). */
  readonly forwardPath: string;
  /** Prefix stripped from the request, e.g. `/box/demo/5173`. Used to rewrite Location headers. */
  readonly prefix: string;
}

const PREVIEW_PATH = /^\/box\/([^/]+)\/(\d+)(?:\/(.*))?$/;

/** True when the pathname is under the path-mode preview prefix. */
export function isPreviewPath(pathname: string): boolean {
  return pathname === "/box" || pathname.startsWith("/box/");
}

/**
 * Parses a preview URL. Returns `null` when the path is not a preview route or the port is out of range.
 * A request for `/box/<ref>/<port>` (no trailing slash) still matches; `forwardPath` is `/`.
 */
export function parsePreviewPath(pathname: string, search = ""): PreviewTarget | null {
  const match = PREVIEW_PATH.exec(pathname);
  if (!match) return null;
  const ref = decodeURIComponent(match[1] ?? "");
  const port = Number(match[2]);
  if (!ref || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const rest = match[3];
  const forwardPath = `/${rest ?? ""}${search}`;
  return {
    ref,
    port,
    forwardPath: forwardPath === "/" && search === "" ? "/" : forwardPath || "/",
    prefix: `/box/${encodeURIComponent(ref)}/${port}`,
  };
}

/** Builds the console-relative preview URL for a box and port. */
export function previewUrl(ref: string, port: number, path = "/"): string {
  const base = `/box/${encodeURIComponent(ref)}/${port}`;
  if (!path || path === "/") return `${base}/`;
  return path.startsWith("/") ? `${base}${path}` : `${base}/${path}`;
}
