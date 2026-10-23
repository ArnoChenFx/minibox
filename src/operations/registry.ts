import { backupOperations } from "./backup";
import { boxOperations } from "./boxes";
import { checkpointPackageOperations } from "./checkpoint-packages";
import { checkpointOperations } from "./checkpoints";
import { eventOperations } from "./events";
import { execOperations } from "./exec";
import { fileOperations } from "./files";
import { hostOperations } from "./hosts";
import { imageOperations } from "./images";
import { notifyOperations } from "./notify";
import { operationIdOf } from "./openapi";
import { portOperations } from "./ports";
import { questionOperations } from "./questions";
import { secretOperations } from "./secrets";
import { selfOperations } from "./self";
import { sessionOperations } from "./sessions";
import { snapshotOperations } from "./snapshots";
import { startupOperations } from "./startup";
import { targetOperations } from "./targets";
import { taskOperations } from "./tasks";
import { templateOperations } from "./templates";
import { tokenOperations } from "./tokens";
import { toolOperations } from "./tools";
import { trashOperations } from "./trash";
import type { Operation } from "./types";
import { volumeOperations } from "./volumes";

/** Every operation the API serves. REST routes, OpenAPI, MCP tools and CLI commands are all derived from this list. */
export const OPERATIONS: readonly Operation[] = [
  ...boxOperations,
  ...startupOperations,
  ...execOperations,
  ...portOperations,
  ...fileOperations,
  ...volumeOperations,
  ...toolOperations,
  ...secretOperations,
  ...sessionOperations,
  ...snapshotOperations,
  ...checkpointOperations,
  ...checkpointPackageOperations,
  ...backupOperations,
  ...targetOperations,
  ...trashOperations,
  ...templateOperations,
  ...imageOperations,
  ...taskOperations,
  ...eventOperations,
  ...tokenOperations,
  ...hostOperations,
  ...notifyOperations,
  ...selfOperations,
  ...questionOperations,
];

const OPERATION_NAME = /^[a-z]+(\.[a-z]+)+$/;
const MCP_NAME = /^[a-z][a-z0-9_]*$/;
const PATH_PARAM = /:([A-Za-z]\w*)/g;

/**
 * Definition errors in a registry: duplicate names or routes, bindings that name inputs the operation does not have,
 * and reads that do not map to GET. An empty list means the registry can be served.
 */
export function registryProblems(operations: readonly Operation[]): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  const routes = new Set<string>();
  const operationIds = new Set<string>();
  const mcpNames = new Set<string>();
  const commands = new Set<string>();

  const claim = (seen: Set<string>, key: string, what: string) => {
    if (seen.has(key)) problems.push(`duplicate ${what}: ${key}`);
    seen.add(key);
  };

  for (const op of operations) {
    claim(names, op.name, "operation");
    if (!OPERATION_NAME.test(op.name)) problems.push(`operation name must look like box.create: ${op.name}`);
    if (op.kind !== "read" && !op.activity) problems.push(`${op.name} changes state but declares no activity`);
    if (op.rest.length === 0) problems.push(`${op.name} has no REST binding`);
    if (op.cli) claim(commands, op.cli, "CLI command");
    if (op.mcp) {
      if (!MCP_NAME.test(op.mcp.name)) problems.push(`MCP tool name must be snake_case: ${op.mcp.name}`);
      claim(mcpNames, op.mcp.name, "MCP tool");
    }

    const inputs = new Set(Object.keys(op.input.shape));
    for (const binding of op.rest) {
      claim(routes, `${binding.method} ${binding.path}`, "REST route");
      claim(operationIds, operationIdOf(op, binding), "operationId");
      if (!binding.path.startsWith("/api/")) problems.push(`${op.name} binds a path outside /api/: ${binding.path}`);
      if (binding.body && (binding.method === "GET" || binding.method === "DELETE")) {
        problems.push(`${op.name} reads a body on ${binding.method}`);
      }
      if (binding.raw && binding.body) problems.push(`${op.name} binds both a JSON body and a raw body`);
      if (binding.raw && (binding.method === "GET" || binding.method === "DELETE")) {
        problems.push(`${op.name} reads a raw body on ${binding.method}`);
      }
      if (binding.stream && binding.method !== "GET")
        problems.push(`${op.name} streams a response on ${binding.method}`);
      if ((op.kind === "read") !== (binding.method === "GET")) {
        problems.push(`${op.name} is ${op.kind} but binds ${binding.method}`);
      }
      if (op.async && binding.status !== 202) problems.push(`${op.name} is async but does not return 202`);
      if (!op.async && binding.status === 202) problems.push(`${op.name} returns 202 but is not async`);
      for (const match of binding.path.matchAll(PATH_PARAM)) {
        const param = match[1] ?? "";
        if (!inputs.has(param)) problems.push(`${op.name} has path parameter :${param} that is not an input`);
      }
      for (const key of [...(binding.query ?? []), ...Object.keys(binding.fixed ?? {})]) {
        if (!inputs.has(key)) problems.push(`${op.name} binds ${key}, which is not an input`);
      }
      if (binding.ifMatch && !inputs.has("expectedRevision")) {
        problems.push(`${op.name} requires If-Match but has no expectedRevision input`);
      }
    }
  }
  return problems;
}
