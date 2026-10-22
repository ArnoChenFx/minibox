import type { HostCtx } from "../host/registry";
import { templateOwnerOf } from "../labels";
import { badRequest } from "../lib/errors";
import { msg } from "../lib/messages";
import { isSshRepoUrl } from "../lib/source";
import { HELPER_SECRETS_DIR, type VolumeOwner } from "../runtime";
import { extractTar } from "./build-context";
import { writableWorkspaceVolume } from "./volume-owner";

export const WORKSPACE = "/workspace";

/** A repository to clone. `secretRef` names a secret holding a token (https) or a base64 deploy key (ssh). */
export interface RepoSource {
  url: string;
  branch?: string;
  secretRef?: string;
}

export const ROOT_OWNER: VolumeOwner = { uid: 0, gid: 0 };

const MIB = 1024 * 1024;
const CLONE_TIMEOUT_SEC = 300;
const CLONE_MEMORY_BYTES = 512 * MIB;
const DEPLOY_KEY_PATH = "/tmp/minibox-deploy-key";
const KNOWN_HOSTS_PATH = "/tmp/minibox-known-hosts";
const SSH_COMMAND = `ssh -i ${DEPLOY_KEY_PATH} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${KNOWN_HOSTS_PATH}`;

/**
 * A token is sent as the password of an https request, with the username GitHub expects for a token. The helper reads
 * the secret file named by MINIBOX_TOKEN_FILE, so the value never appears in the command line or the environment.
 */
const CREDENTIAL_HELPER =
  '!f() { if [ -n "${MINIBOX_TOKEN_FILE:-}" ]; then echo username=x-access-token; echo "password=$(cat -- "$MINIBOX_TOKEN_FILE")"; fi; }; f';

/**
 * Positional arguments: $1 is the clone target, $2 the repository, $3 the branch (empty for the default) and $4 the
 * secret file that holds a base64 deploy key (empty when there is none). Arguments never enter the script text.
 */
const CLONE_SCRIPT = [
  "set -eu",
  'if [ -n "$4" ]; then umask 077; base64 -d -- "$4" > ' + DEPLOY_KEY_PATH + "; fi",
  `if [ -n "$3" ]; then exec git -c 'credential.helper=${CREDENTIAL_HELPER}' clone --depth 1 --single-branch --branch "$3" -- "$2" "$1"; fi`,
  `exec git -c 'credential.helper=${CREDENTIAL_HELPER}' clone --depth 1 -- "$2" "$1"`,
].join("\n");

/** Refuses a clone whose secret is not set. Checked before a box is created, so a failed create leaves nothing behind. */
export function assertRepoSecretSet(host: HostCtx, repo: RepoSource | undefined): void {
  if (repo?.secretRef === undefined || host.secrets.meta(repo.secretRef) !== null) return;
  throw badRequest(msg("repo_secret_missing", { name: repo.secretRef }), { field: "repo" });
}

/** Removes every occurrence of a secret value from helper output, so a clone log never shows it. */
export function scrubSecret(text: string, secret: string | null): string {
  if (!secret) return text;
  return text.split(secret).join("[secret]");
}

export interface CloneOptions {
  repo: RepoSource;
  /** Engine volume that receives the clone. */
  volume: string;
  /** Where the volume is mounted in the helper, and the directory the clone is written into. Must be empty. */
  path: string;
  /** Owner the clone runs as, so the files it writes belong to the box user, or root for a template build. */
  owner: VolumeOwner;
  log?(text: string): void;
}

/**
 * Clones a repository into an empty directory of `volume`, in a helper that has no capabilities, a read-only root and
 * the base template's git. The network is on, because the clone needs it, and the clone's stderr reaches the task log
 * with the secret removed. A failure is refused with the tail of that output.
 */
export async function cloneInto(host: HostCtx, opts: CloneOptions): Promise<void> {
  const { url, branch, secretRef } = opts.repo;
  const secret = secretRef === undefined ? null : host.secrets.value(secretRef);
  if (secretRef !== undefined && secret === null) {
    throw badRequest(msg("repo_secret_missing", { name: secretRef }), { field: "repo" });
  }
  const ssh = isSshRepoUrl(url);
  const env = [
    "HOME=/tmp",
    "GIT_TERMINAL_PROMPT=0",
    "GIT_CONFIG_NOSYSTEM=1",
    "GIT_CONFIG_GLOBAL=/dev/null",
    "GIT_ALLOW_PROTOCOL=https:ssh",
    `GIT_SSH_COMMAND=${SSH_COMMAND}`,
  ];
  const secretPath = secretRef === undefined ? "" : `${HELPER_SECRETS_DIR}/${secretRef}`;
  if (secret !== null && !ssh) env.push(`MINIBOX_TOKEN_FILE=${secretPath}`);
  const result = await host.runtime.runHelper({
    image: host.baseTemplateTag,
    user: `${opts.owner.uid}:${opts.owner.gid}`,
    cmd: ["sh", "-c", CLONE_SCRIPT, "minibox", opts.path, url, branch ?? "", secret !== null && ssh ? secretPath : ""],
    mounts: [{ source: opts.volume, target: opts.path, mode: "rw" }],
    env,
    network: true,
    secrets: secret === null || secretRef === undefined ? [] : [{ name: secretRef, value: secret }],
    secretsOwner: opts.owner,
    memoryBytes: CLONE_MEMORY_BYTES,
    timeoutSec: CLONE_TIMEOUT_SEC,
    labels: { [host.keys.internal]: "true" },
  });
  const logs = scrubSecret(result.logs, secret).trim();
  if (logs) opts.log?.(`${logs}\n`);
  if (result.exitCode !== 0) {
    const detail = logs.slice(-400) || `exit code ${result.exitCode}`;
    throw badRequest(msg("clone_failed", { detail }), { field: "repo" });
  }
}

/**
 * Clones `repo` into the empty /workspace of a box, as the box user. The box already exists, so this runs as a task of
 * its own: a request that waited for a large clone would outlast the server's idle timeout.
 */
export async function cloneIntoWorkspace(
  host: HostCtx,
  boxId: string,
  repo: RepoSource,
  log?: (text: string) => void,
): Promise<void> {
  const spec = host.specs.read(boxId);
  const volume = spec ? writableWorkspaceVolume(spec.mounts) : null;
  if (!spec || !volume) throw badRequest(msg("repo_needs_workspace"), { field: "repo" });
  const image = await host.runtime.inspectImage(spec.template.image).catch(() => null);
  const owner = templateOwnerOf(image?.labels) ?? (await host.runtime.volumeRootOwner(spec.containerId, WORKSPACE));
  await cloneInto(host, { repo, volume, path: WORKSPACE, owner, log });
}

/**
 * Copies the directory `path` of `volume` into the empty directory `dest`, through a container that is created and never
 * started. The `.git` directory is left out, so a template keeps only the files a Dockerfile can use.
 */
export async function copyVolumeOut(host: HostCtx, volume: string, path: string, dest: string): Promise<void> {
  const staging = await host.runtime.createContainer({
    image: host.baseTemplateTag,
    cmd: ["true"],
    labels: { [host.keys.internal]: "true" },
    mounts: [{ source: volume, target: path, mode: "ro" }],
  });
  try {
    const archive = await host.runtime.getArchive(staging.id, `${path}/.`);
    await extractTar(archive, dest, { skip: (top) => top === ".git" });
  } finally {
    await host.runtime.removeContainer(staging.id, { force: true }).catch(() => {});
  }
}
