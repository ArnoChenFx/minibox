import { clearSessionCookie, isAuthorized, isSecureRequest, safeEqual, sessionCookie } from "../auth";
import { AppError } from "../lib/errors";
import { json, readJson } from "../lib/http";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { asObject } from "../lib/validation";
import { type Route, route } from "./router";

export function clientIp(req: Request, fallback?: string): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || fallback || "unknown";
}

export const authRoutes: Route[] = [
  route(
    "POST",
    "/api/auth/login",
    async ({ app, req, server }) => {
      const ip = clientIp(req, server.requestIP(req)?.address);
      if (app.throttle.isBlocked(ip)) {
        throw new AppError(429, "too_many_requests", msg("too_many_attempts"));
      }
      const body = asObject(await readJson(req));
      const key = typeof body.key === "string" ? body.key.trim() : "";
      if (!key || !safeEqual(key, app.cfg.accessKey)) {
        app.throttle.fail(ip);
        log.warn("auth.login_failed", { ip });
        throw new AppError(401, "unauthorized", msg("wrong_key"));
      }
      app.throttle.reset(ip);
      log.info("auth.login", { ip });
      return json({ ok: true }, 200, { "set-cookie": sessionCookie(key, isSecureRequest(req)) });
    },
    { public: true },
  ),
  route("POST", "/api/auth/logout", () => json({ ok: true }, 200, { "set-cookie": clearSessionCookie() }), {
    public: true,
  }),
  route("GET", "/api/auth/session", ({ app, req }) => json({ authenticated: isAuthorized(req, app.cfg.accessKey) }), {
    public: true,
  }),
];
