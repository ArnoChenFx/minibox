import { normalize, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  json: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json",
};

export function contentType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return TYPES[ext] ?? "application/octet-stream";
}

/** Resolve a URL path inside `root`, refusing traversal outside it. */
export function safeJoin(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const full = resolve(root, `.${normalize(`/${decoded}`)}`);
  const base = resolve(root);
  return full === base || full.startsWith(base + sep) ? full : null;
}

export async function serveFile(root: string, urlPath: string): Promise<Response | null> {
  const path = safeJoin(root, urlPath);
  if (!path) return null;
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const isHtml = path.endsWith(".html");
  return new Response(file, {
    headers: {
      "content-type": contentType(path),
      "cache-control": isHtml ? "no-store" : "public, max-age=300",
    },
  });
}
