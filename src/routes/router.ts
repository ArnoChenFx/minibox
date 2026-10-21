import type { Server } from "bun";

import type { App } from "../app";
import type { Caller } from "../auth";
import type { HostCtx } from "../host/registry";
import { AppError } from "../lib/errors";
import { msg } from "../lib/messages";
import type { Principal } from "../operations/types";
import { scopeAllowed } from "../tokens/model";

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

/**
 * Who may call a route. `owner` is the default: a token never reaches an owner route. `scope` admits a token whose
 * grants satisfy the scope, by the same mapping the operations use. Each route still runs its own checks inside.
 */
export type RouteAccess = { readonly kind: "owner" } | { readonly kind: "scope"; readonly scope: string };

export interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  /** Callable without signing in. Only the health check sets this. */
  public?: boolean;
  access: RouteAccess;
}

export const OWNER_ONLY: RouteAccess = { kind: "owner" };
export const scopedAccess = (scope: string): RouteAccess => ({ kind: "scope", scope });

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

export function route(
  method: string,
  path: string,
  handler: Handler,
  opts: { public?: boolean; access?: RouteAccess } = {},
): Route {
  return { method, ...compilePath(path), handler, public: opts.public, access: opts.access ?? OWNER_ONLY };
}

/** Whether a principal may call a route at all. Each operation still checks its own target. */
export function routeAllows(route: Pick<Route, "public" | "access">, principal: Principal): boolean {
  if (route.public) return true;
  if (principal.type === "owner") return true;
  if (principal.type !== "token") return false;
  return route.access.kind === "scope" && scopeAllowed(principal.grants, route.access.scope);
}

/** The principal of a signed-in request. Only a public route runs without one, and it never asks. */
export function principalOf(ctx: RouteCtx): Principal {
  if (!ctx.caller) throw new AppError(401, "unauthorized", msg("unauthorized"));
  return ctx.caller.principal;
}

/**
 * Aborts `controller` when the caller's credential ends: a browser session signs out, or a token is revoked. A stream
 * must stop at that moment, not at its next reconnect. Returns the function that stops watching.
 */
export function abortWhenEnded(app: App, caller: Caller | null, controller: AbortController): () => void {
  const stops: (() => void)[] = [];
  if (caller?.sessionId) stops.push(app.sessions.watch(caller.sessionId, () => controller.abort()));
  if (caller?.principal.type === "token") {
    stops.push(app.tokens.watch(caller.principal.id, () => controller.abort()));
  }
  return () => {
    for (const stop of stops) stop();
  };
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
