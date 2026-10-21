/** The commands the SSH dialog shows. No DOM and no imports, so the tests load them directly. */

/** The host a box answers to. `minibox ssh-config` matches `*.minibox`, and `minibox ssh-proxy` strips the suffix. */
export function sshHost(name) {
  return `${name}.minibox`;
}

/**
 * Run once on the machine that will use ssh. The variables stay exported because `ssh` runs `minibox ssh-proxy` as its
 * ProxyCommand, and that reads them from the environment of the shell that started ssh.
 */
export function setupCommands(origin) {
  return [
    "bun run build:cli && mkdir -p ~/.local/bin && cp dist/minibox ~/.local/bin/minibox",
    `export MINIBOX_URL=${origin}`,
    "export MINIBOX_ACCESS_KEY=<token>",
    "minibox ssh-config --append",
  ].join("\n");
}

export function connectCommands(name) {
  const host = sshHost(name);
  return [`ssh ${host}`, `scp ./file ${host}:/workspace/`].join("\n");
}
