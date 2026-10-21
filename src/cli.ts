import { createInterface } from "node:readline";

const DEFAULT_URL = "http://127.0.0.1:3920";

interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

interface ExecResult {
  execId?: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
  timedOut?: boolean;
  outputRef?: string | null;
  background?: boolean;
  status?: string;
}

const HELP = `minibox — control a MiniBox server

Environment:
  MINIBOX_URL          Server URL (default ${DEFAULT_URL})
  MINIBOX_ACCESS_KEY   Access key. ACCESS_KEY is used when MINIBOX_ACCESS_KEY is unset.
  MINIBOX_TOOLSETS     Toolsets for \`minibox mcp\` (for example core,session)

Commands:
  minibox box ls [--json]              List boxes
  minibox box list [--json]            Same as box ls
  minibox exec <box> [options] -- <argv...>
      --cwd DIR         Working directory (default /workspace)
      --user USER       Container user (default dev; the strict profile allows only dev or 1000)
      --timeout SEC     Stop the process tree after SEC seconds (default 30; at most 55 unless --background)
      --env K=V         Environment variable (repeatable). The value is not logged.
      --stdin TEXT      Write TEXT to stdin, then close it
      --background      Return an exec id without waiting
      --wait MS         With --background, long-poll once for up to MS milliseconds
  minibox session ls <box> [--json]    List the terminal sessions of a box
  minibox session start <box> <name>   Start a session, or return the one that exists
  minibox session read <box> <name> [--lines N] [--since CURSOR] [--json]
                                       Print the screen; the cursor goes to stderr
  minibox session send <box> <name> (--text TEXT | --key KEY ...)
                                       Type text, or press tmux key names in order
  minibox session close <box> <name>   End a session
  minibox mcp [--toolsets LIST]        Proxy stdio JSON-RPC to /mcp

A foreground exec may use --timeout up to 55 seconds. Longer commands use --background with a larger --timeout.
The process exit code is the command's exit code, 124 when the command times out, 1 on an API error, and 2 on usage.
exec can read and write every volume mounted on the box.
A session is a tmux session in the box. A person can take it over in the console, and then session send fails with taken_over; session read still works.
`;

function flagValue(argv: string[], index: number, name: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

async function request(
  env: Record<string, string | undefined>,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown; text: string }> {
  const base = (env.MINIBOX_URL ?? DEFAULT_URL).replace(/\/$/, "");
  const key = env.MINIBOX_ACCESS_KEY ?? env.ACCESS_KEY;
  if (!key) throw new Error("Set MINIBOX_ACCESS_KEY or ACCESS_KEY.");
  const headers: Record<string, string> = {
    authorization: `Bearer ${key}`,
    accept: "application/json",
  };
  let payload: string | undefined;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, json, text };
}

function fail(io: CliIo, status: number, json: unknown, text: string): number {
  const error = (json as { error?: { message?: string; hint?: string } } | null)?.error;
  const message = error?.message ?? (text || `HTTP ${status}`);
  io.stderr(`${message}\n`);
  if (error?.hint) io.stderr(`${error.hint}\n`);
  return 1;
}

function printExec(io: CliIo, result: ExecResult): number {
  if (result.stdout) io.stdout(result.stdout);
  if (result.stderr) io.stderr(result.stderr);
  if (result.truncated && result.outputRef) {
    io.stderr(`output truncated; outputRef ${result.outputRef}\n`);
  }
  if (result.timedOut && result.status === "running") {
    io.stderr(
      `the command timed out and could not be stopped. exec ${result.execId ?? ""} is still running; POST /api/execs/${result.execId ?? ""}/kill retries.\n`,
    );
  }
  if (result.timedOut) return 124;
  if (typeof result.exitCode === "number") return result.exitCode;
  return result.status === "running" ? 0 : 1;
}

async function boxLs(argv: string[], env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  const asJson = argv.includes("--json");
  const res = await request(env, "GET", "/api/boxes?stats=false");
  if (res.status >= 400) return fail(io, res.status, res.json, res.text);
  const boxes = (res.json as { boxes?: Record<string, unknown>[] } | null)?.boxes ?? [];
  if (asJson) {
    io.stdout(`${JSON.stringify(res.json)}\n`);
    return 0;
  }
  io.stdout("NAME  STATE  RUNNING  IMAGE  ID\n");
  for (const box of boxes) {
    const id = String(box.id ?? "");
    io.stdout(
      `${String(box.name ?? "")}  ${String(box.state ?? "")}  ${String(box.running)}  ${String(box.image ?? "")}  ${id.slice(0, 12)}\n`,
    );
  }
  return 0;
}

async function execCommand(argv: string[], env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  const box = argv[0];
  if (!box || box.startsWith("--")) throw new Error("minibox exec needs a box name or id");
  const body: Record<string, unknown> = {};
  const args: string[] = [];
  let background = false;
  let waitMs: number | undefined;
  let dash = false;
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (!dash && token === "--") {
      dash = true;
      continue;
    }
    if (!dash && token.startsWith("--")) {
      if (token === "--background") {
        background = true;
        continue;
      }
      if (token === "--cwd") body.cwd = flagValue(argv, i, token);
      else if (token === "--user") body.user = flagValue(argv, i, token);
      else if (token === "--timeout") body.timeoutSec = Number(flagValue(argv, i, token));
      else if (token === "--stdin") body.stdin = flagValue(argv, i, token);
      else if (token === "--wait") waitMs = Number(flagValue(argv, i, token));
      else if (token === "--env") {
        const pair = flagValue(argv, i, token);
        const eq = pair.indexOf("=");
        if (eq <= 0) throw new Error("--env needs K=V");
        const envMap = (body.env as Record<string, string> | undefined) ?? {};
        envMap[pair.slice(0, eq)] = pair.slice(eq + 1);
        body.env = envMap;
      } else {
        throw new Error(`Unknown option ${token}`);
      }
      i += 1;
      continue;
    }
    args.push(token);
  }
  if (args.length === 0) throw new Error("minibox exec needs a command after --");
  body.argv = args;
  if (background || waitMs !== undefined) body.background = true;
  const started = await request(env, "POST", `/api/boxes/${encodeURIComponent(box)}/exec`, body);
  if (started.status >= 400) return fail(io, started.status, started.json, started.text);
  const result = started.json as ExecResult;
  if (body.background === true && waitMs === undefined) {
    io.stdout(`${result.execId ?? ""}\n`);
    return 0;
  }
  if (waitMs !== undefined && result.execId) {
    const polled = await request(env, "GET", `/api/execs/${encodeURIComponent(result.execId)}?waitMs=${waitMs}`);
    if (polled.status >= 400) return fail(io, polled.status, polled.json, polled.text);
    const follow = polled.json as ExecResult;
    if (follow.status === "running") {
      io.stdout(`${follow.execId ?? result.execId}\n`);
      return 0;
    }
    return printExec(io, follow);
  }
  return printExec(io, result);
}

interface SessionRead {
  lines?: string[];
  cursor?: string;
  reset?: boolean;
  truncated?: boolean;
}

const SESSION_VALUE_FLAGS = ["--lines", "--since", "--text", "--key"];
const SESSION_COMMANDS = ["ls", "start", "read", "send", "close"];

async function sessionCommand(argv: string[], env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || !SESSION_COMMANDS.includes(sub)) {
    throw new Error(`minibox session needs one of ${SESSION_COMMANDS.join(", ")}`);
  }
  const positional: string[] = [];
  const values = new Map<string, string[]>();
  let asJson = false;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] ?? "";
    if (token === "--json") asJson = true;
    else if (SESSION_VALUE_FLAGS.includes(token)) {
      values.set(token, [...(values.get(token) ?? []), flagValue(rest, i, token)]);
      i += 1;
    } else if (token.startsWith("--")) throw new Error(`Unknown option ${token}`);
    else positional.push(token);
  }
  const [box, name] = positional;
  if (!box) throw new Error(`minibox session ${sub} needs a box name or id`);
  const sessions = `/api/boxes/${encodeURIComponent(box)}/sessions`;
  if (sub === "ls") {
    const res = await request(env, "GET", sessions);
    if (res.status >= 400) return fail(io, res.status, res.json, res.text);
    if (asJson) return printJson(io, res.json);
    const listed = (res.json as { sessions?: Record<string, unknown>[] } | null)?.sessions ?? [];
    io.stdout("NAME  ORIGIN  CONTROLLER  ATTACHED  CREATED\n");
    for (const item of listed) {
      io.stdout(
        `${String(item.name)}  ${String(item.origin)}  ${String(item.controller)}  ${String(item.attached)}  ${String(item.createdAt)}\n`,
      );
    }
    return 0;
  }
  if (name === undefined) throw new Error(`minibox session ${sub} needs a session name`);
  const path = `${sessions}/${encodeURIComponent(name)}`;
  if (sub === "start") {
    const res = await request(env, "POST", sessions, { name });
    if (res.status >= 400) return fail(io, res.status, res.json, res.text);
    if (asJson) return printJson(io, res.json);
    io.stdout(`${name}\n`);
    return 0;
  }
  if (sub === "read") {
    const query = new URLSearchParams();
    const lines = values.get("--lines")?.at(-1);
    const since = values.get("--since")?.at(-1);
    if (lines !== undefined) query.set("lines", lines);
    if (since !== undefined) query.set("since", since);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const res = await request(env, "GET", `${path}${suffix}`);
    if (res.status >= 400) return fail(io, res.status, res.json, res.text);
    if (asJson) return printJson(io, res.json);
    const read = res.json as SessionRead;
    const rows = read.lines ?? [];
    if (rows.length > 0) io.stdout(`${rows.join("\n")}\n`);
    io.stderr(`cursor ${read.cursor ?? ""}${read.reset ? " (reset)" : ""}\n`);
    return 0;
  }
  if (sub === "send") {
    const texts = values.get("--text") ?? [];
    const keys = values.get("--key") ?? [];
    if (texts.length > 1 || texts.length > 0 === keys.length > 0) {
      throw new Error("minibox session send needs one --text TEXT, or one or more --key KEY, but not both");
    }
    const body = texts.length === 1 ? { text: texts[0] } : { keys };
    const res = await request(env, "POST", `${path}/input`, body);
    if (res.status >= 400) return fail(io, res.status, res.json, res.text);
    return 0;
  }
  const res = await request(env, "DELETE", path);
  if (res.status >= 400) return fail(io, res.status, res.json, res.text);
  io.stdout(`${name}\n`);
  return 0;
}

function printJson(io: CliIo, json: unknown): number {
  io.stdout(`${JSON.stringify(json)}\n`);
  return 0;
}

async function mcpProxy(
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
    const text = await res.text();
    if (text) io.stdout(text.endsWith("\n") ? text : `${text}\n`);
    if (res.status === 401) return 1;
  }
  return 0;
}

/** Runs one CLI invocation. `bun src/cli.ts` and the compiled binary both call this. */
export async function runCli(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  io: CliIo,
  lines: AsyncIterable<string> = stdinLines(),
): Promise<number> {
  const [command, sub, ...rest] = argv;
  try {
    if (command === undefined || command === "--help" || command === "-h" || command === "help") {
      io.stderr(HELP);
      return 2;
    }
    if (command === "box" && (sub === "ls" || sub === "list")) return await boxLs(rest, env, io);
    if (command === "exec") return await execCommand(sub === undefined ? [] : [sub, ...rest], env, io);
    if (command === "session") return await sessionCommand(sub === undefined ? [] : [sub, ...rest], env, io);
    if (command === "mcp") return await mcpProxy(sub === undefined ? [] : [sub, ...rest], env, io, lines);
    io.stderr(`Unknown command ${command}\n${HELP}`);
    return 2;
  } catch (e) {
    io.stderr(`${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
}

async function* stdinLines(): AsyncGenerator<string> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) yield line;
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2), process.env, {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
  process.exit(code);
}
