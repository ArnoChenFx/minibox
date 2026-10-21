import type { App } from "../app";
import { bearerAllowed } from "../auth";
import { AppError, toAppError } from "../lib/errors";
import { errorResponse, json } from "../lib/http";
import { msg } from "../lib/messages";
import { mcpTools } from "../operations/projections";
import { OPERATIONS } from "../operations/registry";
import { RUN_ID_PATTERN } from "../operations/run";
import type { Toolset } from "../operations/types";
import { OWNER } from "../routes/operations";
import { MCP_INSTRUCTIONS } from "./instructions";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;
const DEFAULT_PROTOCOL: (typeof PROTOCOL_VERSIONS)[number] = "2025-06-18";
const TOOLSETS: readonly Toolset[] = ["core", "session", "network", "storage", "tools", "meta", "rebuild"];

interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function methodNotAllowed(): Response {
  const res = errorResponse(
    new AppError(405, "method_not_allowed", msg("mcp_not_sse"), undefined, { hint: msg("mcp_not_sse_hint") }),
  );
  res.headers.set("allow", "POST, DELETE");
  return res;
}

async function assertBearer(app: App, req: Request, address: string): Promise<void> {
  const allowed = await bearerAllowed(req, { accessKey: app.cfg.accessKey, throttle: app.throttle }, address);
  if (!allowed) {
    throw new AppError(401, "unauthorized", msg("mcp_bearer_required"), undefined, { hint: msg("mcp_bearer_hint") });
  }
}

function acceptsRpc(req: Request): boolean {
  const accept = req.headers.get("accept");
  if (accept === null || accept.trim() === "") return true;
  return accept.split(",").some((part) => {
    const type = part.split(";")[0]?.trim().toLowerCase();
    return type === "application/json" || type === "text/event-stream" || type === "*/*";
  });
}

/** Query `toolsets` wins. An unknown name is refused. An absent parameter leaves the choice to the session. */
function toolsetsOf(url: URL): readonly Toolset[] | undefined {
  if (!url.searchParams.has("toolsets")) return undefined;
  const names = (url.searchParams.get("toolsets") ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (names.length === 0 || names.some((name) => !(TOOLSETS as readonly string[]).includes(name))) {
    throw new AppError(400, "validation_failed", msg("mcp_toolset_invalid"), undefined, {
      hint: msg("mcp_toolset_hint"),
    });
  }
  return names as Toolset[];
}

function protocolOf(value: unknown): (typeof PROTOCOL_VERSIONS)[number] {
  return typeof value === "string" && (PROTOCOL_VERSIONS as readonly string[]).includes(value)
    ? (value as (typeof PROTOCOL_VERSIONS)[number])
    : DEFAULT_PROTOCOL;
}

function rpc(id: unknown, result: unknown, headers: Record<string, string> = {}): Response {
  return json({ jsonrpc: "2.0", id: id ?? null, result }, 200, headers);
}

function rpcError(id: unknown, code: number, message: string, status = 200): Response {
  return json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status);
}

function toolResult(id: unknown, payload: unknown, isError: boolean, headers: Record<string, string>): Response {
  return rpc(
    id,
    {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      ...(isError ? { isError: true } : {}),
    },
    headers,
  );
}

function wireTools(toolsets: readonly Toolset[]) {
  return mcpTools(OPERATIONS, toolsets).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
  }));
}

/**
 * Streamable HTTP MCP at POST /mcp. There is no GET event stream. A bearer access key is required; a session cookie
 * is not accepted. A wrong key counts toward the login limit for `address`. `?toolsets=core,session` selects tools.
 * The default is core and meta.
 */
export async function handleMcp(app: App, req: Request, url: URL, address: string): Promise<Response> {
  if (req.method === "GET" || (req.method !== "POST" && req.method !== "DELETE")) return methodNotAllowed();
  await assertBearer(app, req, address);
  if (req.method === "DELETE") {
    const id = req.headers.get("mcp-session-id");
    if (id) app.mcpSessions.close(id);
    return new Response(null, { status: 204 });
  }
  if (!acceptsRpc(req)) {
    throw new AppError(406, "bad_request", "Accept must include application/json or text/event-stream.");
  }
  const type = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new AppError(415, "unsupported_media_type", msg("unsupported_media_type"));

  const toolsets = toolsetsOf(url);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await req.text());
  } catch {
    return rpcError(null, -32700, "Parse error.", 400);
  }
  if (Array.isArray(parsed)) return rpcError(null, -32600, "Batch requests are not supported.", 400);
  if (typeof parsed !== "object" || parsed === null) return rpcError(null, -32600, "Invalid request.", 400);
  const message = parsed as RpcRequest;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(message.id, -32600, "Invalid request.", 400);
  }

  const sessionId = req.headers.get("mcp-session-id") ?? undefined;
  const session = sessionId ? app.mcpSessions.get(sessionId) : undefined;
  const selected = toolsets ?? session?.toolsets ?? ["core", "meta"];
  const protocol = session?.protocol ?? DEFAULT_PROTOCOL;
  const headers: Record<string, string> = { "mcp-protocol-version": protocol };
  if (sessionId && session) headers["mcp-session-id"] = sessionId;

  if (message.id === undefined) {
    return new Response(null, { status: 202, headers });
  }

  const params =
    typeof message.params === "object" && message.params !== null ? (message.params as Record<string, unknown>) : {};

  if (message.method === "initialize") {
    const version = protocolOf(params.protocolVersion);
    const id = app.mcpSessions.open(selected, version);
    return rpc(
      message.id,
      {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "minibox", version: app.version },
        instructions: MCP_INSTRUCTIONS,
      },
      { "mcp-session-id": id, "mcp-protocol-version": version },
    );
  }
  if (message.method === "ping") return rpc(message.id, {}, headers);
  if (message.method === "tools/list") return rpc(message.id, { tools: wireTools(selected as Toolset[]) }, headers);
  if (message.method === "tools/call")
    return callTool(app, message.id, params, selected as Toolset[], sessionId, headers);
  return rpcError(message.id, -32601, `Method not found: ${message.method}`);
}

async function callTool(
  app: App,
  id: unknown,
  params: Record<string, unknown>,
  toolsets: readonly Toolset[],
  sessionId: string | undefined,
  headers: Record<string, string>,
): Promise<Response> {
  const name = params.name;
  if (typeof name !== "string" || name === "") return rpcError(id, -32602, "Tool name is required.");
  const args = params.arguments === undefined ? {} : params.arguments;
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return rpcError(id, -32602, "Tool arguments must be an object.");
  }
  const operation = OPERATIONS.find((op) => op.mcp?.name === name);
  if (!operation?.mcp) return rpcError(id, -32602, `Unknown tool: ${name}`);
  if (!toolsets.includes(operation.mcp.toolset)) {
    const payload = {
      code: "validation_failed",
      message: `Tool ${name} is in the ${operation.mcp.toolset} toolset, which is not enabled.`,
      hint: msg("mcp_toolset_hint").text,
      retryable: false,
    };
    return toolResult(id, payload, true, headers);
  }
  const run = sessionId && RUN_ID_PATTERN.test(sessionId) ? sessionId : undefined;
  try {
    const result = await app.operations.run(
      operation.name,
      {
        host: app.hosts.get(),
        principal: OWNER,
        source: "mcp",
        run,
        events: app.events,
        execs: app.execs,
        terminals: app.terminals,
      },
      args,
    );
    return toolResult(id, result, false, headers);
  } catch (e) {
    const err = toAppError(e);
    return toolResult(
      id,
      { code: err.code, message: err.message, hint: err.hint ?? null, retryable: err.retryable },
      true,
      headers,
    );
  }
}
