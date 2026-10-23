/** The commands the SSH dialog shows. No DOM and no imports, so the tests load them directly. */

/** The host a box answers to. `minibox ssh-config` matches `*.minibox`, and `minibox ssh-proxy` strips the suffix. */
export function sshHost(name) {
  return `${name}.minibox`;
}

/** Downloads the CLI from this server, checks it against the server's sha256 list, and installs it without sudo. */
export function installCommands(origin) {
  return `curl -fsSL ${origin}/cli/install.sh | sh`;
}

export function windowsInstallCommands(origin) {
  return `irm ${origin}/cli/install.ps1 | iex`;
}

/**
 * Run once on the machine that will use ssh. `ssh-config --append` saves the server and token, so the ProxyCommand
 * works from any shell or IDE without exported variables.
 */
export function setupCommands(origin) {
  return [`MINIBOX_URL=${origin} \\`, "  MINIBOX_ACCESS_KEY=<token> minibox ssh-config --append"].join("\n");
}

/** The same setup in PowerShell, which sets environment variables with `$env:` and runs on one line. */
export function windowsSetupCommands(origin) {
  return `$env:MINIBOX_URL="${origin}"; $env:MINIBOX_ACCESS_KEY="<token>"; minibox ssh-config --append`;
}

export function connectCommands(name) {
  const host = sshHost(name);
  return [`ssh ${host}`, `scp ./file ${host}:/workspace/`].join("\n");
}

/**
 * Where a standard SSH client connects. The server names the host when SSH_PUBLIC_HOST is set; otherwise it is the host
 * the console was opened on. Null when direct SSH is off.
 */
export function directAddress(direct, hostname) {
  if (!direct || !Number.isInteger(direct.port)) return null;
  return { host: direct.host || hostname, port: direct.port };
}

/** The one-line OpenSSH command for a direct connection. The username is the box name; port 22 needs no flag. */
export function directCommand(user, { host, port }) {
  return port === 22 ? `ssh ${user}@${host}` : `ssh -p ${port} ${user}@${host}`;
}
