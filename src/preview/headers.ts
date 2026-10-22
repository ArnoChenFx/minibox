import { PREVIEW_COOKIE } from "./grants";

/**
 * Security headers for proxied Box pages. Path-mode previews share the MiniBox origin, so the
 * document must not inherit the console CSP or be able to read the console session.
 *
 * CSP `sandbox` without `allow-same-origin` gives the document an opaque origin. Combined with
 * the console session cookie's `SameSite=Strict`, modern browsers treat credentialed fetches from
 * that page as cross-site and do not attach the session cookie. `HttpOnly` also blocks
 * `document.cookie`. Subdomain previews (PREVIEW_BASE_DOMAIN) have an origin of their own instead.
 */
export type PreviewIsolation = "path" | "subdomain";

export const PREVIEW_CSP = [
  "sandbox allow-scripts allow-forms allow-popups allow-modals allow-popups-to-escape-sandbox allow-downloads",
  "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:",
].join("; ");

/**
 * A subdomain preview is its own origin, so the sandbox may keep it: `allow-same-origin` lets the app use its own
 * localStorage and cookies. The console is another origin and another site, so the app still cannot reach it.
 */
export const PREVIEW_SUBDOMAIN_CSP = [
  "sandbox allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-popups-to-escape-sandbox allow-downloads",
  "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:",
].join("; ");

export function previewCsp(isolation: PreviewIsolation): string {
  return isolation === "subdomain" ? PREVIEW_SUBDOMAIN_CSP : PREVIEW_CSP;
}

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

/** MiniBox's own cookies. A subdomain preview forwards the box's cookies and never these. */
const MINIBOX_COOKIES = new Set([PREVIEW_COOKIE, "minibox_session", "minibox_key"]);

export function filterRequestHeaders(src: Headers, targetHost: string, isolation: PreviewIsolation = "path"): Headers {
  const out = new Headers();
  src.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || STRIP_REQUEST.has(lower)) return;
    out.set(key, value);
  });
  if (isolation === "subdomain") {
    const cookies = boxCookies(src.get("cookie") ?? "");
    if (cookies) out.set("cookie", cookies);
  }
  out.set("host", targetHost);
  out.set("x-forwarded-host", src.get("host") ?? targetHost);
  out.set("x-forwarded-proto", isolation === "subdomain" ? "https" : "http");
  out.set("x-forwarded-prefix", ""); // callers may overwrite
  return out;
}

/** The cookies a box may see: those it set itself, without MiniBox's. Null when none are left. */
export function boxCookies(header: string): string | null {
  const kept = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      const eq = part.indexOf("=");
      const name = eq < 0 ? part : part.slice(0, eq).trim();
      return name !== "" && !MINIBOX_COOKIES.has(name);
    });
  return kept.length > 0 ? kept.join("; ") : null;
}

export function filterResponseHeaders(src: Headers, prefix: string, isolation: PreviewIsolation = "path"): Headers {
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
  if (isolation === "subdomain") {
    for (const cookie of src.getSetCookie()) {
      const kept = hostOnlyCookie(cookie);
      if (kept !== null) out.append("set-cookie", kept);
    }
  }
  out.set("content-security-policy", previewCsp(isolation));
  out.set("x-frame-options", "SAMEORIGIN");
  out.set("referrer-policy", "same-origin");
  out.set("cache-control", out.get("cache-control") ?? "no-store");
  return out;
}

/**
 * A cookie the box sets on its own preview host. The Domain attribute is dropped, so the cookie stays on that host and
 * cannot reach a sibling preview. A cookie that would replace the grant cookie is refused.
 */
export function hostOnlyCookie(setCookie: string): string | null {
  const parts = setCookie.split(";");
  const name = (parts[0] ?? "").split("=")[0]?.trim() ?? "";
  if (name === PREVIEW_COOKIE) return null;
  return parts
    .filter((part, index) => index === 0 || part.trim().split("=")[0]?.trim().toLowerCase() !== "domain")
    .join(";");
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
