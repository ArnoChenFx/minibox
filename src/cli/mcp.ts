import { OWNER_KEY_HEADER } from "../mcp/owner-key";
import { type CliIo, DEFAULT_URL, fail, flagValue } from "./shared";

const OWNER_KEY_WARNING =
  "minibox mcp: this key is the owner access key, and the server accepts it because MCP_ALLOW_OWNER_KEY=true. Create an agent token with minibox token create <name>, and set MINIBOX_ACCESS_KEY to the token it prints.";
const OWNER_KEY_REFUSAL =
  "minibox mcp: the server refuses the owner access key on /mcp, because MCP_ALLOW_OWNER_KEY is false. Create an agent token with minibox token create <name>, and set MINIBOX_ACCESS_KEY to the token it prints.";

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isOwnerKeyRefusal(json: unknown): boolean {
  return (json as { error?: { key?: string } } | null)?.error?.key === "mcp_owner_key_refused";
}

export async function mcpProxy(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
  lines: AsyncIterable<string>,
): Promise<number> {
  let toolsets = env.MINIBOX_TOOLSETS;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--toolsets") {
      toolsets = flagValue(argv, i, token);
      i += 1;
    } else if (token !== undefined) throw new Error(`Unknown option ${token}`);
  }
  const base = (env.MINIBOX_URL ?? DEFAULT_URL).replace(/\/$/, "");
  const key = env.MINIBOX_ACCESS_KEY ?? env.ACCESS_KEY;
  if (!key) throw new Error("Set MINIBOX_ACCESS_KEY or ACCESS_KEY.");
  const url = new URL("/mcp", base);
  if (toolsets) url.searchParams.set("toolsets", toolsets);
  let session: string | undefined;
  let warnedOwnerKey = false;
  for await (const line of lines) {
    if (!line.trim()) continue;
    const headers: Record<string, string> = {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (session) headers["mcp-session-id"] = session;
    const res = await fetch(url, { method: "POST", headers, body: line });
    const next = res.headers.get("mcp-session-id");
    if (next) session = next;
    if (!warnedOwnerKey && res.headers.get(OWNER_KEY_HEADER) === "accepted") {
      warnedOwnerKey = true;
      io.stderr(`${OWNER_KEY_WARNING}\n`);
    }
    const text = await res.text();
    if (text) io.stdout(text.endsWith("\n") ? text : `${text}\n`);
    if (res.status === 401) {
      const body = parsedJson(text);
      if (isOwnerKeyRefusal(body)) io.stderr(`${OWNER_KEY_REFUSAL}\n`);
      return fail(io, res.status, body, text);
    }
  }
  return 0;
}
