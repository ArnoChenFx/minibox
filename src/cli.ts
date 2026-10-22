import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, posix, resolve, win32 } from "node:path";
import { createInterface } from "node:readline";

const DEFAULT_URL = "http://127.0.0.1:3920";
const SSH_SUFFIX = ".minibox";
const SSH_BLOCK_BEGIN = "# BEGIN minibox ssh-config";
const SSH_BLOCK_END = "# END minibox ssh-config";
/** The server version the binary was compiled from. `bun build --env` inlines it; a run from source reports `dev`. */
const BUILT_VERSION = process.env.MINIBOX_CLI_BUILD_VERSION?.trim() || "dev";
/** Set by `bun build --compile`, so process.execPath is this CLI. From source it is the bun runtime. */
const COMPILED = process.env.MINIBOX_CLI_BUILD_COMPILED === "1";
const VERSION_SHAPE = /^(\d+)\.(\d+)\.(\d+)(?:-(\d+)-g[0-9a-f]+)?(?:-dirty)?$/;

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
  minibox cp <from>... <to> [--overwrite]  Copy between this machine and a box: box:/path names a path in the box
  minibox upload <local>... <box>:<path> [--overwrite]
                                       Upload files or folders into a box. Several sources, or a path ending in /, take
                                       the file names into that folder. A folder is uploaded with its tree.
  minibox download <box>:<path> [local] [--overwrite]
                                       Download a file, or a folder as <name>.tar.gz, into local (default: this folder)
  minibox tool custom list [--json]    List the custom tool entries in DATA_DIR/tools.d (owner only)
  minibox tool custom put <id> (--file FILE | --stdin) [--override-builtin] [--json]
                                       Save an entry from a JSON document (owner only)
  minibox tool custom delete <id> [--json]
                                       Remove an entry from tools.d; nothing is uninstalled
  minibox mcp [--toolsets LIST]        Proxy stdio JSON-RPC to /mcp
  minibox ssh-config [--append] [--url URL] [--token KEY]
                                       Print the ~/.ssh/config block and host key pin. --append writes both and saves
                                       the server and key for ssh-proxy. --token leaves the key in shell history.
  minibox ssh-proxy <box>              Carry one SSH connection over stdio (the ProxyCommand from ssh-config)
  minibox --version                    Print the MiniBox version this CLI was built from

Every command takes --help. Install this CLI from the server: curl -fsSL <MINIBOX_URL>/cli/install.sh | sh
On Windows, in PowerShell: irm <MINIBOX_URL>/cli/install.ps1 | iex
A foreground exec may use --timeout up to 55 seconds. Longer commands use --background with a larger --timeout.
The process exit code is the command's exit code, 124 when the command times out, 1 on an API error, and 2 on usage.
exec can read and write every volume mounted on the box.
File commands work on volumes (including when no box is running) via a helper container and the Docker archive API.
cp, upload and download reach a box's volumes the same way, so they work while the box is stopped. Symbolic links in an
uploaded folder are skipped, and an existing file is kept unless --overwrite is given.
files:* scopes only matter for a token that does not have exec.
A session is a tmux session in the box. A person can take it over in the console, and then session send fails with taken_over; session read still works.
`;

function flagValue(argv: string[], index: number, name: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

function serverOf(env: Record<string, string | undefined>): { base: string; headers: Record<string, string> } {
  const base = (env.MINIBOX_URL ?? DEFAULT_URL).replace(/\/$/, "");
  const key = env.MINIBOX_ACCESS_KEY ?? env.ACCESS_KEY;
  if (!key) throw new Error("Set MINIBOX_ACCESS_KEY or ACCESS_KEY.");
  return { base, headers: { authorization: `Bearer ${key}`, accept: "application/json" } };
}

async function request(
  env: Record<string, string | undefined>,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown; text: string; headers: Headers }> {
  const { base, headers } = serverOf(env);
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
  return { status: res.status, json, text, headers: res.headers };
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

export type Env = Record<string, string | undefined>;

/** What the SSH setup depends on about this machine. Tests pass another one to cover Windows on any OS. */
export interface SshHost {
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  /** The running executable: the CLI itself when compiled, the bun runtime when run from source. */
  readonly execPath: string;
  readonly compiled: boolean;
}

export interface SshLayout {
  readonly sshDir: string;
  readonly configPath: string;
  readonly pinPath: string;
  readonly credentialsDir: string;
  readonly credentialsPath: string;
}

function currentSshHost(): SshHost {
  return { platform: process.platform, homedir: homedir(), execPath: process.execPath, compiled: COMPILED };
}

function pathsOf(host: SshHost) {
  return host.platform === "win32" ? win32 : posix;
}

/**
 * The folder that holds `.ssh` and `.config`. Windows programs, OpenSSH included, use the profile folder, and MSYS sets
 * HOME to a POSIX path such as /c/Users/me that they cannot open, so HOME is read only on other platforms.
 */
function homeFolder(env: Env, host: SshHost): string {
  return host.platform === "win32" ? env.USERPROFILE || host.homedir : env.HOME || host.homedir;
}

/**
 * Where `ssh-config` reads and writes. `credentialsPath` holds the server and key that `ssh-config --append` saves, so
 * `ssh-proxy` works from any shell, IDE or launcher.
 */
export function sshLayout(env: Env, host: SshHost): SshLayout {
  const path = pathsOf(host);
  const home = homeFolder(env, host);
  const sshDir = path.join(home, ".ssh");
  const credentialsDir = path.join(home, ".config", "minibox");
  return {
    sshDir,
    configPath: path.join(sshDir, "config"),
    pinPath: path.join(sshDir, "minibox_known_hosts"),
    credentialsDir,
    credentialsPath: path.join(credentialsDir, "ssh-credentials.json"),
  };
}

function assertQuoteFree(path: string): void {
  if (path.includes('"')) throw new Error(`${path} contains a double quote, which an SSH config line cannot hold`);
}

/**
 * A quoted `UserKnownHostsFile` value. ssh expands `%` tokens in it, so a literal `%` is written `%%`. Windows
 * separators become `/`, which ssh reads without treating `\` as an escape.
 */
function configValuePath(path: string, platform: NodeJS.Platform): string {
  assertQuoteFree(path);
  const slashed = platform === "win32" ? path.replaceAll("\\", "/") : path;
  return `"${slashed.replaceAll("%", "%%")}"`;
}

/**
 * The quoted program of a ProxyCommand. OpenSSH on POSIX gives the line to a shell, and Windows OpenSSH starts it with
 * CreateProcess, so the quoting rules differ.
 */
function proxyProgram(path: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return configValuePath(path, platform);
  assertQuoteFree(path);
  return `"${path.replace(/[\\$`]/g, "\\$&").replaceAll("%", "%%")}"`;
}

/**
 * The environment `ssh-proxy` runs with. ssh starts it from whatever launched ssh, often an IDE that never saw the
 * shell's exports, so when no key is set it reads the server and key `ssh-config --append` saved.
 */
async function proxyEnv(env: Env): Promise<Env> {
  if (env.MINIBOX_ACCESS_KEY ?? env.ACCESS_KEY) return env;
  const { credentialsPath } = sshLayout(env, currentSshHost());
  const text = await readFile(credentialsPath, "utf8").catch(() => null);
  if (text === null) return env;
  let saved: { url?: unknown; key?: unknown };
  try {
    saved = JSON.parse(text) as { url?: unknown; key?: unknown };
  } catch {
    throw new Error(`${credentialsPath} is not valid JSON. Run minibox ssh-config --append again.`);
  }
  if (typeof saved.key !== "string" || !saved.key) return env;
  return {
    ...env,
    MINIBOX_ACCESS_KEY: saved.key,
    MINIBOX_URL: env.MINIBOX_URL ?? (typeof saved.url === "string" ? saved.url : undefined),
  };
}

async function saveCredentials(env: Env, layout: SshLayout): Promise<void> {
  await mkdir(layout.credentialsDir, { recursive: true, mode: 0o700 });
  const url = (env.MINIBOX_URL ?? DEFAULT_URL).replace(/\/$/, "");
  await writeFile(layout.credentialsPath, `${JSON.stringify({ url, key: accessKey(env) })}\n`, { mode: 0o600 });
  await chmod(layout.credentialsPath, 0o600);
}

function accessKey(env: Env): string {
  const key = env.MINIBOX_ACCESS_KEY ?? env.ACCESS_KEY;
  if (!key) throw new Error("Set MINIBOX_ACCESS_KEY or ACCESS_KEY.");
  return key;
}

/**
 * The block `ssh-config` manages. It goes first in ~/.ssh/config, so its settings win over any earlier `Host *`. The pin
 * path is absolute: ssh expands `~` from the account's passwd entry, which is not always $HOME, and the pin must be
 * where the CLI wrote it. A compiled CLI is named by its absolute path, since an IDE that starts ssh may not have the
 * install folder on its PATH.
 */
export function sshConfigBlock(env: Env, host: SshHost): string {
  const layout = sshLayout(env, host);
  const program = host.compiled ? proxyProgram(host.execPath, host.platform) : "minibox";
  return [
    SSH_BLOCK_BEGIN,
    `Host *${SSH_SUFFIX}`,
    "  User dev",
    `  ProxyCommand ${program} ssh-proxy %h`,
    `  UserKnownHostsFile ${configValuePath(layout.pinPath, host.platform)}`,
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

interface SshConfigOptions {
  readonly append: boolean;
  readonly url?: string;
  readonly token?: string;
}

function sshConfigOptions(argv: string[]): SshConfigOptions {
  const options: { append: boolean; url?: string; token?: string } = { append: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (token === "--append") options.append = true;
    else if (token === "--url") options.url = serverUrl(flagValue(argv, i++, token));
    else if (token === "--token") options.token = flagValue(argv, i++, token);
    else throw new Error(`Unknown option ${token}`);
  }
  return options;
}

function serverUrl(value: string): string {
  if (!/^https?:\/\/[^/\s]+/.test(value)) throw new Error(`--url needs an http:// or https:// address, not ${value}`);
  return value.replace(/\/$/, "");
}

async function sshConfig(argv: string[], env: Env, io: CliIo): Promise<number> {
  const options = sshConfigOptions(argv);
  const scoped: Env = { ...env };
  if (options.url !== undefined) scoped.MINIBOX_URL = options.url;
  if (options.token !== undefined) scoped.MINIBOX_ACCESS_KEY = options.token;
  const host = currentSshHost();
  const layout = sshLayout(scoped, host);
  const res = await request(scoped, "GET", "/api/ssh/host-key");
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
  const block = sshConfigBlock(scoped, host);
  if (!options.append) {
    io.stdout(`# ${layout.configPath}\n${block}\n# ${layout.pinPath}\n${pin}`);
    return 0;
  }
  await mkdir(layout.sshDir, { recursive: true, mode: 0o700 });
  const existing = await readFile(layout.configPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const kept = withoutManagedBlock(existing).replace(/^\n+/, "");
  await writeFile(layout.configPath, kept ? `${block}\n${kept}` : block, { mode: 0o600 });
  await writeFile(layout.pinPath, pin, { mode: 0o600 });
  await saveCredentials(scoped, layout);
  const mode = host.platform === "win32" ? "" : " (mode 600)";
  io.stdout(
    `Wrote ${layout.configPath}, ${layout.pinPath} and ${layout.credentialsPath}${mode}. Pinned ${published.fingerprint} for *${SSH_SUFFIX}.\n`,
  );
  if (host.platform === "win32") {
    io.stdout(
      "Windows OpenSSH checks who owns these files, so run ssh-config from a normal PowerShell window, not an administrator one.\n",
    );
  }
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

/** Whether `candidate` is a later build than `current`, both as `git describe` writes them, such as 0.3.0 or 0.3.0-62-gef442f5. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const left = parseVersion(candidate);
  const right = parseVersion(current);
  if (left === null || right === null) return false;
  for (let i = 0; i < 4; i += 1) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

function parseVersion(text: string): number[] | null {
  const match = VERSION_SHAPE.exec(text.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 0)];
}

/**
 * Carries one SSH connection over stdio, so `ssh` can reach a box through this server. The server's checks run first,
 * so a refusal prints its reason. A WebSocket reports only that the upgrade failed, not the status it got.
 */
async function sshProxy(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
  version: string,
): Promise<number> {
  const [host, ...extra] = argv;
  if (!host || host.startsWith("--") || extra.length > 0) throw new Error("minibox ssh-proxy needs one box name");
  const name = host.endsWith(SSH_SUFFIX) ? host.slice(0, -SSH_SUFFIX.length) : host;
  if (!name) throw new Error("minibox ssh-proxy needs one box name");
  const path = `/api/ssh/${encodeURIComponent(name)}`;
  const probe = await request(env, "GET", path);
  if (probe.status >= 400) return fail(io, probe.status, probe.json, probe.text);
  const base = (env.MINIBOX_URL ?? DEFAULT_URL).replace(/\/$/, "");
  const served = probe.headers.get("x-minibox-version");
  if (served && isNewerVersion(served, version)) {
    io.stderr(
      `minibox: ${base} runs MiniBox ${served}, newer than this CLI (${version}). Update it with: curl -fsSL ${base}/cli/install.sh | sh\n`,
    );
  }
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

/** A `box:/path` argument names a path inside a box. Any other argument is a path on this machine. */
const BOX_PATH = /^([^/\\:]+):(\/.*)$/;

interface BoxPath {
  box: string;
  path: string;
}

/** The volume behind a path in a box, and the path inside that volume. */
interface VolumePath {
  volume: string;
  path: string;
}

/** An answer the server refused. The command prints its message and exits 1, as the other commands do. */
class ApiRefusal extends Error {
  constructor(
    readonly status: number,
    readonly json: unknown,
    readonly text: string,
  ) {
    super(`HTTP ${status}`);
  }
}

/** A transfer that cannot finish for a reason the caller can act on, such as a file already in the way. Exit 1. */
class CommandFailure extends Error {}

function boxPathOf(arg: string): BoxPath | null {
  const match = BOX_PATH.exec(arg);
  return match ? { box: match[1] ?? "", path: match[2] ?? "/" } : null;
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/**
 * Finds the volume that backs a path in a box: the mount that holds the path most deeply. A file goes through the
 * file API by volume, so it works while the box is stopped.
 */
async function volumePathOf(env: Record<string, string | undefined>, ref: BoxPath): Promise<VolumePath> {
  const res = await request(env, "GET", `/api/boxes/${encodeURIComponent(ref.box)}`);
  if (res.status >= 400) throw new ApiRefusal(res.status, res.json, res.text);
  const mounts = (res.json as { box?: { mounts?: { path: string; volumeId: string | null }[] } } | null)?.box?.mounts;
  const abs = posix.normalize(ref.path).replace(/(.)\/+$/, "$1");
  let best: { root: string; volume: string } | null = null;
  for (const mount of mounts ?? []) {
    if (!mount.volumeId) continue;
    const root = posix.normalize(mount.path).replace(/(.)\/+$/, "$1");
    const holds = abs === root || abs.startsWith(root === "/" ? "/" : `${root}/`);
    if (holds && (best === null || root.length > best.root.length)) best = { root, volume: mount.volumeId };
  }
  if (best === null) throw new CommandFailure(`${ref.box} has no mounted volume at ${abs}`);
  const inside = abs.slice(best.root.length).replace(/^\/+/, "");
  return { volume: best.volume, path: inside === "" ? "/" : inside };
}

function childOf(dir: string, name: string): string {
  return dir === "/" ? name : `${dir}/${name}`;
}

/** The same join for the `box:/path` text a transfer prints. */
function childLabel(label: string, name: string): string {
  return label.endsWith("/") ? `${label}${name}` : `${label}/${name}`;
}

/** True when the path is a folder in its volume. A path that does not exist is not one. */
async function isRemoteFolder(env: Record<string, string | undefined>, target: VolumePath): Promise<boolean> {
  const query = new URLSearchParams({ path: target.path, maxDepth: "0", limit: "1" });
  const res = await request(env, "GET", `/api/volumes/${encodeURIComponent(target.volume)}/files?${query}`);
  if (res.status === 404) return false;
  if (res.status >= 400) throw new ApiRefusal(res.status, res.json, res.text);
  const entries = (res.json as { entries?: { type: string }[] } | null)?.entries ?? [];
  return entries[0]?.type === "dir";
}

async function makeRemoteDir(env: Record<string, string | undefined>, target: VolumePath): Promise<void> {
  const res = await request(env, "POST", `/api/volumes/${encodeURIComponent(target.volume)}/files/directory`, {
    path: target.path,
  });
  if (res.status >= 400) throw new ApiRefusal(res.status, res.json, res.text);
}

async function uploadFile(
  env: Record<string, string | undefined>,
  io: CliIo,
  local: string,
  size: number,
  target: VolumePath,
  label: string,
  overwrite: boolean,
): Promise<void> {
  const { base, headers } = serverOf(env);
  const query = new URLSearchParams({ path: target.path, overwrite: String(overwrite) });
  const res = await fetch(`${base}/api/volumes/${encodeURIComponent(target.volume)}/files/stream?${query}`, {
    method: "PUT",
    // The server takes the length from Content-Length and streams the body, so it is sent from the file as it is read.
    headers: { ...headers, "content-type": "application/octet-stream", "content-length": String(size) },
    body: Bun.file(local),
  });
  const text = await res.text();
  if (!res.ok) throw new ApiRefusal(res.status, parseJson(text), text);
  io.stdout(`${local} -> ${label}\n`);
}

/** Uploads a file, or a folder with its tree. Symbolic links are skipped, not followed, so nothing outside the folder is sent. */
async function uploadTree(
  env: Record<string, string | undefined>,
  io: CliIo,
  local: string,
  target: VolumePath,
  label: string,
  overwrite: boolean,
): Promise<void> {
  const info = await lstat(local);
  if (info.isSymbolicLink()) {
    io.stderr(`skipped ${local}: a symbolic link is not followed\n`);
    return;
  }
  if (info.isDirectory()) {
    await makeRemoteDir(env, target);
    for (const name of (await readdir(local)).toSorted()) {
      const child = { volume: target.volume, path: childOf(target.path, name) };
      await uploadTree(env, io, join(local, name), child, childLabel(label, name), overwrite);
    }
    return;
  }
  if (!info.isFile()) {
    io.stderr(`skipped ${local}: not a file or a folder\n`);
    return;
  }
  await uploadFile(env, io, local, info.size, target, label, overwrite);
}

/** The file name the server gives a download, from its Content-Disposition, reduced to its last segment. */
function downloadNameOf(header: string | null): string {
  let name: string | null = null;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header ?? "");
  const plain = /filename="([^"]*)"/i.exec(header ?? "");
  try {
    name = encoded?.[1] ? decodeURIComponent(encoded[1]) : (plain?.[1] ?? null);
  } catch {
    name = null;
  }
  const last = posix.basename((name ?? "").replace(/\\/g, "/"));
  return last === "" || last === "." || last === ".." ? "download" : last;
}

async function downloadTo(
  env: Record<string, string | undefined>,
  io: CliIo,
  remote: BoxPath,
  local: string | null,
  overwrite: boolean,
): Promise<void> {
  const target = await volumePathOf(env, remote);
  const { base, headers } = serverOf(env);
  const query = new URLSearchParams({ path: target.path });
  const res = await fetch(`${base}/api/volumes/${encodeURIComponent(target.volume)}/files/stream?${query}`, {
    headers: { ...headers, accept: "*/*" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiRefusal(res.status, parseJson(text), text);
  }
  const name = downloadNameOf(res.headers.get("content-disposition"));
  const given = local ?? ".";
  const directory = /[\\/]$/.test(given) || (await stat(given).catch(() => null))?.isDirectory() === true;
  if (directory) await mkdir(given, { recursive: true });
  const dest = directory ? join(given, name) : resolve(given);
  if (!overwrite && (await stat(dest).catch(() => null)) !== null) {
    await res.body?.cancel();
    throw new CommandFailure(`${dest} already exists. Pass --overwrite to replace it.`);
  }
  // Written under a temporary name and renamed once complete, so a cut-short download never looks finished.
  const part = `${dest}.${randomBytes(6).toString("hex")}.part`;
  try {
    await Bun.write(part, res);
    await rename(part, dest);
  } catch (e) {
    await rm(part, { force: true });
    throw e;
  }
  io.stdout(`${remote.box}:${remote.path} -> ${dest}\n`);
}

async function uploadTo(
  env: Record<string, string | undefined>,
  io: CliIo,
  locals: string[],
  remote: BoxPath,
  overwrite: boolean,
): Promise<void> {
  for (const local of locals) {
    if (boxPathOf(local)) throw new Error(`${local} names a path in a box. Upload takes paths on this machine.`);
  }
  const dest = await volumePathOf(env, remote);
  const label = `${remote.box}:${remote.path}`;
  const intoFolder = remote.path.endsWith("/") || locals.length > 1 || (await isRemoteFolder(env, dest));
  if (!intoFolder) {
    for (const local of locals) await uploadTree(env, io, resolve(local), dest, label, overwrite);
    return;
  }
  await makeRemoteDir(env, dest);
  for (const local of locals) {
    const from = resolve(local);
    const name = basename(from);
    const child = { volume: dest.volume, path: childOf(dest.path, name) };
    await uploadTree(env, io, from, child, childLabel(label, name), overwrite);
  }
}

/** `upload`, `download` and `cp` move files between this machine and a box. `box:/path` names a path inside a box. */
async function transferCommand(
  command: "cp" | "upload" | "download",
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  const overwrite = argv.includes("--overwrite");
  const args = argv.filter((arg) => arg !== "--overwrite");
  const unknown = args.find((arg) => arg.startsWith("--"));
  if (unknown !== undefined) throw new Error(`Unknown option ${unknown}`);
  try {
    const first = boxPathOf(args[0] ?? "");
    const last = args.at(-1) ?? "";
    const remoteLast = boxPathOf(last);
    if (command === "download") {
      if (first === null || args.length > 2) {
        throw new Error("minibox download needs a box:/path and an optional local path");
      }
      await downloadTo(env, io, first, args[1] ?? null, overwrite);
    } else if (command === "upload") {
      if (args.length < 2 || remoteLast === null) {
        throw new Error("minibox upload needs one or more local paths and a box:/path last");
      }
      await uploadTo(env, io, args.slice(0, -1), remoteLast, overwrite);
    } else if (remoteLast !== null && args.length >= 2) {
      await uploadTo(env, io, args.slice(0, -1), remoteLast, overwrite);
    } else if (first !== null && args.length === 2) {
      await downloadTo(env, io, first, last, overwrite);
    } else {
      throw new Error("minibox cp needs a box:/path on one side and a path on this machine on the other");
    }
    return 0;
  } catch (e) {
    if (e instanceof ApiRefusal) return fail(io, e.status, e.json, e.text);
    if (e instanceof CommandFailure) {
      io.stderr(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

const TOOL_CUSTOM_COMMANDS = ["list", "put", "delete"];

async function readStdinText(io: CliIo): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of io.stdinBytes()) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** `tool custom` manages DATA_DIR/tools.d. The other tool operations are reached over REST and MCP only. */
async function toolCommand(argv: string[], env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  const [group, sub, ...rest] = argv;
  if (group !== "custom" || sub === undefined || !TOOL_CUSTOM_COMMANDS.includes(sub)) {
    throw new Error(`minibox tool custom needs one of ${TOOL_CUSTOM_COMMANDS.join(", ")}`);
  }
  const positional: string[] = [];
  let asJson = false;
  let file: string | undefined;
  let fromStdin = false;
  let overrideBuiltin = false;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] ?? "";
    if (token === "--json") asJson = true;
    else if (token === "--override-builtin") overrideBuiltin = true;
    else if (token === "--stdin") fromStdin = true;
    else if (token === "--file") {
      file = flagValue(rest, i, token);
      i += 1;
    } else if (token.startsWith("--")) throw new Error(`Unknown option ${token}`);
    else positional.push(token);
  }

  if (sub === "list") {
    if (positional.length > 0 || file !== undefined || fromStdin || overrideBuiltin) {
      throw new Error("minibox tool custom list takes no arguments");
    }
    const res = await request(env, "GET", "/api/tools/custom");
    if (res.status >= 400) return fail(io, res.status, res.json, res.text);
    if (asJson) return printJson(io, res.json);
    const tools = (res.json as { tools?: Record<string, unknown>[] } | null)?.tools ?? [];
    io.stdout("ID  NAME  SOURCE  PACKAGE  BIN  REPLACES BUILT-IN\n");
    for (const tool of tools) {
      io.stdout(
        `${String(tool.id)}  ${String(tool.name)}  ${String(tool.source)}  ${String(tool.package)}  ${String(tool.bin)}  ${String(tool.overridesBuiltin)}\n`,
      );
    }
    return 0;
  }

  const [id, ...more] = positional;
  if (!id || more.length > 0) throw new Error(`minibox tool custom ${sub} needs exactly one id`);
  const path = `/api/tools/custom/${encodeURIComponent(id)}`;

  if (sub === "delete") {
    if (file !== undefined || fromStdin || overrideBuiltin)
      throw new Error("minibox tool custom delete takes only an id");
    const res = await request(env, "DELETE", path);
    if (res.status >= 400) return fail(io, res.status, res.json, res.text);
    if (asJson) return printJson(io, res.json);
    io.stdout(`${id}\n`);
    return 0;
  }

  if (fromStdin === (file !== undefined)) {
    throw new Error("minibox tool custom put needs exactly one of --file or --stdin");
  }
  const text = file !== undefined ? await readFile(file, "utf8") : await readStdinText(io);
  let entry: unknown;
  try {
    entry = JSON.parse(text);
  } catch {
    throw new Error("minibox tool custom put reads one JSON object from --file or stdin");
  }
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error("minibox tool custom put reads one JSON object from --file or stdin");
  }
  const res = await request(env, "PUT", path, {
    ...entry,
    ...(overrideBuiltin ? { overrideBuiltin: true } : {}),
  });
  if (res.status >= 400) return fail(io, res.status, res.json, res.text);
  if (asJson) return printJson(io, res.json);
  io.stdout(`${id}\n`);
  return 0;
}

/** `--help` anywhere before a `--`, so `minibox exec box -- npm --help` still runs npm. */
function asksForHelp(args: readonly string[]): boolean {
  const end = args.indexOf("--");
  return (end === -1 ? args : args.slice(0, end)).includes("--help");
}

/** Runs one CLI invocation. `bun src/cli.ts` and the compiled binary both call this. */
export async function runCli(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  io: CliIo,
  lines: AsyncIterable<string> = stdinLines(),
  version: string = BUILT_VERSION,
): Promise<number> {
  const [command, sub, ...rest] = argv;
  try {
    if (command === undefined) {
      io.stderr(HELP);
      return 2;
    }
    if (command === "--help" || command === "-h" || command === "help") {
      io.stdout(HELP);
      return 0;
    }
    if (command === "--version" || command === "-v" || command === "version") {
      io.stdout(`minibox ${version}\n`);
      return 0;
    }
    if (asksForHelp(argv.slice(1))) {
      io.stdout(HELP);
      return 0;
    }
    if (command === "box" && (sub === "ls" || sub === "list")) return await boxLs(rest, env, io);
    if (command === "exec") return await execCommand(sub === undefined ? [] : [sub, ...rest], env, io);
    if (command === "session") return await sessionCommand(sub === undefined ? [] : [sub, ...rest], env, io);
    if (command === "files") return await filesCommand(sub === undefined ? [] : [sub, ...rest], env, io);
    if (command === "cp" || command === "upload" || command === "download") {
      return await transferCommand(command, sub === undefined ? [] : [sub, ...rest], env, io);
    }
    if (command === "tool") return await toolCommand(sub === undefined ? [] : [sub, ...rest], env, io);
    if (command === "mcp") return await mcpProxy(sub === undefined ? [] : [sub, ...rest], env, io, lines);
    if (command === "ssh-config") return await sshConfig(sub === undefined ? [] : [sub, ...rest], env, io);
    if (command === "ssh-proxy")
      return await sshProxy(sub === undefined ? [] : [sub, ...rest], await proxyEnv(env), io, version);
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
