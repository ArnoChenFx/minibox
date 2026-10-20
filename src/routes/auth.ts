import {
  clearSessionCookie,
  clientAddress,
  isAuthorized,
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
import { type Route, route } from "./router";

export const authRoutes: Route[] = [
  route(
    "POST",
    "/api/auth/login",
    async ({ app, req, server }) => {
      const ip = rateLimitKey(clientAddress(req, server.requestIP(req)?.address, app.cfg.trustProxy));
      const body = asObject(await readJson(req));
      const key = typeof body.key === "string" ? body.key.trim() : "";
      if (key && safeEqual(key, app.cfg.accessKey)) {
        app.throttle.recordSuccess(ip);
        log.info("auth.login", { ip });
        const secure = app.cfg.cookieSecure || isSecureRequest(req, app.cfg.trustProxy);
        return json({ ok: true }, 200, { "set-cookie": sessionCookie(key, secure) });
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
  route("POST", "/api/auth/logout", () => json({ ok: true }, 200, { "set-cookie": clearSessionCookie() }), {
    public: true,
  }),
  route("GET", "/api/auth/session", ({ app, req }) => json({ authenticated: isAuthorized(req, app.cfg.accessKey) }), {
    public: true,
  }),
];
