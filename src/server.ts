import type { Server } from "bun";

import { AGENT_CONNECT_PATH } from "./agent/protocol";
import { type App, createApp } from "./app";
import {
  type Caller,
  callerGate,
  clearLegacyKeyCookie,
  clientAddress,
  isSecureRequest,
  isWeakAccessKey,
  MIN_ACCESS_KEY_LENGTH,
  proxyHeaderWarner,
  resolveCaller,
  sessionCaller,
} from "./auth";
import { type Config, loadConfig } from "./config";
import { accessKeyPath } from "./data-dir";
import type { EventReader } from "./events/store";
import type { Source } from "./events/types";
import { guardRequest } from "./guard";
import { AppError, badRequest } from "./lib/errors";
import { assertBodyAllowed, errorResponse, withSecurityHeaders } from "./lib/http";
import { log, setLogLevel } from "./lib/logger";
import { msg } from "./lib/messages";
import { handleMcp } from "./mcp/http";
import { latestOwnerKeyUse } from "./mcp/owner-key";
import { isPreviewPath } from "./preview/path";
import { proxyHttp, resolvePreview, upstreamSocket } from "./preview/proxy";
import { isPreviewHostRequest, servePreviewHost } from "./preview/subdomain";
import { attachPreviewUpstream, type PreviewSocketData, watchPreviewSocket } from "./preview/ws";
import { routes } from "./routes";
import { handleCli } from "./routes/cli";
import { matchRoute, routeAllows } from "./routes/router";
import { type Box, hostOfSpecRef, locateBox, wakeIfSleeping } from "./services/boxes";
import { reconcileHost } from "./services/reconcile";
import { INIT_SESSION } from "./startup/command";
import { serveFile } from "./static";
import { isSessionName } from "./tmux/format";
import { boxVisible, mayUseSecrets, refusal, scopeAllowed, viewOfBox } from "./tokens/model";
import { resolveVersion } from "./version";
import type { AgentSocketData } from "./ws/agent";
import { type SocketData, socketHandlers } from "./ws/socket";
import type { SshSocketData } from "./ws/ssh";
import { BACKPRESSURE_LIMIT_BYTES, HEARTBEAT_SEC, type TerminalData } from "./ws/terminal";

const PUBLIC_PREFIXES = ["/assets/", "/css/", "/js/", "/vendor/", "/favicon"];
const TERMINAL_PATH = /^\/api\/boxes\/([^/]+)\/terminal$/;
const SSH_PATH = /^\/api\/ssh\/(?!host-key$)([^/]+)$/;
const MB = 1024 * 1024;
const PACKAGE_BODY_SLACK_BYTES = MB;
const PROXY_HINT =
  "Proxy headers arrived while TRUST_PROXY is off, so they are ignored. Behind a reverse proxy you control that overwrites them, set TRUST_PROXY=true (and ALLOWED_ORIGINS to its public address if it rewrites Host). A same-host tunnel such as OpenTunnel adds none of these headers, so leave TRUST_PROXY off and ignore this warning.";

/** The address a request is counted under: the TCP peer, or the proxy's entry when TRUST_PROXY is set. */
function addressOf(app: App, req: Request, server: Pick<Server<unknown>, "requestIP">): string {
  return clientAddress(req, server.requestIP(req)?.address, app.cfg.trustProxy);
}

/**
 * The caller of an API or terminal request. A Bearer header is the access key or an agent token, and a wrong one
 * counts toward the login limit. Without one, the session cookie decides.
 */
function callerOf(app: App, req: Request, server: Pick<Server<unknown>, "requestIP">): Promise<Caller | null> {
  return resolveCaller(req, callerGate(app), addressOf(app, req, server));
}

/**
 * `GET /api/ssh/<box>`. A WebSocket upgrade carries one SSH connection. A plain GET only runs the same checks, so the
 * CLI can print a refusal as an HTTP error. Returns undefined once the socket has been upgraded.
 */
async function sshRequest(
  app: App,
  req: Request,
  server: Server<SocketData>,
  ref: string,
): Promise<Response | undefined> {
  const caller = await callerOf(app, req, server);
  if (!caller) throw new AppError(401, "unauthorized", msg("unauthorized"));
  const host = hostOfSpecRef(app.hosts, ref) ?? app.hosts.get();
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    await app.ssh.probe(host, ref, caller);
    // The CLI compares this with its own version. A box:ssh token cannot read /api/system, which is owner-only.
    return new Response(null, { status: 204, headers: { "x-minibox-version": app.version } });
  }
  const lease = await app.ssh.enter(host, ref, caller);
  const data: SshSocketData = { kind: "ssh", lease };
  if (server.upgrade(req, { data })) return undefined;
  lease.release();
  throw new AppError(400, "bad_request", msg("ws_upgrade_failed"));
}

async function handleApi(app: App, req: Request, url: URL, server: Server<SocketData>): Promise<Response> {
  const m = matchRoute(routes, req.method, url.pathname);
  if (m === null) throw new AppError(404, "not_found", msg("api_not_found"));
  if (m === "method_not_allowed") throw new AppError(405, "method_not_allowed", msg("method_not_allowed"));
  // Public routes judge the cookie only, so a stray Bearer header cannot count against a login.
  const caller = m.route.public ? sessionCaller(req, app.sessions) : await callerOf(app, req, server);
  if (!m.route.public) {
    if (caller === null) throw new AppError(401, "unauthorized", msg("unauthorized"));
    if (!routeAllows(m.route, caller.principal)) {
      throw new AppError(403, "forbidden", msg("operation_forbidden", { op: `${req.method} ${url.pathname}` }));
    }
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
  const authed = sessionCaller(req, app.sessions) !== null;
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

/**
 * Routes one request. A request to a preview host belongs to a box, so it is served before the console's guard and body
 * limit: a box's own pages may send any content type. Returns undefined when the request became a WebSocket.
 */
async function dispatch(app: App, req: Request, url: URL, server: Server<SocketData>): Promise<Response | undefined> {
  const base = app.cfg.previewBaseDomain;
  if (base !== null && isPreviewHostRequest(url, base)) {
    return servePreviewHost(req, url, server, {
      base,
      hosts: app.hosts,
      grants: app.previewGrants,
      pulse: app.pulse,
      record: app.record,
      relay: app.previewRelay,
    });
  }
  guardRequest(req, app.cfg);
  assertBodyAllowed(req, url.pathname);
  if (url.pathname === AGENT_CONNECT_PATH) {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      throw badRequest(msg("ws_upgrade_failed"));
    }
    const data: AgentSocketData = { kind: "agent" };
    if (server.upgrade(req, { data })) return undefined;
    throw new AppError(400, "bad_request", msg("ws_upgrade_failed"));
  }
  const tm = TERMINAL_PATH.exec(url.pathname);
  if (tm && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    const caller = await callerOf(app, req, server);
    if (!caller) throw new AppError(401, "unauthorized", msg("unauthorized"));
    const name = url.searchParams.get("session") ?? "";
    if (!isSessionName(name)) throw badRequest(msg("session_name_invalid"), { field: "session" });
    const { host, box: found } = await locateBox(app.hosts, decodeURIComponent(tm[1] ?? ""));
    const principal = caller.principal;
    const source: Source = caller.sessionId ? "ui" : "rest";
    if (principal.type === "box-self") throw refusal("box_out_of_scope");
    if (
      principal.type === "token" &&
      (!scopeAllowed(principal.grants, "box:session") || !boxVisible(principal, viewOfBox(found, host.host.id)))
    ) {
      throw new AppError(403, "forbidden", msg("box_out_of_scope"));
    }
    if (name === INIT_SESSION && !mayUseSecrets(principal)) throw refusal("startup_session_forbidden");
    // The hold spans the wake and the attach, so the idle sweep cannot stop the box in between (#12).
    const release = app.pulse.hold(found.boxId);
    let box: Box;
    try {
      box = await wakeIfSleeping(host, found.boxId, {
        record: (note) => app.record(host.host.id, source, principal, note),
      });
      if (!box.running) throw new AppError(409, "conflict", msg("terminal_not_running"));
    } catch (e) {
      release();
      throw e;
    }
    const data: TerminalData = {
      boxId: box.id,
      box,
      host,
      name,
      source,
      sessionId: caller.sessionId,
      principal,
      releaseHold: release,
    };
    if (server.upgrade(req, { data })) return undefined;
    release();
    throw new AppError(400, "bad_request", msg("ws_upgrade_failed"));
  }
  const sm = SSH_PATH.exec(url.pathname);
  if (sm && req.method === "GET") return sshRequest(app, req, server, decodeURIComponent(sm[1] ?? ""));
  if (base === null && isPreviewPath(url.pathname)) return pathPreview(app, req, url, server);
  if (url.pathname === "/mcp") return handleMcp(app, req, url, addressOf(app, req, server));
  if (url.pathname.startsWith("/cli/")) return handleCli(app, req, url, server);
  return url.pathname.startsWith("/api/") ? handleApi(app, req, url, server) : handlePage(app, req, url);
}

/**
 * A path-mode preview, `/box/<name>/<port>/`. It needs the console's session cookie, and a proxied page gets the CSP
 * sandbox. A socket keeps the sign-in it was opened under, so signing out closes it.
 */
async function pathPreview(
  app: App,
  req: Request,
  url: URL,
  server: Server<SocketData>,
): Promise<Response | undefined> {
  const caller = sessionCaller(req, app.sessions);
  if (caller === null) throw new AppError(401, "unauthorized", msg("preview_unauthorized"));
  const resolved = await resolvePreview(app.hosts, url, {
    pulse: app.pulse,
    audit: (hostId, note) => app.record(hostId, "ui", caller.principal, note),
    relay: app.previewRelay,
  });
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    const data: PreviewSocketData = {
      kind: "preview",
      boxId: resolved.box.boxId,
      pendingUpstream: upstreamSocket(resolved),
      pendingHeaders: req.headers,
      release: resolved.release,
      sessionId: caller.sessionId ?? undefined,
    };
    if (server.upgrade(req, { data })) return undefined;
    resolved.release();
    throw new AppError(400, "bad_request", msg("ws_upgrade_failed"));
  }
  return proxyHttp(req, resolved);
}

export function startServer(app: App): Server<SocketData> {
  const sockets = socketHandlers({
    sessions: app.sessions,
    tokens: app.tokens,
    terminals: app.terminals,
    pulse: app.pulse,
    ssh: app.ssh,
    agents: app.agents,
  });
  const warnIgnoredProxyHeaders = proxyHeaderWarner(app.cfg.trustProxy, (headers) =>
    log.warn("proxy.headers_ignored", { headers, hint: PROXY_HINT }),
  );
  return Bun.serve<SocketData>({
    hostname: app.cfg.host,
    port: app.cfg.port,
    // Bun refuses a larger body before any route runs. Packages and volume files are the only bodies this large: every
    // other route keeps the 128 MiB ceiling (assertBodyAllowed, readBodyText, and the preview proxy's limitedBody). The
    // slack keeps a body a little over its limit on its own check, which answers with its JSON error, not Bun's plain one.
    maxRequestBodySize:
      Math.max(app.cfg.checkpointPackageMaxMb, app.cfg.fileUploadMaxMb) * MB + PACKAGE_BODY_SLACK_BYTES,
    // Bun's idle timer is a hard cap measured from the start of the request, in 4-second steps, and writes do not
    // extend it. A handler that stays silent for longer than this is reset. Long work returns 202 and keeps running;
    // progress streams call server.timeout(req, 0), which disables the cap (tests/long-work-routes.test.ts).
    idleTimeout: 60,
    async fetch(req, server) {
      warnIgnoredProxyHeaders(req);
      const url = new URL(req.url);
      const started = performance.now();
      let res: Response | undefined;
      try {
        res = await dispatch(app, req, url, server);
      } catch (e) {
        res = errorResponse(e);
        if (res.status >= 500)
          log.error("request.failed", { method: req.method, path: url.pathname, error: String(e) });
      }
      if (res === undefined) return undefined;
      if ((url.pathname.startsWith("/api/") && url.pathname !== "/api/host/metrics") || url.pathname === "/mcp") {
        log.debug("request", {
          method: req.method,
          path: url.pathname,
          status: res.status,
          ms: Math.round(performance.now() - started),
        });
      }
      // Preview responses already set CSP sandbox; withSecurityHeaders keeps existing CSP.
      return withSecurityHeaders(res, isSecureRequest(req, app.cfg.trustProxy));
    },
    websocket: {
      open: async (ws) => {
        if (ws.data && "kind" in ws.data && ws.data.kind === "preview") {
          const data = ws.data;
          if (data.pendingUpstream) {
            const upstream = data.pendingUpstream;
            const headers = data.pendingHeaders ?? new Headers();
            data.pendingUpstream = undefined;
            data.pendingHeaders = undefined;
            const preview = ws as import("bun").ServerWebSocket<PreviewSocketData>;
            if (!watchPreviewSocket(preview, { watch: (id, listener) => app.sessions.watch(id, listener) })) return;
            await attachPreviewUpstream(preview, upstream, app.pulse, headers);
          }
          return;
        }
        return sockets.open(ws);
      },
      message: sockets.message,
      drain: sockets.drain,
      close: sockets.close,
      idleTimeout: HEARTBEAT_SEC,
      backpressureLimit: BACKPRESSURE_LIMIT_BYTES,
      closeOnBackpressureLimit: true,
    },
  });
}

/**
 * Opens the direct SSH port when SSH_PORT is set. A port that cannot be bound is logged and left off: the web console
 * still starts, so the owner can read the log and fix the setting.
 */
export async function startDirectSsh(app: App): Promise<number | null> {
  const { sshDirect, cfg } = app;
  if (!sshDirect || cfg.sshPort === null) return null;
  try {
    const port = await sshDirect.listen(cfg.sshBind, cfg.sshPort);
    log.info("ssh.direct_listening", { bind: cfg.sshBind, port, fingerprint: app.ssh.hostKeyView().fingerprint });
    return port;
  } catch (e) {
    log.error("ssh.direct_listen_failed", { bind: cfg.sshBind, port: cfg.sshPort, error: String(e) });
    return null;
  }
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

const OWNER_KEY_NOW_REFUSED_HINT =
  "The owner access key reached /mcp recently, and MCP_ALLOW_OWNER_KEY is false, so those requests now get 401. Give each agent an agent token (minibox token create <name>), or set MCP_ALLOW_OWNER_KEY=true to accept the key again.";

/**
 * Warns at startup when the owner access key reached `/mcp` recently and MCP_ALLOW_OWNER_KEY refuses it. The agents that
 * still send the key get 401 from now on, so the log names the fix before anyone has to find out from a failing agent.
 */
export function warnIfOwnerKeyRecentlyUsed(events: EventReader, allowed: boolean, now: number): void {
  if (allowed) return;
  const latest = latestOwnerKeyUse(events, allowed, now);
  if (latest === null) return;
  log.warn("mcp.owner_key_now_refused", { lastUsedAt: latest.lastUsedAt, hint: OWNER_KEY_NOW_REFUSED_HINT });
}

async function boot(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  if (cfg.accessKeySource === "generated") log.info("access_key.generated", { path: accessKeyPath(cfg.dataDir) });
  warnIfWeakAccessKey(cfg);
  const version = resolveVersion();
  const app = createApp(cfg, version);
  warnIfOwnerKeyRecentlyUsed(app.events, cfg.mcpAllowOwnerKey, Date.now());
  const local = app.hosts.get();
  try {
    const report = await reconcileHost(local);
    log.info("box.reconciled", { host: local.host.id, ...report });
  } catch (e) {
    log.error("box.reconcile_failed", { host: local.host.id, error: String(e) });
  }
  local.sampler.start();
  app.hostAdmin.start();
  app.monitor.start();
  app.retention.start();
  app.checkpointSweep.start();
  app.checkpointScheduler.start();
  app.containers.start();
  app.startups.start();
  app.lifecycle.start();
  app.volumeUsage.start();
  const server = startServer(app);
  log.info("server.started", startupFields(cfg, version));
  await startDirectSsh(app);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("server.stopping", { signal });
    app.monitor.stop();
    app.hostAdmin.close();
    app.agents.close();
    for (const host of app.hosts.list()) host.sampler.stop();
    app.retention.stop();
    app.checkpointSweep.stop();
    app.checkpointScheduler.stop();
    app.containers.stop();
    app.startups.stop();
    app.lifecycle.stop();
    app.volumeUsage.stop();
    app.notify.stop();
    app.throttle.stop();
    app.sessions.stop();
    app.terminals.shutdown();
    const force = setTimeout(() => process.exit(1), 5000);
    await app.sshDirect?.close();
    app.ssh.disconnectAll("server stopping");
    await server.stop(true);
    clearTimeout(force);
    app.previewRelay.stop();
    await app.tasks.shutdown();
    app.events.close();
    log.info("server.stopped");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.main) void boot();
