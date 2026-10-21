import { z } from "zod";

import { COOKIE_NAME } from "../auth";
import { type JsonSchema, toJsonSchema } from "./jsonschema";
import { RUN_HEADER, RUN_ID_PATTERN } from "./run";
import { ErrorSchema, TaskAcceptedSchema } from "./schemas";
import type { Operation, RestBinding } from "./types";

const PATH_PARAM = /:([A-Za-z]\w*)/g;

const ERROR_RESPONSES: Record<string, string> = {
  "400": "Invalid input, or a malformed X-Minibox-Run header.",
  "401": "Not signed in, or the access key is invalid.",
  "403": "Refused: a cross-site write, or an operation this credential may not run.",
  "404": "The box, snapshot, template, task or exec named in the path does not exist.",
  "409":
    "The name is already taken, this operation is already running, a rebuild was requested without confirm set to true, or an exec is not running. A rebuild refusal includes a preview of the docker diff and the planned changes.",
  "415": "The request declares a body that is not JSON.",
  "412": "The If-Match revision is not the box's current revision.",
  "422": "The box would exceed the host's CPU or memory.",
  "428": "If-Match is required and was not sent.",
  "500": "Unexpected server error.",
  "502": "Docker returned an error.",
  "503": "Docker is unavailable.",
};

/** The OpenAPI operationId: the operation name, plus the fixed value that tells the bindings of one operation apart. */
export function operationIdOf(op: Pick<Operation, "name">, binding: RestBinding): string {
  return [op.name, ...Object.values(binding.fixed ?? {})].join(".");
}

export const toOpenApiPath = (path: string): string => path.replace(PATH_PARAM, "{$1}");

const pathParams = (binding: RestBinding): string[] => [...binding.path.matchAll(PATH_PARAM)].map((m) => m[1] ?? "");

/** The schemas of the named input fields, in the order given. */
function fieldsOf(op: Operation, keys: readonly string[]): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType | undefined> = op.input.shape;
  return Object.fromEntries(
    keys.flatMap((key) => {
      const field = shape[key];
      return field ? [[key, field] as const] : [];
    }),
  );
}

const schemaOf = (op: Operation, key: string): JsonSchema => {
  const field = fieldsOf(op, [key])[key];
  return field ? toJsonSchema(field) : {};
};

const IF_MATCH_PARAMETER: JsonSchema = {
  name: "If-Match",
  in: "header",
  required: true,
  description:
    "The box's current revision: a positive integer, a quoted entity tag, or a weak tag. Missing is 428 precondition_required. A stale revision is 412 precondition_failed.",
  schema: { type: "string", minLength: 1 },
};

const RUN_PARAMETER: JsonSchema = {
  name: RUN_HEADER,
  in: "header",
  required: false,
  description:
    "Groups the audit events of one client session. 1 to 64 letters, digits, dots, colons, underscores or hyphens, starting with a letter or digit.",
  schema: { type: "string", minLength: 1, maxLength: 64, pattern: RUN_ID_PATTERN.source },
};

function parameters(op: Operation, binding: RestBinding): JsonSchema[] {
  const param = (name: string, required: boolean) => ({
    name,
    in: required ? "path" : "query",
    required,
    schema: schemaOf(op, name),
  });
  return [
    ...pathParams(binding).map((name) => param(name, true)),
    ...(binding.query ?? []).map((name) => param(name, false)),
    ...(binding.ifMatch ? [IF_MATCH_PARAMETER] : []),
    RUN_PARAMETER,
  ];
}

/** The body holds the input keys that the path, the query and the fixed values do not supply. */
function requestBody(op: Operation, binding: RestBinding): JsonSchema | undefined {
  if (!binding.body) return undefined;
  const supplied = new Set([...pathParams(binding), ...(binding.query ?? []), ...Object.keys(binding.fixed ?? {})]);
  if (binding.ifMatch) supplied.add("expectedRevision");
  const keys = Object.keys(op.input.shape).filter((key) => !supplied.has(key));
  const schema = toJsonSchema(z.object(fieldsOf(op, keys)));
  return {
    required: Array.isArray(schema.required) && schema.required.length > 0,
    content: { "application/json": { schema } },
  };
}

function errorResponses(op: Operation, binding: RestBinding): Record<string, JsonSchema> {
  const codes = new Set(["401", "403", "500", "502", "503", "400"]);
  if (pathParams(binding).length > 0) codes.add("404");
  if (op.conflicts) codes.add("409");
  if (binding.method !== "GET") codes.add("415");
  if (op.precondition) codes.add("422");
  if (binding.ifMatch) {
    codes.add("412");
    codes.add("428");
  }
  return Object.fromEntries(
    [...codes].map((code) => [
      code,
      {
        description: ERROR_RESPONSES[code],
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
    ]),
  );
}

function operationObject(op: Operation, binding: RestBinding): JsonSchema {
  const status = String(binding.status ?? 200);
  const accepted = status === "202";
  const body = requestBody(op, binding);
  return {
    operationId: operationIdOf(op, binding),
    tags: [op.tag],
    summary: op.summary,
    parameters: parameters(op, binding),
    ...(body ? { requestBody: body } : {}),
    responses: {
      [status]: {
        description: accepted ? "Accepted. The result is stored on the task." : status === "201" ? "Created." : "OK.",
        content: {
          "application/json": { schema: toJsonSchema(accepted ? TaskAcceptedSchema : op.output, "output") },
        },
      },
      ...errorResponses(op, binding),
    },
    "x-kind": op.kind,
    "x-scope": op.scope,
    "x-async": op.async,
    ...(accepted ? { "x-task-result": toJsonSchema(op.output, "output") } : {}),
    ...(op.cli ? { "x-cli": op.cli } : {}),
    ...(op.mcp ? { "x-mcp": { name: op.mcp.name, toolset: op.mcp.toolset } } : {}),
  };
}

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string; description: string; license: { name: string } };
  tags: { name: string }[];
  paths: Record<string, Record<string, JsonSchema>>;
  components: { schemas: Record<string, JsonSchema>; securitySchemes: Record<string, JsonSchema> };
  security: Record<string, string[]>[];
}

/** The OpenAPI document for the operations in the registry. Routes that have not been migrated are not in it. */
export function buildOpenApi(operations: readonly Operation[], version: string): OpenApiDocument {
  const paths: Record<string, Record<string, JsonSchema>> = {};
  for (const op of operations) {
    for (const binding of op.rest) {
      const path = toOpenApiPath(binding.path);
      paths[path] = { ...paths[path], [binding.method.toLowerCase()]: operationObject(op, binding) };
    }
  }
  const tags = [...new Set(operations.map((op) => op.tag))].map((name) => ({ name }));
  return {
    openapi: "3.1.0",
    info: {
      title: "MiniBox API",
      version,
      description:
        "Generated from the operation registry: boxes, snapshots, templates, tasks and the event log. Sign-in, host and activity routes, and the event and task streams (GET /api/events/stream and GET /api/tasks/{id}/events, text/event-stream), are not listed yet.",
      license: { name: "MIT" },
    },
    tags,
    paths,
    components: {
      schemas: { Error: toJsonSchema(ErrorSchema, "output") },
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", description: "The access key, as a Bearer token." },
        cookie: {
          type: "apiKey",
          in: "cookie",
          name: COOKIE_NAME,
          description: "Session cookie from POST /api/auth/login.",
        },
      },
    },
    security: [{ bearer: [] }, { cookie: [] }],
  };
}

/** The text written to `docs/openapi.json`: two-space JSON with a trailing newline, so diffs stay readable. */
export function renderOpenApi(operations: readonly Operation[], version: string): string {
  return `${JSON.stringify(buildOpenApi(operations, version), null, 2)}\n`;
}
