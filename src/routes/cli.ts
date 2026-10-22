import type { Server } from "bun";

import type { App } from "../app";
import { clientAddress, rateLimitKey } from "../auth";
import { CliUnavailableError } from "../cli-dist/distribution";
import { renderInstallScript, requestOrigin } from "../cli-dist/scripts";
import { cliTargetByFileName } from "../cli-dist/targets";
import { type Route, type RouteCtx, matchRoute, route } from "./router";

const PLAIN = "text/plain; charset=utf-8";

function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": PLAIN, "cache-control": "no-cache", ...headers } });
}

function installerRoute(name: "install.sh" | "install.ps1"): (ctx: RouteCtx) => Response {
  return ({ app, req }) => {
    const origin = requestOrigin(req, app.cfg);
    if (origin === null) {
      return text("The address MiniBox was reached at cannot be written into the installer.\n", 400);
    }
    return text(renderInstallScript(name, origin));
  };
}

/** The binary's name must be one of the whitelisted targets, so the request never names a path on disk. */
async function binaryRoute({ app, params, req, server }: RouteCtx): Promise<Response> {
  const target = cliTargetByFileName(params.file ?? "");
  if (target === null) return text("Not Found\n", 404);
  // A build, or a download over a slow link, can outlast the server's 60-second idle cap.
  server.timeout(req, 0);
  const artifact = await app.cli.artifact(target);
  return new Response(Bun.file(artifact.path), {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${target.fileName}"`,
      "x-checksum-sha256": artifact.sha256,
      "x-minibox-version": artifact.version,
      "cache-control": "no-cache",
    },
  });
}

/** The public CLI downloads. No caller is needed: the binaries hold no secrets and only the sha256 list describes them. */
export const cliRoutes: Route[] = [
  route("GET", "/cli/install.sh", installerRoute("install.sh"), { public: true }),
  route("GET", "/cli/install.ps1", installerRoute("install.ps1"), { public: true }),
  route("GET", "/cli/checksums.txt", async ({ app }) => text(await app.cli.checksums()), { public: true }),
  route("GET", "/cli/:file", binaryRoute, { public: true }),
];

function matchCli(method: string, pathname: string) {
  try {
    return matchRoute(cliRoutes, method, pathname);
  } catch {
    return null;
  }
}

function unavailable(error: CliUnavailableError): string {
  return [
    `MiniBox could not build the CLI for ${error.target.id} on this server: ${error.message}`,
    "Fallback: build it from a checkout with bun run build:cli, then put dist/minibox on your PATH.",
    "If this server reaches npm only through a proxy, set HTTPS_PROXY for MiniBox and try again.",
    "",
  ].join("\n");
}

/**
 * Serves `/cli/`. It sits outside handleApi because these routes are not JSON and need no caller. Every request counts
 * against its client's limit, so a loop of retries cannot start unlimited builds.
 */
export async function handleCli(app: App, req: Request, url: URL, server: Server<unknown>): Promise<Response> {
  const address = rateLimitKey(clientAddress(req, server.requestIP(req)?.address, app.cfg.trustProxy));
  const wait = app.cli.admit(address);
  if (wait > 0) {
    return text("Too many requests for the CLI downloads. Try again shortly.\n", 429, { "retry-after": String(wait) });
  }
  const found = matchCli(req.method, url.pathname);
  if (found === null) return text("Not Found\n", 404);
  if (found === "method_not_allowed") return text("Method Not Allowed\n", 405, { allow: "GET" });
  try {
    return await found.route.handler({
      app,
      host: app.hosts.get(),
      req,
      url,
      params: found.params,
      server: server as Server<unknown>,
      caller: null,
    });
  } catch (e) {
    if (e instanceof CliUnavailableError) return text(unavailable(e), 503);
    throw e;
  }
}
