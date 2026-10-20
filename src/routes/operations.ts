import { AppError } from "../lib/errors";
import { json, readJson } from "../lib/http";
import { msg } from "../lib/messages";
import { asObject } from "../lib/validation";
import { RUN_HEADER, RUN_ID_PATTERN } from "../operations/run";
import type { Operation, Principal, RestBinding } from "../operations/types";
import { type Handler, type Route, route } from "./router";

/** Until scoped tokens (#13) exist, every REST request acts as the owner. */
const OWNER: Principal = { type: "owner" };

/** The `run` a request belongs to, or `undefined` when it does not send `X-Minibox-Run`. */
export function runOf(req: Request): string | undefined {
  const value = req.headers.get(RUN_HEADER);
  if (value === null) return undefined;
  if (!RUN_ID_PATTERN.test(value))
    throw new AppError(400, "validation_failed", msg("run_invalid"), { field: RUN_HEADER });
  return value;
}

/** The input a binding reads from the request. Path and fixed values win over anything the client sent. */
function inputOf(binding: RestBinding, url: URL, params: Record<string, string>, body: Record<string, unknown>) {
  const query: Record<string, string> = {};
  for (const key of binding.query ?? []) {
    const value = url.searchParams.get(key);
    if (value !== null) query[key] = value;
  }
  return { ...body, ...query, ...params, ...binding.fixed };
}

function handlerFor(operation: Operation, binding: RestBinding): Handler {
  return async ({ app, host, req, url, params }) => {
    const run = runOf(req);
    const body = binding.body ? asObject(await readJson(req)) : {};
    const result = await app.operations.run(
      operation.name,
      { host, principal: OWNER, run },
      inputOf(binding, url, params, body),
    );
    return json(result, binding.status ?? 200);
  };
}

/** One route per REST binding of each operation. Routes never validate or audit on their own: the executor does both. */
export function operationRoutes(operations: readonly Operation[]): Route[] {
  return operations.flatMap((operation) =>
    operation.rest.map((binding) => route(binding.method, binding.path, handlerFor(operation, binding))),
  );
}
