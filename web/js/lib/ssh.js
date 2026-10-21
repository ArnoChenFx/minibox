/** The commands the SSH dialog shows. No DOM and no imports, so the tests load them directly. */

/** The host a box answers to. `minibox ssh-config` matches `*.minibox`, and `minibox ssh-proxy` strips the suffix. */
export function sshHost(name) {
  return `${name}.minibox`;
}

/**
 * Run once on the machine that will use ssh. `ssh-config --append` saves the server and token (mode 600), so the
 * ProxyCommand works from any shell or IDE without exported variables.
 */
export function setupCommands(origin) {
  return [
    "bun run build:cli && mkdir -p ~/.local/bin && cp dist/minibox ~/.local/bin/minibox",
    `MINIBOX_URL=${origin} \\`,
    "  MINIBOX_ACCESS_KEY=<token> minibox ssh-config --append",
  ].join("\n");
}

export function connectCommands(name) {
  const host = sshHost(name);
  return [`ssh ${host}`, `scp ./file ${host}:/workspace/`].join("\n");
}
