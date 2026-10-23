import { normalize, posix, resolve, sep } from "node:path";

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
  const body = path.endsWith(".css") ? await inlineImports(root, urlPath, await file.text()) : file;
  return new Response(body, {
    headers: {
      "content-type": contentType(path),
      "cache-control": isHtml ? "no-store" : "public, max-age=300",
    },
  });
}

/** A line such as `@import "app/base.css";`. Only quoted relative paths are inlined. */
const IMPORT_LINE = /^@import "([^":]+\.css)";[ \t]*$/gm;

/**
 * Replaces each top-level `@import` of a stylesheet under `root` with that file's text, so a stylesheet kept as parts
 * (app.css and web/css/app/) still loads as one request. One level only: the parts do not import further. An import
 * that leaves `root` or names a missing file is left as it is.
 */
async function inlineImports(root: string, urlPath: string, css: string): Promise<string> {
  const parts = new Map<string, string>();
  for (const [, rel = ""] of css.matchAll(IMPORT_LINE)) {
    const full = safeJoin(root, posix.join(posix.dirname(urlPath), rel));
    const part = full ? Bun.file(full) : null;
    if (part && (await part.exists())) parts.set(rel, await part.text());
  }
  return css.replace(IMPORT_LINE, (line, rel: string) => {
    const text = parts.get(rel);
    return text === undefined ? line : `/* ${rel} */\n${text.trimEnd()}`;
  });
}
