/**
 * Security headers for proxied Box pages. Path-mode previews share the MiniBox origin, so the
 * document must not inherit the console CSP or be able to read the console session.
 *
 * CSP `sandbox` without `allow-same-origin` gives the document an opaque origin. Combined with
 * the console session cookie's `SameSite=Strict`, modern browsers treat credentialed fetches from
 * that page as cross-site and do not attach the session cookie. `HttpOnly` also blocks
 * `document.cookie`. Subdomain isolation remains the stronger follow-up (see BASE_DOMAIN).
 */
export const PREVIEW_CSP = [
  "sandbox allow-scripts allow-forms allow-popups allow-modals allow-popups-to-escape-sandbox allow-downloads",
  "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:",
].join("; ");

/** Hop-by-hop and MiniBox-only headers that must not be forwarded to or from the box. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

const STRIP_REQUEST = new Set(["cookie", "authorization", "minibox_session"]);
const STRIP_RESPONSE = new Set(["set-cookie", "set-cookie2", "content-security-policy", "x-frame-options"]);

export function filterRequestHeaders(src: Headers, targetHost: string): Headers {
  const out = new Headers();
  src.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || STRIP_REQUEST.has(lower)) return;
    out.set(key, value);
  });
  out.set("host", targetHost);
  out.set("x-forwarded-host", src.get("host") ?? targetHost);
  out.set("x-forwarded-proto", "http");
  out.set("x-forwarded-prefix", ""); // callers may overwrite
  return out;
}

export function filterResponseHeaders(src: Headers, prefix: string): Headers {
  const out = new Headers();
  src.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || STRIP_RESPONSE.has(lower)) return;
    if (lower === "location") {
      out.set(key, rewriteLocation(value, prefix));
      return;
    }
    out.set(key, value);
  });
  out.set("content-security-policy", PREVIEW_CSP);
  out.set("x-frame-options", "SAMEORIGIN");
  out.set("referrer-policy", "same-origin");
  out.set("cache-control", out.get("cache-control") ?? "no-store");
  return out;
}

/**
 * Rewrites an absolute Location that points at the container back under the preview prefix, so a
 * framework redirect to `/login` or `http://127.0.0.1:5173/app` stays inside the proxy.
 */
export function rewriteLocation(location: string, prefix: string): string {
  if (location.startsWith("/")) return `${prefix}${location}`;
  try {
    const url = new URL(location);
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "0.0.0.0") {
      return `${prefix}${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    // leave non-URL values alone
  }
  return location;
}
