import { probeHost } from "../host/registry";
import { json } from "../lib/http";
import { LIMITS } from "../lib/validation";
import { type Route, route } from "./router";

export const systemRoutes: Route[] = [
  route(
    "GET",
    "/api/health",
    async ({ host }) => {
      const docker = (await probeHost(host)) === "online";
      return json({ ok: true, docker }, docker ? 200 : 503);
    },
    { public: true },
  ),
  route("GET", "/api/system", ({ app }) =>
    json({
      name: "MiniBox",
      version: app.version,
      runtime: `Bun ${Bun.version}`,
      startedAt: app.startedAt.toISOString(),
      config: {
        host: app.cfg.host,
        port: app.cfg.port,
        dockerSocket: app.cfg.dockerSocket,
        labelPrefix: app.cfg.labelPrefix,
        baseTemplate: app.cfg.baseTemplateTag,
        metricsIntervalMs: app.cfg.metricsIntervalMs,
      },
      limits: LIMITS,
    }),
  ),
  route("GET", "/api/host/metrics", async ({ app }) => json(await app.monitor.snapshot())),
  route("GET", "/api/activity", ({ app }) => json({ activity: app.activity.list(20) })),
];
