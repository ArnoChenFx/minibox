import type { Server } from "bun";

import { type App, createApp } from "./app";
import {
  authenticate,
  clearLegacyKeyCookie,
  clientAddress,
  isSecureRequest,
  isWeakAccessKey,
  MIN_ACCESS_KEY_LENGTH,
  proxyHeaderWarner,
} from "./auth";
import { type Config, loadConfig } from "./config";
import { accessKeyPath } from "./data-dir";
import { guardRequest } from "./guard";
import { AppError } from "./lib/errors";
import { errorResponse, withSecurityHeaders } from "./lib/http";
import { log, setLogLevel } from "./lib/logger";
import { msg } from "./lib/messages";
import { routes } from "./routes";
import { matchRoute } from "./routes/router";
import { getBox } from "./services/boxes";
import { reconcileHost } from "./services/reconcile";
import { serveFile } from "./static";
import { canExec, viewFromBox } from "./tokens/model";
import { resolveVersion } from "./version";
import { type TerminalData, terminalHandlers } from "./ws/terminal";

const PUBLIC_PREFIXES = ["/assets/", "/css/", "/js/", "/vendor/", "/favicon"];
const TERMINAL_PATH = /^\/api\/boxes\/([^/]+)\/terminal$/;
const PROXY_HINT =
  "Proxy headers arrived while TRUST_PROXY is off, so they are ignored. Behind a reverse proxy you control that overwrites them, set TRUST_PROXY=true (and ALLOWED_ORIGINS to its public address if it rewrites Host). A same-host tunnel such as OpenTunnel adds none of these headers, so leave TRUST_PROXY off and ignore this warning.";

async function handleApi(app: App, req: Request, url: URL, server: Server<TerminalData>): Promise<Response> {
  const m = matchRoute(routes, req.method, url.pathname);
  if (m === null) throw new AppError(404, "not_found", msg("api_not_found"));
  if (m === "method_not_allowed") throw new AppError(405, "method_not_allowed", msg("method_not_allowed"));
  const caller = authenticate(
    req,
    app.cfg.accessKey,
    app.sessions,
    app.tokens,
    clientAddress(req, server.requestIP(req)?.address, app.cfg.trustProxy),
  );
  if (!m.route.public && caller === null) {
    throw new AppError(401, "unauthorized", msg("unauthorized"));
  }
  return m.route.handler({
    app,
    host: app.hosts.get(),
    req,
    url,
    params: m.params,
    server: server as Server<unknown>,
    caller,
  });
}

/** Relative redirect: correct behind TLS-terminating tunnels/proxies where req.url is http. */
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

async function handlePage(app: App, req: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  const authed =
    authenticate(
      req,
      app.cfg.accessKey,
      app.sessions,
      app.tokens,
      clientAddress(req, undefined, app.cfg.trustProxy),
    ) !== null;
  if (PUBLIC_PREFIXES.some((p) => path.startsWith(p))) {
    const file = await serveFile(app.cfg.webDir, path === "/favicon.ico" ? "/assets/favicon-32.png" : path);
    if (file) return file;
    return new Response("Not Found", { status: 404 });
  }
  if (path === "/login") {
    if (authed) return redirect("/");
    const page = await serveFile(app.cfg.webDir, "/login.html");
    if (!page) return new Response("Not Found", { status: 404 });
    page.headers.append("set-cookie", clearLegacyKeyCookie());
    return page;
  }
  if (path === "/" || path === "/index.html") {
    if (!authed) return redirect("/login");
    return (await serveFile(app.cfg.webDir, "/index.html")) ?? new Response("Not Found", { status: 404 });
  }
  return new Response("Not Found", { status: 404 });
}

export function startServer(app: App): Server<TerminalData> {
  const term = terminalHandlers(app.sessions, app.tokens);
  const warnIgnoredProxyHeaders = proxyHeaderWarner(app.cfg.trustProxy, (headers) =>
    log.warn("proxy.headers_ignored", { headers, hint: PROXY_HINT }),
  );
  return Bun.serve<TerminalData>({
    hostname: app.cfg.host,
    port: app.cfg.port,
    idleTimeout: 60,
    async fetch(req, server) {
      warnIgnoredProxyHeaders(req);
      const url = new URL(req.url);
      const started = performance.now();
      let res: Response | undefined;
      try {
        guardRequest(req, app.cfg);
        const tm = TERMINAL_PATH.exec(url.pathname);
        if (tm && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const caller = authenticate(
            req,
            app.cfg.accessKey,
            app.sessions,
            app.tokens,
            clientAddress(req, server.requestIP(req)?.address, app.cfg.trustProxy),
          );
          if (!caller) throw new AppError(401, "unauthorized", msg("unauthorized"));
          const host = app.hosts.get();
          const box = await getBox(host, decodeURIComponent(tm[1] ?? ""));
          if (!box.running) throw new AppError(409, "conflict", msg("terminal_not_running"));
          if (!canExec(caller.principal, viewFromBox(box))) {
            throw new AppError(403, "forbidden", msg("operation_forbidden", { op: "exec" }));
          }
          const data: TerminalData = {
            boxId: box.id,
            host,
            sessionId: caller.sessionId,
            tokenId: caller.principal.type === "token" ? caller.principal.id : null,
          };
          if (server.upgrade(req, { data })) return undefined;
          throw new AppError(400, "bad_request", msg("ws_upgrade_failed"));
        }
        res = url.pathname.startsWith("/api/")
          ? await handleApi(app, req, url, server)
          : await handlePage(app, req, url);
      } catch (e) {
        res = errorResponse(e);
        if (res.status >= 500)
          log.error("request.failed", { method: req.method, path: url.pathname, error: String(e) });
      }
      if (url.pathname.startsWith("/api/") && url.pathname !== "/api/host/metrics") {
        log.debug("request", {
          method: req.method,
          path: url.pathname,
          status: res.status,
          ms: Math.round(performance.now() - started),
        });
      }
      return withSecurityHeaders(res, isSecureRequest(req, app.cfg.trustProxy));
    },
    websocket: {
      open: term.open,
      message: term.message,
      close: term.close,
      idleTimeout: 0,
    },
  });
}

/** Fields of the `server.started` log line. None of them may carry any part of the access key. */
export function startupFields(cfg: Config, version: string) {
  return {
    url: `http://${cfg.host}:${cfg.port}`,
    version,
    bun: Bun.version,
    docker: cfg.dockerSocket,
    dataDir: cfg.dataDir,
    accessKeySource: cfg.accessKeySource,
  };
}

const WEAK_KEY_HINT = `ACCESS_KEY is weak: use at least ${MIN_ACCESS_KEY_LENGTH} random characters, for example openssl rand -hex 32, then restart.`;

/** Warns about a weak key without refusing to start, so existing deployments keep running. The key is never logged. */
export function warnIfWeakAccessKey(cfg: Config): void {
  if (!isWeakAccessKey(cfg.accessKey)) return;
  log.warn("auth.weak_key", { hint: WEAK_KEY_HINT, source: cfg.accessKeySource });
}

async function boot(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  if (cfg.accessKeySource === "generated") log.info("access_key.generated", { path: accessKeyPath(cfg.dataDir) });
  warnIfWeakAccessKey(cfg);
  const version = resolveVersion();
  const app = createApp(cfg, version);
  for (const host of app.hosts.list()) {
    try {
      const report = await reconcileHost(host);
      log.info("box.reconciled", { host: host.host.id, ...report });
    } catch (e) {
      log.error("box.reconcile_failed", { host: host.host.id, error: String(e) });
    }
  }
  app.monitor.start();
  app.retention.start();
  const server = startServer(app);
  log.info("server.started", startupFields(cfg, version));

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("server.stopping", { signal });
    app.monitor.stop();
    app.retention.stop();
    app.throttle.stop();
    app.sessions.stop();
    app.tokens.stop();
    const force = setTimeout(() => process.exit(1), 5000);
    await server.stop(true);
    clearTimeout(force);
    app.events.close();
    log.info("server.stopped");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.main) void boot();
