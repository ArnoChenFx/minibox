import { readFile, mkdir, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { win32, posix } from "node:path";

import { DEFAULT_URL, flagValue, type CliIo, request, fail } from "./shared";

export const SSH_SUFFIX = ".minibox";

const SSH_BLOCK_BEGIN = "# BEGIN minibox ssh-config";

const SSH_BLOCK_END = "# END minibox ssh-config";

/** Set by `bun build --compile`, so process.execPath is this CLI. From source it is the bun runtime. */
const COMPILED = process.env.MINIBOX_CLI_BUILD_COMPILED === "1";

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
export async function proxyEnv(env: Env): Promise<Env> {
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

export function accessKey(env: Env): string {
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

export async function sshConfig(argv: string[], env: Env, io: CliIo): Promise<number> {
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
