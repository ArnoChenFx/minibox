import type { Source } from "../events/types";
import { isByteStream, type RawBody } from "../lib/body";
import { AppError } from "../lib/errors";
import { byteResponse, json, readJson } from "../lib/http";
import { msg } from "../lib/messages";
import { asObject } from "../lib/validation";
import { RUN_HEADER, RUN_ID_PATTERN } from "../operations/run";
import type { Operation, RestBinding } from "../operations/types";
import { type Handler, principalOf, type Route, route, scopedAccess } from "./router";

const OCTET_STREAM = "application/octet-stream";

/** The `run` a request belongs to, or `undefined` when it does not send `X-Minibox-Run`. */
export function runOf(req: Request): string | undefined {
  const value = req.headers.get(RUN_HEADER);
  if (value === null) return undefined;
  if (!RUN_ID_PATTERN.test(value))
    throw new AppError(400, "validation_failed", msg("run_invalid"), { field: RUN_HEADER });
  return value;
}

/**
 * The body of a `raw` binding, handed to the operation unread. The length comes from Content-Length, because the
 * operation refuses an oversized upload before it writes a byte, and that check needs the length up front.
 */
function rawBodyOf(req: Request): RawBody {
  const declared = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (declared !== OCTET_STREAM) throw new AppError(415, "unsupported_media_type", msg("file_upload_type"));
  const header = req.headers.get("content-length");
  if (header === null) throw new AppError(411, "length_required", msg("file_upload_length"));
  const length = Number(header);
  if (!/^\d+$/.test(header) || !Number.isSafeInteger(length)) {
    throw new AppError(400, "validation_failed", msg("file_upload_length"), { field: "content-length" });
  }
  return { stream: req.body, length };
}

/** The input a binding reads from the request. Path, If-Match and fixed values win over anything the client sent. */
function inputOf(
  binding: RestBinding,
  url: URL,
  params: Record<string, string>,
  body: Record<string, unknown>,
  ifMatch: string | null,
) {
  const query: Record<string, string> = {};
  for (const key of binding.query ?? []) {
    const value = url.searchParams.get(key);
    if (value !== null) query[key] = value;
  }
  const revision = binding.ifMatch ? { expectedRevision: ifMatch ?? "" } : {};
  return { ...body, ...query, ...params, ...revision, ...binding.fixed };
}

/** Single-box responses carry the revision as an entity tag so a client can send it back as If-Match. */
function entityTag(result: unknown): Record<string, string> {
  if (typeof result !== "object" || result === null || !("box" in result)) return {};
  const box = result.box;
  if (typeof box !== "object" || box === null || !("revision" in box)) return {};
  const revision = box.revision;
  return typeof revision === "number" ? { etag: `"${revision}"` } : {};
}

function handlerFor(operation: Operation, binding: RestBinding): Handler {
  return async (ctx) => {
    const { app, host, req, url, params, caller, server } = ctx;
    const principal = principalOf(ctx);
    const run = runOf(req);
    // A transfer can outlast the server's idle cap, so its request has no idle timer, as a checkpoint download does.
    if (binding.raw || binding.stream) server.timeout(req, 0);
    const body = binding.body ? asObject(await readJson(req)) : {};
    const raw = binding.raw ? rawBodyOf(req) : undefined;
    if (operation.longSync) server.timeout(req, 0);
    // The source comes from how the request signed in, never from a header: a browser session is the console (`ui`).
    const source: Source = caller?.sessionId ? "ui" : "rest";
    const result = await app.operations.run(
      operation.name,
      {
        host,
        principal,
        source,
        run,
        events: app.events,
        tokens: app.tokens,
        execs: app.execs,
        terminals: app.terminals,
        ...(raw ? { body: raw } : {}),
      },
      inputOf(binding, url, params, body, req.headers.get("if-match")),
    );
    if (isByteStream(result)) return byteResponse(result);
    const status = operation.async ? 202 : (binding.status ?? 200);
    return json(result, status, entityTag(result));
  };
}

/**
 * One route per REST binding of each operation. A route only checks the operation's scope; the executor checks the
 * target, the profile, the volumes and the quotas. Routes never validate or audit on their own.
 */
export function operationRoutes(operations: readonly Operation[]): Route[] {
  return operations.flatMap((operation) =>
    operation.rest.map((binding) =>
      route(binding.method, binding.path, handlerFor(operation, binding), {
        access: scopedAccess(operation.scope),
      }),
    ),
  );
}
