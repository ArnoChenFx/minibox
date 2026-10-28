/** The commands that start a host agent. No DOM and no imports, so the tests load them directly. */

export const AGENT_IMAGE = "ghcr.io/arnochenfx/minibox-agent";
/** The tag a build without a release of its own uses. The release workflow pushes it for every final release. */
export const AGENT_LATEST_TAG = "latest";
/** A release version, in the shape the release workflow also pushes as an image tag: `0.6.8`, never `v0.6.8`. */
const RELEASE = /^\d+\.\d+\.\d+$/;
const AGENT_VOLUME = "minibox-agent";
/** Characters a shell reads as themselves, so a value made of them needs no quotes. */
const BARE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * The image tag for the version this MiniBox runs. The release workflow tags the agent image with the version it was
 * built from (`type=semver,pattern={{version}}`), so a console pins the agent to its own version. A dev build
 * (`0.6.8-3-gabc1234`), a prerelease or a version that could not be read has no tag of its own, and `latest` stands in.
 */
export function agentImageTag(version) {
  const clean = String(version ?? "")
    .trim()
    .replace(/^v(?=\d)/, "");
  return RELEASE.test(clean) ? clean : AGENT_LATEST_TAG;
}

/** The image the command runs, at the tag for `version`. */
export function agentImage(version) {
  return `${AGENT_IMAGE}:${agentImageTag(version)}`;
}

/** Whether the console is reached over plain http, where the pairing code and the agent's traffic travel in the clear. */
export function insecureConsole(protocol) {
  return protocol !== "https:";
}

/** A value as one bash word: bare when it is plain, otherwise in single quotes. */
function bashWord(value) {
  return BARE.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** A value as one PowerShell word: single quotes are literal there, and a quote inside them is doubled. */
function powershellWord(value) {
  return BARE.test(value) ? value : `'${value.replaceAll("'", "''")}'`;
}

/** The `docker run` that starts an agent on this machine and pairs it with `code`, in bash. */
export function agentBashCommand(server, code, version) {
  return [
    "docker run -d --restart unless-stopped \\",
    "  -v /var/run/docker.sock:/var/run/docker.sock \\",
    `  -v ${AGENT_VOLUME}:/data \\`,
    `  ${agentImage(version)} --server ${bashWord(server)} --pair ${bashWord(code)}`,
  ].join("\n");
}

/** The same command for PowerShell, which continues a line with a backtick. */
export function agentPowerShellCommand(server, code, version) {
  return [
    "docker run -d --restart unless-stopped `",
    "  -v /var/run/docker.sock:/var/run/docker.sock `",
    `  -v ${AGENT_VOLUME}:/data \``,
    `  ${agentImage(version)} --server ${powershellWord(server)} --pair ${powershellWord(code)}`,
  ].join("\n");
}
