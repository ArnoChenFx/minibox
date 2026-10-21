import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const DEFAULT_URL = "http://127.0.0.1:3920";
const SSH_SUFFIX = ".minibox";
const SSH_BLOCK_BEGIN = "# BEGIN minibox ssh-config";
const SSH_BLOCK_END = "# END minibox ssh-config";

interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Raw bytes to stdout. `ssh-proxy` writes SSH, which is binary. */
  stdoutBytes(bytes: Uint8Array): void;
  /** Raw bytes from stdin. `ssh-proxy` reads the SSH client's stream from it. */
  stdinBytes(): AsyncIterable<Uint8Array>;
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
  minibox files ls <volume> [--path DIR] [--depth N] [--limit N] [--json]
  minibox files read <volume> <path> [--encoding utf-8|base64]
  minibox files write <volume> <path> (--content TEXT | --stdin) [--encoding utf-8|base64]
  minibox files cp <volume> <from> <to>
  minibox files download <volume> [path]   Print a base64 tar of the path
  minibox files upload <volume> [path]     Read a base64 tar from stdin and extract
  minibox mcp [--toolsets LIST]        Proxy stdio JSON-RPC to /mcp
  minibox ssh-config [--append]        Print the ~/.ssh/config block and host key pin; --append writes both
  minibox ssh-proxy <box>              Carry one SSH connection over stdio (the ProxyCommand from ssh-config)

A foreground exec may use --timeout up to 55 seconds. Longer commands use --background with a larger --timeout.
The process exit code is the command's exit code, 124 when the command times out, 1 on an API error, and 2 on usage.
exec can read and write every volume mounted on the box.
File commands work on volumes (including when no box is running) via a helper container and the Docker archive API.
files:* scopes only matter for a token that does not have exec.
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

/** Where `ssh-config --append` saves the server and key, so `ssh-proxy` works from any shell, IDE or launcher. */
function credentialsPath(env: Record<string, string | undefined>): string {
  return join(env.HOME ?? homedir(), ".config", "minibox", "ssh-credentials.json");
}

/**
 * The environment `ssh-proxy` runs with. ssh starts it from whatever launched ssh, often an IDE that never saw the
 * shell's exports, so when no key is set it reads the server and key `ssh-config --append` saved (mode 600).
 */
async function proxyEnv(env: Record<string, string | undefined>): Promise<Record<string, string | undefined>> {
  if (env.MINIBOX_ACCESS_KEY ?? env.ACCESS_KEY) return env;
  const text = await readFile(credentialsPath(env), "utf8").catch(() => null);
  if (text === null) return env;
  let saved: { url?: unknown; key?: unknown };
  try {
    saved = JSON.parse(text) as { url?: unknown; key?: unknown };
  } catch {
    throw new Error(`${credentialsPath(env)} is not valid JSON. Run minibox ssh-config --append again.`);
  }
  if (typeof saved.key !== "string" || !saved.key) return env;
  return {
    ...env,
    MINIBOX_ACCESS_KEY: saved.key,
    MINIBOX_URL: env.MINIBOX_URL ?? (typeof saved.url === "string" ? saved.url : undefined),
  };
}

async function saveCredentials(env: Record<string, string | undefined>): Promise<void> {
  const path = credentialsPath(env);
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  const url = (env.MINIBOX_URL ?? DEFAULT_URL).replace(/\/$/, "");
  await writeFile(path, `${JSON.stringify({ url, key: accessKey(env) })}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function accessKey(env: Record<string, string | undefined>): string {
  const key = env.MINIBOX_ACCESS_KEY ?? env.ACCESS_KEY;
  if (!key) throw new Error("Set MINIBOX_ACCESS_KEY or ACCESS_KEY.");
  return key;
}

/**
 * The block `ssh-config` manages. It goes first in ~/.ssh/config, so its settings win over any earlier `Host *`. The pin
 * path is absolute: ssh expands `~` from the account's passwd entry, which is not always $HOME, and the pin must be
 * where the CLI wrote it.
 */
function sshConfigBlock(pinPath: string): string {
  return [
    SSH_BLOCK_BEGIN,
    `Host *${SSH_SUFFIX}`,
    "  User dev",
    "  ProxyCommand minibox ssh-proxy %h",
    `  UserKnownHostsFile "${pinPath.replaceAll("%", "%%")}"`,
    "  StrictHostKeyChecking yes",
    "  ServerAliveInterval 15",
    SSH_BLOCK_END,
    "",
  ].join("\n");
}

function withoutManagedBlock(text: string): string {
  const begin = text.indexOf(SSH_BLOCK_BEGIN);
  if (begin === -1) return text;
  const endMarker = text.indexOf(SSH_BLOCK_END, begin);
  if (endMarker === -1)
    throw new Error(`~/.ssh/config has "${SSH_BLOCK_BEGIN}" without its end marker. Fix it by hand.`);
  const lineEnd = text.indexOf("\n", endMarker);
  return text.slice(0, begin) + (lineEnd === -1 ? "" : text.slice(lineEnd + 1));
}

async function sshConfig(argv: string[], env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  const unknown = argv.find((token) => token !== "--append");
  if (unknown !== undefined) throw new Error(`Unknown option ${unknown}`);
  const res = await request(env, "GET", "/api/ssh/host-key");
  if (res.status >= 400) {
    fail(io, res.status, res.json, res.text);
    if (res.status === 403) io.stderr("A token needs the box:ssh scope to set up SSH.\n");
    return 1;
  }
  const published = res.json as { publicKey?: unknown; fingerprint?: unknown } | null;
  if (typeof published?.publicKey !== "string" || typeof published.fingerprint !== "string") {
    throw new Error("The server did not publish an SSH host key.");
  }
  const pin = `*${SSH_SUFFIX} ${published.publicKey}\n`;
  const sshDir = join(env.HOME ?? homedir(), ".ssh");
  const configPath = join(sshDir, "config");
  const pinPath = join(sshDir, "minibox_known_hosts");
  if (!argv.includes("--append")) {
    io.stdout(`# ~/.ssh/config\n${sshConfigBlock(pinPath)}\n# ~/.ssh/minibox_known_hosts\n${pin}`);
    return 0;
  }
  await mkdir(sshDir, { recursive: true, mode: 0o700 });
  const existing = await readFile(configPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const kept = withoutManagedBlock(existing).replace(/^\n+/, "");
  const block = sshConfigBlock(pinPath);
  await writeFile(configPath, kept ? `${block}\n${kept}` : block, { mode: 0o600 });
  await writeFile(pinPath, pin, { mode: 0o600 });
  await saveCredentials(env);
  io.stdout(
    `Wrote ~/.ssh/config, ~/.ssh/minibox_known_hosts and ~/.config/minibox/ssh-credentials.json (mode 600). Pinned ${published.fingerprint} for *${SSH_SUFFIX}.\n`,
  );
  return 0;
}

/** Feeds the SSH client's bytes into the WebSocket, and closes it when the client has nothing more to send. */
async function forwardStdin(input: AsyncIterable<Uint8Array>, ws: WebSocket): Promise<void> {
  for await (const chunk of input) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(chunk);
  }
  if (ws.readyState === WebSocket.OPEN) ws.close(1000, "ssh finished");
}

/**
 * Carries one SSH connection over stdio, so `ssh` can reach a box through this server. The server's checks run first,
 * so a refusal prints its reason. A WebSocket reports only that the upgrade failed, not the status it got.
 */
async function sshProxy(argv: string[], env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  const [host, ...extra] = argv;
  if (!host || host.startsWith("--") || extra.length > 0) throw new Error("minibox ssh-proxy needs one box name");
  const name = host.endsWith(SSH_SUFFIX) ? host.slice(0, -SSH_SUFFIX.length) : host;
  if (!name) throw new Error("minibox ssh-proxy needs one box name");
  const path = `/api/ssh/${encodeURIComponent(name)}`;
  const probe = await request(env, "GET", path);
  if (probe.status >= 400) return fail(io, probe.status, probe.json, probe.text);
  const base = (env.MINIBOX_URL ?? DEFAULT_URL).replace(/\/$/, "");
  const ws = new WebSocket(`${base}${path}`.replace(/^http/, "ws"), {
    headers: { authorization: `Bearer ${accessKey(env)}` },
  });
  ws.binaryType = "arraybuffer";
  const opened = await new Promise<boolean>((resolve) => {
    ws.addEventListener("open", () => resolve(true), { once: true });
    ws.addEventListener("close", () => resolve(false), { once: true });
  });
  if (!opened) {
    io.stderr(
      `minibox: the SSH connection to ${name} could not be opened. Run minibox ssh-config to check the setup.\n`,
    );
    return 1;
  }
  const ended = new Promise<number>((resolve) => {
    ws.addEventListener("message", (event) => io.stdoutBytes(new Uint8Array(event.data as ArrayBuffer)));
    ws.addEventListener("close", (event) => {
      if (event.code !== 1000 && event.reason) io.stderr(`minibox: ${event.reason}\n`);
      resolve(event.code === 1000 ? 0 : 1);
    });
  });
  void forwardStdin(io.stdinBytes(), ws).catch(() => ws.close(1011, "stdin failed"));
  return ended;
}

async function filesCommand(argv: string[], env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub.startsWith("--")) throw new Error("minibox files needs ls, read, write, cp, download or upload");
  if (sub === "ls") {
    const volume = rest[0];
    if (!volume || volume.startsWith("--")) throw new Error("minibox files ls needs a volume");
    let path: string | undefined;
    let depth: string | undefined;
    let limit: string | undefined;
    let asJson = false;
    for (let i = 1; i < rest.length; i++) {
      const token = rest[i];
      if (token === undefined) break;
      if (token === "--json") asJson = true;
      else if (token === "--path") path = flagValue(rest, i++, "--path");
      else if (token === "--depth") depth = flagValue(rest, i++, "--depth");
      else if (token === "--limit") limit = flagValue(rest, i++, "--limit");
      else throw new Error(`Unknown option ${token}`);
    }
    const query = new URLSearchParams();
    if (path) query.set("path", path);
    if (depth) query.set("maxDepth", depth);
    if (limit) query.set("limit", limit);
    const q = query.toString();
    const res = await request(env, "GET", `/api/volumes/${encodeURIComponent(volume)}/files${q ? `?${q}` : ""}`);
    if (res.status >= 400) return fail(io, res.status, res.json, res.text);
    if (asJson) {
      io.stdout(`${JSON.stringify(res.json)}\n`);
      return 0;
    }
    const body = res.json as { entries?: { path: string; type: string; size: number | null }[] };
    for (const entry of body.entries ?? []) {
      const size = entry.size === null ? "-" : String(entry.size);
      io.stdout(`${entry.type}\t${size}\t${entry.path}\n`);
    }
    return 0;
  }
  if (sub === "read") {
    const volume = rest[0];
    const filePath = rest[1];
    if (!volume || !filePath) throw new Error("minibox files read needs a volume and a path");
    let encoding = "utf-8";
    for (let i = 2; i < rest.length; i++) {
      const token = rest[i];
      if (token === undefined) break;
      if (token === "--encoding") encoding = flagValue(rest, i++, "--encoding");
      else throw new Error(`Unknown option ${token}`);
    }
    const query = new URLSearchParams({ path: filePath, encoding });
    const res = await request(env, "GET", `/api/volumes/${encodeURIComponent(volume)}/files/content?${query}`);
    if (res.status >= 400) return fail(io, res.status, res.json, res.text);
    const body = res.json as { content?: string };
    io.stdout(body.content ?? "");
    if (encoding === "utf-8" && body.content && !body.content.endsWith("\n")) io.stdout("\n");
    return 0;
  }
  if (sub === "write") {
    const volume = rest[0];
    const filePath = rest[1];
    if (!volume || !filePath) throw new Error("minibox files write needs a volume and a path");
    let encoding = "utf-8";
    let content: string | undefined;
    let fromStdin = false;
    for (let i = 2; i < rest.length; i++) {
      const token = rest[i];
      if (token === undefined) break;
      if (token === "--encoding") encoding = flagValue(rest, i++, "--encoding");
      else if (token === "--content") content = flagValue(rest, i++, "--content");
      else if (token === "--stdin") fromStdin = true;
      else throw new Error(`Unknown option ${token}`);
    }
    if (fromStdin === (content !== undefined)) {
      throw new Error("minibox files write needs exactly one of --content or --stdin");
    }
    if (fromStdin) {
      const chunks: Buffer[] = [];
      for await (const chunk of Bun.stdin.stream()) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      content = encoding === "base64" ? raw.toString("base64") : raw.toString("utf8");
    }
    const res = await request(env, "PUT", `/api/volumes/${encodeURIComponent(volume)}/files/content`, {
      path: filePath,
      content,
      encoding,
    });
    if (res.status >= 400) return fail(io, res.status, res.json, res.text);
    const body = res.json as { bytesWritten?: number };
    io.stdout(`${body.bytesWritten ?? 0}\n`);
    return 0;
  }
  if (sub === "cp") {
    const volume = rest[0];
    const from = rest[1];
    const to = rest[2];
    if (!volume || !from || !to) throw new Error("minibox files cp needs a volume, from and to");
    const res = await request(env, "POST", `/api/volumes/${encodeURIComponent(volume)}/files/copy`, { from, to });
    if (res.status >= 400) return fail(io, res.status, res.json, res.text);
    io.stdout(`${from} -> ${to}\n`);
    return 0;
  }
  if (sub === "download") {
    const volume = rest[0];
    if (!volume) throw new Error("minibox files download needs a volume");
    const filePath = rest[1] && !rest[1].startsWith("--") ? rest[1] : "/";
    const query = new URLSearchParams();
    if (filePath) query.set("path", filePath);
    const res = await request(env, "GET", `/api/volumes/${encodeURIComponent(volume)}/files/archive?${query}`);
    if (res.status >= 400) return fail(io, res.status, res.json, res.text);
    const body = res.json as { content?: string };
    io.stdout(`${body.content ?? ""}\n`);
    return 0;
  }
  if (sub === "upload") {
    const volume = rest[0];
    if (!volume) throw new Error("minibox files upload needs a volume");
    const filePath = rest[1] && !rest[1].startsWith("--") ? rest[1] : "/";
    const chunks: Buffer[] = [];
    for await (const chunk of Bun.stdin.stream()) chunks.push(Buffer.from(chunk));
    const content = Buffer.concat(chunks).toString("utf8").trim();
    const res = await request(env, "PUT", `/api/volumes/${encodeURIComponent(volume)}/files/archive`, {
      path: filePath,
      content,
      encoding: "base64",
    });
    if (res.status >= 400) return fail(io, res.status, res.json, res.text);
    const body = res.json as { bytes?: number };
    io.stdout(`${body.bytes ?? 0}\n`);
    return 0;
  }
  throw new Error(`Unknown files subcommand ${sub}`);
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
    if (command === "files") return await filesCommand(sub === undefined ? [] : [sub, ...rest], env, io);
    if (command === "mcp") return await mcpProxy(sub === undefined ? [] : [sub, ...rest], env, io, lines);
    if (command === "ssh-config") return await sshConfig(sub === undefined ? [] : [sub, ...rest], env, io);
    if (command === "ssh-proxy")
      return await sshProxy(sub === undefined ? [] : [sub, ...rest], await proxyEnv(env), io);
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
    stdoutBytes: (bytes) => process.stdout.write(bytes),
    stdinBytes: () => process.stdin,
  });
  // Pipe writes can finish after exit, and the last SSH bytes must reach ssh before the process ends.
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  process.exit(code);
}
