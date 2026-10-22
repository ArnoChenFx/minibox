import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";

import { Client, utils } from "ssh2";

import { log } from "../lib/logger";

export const SSH_CONNECT_TIMEOUT_MS = 10_000;
const KEEPALIVE_MS = 15_000;
const KEEPALIVE_MISSES = 3;

/** `SHA256:` and the unpadded base64 digest of an SSH host key blob, the form `ssh-keygen -l` prints. */
export function fingerprintOf(blob: Buffer): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

export interface SshTarget {
  readonly user: string;
  readonly hostname: string;
  readonly port: number;
  /** The Docker socket on the remote host, such as /var/run/docker.sock. */
  readonly remoteSocket: string;
  readonly privateKey: string;
  /** The fingerprint the host was added with. Null while it is being added, when only the key probe runs. */
  readonly hostKeyFingerprint: string | null;
}

/** The host presented a key other than the one it was added with. Nothing was sent to it. */
export class HostKeyMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly presented: string,
  ) {
    super(`host key ${presented} does not match ${expected}`);
    this.name = "HostKeyMismatchError";
  }
}

/** The host has not been added with a key yet. The presented fingerprint lets the caller ask for confirmation. */
export class HostKeyUnconfirmedError extends Error {
  constructor(readonly presented: string) {
    super(`host key ${presented} has not been confirmed`);
    this.name = "HostKeyUnconfirmedError";
  }
}

/** The private key cannot be used for a login, such as an encrypted key or a file that is not a key. */
export class SshKeyError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SshKeyError";
  }
}

/** Checks that a private key parses without a passphrase. Nothing is connected. */
export function checkSshKey(privateKey: string): void {
  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error) {
    const encrypted = /passphrase/i.test(parsed.message);
    throw new SshKeyError(encrypted ? "passphrase-protected keys are not supported" : "the file is not a private key");
  }
}

/**
 * Connects to the host and checks its key before anything else is sent. The login follows only after the presented key
 * matches the pinned one, so the private key never reaches a server that is not the one the operator confirmed.
 */
function connectClient(target: SshTarget): Promise<Client> {
  let presented: string | null = null;
  return new Promise<Client>((resolve, reject) => {
    const client = new Client();
    client.once("ready", () => resolve(client));
    client.once("error", (e: Error) => {
      client.destroy();
      if (presented === null || presented === target.hostKeyFingerprint) reject(e);
      else if (target.hostKeyFingerprint === null) reject(new HostKeyUnconfirmedError(presented));
      else reject(new HostKeyMismatchError(target.hostKeyFingerprint, presented));
    });
    client.connect({
      host: target.hostname,
      port: target.port,
      username: target.user,
      privateKey: target.privateKey,
      readyTimeout: SSH_CONNECT_TIMEOUT_MS,
      keepaliveInterval: KEEPALIVE_MS,
      keepaliveCountMax: KEEPALIVE_MISSES,
      hostVerifier: (key: Buffer) => {
        presented = fingerprintOf(key);
        return target.hostKeyFingerprint !== null && presented === target.hostKeyFingerprint;
      },
    });
  });
}

/**
 * The host's key fingerprint, read from the key exchange alone. The connection is refused at that point, so no user name
 * or key is sent to the host. Adding a host then asks the operator to confirm the value before it is pinned.
 */
export function probeHostKey(hostname: string, port: number): Promise<string> {
  let presented: string | null = null;
  return new Promise<string>((resolve, reject) => {
    const client = new Client();
    client.once("error", (e: Error) => {
      client.destroy();
      if (presented !== null) resolve(presented);
      else reject(e);
    });
    client.once("ready", () => {
      client.destroy();
      reject(new Error("the host accepted a connection without a login"));
    });
    client.connect({
      host: hostname,
      port,
      username: "minibox-probe",
      readyTimeout: SSH_CONNECT_TIMEOUT_MS,
      hostVerifier: (key: Buffer) => {
        presented = fingerprintOf(key);
        return false;
      },
    });
  });
}

/**
 * A local Unix socket that Docker speaks to, which forwards each connection to the remote Docker socket over SSH. The
 * SSH connection is opened on first use and opened again after it drops, so a host that comes back is picked up by the
 * next request without any caller noticing the gap.
 */
export class SshTunnel {
  /** The local socket. Docker connects here, as it would to a local daemon. */
  readonly socketPath: string;
  private readonly dir: string;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private client: Client | null = null;
  private opening: Promise<Client> | null = null;
  private closed = false;

  constructor(private readonly target: SshTarget) {
    this.dir = mkdtempSync(join(tmpdir(), "mbh-"));
    this.socketPath = join(this.dir, "docker.sock");
    // Half-open, so a client that ends its side (Docker's exec closes stdin) still reads the engine's reply to the end.
    this.server = createServer({ allowHalfOpen: true }, (local) => this.forward(local));
    this.server.on("error", (e) => log.error("host.tunnel_failed", { host: target.hostname, error: String(e) }));
    this.server.listen(this.socketPath);
  }

  /** Opens the SSH connection now, so a caller learns at once whether the host is reachable and trusted. */
  async connect(): Promise<void> {
    await this.session();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.server.close();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.client?.end();
    this.client = null;
    rmSync(this.dir, { recursive: true, force: true });
  }

  private forward(local: Socket): void {
    if (this.closed) {
      local.destroy();
      return;
    }
    this.sockets.add(local);
    local.once("close", () => this.sockets.delete(local));
    local.on("error", () => local.destroy());
    this.channel().then(
      (remote) => {
        if (local.destroyed) {
          remote.destroy();
          return;
        }
        remote.on("error", () => local.destroy());
        // End rather than destroy: a reply the engine sent just before it closed may still be on its way to the client.
        remote.on("close", () => local.end());
        local.on("close", () => remote.destroy());
        local.pipe(remote);
        remote.pipe(local);
      },
      () => local.destroy(),
    );
  }

  private channel(): Promise<Duplex> {
    return this.session().then(
      (client) =>
        new Promise<Duplex>((resolve, reject) => {
          client.openssh_forwardOutStreamLocal(this.target.remoteSocket, (err, stream) => {
            if (err) reject(err);
            else resolve(stream);
          });
        }),
    );
  }

  /** The live connection, or one opened now. Concurrent callers share a single attempt. */
  private session(): Promise<Client> {
    if (this.closed) return Promise.reject(new Error("the tunnel is closed"));
    if (this.client) return Promise.resolve(this.client);
    this.opening ??= connectClient(this.target)
      .then((client) => {
        this.client = client;
        client.on("error", (e: Error) => log.warn("host.ssh_error", { host: this.target.hostname, error: e.message }));
        client.once("close", () => {
          if (this.client === client) this.client = null;
        });
        return client;
      })
      .finally(() => {
        this.opening = null;
      });
    return this.opening;
  }
}
