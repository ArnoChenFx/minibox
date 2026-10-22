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
 * Run once on the machine that will use ssh. `ssh-config --append` saves the server and token (mode 600), so the
 * ProxyCommand works from any shell or IDE without exported variables.
 */
export function setupCommands(origin) {
  return [`MINIBOX_URL=${origin} \\`, "  MINIBOX_ACCESS_KEY=<token> minibox ssh-config --append"].join("\n");
}

export function connectCommands(name) {
  const host = sshHost(name);
  return [`ssh ${host}`, `scp ./file ${host}:/workspace/`].join("\n");
}
