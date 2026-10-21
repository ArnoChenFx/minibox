/** The login user inside every box. The box id is accepted too, and `root` never is. */
export const SSH_USER = "dev";
export const SSH_WORKDIR = "/workspace";
/** SSH channels one connection may have running at once. */
export const SSH_CHANNELS_PER_CONNECTION = 16;
/** SSH connections one box may have open, across every client. */
export const SSH_BOX_CONNECTIONS_MAX = 8;
/** SSH connections the whole server may have open. */
export const SSH_CONNECTIONS_MAX = 64;
/**
 * Global requests that set up or cancel a remote (-R) forward. They are refused and audited. `no-more-sessions` is only
 * a hint from `ssh -N`, so it is not in the set.
 */
export const REMOTE_FORWARD_REQUESTS: ReadonlySet<string> = new Set([
  "tcpip-forward",
  "cancel-tcpip-forward",
  "streamlocal-forward@openssh.com",
  "cancel-streamlocal-forward@openssh.com",
]);
/** Longest command line a client may send, in bytes. */
export const SSH_COMMAND_MAX = 16 * 1024;

const ENV_NAME = /^(LANG|LC_[A-Z_]+|TERM|COLORTERM)$/;
const ENV_VALUE_MAX = 1024;
const TERM_NAME = /^[A-Za-z0-9._+-]{1,64}$/;

export function userAllowed(username: string, boxId: string): boolean {
  return username === SSH_USER || username === boxId;
}

/** The terminal type a client asked for, when it is a plain name. Anything else falls back to the default. */
export function termName(term: string): string | null {
  return TERM_NAME.test(term) ? term : null;
}

/** Only locale and terminal variables pass. Anything else would let a client reshape the box's environment. */
export function envAllowed(name: string, value: string): boolean {
  return ENV_NAME.test(name) && value.length <= ENV_VALUE_MAX && !value.includes("\0");
}

export function commandAllowed(command: string): boolean {
  return command.length > 0 && Buffer.byteLength(command) <= SSH_COMMAND_MAX && !command.includes("\0");
}

/** Forwarding reaches only ports on the box's own loopback, which is where `-L` to a service in the box lands. */
export function forwardAllowed(host: string, port: number): boolean {
  return (host === "localhost" || host === "127.0.0.1") && Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** A command runs through the box's login bash, or sh when bash is missing, the same as `minibox exec` with a shell. */
export function execArgv(command: string): string[] {
  return ["sh", "-c", 'if command -v bash >/dev/null 2>&1; then exec bash -lc "$0"; fi; exec sh -c "$0"', command];
}

export function shellArgv(): string[] {
  return ["sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash -l || exec sh -l"];
}

/** The sftp server ships with openssh-sftp-server in the base template; its path differs by distribution. */
export function sftpArgv(): string[] {
  return [
    "sh",
    "-c",
    [
      'for p in "$(command -v sftp-server)" /usr/lib/openssh/sftp-server /usr/lib/ssh/sftp-server; do',
      '  if [ -n "$p" ] && [ -x "$p" ]; then exec "$p"; fi',
      "done",
      'echo "sftp-server is not installed in this box" >&2',
      "exit 127",
    ].join("\n"),
  ];
}

/** socat copies the channel to the loopback port inside the box. The port is checked by `forwardAllowed` first. */
export function relayArgv(port: number): string[] {
  return ["socat", "-", `TCP4:127.0.0.1:${port}`];
}

export function defaultEnv(term: string | null, client: Record<string, string>): string[] {
  const values: Record<string, string> = { TERM: term || "xterm-256color", LANG: "C.UTF-8", ...client };
  return Object.entries(values).map(([key, value]) => `${key}=${value}`);
}
