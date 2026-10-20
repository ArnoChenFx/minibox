import type { Server } from "bun";

import type { App } from "../app";
import type { Caller } from "../auth";
import type { HostCtx } from "../host/registry";

export interface RouteCtx {
  app: App;
  host: HostCtx;
  req: Request;
  url: URL;
  params: Record<string, string>;
  server: Server<unknown>;
  /** `null` when the request is not signed in. Only public routes are reached in that case. */
  caller: Caller | null;
}

export type Handler = (ctx: RouteCtx) => Promise<Response> | Response;

export interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  public?: boolean;
}

/** Compile `/api/boxes/:id/logs` into a regex with named segments. */
export function compilePath(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const src = path
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":")) {
        keys.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { pattern: new RegExp(`^${src}$`), keys };
}

export function route(method: string, path: string, handler: Handler, opts: { public?: boolean } = {}): Route {
  return { method, ...compilePath(path), handler, public: opts.public };
}

export interface Match {
  route: Route;
  params: Record<string, string>;
}

/** Returns the matching route, or `"method_not_allowed"` when only the path matches. */
export function matchRoute(routes: Route[], method: string, pathname: string): Match | "method_not_allowed" | null {
  let pathMatched = false;
  for (const r of routes) {
    const m = r.pattern.exec(pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== method) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => {
      params[k] = decodeURIComponent(m[i + 1] ?? "");
    });
    return { route: r, params };
  }
  return pathMatched ? "method_not_allowed" : null;
}
