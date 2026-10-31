import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { createSecretFile, ensureDataDir, readSecretFile } from "../data-dir";

/**
 * The credentials a remote repository needs, apart from its password. They travel to the restic helper as secret files,
 * never in its environment, which `docker inspect` shows to anyone who can reach the engine.
 */
export interface S3RemoteCredentials {
  readonly kind: "s3";
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface SftpRemoteCredentials {
  readonly kind: "sftp";
  readonly port: number;
  readonly privateKey: string;
  /** The server's public key as a known_hosts line, such as `[host]:2222 ssh-ed25519 AAAA…`. */
  readonly knownHosts: string;
}

export type RemoteCredentials = S3RemoteCredentials | SftpRemoteCredentials;

/**
 * A remote repository a host's checkpoint snapshots are copied to. `repository` is the string restic opens, and it holds
 * no credential. The password is the remote repository's own: it is not the local repository's key.
 */
export interface RemoteRepository {
  /** The target the repository lives on, which the checkpoint records name. */
  readonly targetId: string;
  readonly targetName: string;
  /** `s3:https://host/bucket/prefix` or `sftp:user@host:path`, with nothing secret in it. */
  readonly repository: string;
  readonly password: string;
  readonly credentials: RemoteCredentials;
}

/** The secrets file that holds one host's remote repository password, under `DATA_DIR/secrets`. */
export function remoteKeyFile(hostId: string): string {
  return `checkpoint-remote-${hostId.replace(/[^A-Za-z0-9_.-]/g, "_")}.key`;
}

/**
 * The remote repository's password, generated once and kept beside the local repository's key. The two are separate on
 * purpose: each opens only its own repository, and losing one leaves the other readable.
 */
export function remoteRepoPassword(dataDir: string, hostId: string): string {
  const path = join(dataDir, "secrets", remoteKeyFile(hostId));
  const existing = readSecretFile(path);
  if (existing) return existing;
  ensureDataDir(dataDir);
  createSecretFile(path, randomBytes(32).toString("hex"));
  const created = readSecretFile(path);
  if (!created) throw new Error("could not create the remote checkpoint repository key");
  return created;
}

/**
 * The folder one host's repository lives in, under the base path the operator chose. The host id is always the last
 * segment, so two hosts that share a target never share a repository.
 */
export function remotePathFor(base: string, hostId: string): string {
  const segments = base.split("/").filter((segment) => segment !== "");
  return `${base.startsWith("/") ? "/" : ""}${[...segments, hostId].join("/")}`;
}

/** The `s3:` repository string. The endpoint is the target's origin, and the path is a key prefix with no leading slash. */
export function s3Repository(endpoint: string, bucket: string, path: string): string {
  const prefix = path
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `s3:${endpoint.replace(/\/+$/, "")}/${bucket}${prefix === "" ? "" : `/${prefix}`}`;
}

/**
 * The `sftp:` repository string. The port goes in it only when it is not 22, so the known_hosts pattern is the plain
 * host name for the default port, as OpenSSH writes it. An absolute path doubles the slash after the authority, which is
 * how restic's URL form tells it from a path relative to the login folder.
 */
export function sftpRepository(user: string, host: string, port: number, path: string): string {
  const authority = `${encodeURIComponent(user)}@${host.includes(":") ? `[${host}]` : host}${port === 22 ? "" : `:${port}`}`;
  // An absolute path already starts with the extra slash restic needs after the authority.
  const directory = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `sftp://${authority}/${directory}`;
}

/**
 * The known_hosts line for a server's public key. OpenSSH matches a non-default port as `[host]:port`, and the default
 * one as the bare host name. `key` is the `type base64` text, never a bare fingerprint: ssh cannot check a hash.
 */
export function knownHostsLine(host: string, port: number, key: string): string {
  return `${port === 22 ? host : `[${host}]:${port}`} ${key}`;
}
