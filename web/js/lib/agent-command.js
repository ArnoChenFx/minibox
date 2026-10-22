/** The commands that start a host agent. No DOM and no imports, so the tests load them directly. */

export const AGENT_IMAGE = "ghcr.io/arnochenfx/minibox-agent";
const AGENT_VOLUME = "minibox-agent";
/** Characters a shell reads as themselves, so a value made of them needs no quotes. */
const BARE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** A value as one bash word: bare when it is plain, otherwise in single quotes. */
function bashWord(value) {
  return BARE.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** A value as one PowerShell word: single quotes are literal there, and a quote inside them is doubled. */
function powershellWord(value) {
  return BARE.test(value) ? value : `'${value.replaceAll("'", "''")}'`;
}

/** The `docker run` that starts an agent on this machine and pairs it with `code`, in bash. */
export function agentBashCommand(server, code) {
  return [
    "docker run -d --restart unless-stopped \\",
    "  -v /var/run/docker.sock:/var/run/docker.sock \\",
    `  -v ${AGENT_VOLUME}:/data \\`,
    `  ${AGENT_IMAGE} --server ${bashWord(server)} --pair ${bashWord(code)}`,
  ].join("\n");
}

/** The same command for PowerShell, which continues a line with a backtick. */
export function agentPowerShellCommand(server, code) {
  return [
    "docker run -d --restart unless-stopped `",
    "  -v /var/run/docker.sock:/var/run/docker.sock `",
    `  -v ${AGENT_VOLUME}:/data \``,
    `  ${AGENT_IMAGE} --server ${powershellWord(server)} --pair ${powershellWord(code)}`,
  ].join("\n");
}
