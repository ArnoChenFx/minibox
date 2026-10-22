import { AGENT_PAIR_PATH, PairRequestSchema } from "../agent/protocol";
import { clientAddress, rateLimitKey } from "../auth";
import { AppError, badRequest } from "../lib/errors";
import { json, readJson } from "../lib/http";
import { msg } from "../lib/messages";
import { type Route, route } from "./router";

/**
 * Exchanges a one-time pairing code and an agent's public key for the agent's id. Public, because the agent has no
 * session; the code is the credential. Wrong codes count toward the same limit as failed logins.
 */
export const agentRoutes: Route[] = [
  route(
    "POST",
    AGENT_PAIR_PATH,
    async ({ app, req, server }) => {
      const ip = rateLimitKey(clientAddress(req, server.requestIP(req)?.address, app.cfg.trustProxy));
      if (app.throttle.refuses(ip)) {
        await app.throttle.delayRefusal();
        throw new AppError(429, "too_many_requests", msg("too_many_attempts"));
      }
      const parsed = PairRequestSchema.safeParse(await readJson(req));
      if (!parsed.success) throw badRequest(msg("agent_pairing_request_invalid"));
      try {
        const reply = await app.hostAdmin.pairAgent(parsed.data);
        app.throttle.recordSuccess(ip);
        return json(reply, 201);
      } catch (e) {
        if (e instanceof AppError && e.status === 401) app.throttle.recordFailure(ip);
        throw e;
      }
    },
    { public: true },
  ),
];
