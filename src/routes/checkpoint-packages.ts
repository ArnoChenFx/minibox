import type { Caller } from "../auth";
import { PACKAGE_EXTENSION } from "../checkpoints/package";
import { AppError, toAppError } from "../lib/errors";
import { json } from "../lib/http";
import { msg } from "../lib/messages";
import type { Principal } from "../operations/types";
import { packageView, receivePackage, rejected, storedPackage } from "../services/checkpoint-transfer";
import { type Route, type RouteCtx, principalOf, route } from "./router";

const OCTET_STREAM = "application/octet-stream";

async function* chunksOf(body: ReadableStream<Uint8Array> | null): AsyncIterable<Uint8Array> {
  if (!body) return;
  for await (const chunk of body) yield chunk;
}

function sourceOf(caller: Caller | null): "ui" | "rest" {
  return caller?.sessionId ? "ui" : "rest";
}

/**
 * Uploads a package as a raw stream. Packages are not JSON, so the route stays outside the operation registry and writes
 * its own audit note, as the log stream does. The stream is checked as it arrives, and a refused one leaves no file.
 */
async function uploadPackage(ctx: RouteCtx): Promise<Response> {
  const { app, host, req, server, caller } = ctx;
  const principal: Principal = principalOf(ctx);
  const source = sourceOf(caller);
  const declared = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (declared !== OCTET_STREAM) throw new AppError(415, "unsupported_media_type", msg("package_upload_type"));
  // A large upload can outlast the server's idle cap, so this request has no idle timer, as a download does.
  server.timeout(req, 0);
  try {
    const meta = await receivePackage(host, chunksOf(req.body), principal.id).catch(rejected);
    app.recordNote(host.host.id, source, principal, {
      op: "checkpoint.package_upload",
      kind: "write",
      status: "ok",
      summary: "Uploaded a checkpoint package",
      detail: { package: meta.id, bytes: meta.bytes, sha256: meta.sha256 },
    });
    return json({ package: packageView(meta) }, 201);
  } catch (e) {
    const error = toAppError(e);
    app.recordNote(host.host.id, source, principal, {
      op: "checkpoint.package_upload",
      kind: "write",
      status: "error",
      summary: "Uploading a checkpoint package failed",
      error: { code: error.code, status: error.status },
    });
    throw e;
  }
}

/** Streams a stored package. Packages are sealed, but the download is still audited, since it leaves the instance. */
async function downloadPackage(ctx: RouteCtx): Promise<Response> {
  const { app, host, params, req, server, caller } = ctx;
  const principal = principalOf(ctx);
  const meta = storedPackage(host, params.id ?? "");
  server.timeout(req, 0);
  app.recordNote(host.host.id, sourceOf(caller), principal, {
    op: "checkpoint.package_download",
    kind: "read",
    status: "ok",
    summary: "Downloaded a checkpoint package",
    detail: { package: meta.id, bytes: meta.bytes },
  });
  return new Response(Bun.file(host.checkpoints.packages.pathFor(meta.id)), {
    headers: {
      "content-type": OCTET_STREAM,
      "content-length": String(meta.bytes),
      "content-disposition": `attachment; filename="${meta.id}${PACKAGE_EXTENSION}"`,
      "cache-control": "no-store",
    },
  });
}

/** Owner-only, like every route that moves a checkpoint's data. The scopes of the export and import operations stay owner-only too. */
export const checkpointPackageRoutes: Route[] = [
  route("POST", "/api/packages", uploadPackage),
  route("GET", "/api/packages/:id/download", downloadPackage),
];
