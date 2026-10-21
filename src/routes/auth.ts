import {
  clearLegacyKeyCookie,
  clearSessionCookie,
  clientAddress,
  isSecureRequest,
  rateLimitKey,
  safeEqual,
  sessionCookie,
} from "../auth";
import { AppError } from "../lib/errors";
import { json, readJson } from "../lib/http";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { asObject } from "../lib/validation";
import type { SessionInfo } from "../sessions";
import { type Route, route } from "./router";

function withCookies(res: Response, cookies: string[]): Response {
  for (const cookie of cookies) res.headers.append("set-cookie", cookie);
  return res;
}

function sessionView(session: SessionInfo, currentId: string | null) {
  return {
    id: session.id,
    current: session.id === currentId,
    createdAt: new Date(session.createdAt).toISOString(),
    lastSeenAt: new Date(session.lastSeenAt).toISOString(),
    userAgent: session.userAgent,
    ip: session.ip,
  };
}

export const authRoutes: Route[] = [
  route(
    "POST",
    "/api/auth/login",
    async ({ app, req, server, caller }) => {
      const address = clientAddress(req, server.requestIP(req)?.address, app.cfg.trustProxy);
      const ip = rateLimitKey(address);
      const body = asObject(await readJson(req));
      const key = typeof body.key === "string" ? body.key.trim() : "";
      if (key && safeEqual(key, app.cfg.accessKey)) {
        app.throttle.recordSuccess(ip);
        if (caller?.sessionId) app.sessions.revoke(caller.sessionId, "replaced");
        const { token } = app.sessions.create({ userAgent: req.headers.get("user-agent") ?? "", ip: address });
        log.info("auth.login", { ip });
        const secure = app.cfg.cookieSecure || isSecureRequest(req, app.cfg.trustProxy);
        return withCookies(json({ ok: true }), [
          sessionCookie(token, { secure, maxAgeSeconds: Math.floor(app.cfg.sessionTtlMs / 1000) }),
          clearLegacyKeyCookie(),
        ]);
      }
      const refused = app.throttle.refuses(ip);
      app.throttle.recordFailure(ip);
      log.warn("auth.login_failed", { ip, refused });
      if (refused) {
        await app.throttle.delayRefusal();
        throw new AppError(429, "too_many_requests", msg("too_many_attempts"));
      }
      throw new AppError(401, "unauthorized", msg("wrong_key"));
    },
    { public: true },
  ),
  route(
    "POST",
    "/api/auth/logout",
    ({ app, caller }) => {
      if (caller?.sessionId) app.sessions.revoke(caller.sessionId, "logout");
      return withCookies(json({ ok: true }), [clearSessionCookie(), clearLegacyKeyCookie()]);
    },
    { public: true },
  ),
  route("GET", "/api/auth/session", ({ caller }) => json({ authenticated: caller !== null }), { public: true }),
  route("GET", "/api/auth/sessions", ({ app, caller }) =>
    json({ sessions: app.sessions.list().map((s) => sessionView(s, caller?.sessionId ?? null)) }),
  ),
  route("POST", "/api/auth/sessions/revoke-others", ({ app, caller }) =>
    json({ ok: true, revoked: app.sessions.revokeOthers(caller?.sessionId ?? null) }),
  ),
  route("DELETE", "/api/auth/sessions/:id", ({ app, caller, params }) => {
    const id = params.id ?? "";
    if (!app.sessions.revoke(id, "revoked")) throw new AppError(404, "not_found", msg("session_not_found"));
    const endedOwnSession = id === caller?.sessionId;
    return withCookies(json({ ok: true }), endedOwnSession ? [clearSessionCookie(), clearLegacyKeyCookie()] : []);
  }),
];
