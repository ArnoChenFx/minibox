import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Connection, Server, utils } from "ssh2";

export interface KeyPair {
  /** OpenSSH private key, as the operator pastes it. */
  readonly privateKey: string;
  readonly publicKey: string;
}

/**
 * A fresh ed25519 key. ssh2's generator sometimes writes one its own parser rejects, so a key is kept only once it
 * parses, as `src/ssh/host-key.ts` does. Node's PKCS#8 ed25519 output is not readable by ssh2 1.x.
 */
export function newKeyPair(): KeyPair {
  for (;;) {
    const pair = utils.generateKeyPairSync("ed25519");
    if (!(utils.parseKey(pair.private) instanceof Error)) {
      return { privateKey: pair.private.trimEnd(), publicKey: pair.public };
    }
  }
}

/** `SHA256:` and the unpadded base64 digest of a key blob, the form `ssh-keygen -lf` prints. */
export function fingerprintOfBlob(blob: Buffer): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

export interface FakeEngineOptions {
  readonly cpus?: number;
  readonly memoryBytes?: number;
  readonly version?: string;
}

export interface FakeEngine {
  /** The Unix socket the engine listens on. A remote host's Docker socket path is this. */
  readonly socketPath: string;
  /** Every request answered so far, as `METHOD /path`. */
  readonly requests: string[];
  stop(): void;
}

export interface TlsFakeEngine {
  readonly port: number;
  /** Every request answered so far, as `METHOD /path`. */
  readonly requests: string[];
  stop(): void;
}

interface Routes {
  readonly requests: string[];
  readonly fetch: (req: Request) => Response;
  close(): void;
}

/**
 * The Docker Engine API calls a host check and its periodic probe make: ping, version, info, an empty container list and
 * an event stream that stays open. Anything else is a 404, so a test sees a call it did not expect.
 */
function engineRoutes(options: FakeEngineOptions): Routes {
  const requests: string[] = [];
  const cpus = options.cpus ?? 4;
  const memoryBytes = options.memoryBytes ?? 8 * 1024 ** 3;
  const version = options.version ?? "27.0.0-fake";
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  return {
    requests,
    fetch(req) {
      const { pathname } = new URL(req.url);
      requests.push(`${req.method} ${pathname}`);
      switch (pathname) {
        case "/_ping":
          return new Response("OK", { headers: { "api-version": "1.47" } });
        case "/version":
          return Response.json({ Version: version, ApiVersion: "1.47" });
        case "/info":
          return Response.json({
            NCPU: cpus,
            MemTotal: memoryBytes,
            Containers: 0,
            ContainersRunning: 0,
            Images: 0,
            DockerRootDir: "/var/lib/docker",
            ServerVersion: version,
          });
        case "/containers/json":
          return Response.json([]);
        case "/events":
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streams.add(controller);
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        default:
          return Response.json({ message: `no route for ${req.method} ${pathname}` }, { status: 404 });
      }
    },
    close() {
      for (const controller of streams) controller.close();
      streams.clear();
    },
  };
}

/** A Docker Engine API on a Unix socket in `dir`, for a host reached over SSH or a socket path. */
export function startFakeEngine(dir: string, options: FakeEngineOptions = {}): FakeEngine {
  const socketPath = join(dir, "engine.sock");
  const routes = engineRoutes(options);
  const server = Bun.serve({ unix: socketPath, fetch: routes.fetch });
  return {
    socketPath,
    requests: routes.requests,
    stop() {
      routes.close();
      server.stop(true);
    },
  };
}

/**
 * A Docker Engine API on 127.0.0.1 over TLS. It requires a client certificate signed by the CA it is given, as an engine
 * set up for mutual TLS does.
 */
export function startTlsFakeEngine(
  pki: { readonly ca: string; readonly cert: string; readonly key: string },
  options: FakeEngineOptions = {},
): TlsFakeEngine {
  const routes = engineRoutes(options);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: routes.fetch,
    tls: { cert: pki.cert, key: pki.key, ca: pki.ca, requestCert: true, rejectUnauthorized: true },
  });
  return {
    port: server.port ?? 0,
    requests: routes.requests,
    stop() {
      routes.close();
      server.stop(true);
    },
  };
}

export interface FakeSshHost {
  readonly port: number;
  /** The host key as `SHA256:…`: the value an operator confirms before a host is added. */
  readonly fingerprint: string;
  /** The user name of every authentication request, in order. ssh2 sends a key query and then a signed request. */
  readonly authAttempts: string[];
  /** The socket path of every `direct-streamlocal` channel the client asked to open. */
  readonly forwards: string[];
  close(): Promise<void>;
}

/**
 * An SSH server in this process that accepts one public key, and forwards `direct-streamlocal` channels to the Unix
 * socket path it is given. Other socket paths are refused, so a client that asks for anything else gets nothing.
 */
export async function startSshHost(authorized: KeyPair, forwardTo: string): Promise<FakeSshHost> {
  const host = newKeyPair();
  const hostKey = utils.parseKey(host.privateKey);
  if (hostKey instanceof Error) throw hostKey;
  const fingerprint = fingerprintOfBlob(hostKey.getPublicSSH());
  const clientKey = utils.parseKey(authorized.privateKey);
  if (clientKey instanceof Error) throw clientKey;
  const authAttempts: string[] = [];
  const forwards: string[] = [];
  const clients = new Set<Connection>();

  const server = new Server({ hostKeys: [host.privateKey] }, (client) => {
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    client.on("authentication", (ctx) => {
      authAttempts.push(ctx.username);
      const allowed =
        ctx.method === "publickey" &&
        ctx.key.algo === clientKey.type &&
        ctx.key.data.equals(clientKey.getPublicSSH()) &&
        (ctx.signature === undefined ||
          clientKey.verify(ctx.blob ?? Buffer.alloc(0), ctx.signature, ctx.hashAlgo) === true);
      if (allowed) ctx.accept();
      else ctx.reject(["publickey"]);
    });
    client.on("openssh.streamlocal", (accept, reject, info) => {
      forwards.push(info.socketPath);
      if (info.socketPath !== forwardTo) {
        reject();
        return;
      }
      const channel = accept();
      const upstream = createConnection(info.socketPath);
      channel.on("error", () => upstream.destroy());
      upstream.on("error", () => channel.destroy());
      channel.pipe(upstream).pipe(channel);
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

  return {
    port,
    fingerprint,
    authAttempts,
    forwards,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of clients) client.end();
        server.close(() => resolve());
      }),
  };
}

/** A temporary directory for one test's sockets. Removed with `rmSync` by the caller. */
export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
