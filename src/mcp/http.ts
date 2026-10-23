import type { App } from "../app";
import { bearerKey, type Caller, callerGate, resolveCaller } from "../auth";
import { AppError, toAppError } from "../lib/errors";
import { errorResponse, JSON_BODY_MAX_BYTES, json, readBodyText } from "../lib/http";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { mcpTools } from "../operations/projections";
import { OPERATIONS } from "../operations/registry";
import { RUN_ID_PATTERN } from "../operations/run";
import { type Operation, OWNER, type Principal, type Toolset } from "../operations/types";
import { scopeAllowed } from "../tokens/model";
import { SELF_SCOPE } from "../tokens/self-policy";
import { MCP_INSTRUCTIONS, SELF_MCP_INSTRUCTIONS } from "./instructions";
import { OWNER_KEY_HEADER, OWNER_KEY_OP, OWNER_KEY_STATUS, type OwnerKeyOutcome } from "./owner-key";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;
const DEFAULT_PROTOCOL: (typeof PROTOCOL_VERSIONS)[number] = "2025-06-18";
const TOOLSETS: readonly Toolset[] = [
  "core",
  "session",
  "network",
  "storage",
  "tools",
  "meta",
  "rebuild",
  "move",
  "self",
];

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

/**
 * The caller of an MCP request. A Bearer header is required: a session cookie never opens MCP, since MCP is driven by
 * clients that hold a credential rather than a browser. A wrong key counts toward the login limit, as on the REST API.
 * The owner access key then has to pass MCP_ALLOW_OWNER_KEY. A correct key never counts toward the limit, so a refusal
 * does not either.
 */
async function callerOf(app: App, req: Request, address: string): Promise<Caller> {
  const caller = bearerKey(req) === null ? null : await resolveCaller(req, callerGate(app), address);
  if (!caller) {
    throw new AppError(401, "unauthorized", msg("mcp_bearer_required"), undefined, { hint: msg("mcp_bearer_hint") });
  }
  if (caller.principal.type === "owner") admitOwnerKey(app, address);
  return caller;
}

const OWNER_KEY_ACCEPTED_HINT =
  "Give each agent an agent token from Settings or minibox token create, then set MCP_ALLOW_OWNER_KEY=false to refuse the owner key on /mcp. The next minor release refuses it by default.";
const OWNER_KEY_REFUSED_HINT =
  "MCP_ALLOW_OWNER_KEY is false, so /mcp refused the owner access key. Give the agent an agent token.";

/** The first warning of each outcome in a process. Stored per app, so a test that builds its own app sees its own warning. */
const warnedOwnerKey = new WeakMap<App, Set<OwnerKeyOutcome>>();

/**
 * Applies MCP_ALLOW_OWNER_KEY to the owner access key. Each use is recorded in the event store, and the first use of
 * each outcome is logged. A refused key gets 401 with a hint toward agent tokens. Agent tokens never reach this check.
 */
function admitOwnerKey(app: App, address: string): void {
  const outcome: OwnerKeyOutcome = app.cfg.mcpAllowOwnerKey ? "accepted" : "refused";
  app.record(app.hosts.get().host.id, "mcp", OWNER, {
    op: OWNER_KEY_OP,
    kind: "read",
    status: OWNER_KEY_STATUS[outcome],
    summary: outcome === "accepted" ? "Owner access key used on /mcp" : "Owner access key refused on /mcp",
    detail: { address },
    error: outcome === "refused" ? { code: "unauthorized", status: 401 } : undefined,
  });
  warnOwnerKeyOnce(app, outcome, address);
  if (outcome === "refused") {
    throw new AppError(401, "unauthorized", msg("mcp_owner_key_refused"), undefined, {
      hint: msg("mcp_owner_key_hint"),
    });
  }
}

function warnOwnerKeyOnce(app: App, outcome: OwnerKeyOutcome, address: string): void {
  const seen = warnedOwnerKey.get(app) ?? new Set<OwnerKeyOutcome>();
  warnedOwnerKey.set(app, seen);
  if (seen.has(outcome)) return;
  seen.add(outcome);
  if (outcome === "accepted") {
    log.warn("mcp.owner_key_used", { address, hint: OWNER_KEY_ACCEPTED_HINT });
  } else {
    log.warn("mcp.owner_key_refused", { address, hint: OWNER_KEY_REFUSED_HINT });
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

/**
 * The tools a principal may see. The owner's are every tool but the self ones, which only a box's own agent may run. A
 * box's agent sees the self tools alone, and a token sees those its scopes reach.
 */
function callableBy(principal: Principal): readonly Operation[] {
  if (principal.type === "owner") return OPERATIONS.filter((operation) => operation.scope !== SELF_SCOPE);
  if (principal.type === "box-self") return OPERATIONS.filter((operation) => operation.scope === SELF_SCOPE);
  return OPERATIONS.filter(
    (operation) => principal.type === "token" && scopeAllowed(principal.grants, operation.scope),
  );
}

/** A box's agent starts with the self toolset. Everyone else gets core and meta. */
function defaultToolsets(principal: Principal): readonly Toolset[] {
  return principal.type === "box-self" ? ["self"] : ["core", "meta"];
}

function wireTools(principal: Principal, toolsets: readonly Toolset[]) {
  return mcpTools(callableBy(principal), toolsets).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
  }));
}

/**
 * Streamable HTTP MCP at POST /mcp. There is no GET event stream. A Bearer credential is required: the access key or an
 * agent token. A session cookie is not accepted. Every tool call runs as the caller's principal, so a token's scopes and
 * grants apply exactly as they do on REST. `?toolsets=core,session` selects tools. The default is core and meta, or the
 * self toolset for a box's own agent.
 */
export async function handleMcp(app: App, req: Request, url: URL, address: string): Promise<Response> {
  if (req.method === "GET" || (req.method !== "POST" && req.method !== "DELETE")) return methodNotAllowed();
  const { principal } = await callerOf(app, req, address);
  const res = await serveMcp(app, req, url, principal);
  if (principal.type === "owner") res.headers.set(OWNER_KEY_HEADER, "accepted");
  return res;
}

async function serveMcp(app: App, req: Request, url: URL, principal: Principal): Promise<Response> {
  if (req.method === "DELETE") {
    const id = req.headers.get("mcp-session-id");
    if (id) app.mcpSessions.close(id, principal);
    return new Response(null, { status: 204 });
  }
  if (!acceptsRpc(req)) {
    throw new AppError(406, "bad_request", "Accept must include application/json or text/event-stream.");
  }
  const type = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new AppError(415, "unsupported_media_type", msg("unsupported_media_type"));

  const toolsets = toolsetsOf(url);
  const text = await readBodyText(req, JSON_BODY_MAX_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
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
  const session = sessionId ? app.mcpSessions.get(sessionId, principal) : undefined;
  const selected = toolsets ?? session?.toolsets ?? defaultToolsets(principal);
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
    const id = app.mcpSessions.open(principal, selected, version);
    return rpc(
      message.id,
      {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "minibox", version: app.version },
        instructions: principal.type === "box-self" ? SELF_MCP_INSTRUCTIONS : MCP_INSTRUCTIONS,
      },
      { "mcp-session-id": id, "mcp-protocol-version": version },
    );
  }
  if (message.method === "ping") return rpc(message.id, {}, headers);
  if (message.method === "tools/list") {
    return rpc(message.id, { tools: wireTools(principal, selected as Toolset[]) }, headers);
  }
  if (message.method === "tools/call") {
    return callTool(app, principal, message.id, params, selected as Toolset[], sessionId, headers);
  }
  return rpcError(message.id, -32601, `Method not found: ${message.method}`);
}

async function callTool(
  app: App,
  principal: Principal,
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
        principal,
        source: "mcp",
        run,
        events: app.events,
        tokens: app.tokens,
        execs: app.execs,
        terminals: app.terminals,
      },
      args,
    );
    return toolResult(id, result, false, headers);
  } catch (e) {
    const err = toAppError(e);
    const payload = {
      code: err.code,
      message: err.message,
      hint: err.hint ?? null,
      retryable: err.retryable,
      ...(err.details === undefined ? {} : { details: err.details }),
    };
    return toolResult(id, payload, true, headers);
  }
}
