import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

import type { HostCtx } from "../host/registry";
import { AppError, toAppError } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import type { ExecSession } from "../runtime";
import type { Box } from "../services/box-model";

/**
 * The relay that runs inside a box as `dev`. It connects to the port on the box's loopback, answers `ok` or `err <why>` on
 * its first line, and then copies bytes between its standard input and that connection, and back to standard output.
 */
const RELAY_SCRIPT = `import os, select, socket, sys
NEWLINE = bytes([10])

def emit(data):
    while data:
        data = data[os.write(1, data):]

try:
    up = socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=10)
except OSError as error:
    emit(b"err " + str(error).replace(chr(10), " ").encode() + NEWLINE)
    sys.exit(1)
up.settimeout(None)
emit(b"ok" + NEWLINE)
reading = True
try:
    while True:
        ready = select.select([up, 0] if reading else [up], [], [])[0]
        if up in ready:
            data = up.recv(65536)
            if not data:
                break
            emit(data)
        if reading and 0 in ready:
            data = os.read(0, 65536)
            if data:
                up.sendall(data)
            else:
                reading = False
                up.shutdown(socket.SHUT_WR)
except OSError:
    pass
up.close()
`;

/** The address a box's service answers on, as seen from inside the box. */
const BOX_LOOPBACK = "127.0.0.1";
/** Longest the relay may take to connect to the port and answer. */
const HANDSHAKE_MS = 10_000;
/** A WebSocket grant is single use, and must be spent before it expires. */
const GRANT_MS = 60_000;
/**
 * An HTTP connection that carries nothing for this long is closed, so a pooled connection does not keep a relay in the
 * box. It sits just above the 60 second cap on a preview request, so no request in flight is cut.
 */
const HTTP_IDLE_MS = 65_000;
/** A socket listener with no connection and no request for this long is closed and its file removed. */
const LISTENER_IDLE_MS = 60_000;
const SWEEP_MS = 30_000;
/** How long a relay gets to end on its own after its client has gone, before it is killed. */
const CLOSE_GRACE_MS = 5_000;
const STDERR_TAIL_CHARS = 512;
const MAX_HEAD_BYTES = 8192;

/** What a preview request needs to reach a box port on another host. */
export interface PreviewBridge {
  /** The address the service answers on, as seen from inside the box. Its Host header and proxy target. */
  readonly address: string;
  /** The Unix socket `fetch` dials for an HTTP request to the port. */
  readonly httpSocket: string;
  /** The loopback proxy a WebSocket connects through. */
  readonly proxyUrl: string;
  /** A fresh single-use token for one WebSocket connection. */
  grant(): string;
}

interface Grant {
  readonly host: HostCtx;
  readonly boxId: string;
  readonly port: number;
  /** The address the WebSocket asks the proxy to connect to. The proxy refuses any other. */
  readonly target: string;
  readonly expires: number;
}

interface Listener {
  readonly path: string;
  readonly server: Server;
  readonly ready: Promise<void>;
  readonly stats: { open: number; lastUsed: number };
}

interface Bridged {
  readonly session: ExecSession;
  /** Bytes the relay wrote after its handshake line, which belong to the client. */
  readonly rest: Buffer;
}

/**
 * Carries preview traffic to a box whose engine is on another host. The control plane cannot reach the box's address
 * there, so each connection runs the relay inside the box, and the bytes go through its exec. HTTP dials a Unix socket,
 * because `fetch` can. A WebSocket connects through a loopback CONNECT proxy, because a Bun WebSocket cannot dial a
 * Unix socket. Each proxy grant is one connection, and names the box and port it may reach.
 */
export class PreviewRelay {
  private dir: string | null = null;
  private readonly listeners = new Map<string, Listener>();
  private readonly grants = new Map<string, Grant>();
  private proxy: Server | null = null;
  private proxyReady: Promise<string> | null = null;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  async bridge(host: HostCtx, box: Pick<Box, "boxId">, port: number): Promise<PreviewBridge> {
    const address = `${BOX_LOOPBACK}:${port}`;
    const [httpSocket, proxyUrl] = await Promise.all([
      this.httpSocket(host, box.boxId, port).catch((error: unknown) => {
        throw bridgeFailed(error instanceof Error ? error.message : String(error));
      }),
      this.connectProxy(),
    ]);
    return {
      address,
      httpSocket,
      proxyUrl,
      grant: () => this.grant({ host, boxId: box.boxId, port, target: address }),
    };
  }

  /** Closes every listener and the proxy, and removes their files. Tests and shutdown call it. */
  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    for (const listener of this.listeners.values()) listener.server.close();
    this.listeners.clear();
    this.proxy?.close();
    this.proxy = null;
    this.proxyReady = null;
    this.grants.clear();
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
    this.dir = null;
  }

  private httpSocket(host: HostCtx, boxId: string, port: number): Promise<string> {
    const key = `${host.host.id}:${boxId}:${port}`;
    const listener = this.listeners.get(key) ?? this.openListener(key, host, boxId, port);
    listener.stats.lastUsed = Date.now();
    return listener.ready.then(() => listener.path);
  }

  private openListener(key: string, host: HostCtx, boxId: string, port: number): Listener {
    const listener = this.createListener(host, boxId, port, key);
    this.listeners.set(key, listener);
    listener.ready.catch(() => {
      if (this.listeners.get(key) === listener) this.listeners.delete(key);
    });
    return listener;
  }

  private createListener(host: HostCtx, boxId: string, port: number, key: string): Listener {
    const name = createHash("sha256").update(key).digest("hex").slice(0, 16);
    const path = join(this.scratchDir(), `${name}.sock`);
    const stats = { open: 0, lastUsed: Date.now() };
    const server = createServer((client) => {
      stats.open += 1;
      client.on("error", () => client.destroy());
      client.once("close", () => {
        stats.open -= 1;
        stats.lastUsed = Date.now();
      });
      client.setTimeout(HTTP_IDLE_MS, () => client.destroy());
      client.pause();
      this.relayHttp(host, boxId, port, client).catch((error: unknown) => {
        log.warn("preview.socket_failed", { box: boxId, error: String(error) });
        client.destroy();
      });
    });
    server.on("error", (error) => log.warn("preview.socket_error", { box: boxId, error: String(error) }));
    const ready = new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.startSweeper();
    return { path, server, ready, stats };
  }

  private async relayHttp(host: HostCtx, boxId: string, port: number, client: Socket): Promise<void> {
    let bridged: Bridged;
    try {
      bridged = await openBridge(host, boxId, port);
    } catch (error) {
      log.warn("preview.bridge_failed", { box: boxId, port, error: String(error) });
      if (!client.destroyed) client.end(textResponse(toAppError(error).message));
      return;
    }
    attach(client, bridged, Buffer.alloc(0));
  }

  private connectProxy(): Promise<string> {
    if (!this.proxyReady) {
      this.proxyReady = new Promise<string>((resolve, reject) => {
        const server = createServer((client) => {
          client.on("error", () => client.destroy());
          this.acceptConnect(client).catch((error: unknown) => {
            log.warn("preview.proxy_failed", { error: String(error) });
            client.destroy();
          });
        });
        server.once("error", reject);
        server.listen(0, BOX_LOOPBACK, () => {
          server.off("error", reject);
          this.proxy = server;
          resolve(`http://${BOX_LOOPBACK}:${(server.address() as AddressInfo).port}`);
        });
      });
      this.proxyReady.catch(() => {
        this.proxyReady = null;
      });
    }
    return this.proxyReady;
  }

  private async acceptConnect(client: Socket): Promise<void> {
    const head = await readHead(client);
    if (!head) {
      client.destroy();
      return;
    }
    const { method, target, token } = parseRequestHead(head.text);
    const grant = token === undefined ? undefined : this.redeem(token);
    if (grant === undefined) {
      client.end("HTTP/1.1 407 Proxy Authentication Required\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    if (method !== "CONNECT" || target !== grant.target) {
      client.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    let bridged: Bridged;
    try {
      bridged = await openBridge(grant.host, grant.boxId, grant.port);
    } catch (error) {
      log.warn("preview.bridge_failed", { box: grant.boxId, port: grant.port, error: String(error) });
      client.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    if (client.destroyed) {
      closeBridge(bridged.session);
      return;
    }
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    attach(client, bridged, head.rest);
  }

  private grant(init: Omit<Grant, "expires">): string {
    this.pruneGrants();
    const token = randomBytes(24).toString("base64url");
    this.grants.set(token, { ...init, expires: Date.now() + GRANT_MS });
    return token;
  }

  private redeem(token: string): Grant | undefined {
    const grant = this.grants.get(token);
    this.grants.delete(token);
    return grant && grant.expires > Date.now() ? grant : undefined;
  }

  private pruneGrants(): void {
    const now = Date.now();
    for (const [token, grant] of this.grants) {
      if (grant.expires <= now) this.grants.delete(token);
    }
  }

  private scratchDir(): string {
    this.dir ??= mkdtempSync(join(tmpdir(), "mbp-"));
    return this.dir;
  }

  private startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS);
    this.sweeper.unref();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, listener] of this.listeners) {
      if (listener.stats.open > 0 || now - listener.stats.lastUsed < LISTENER_IDLE_MS) continue;
      this.listeners.delete(key);
      listener.server.close();
      rmSync(listener.path, { force: true });
    }
    this.pruneGrants();
  }
}

/**
 * Starts the relay in the box and waits for its first line. A relay that cannot reach the port says so with `err`, and
 * one that cannot start at all, such as a box with no python3, ends with whatever its shell wrote to standard error.
 * The container is looked up on each call, so a box rebuilt under the same id is reached at its new container.
 */
async function openBridge(host: HostCtx, boxId: string, port: number): Promise<Bridged> {
  const containerId = host.specs.read(boxId)?.containerId;
  if (!containerId) throw new AppError(404, "not_found", msg("box_not_found"));
  const session = await host.runtime.startExec(containerId, {
    cmd: ["python3", "-c", RELAY_SCRIPT, String(port)],
    env: [],
    workingDir: "/",
    user: "dev",
    tty: false,
  });
  const stderr = stderrTail(session.stderr);
  try {
    return { session, rest: await handshake(session, stderr) };
  } catch (error) {
    closeBridge(session);
    throw error;
  }
}

function handshake(session: ExecSession, stderr: ReturnType<typeof stderrTail>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const out = session.stdout;
    let seen = Buffer.alloc(0);
    let settled = false;
    const settle = () => {
      settled = true;
      clearTimeout(timer);
      out.off("data", onData);
      out.off("end", onEnd);
      out.off("close", onEnd);
      out.pause();
    };
    const succeed = (rest: Buffer) => {
      if (settled) return;
      settle();
      resolve(rest);
    };
    const fail = (error: AppError) => {
      if (settled) return;
      settle();
      reject(error);
    };
    const timer = setTimeout(() => fail(bridgeFailed("the relay did not answer in time")), HANDSHAKE_MS);
    const onData = (chunk: Buffer) => {
      seen = Buffer.concat([seen, chunk]);
      const end = seen.indexOf(10);
      if (end < 0) {
        if (seen.length > MAX_HEAD_BYTES) fail(bridgeFailed("the relay sent no answer line"));
        return;
      }
      const line = seen.subarray(0, end).toString("utf8");
      if (line === "ok") succeed(seen.subarray(end + 1));
      else if (line.startsWith("err ")) fail(upstreamFailed(line.slice(4)));
      else fail(bridgeFailed(line || "the relay sent no answer line"));
    };
    const onEnd = () => {
      void stderr.closed.then(() => fail(bridgeFailed(stderr.text() || "the relay stopped before it answered")));
    };
    out.on("data", onData);
    out.on("end", onEnd);
    out.on("close", onEnd);
    out.resume();
  });
}

/** Copies bytes both ways between a client socket and a relay, and ends the relay when the client is gone. */
function attach(client: Socket, bridged: Bridged, clientRest: Buffer): void {
  const { session, rest } = bridged;
  const out = session.stdout;
  const into = session.stream;
  if (client.destroyed) {
    closeBridge(session);
    return;
  }
  into.on("error", () => client.destroy());
  out.on("error", () => client.destroy());
  client.on("error", () => closeBridge(session));
  client.on("close", () => {
    closeBridge(session);
    out.resume();
  });
  client.on("data", (chunk: Buffer) => {
    if (!into.write(chunk)) client.pause();
  });
  into.on("drain", () => client.resume());
  client.on("end", () => into.end());
  out.on("data", (chunk: Buffer) => {
    if (!client.write(chunk)) out.pause();
  });
  client.on("drain", () => out.resume());
  out.on("end", () => client.end());
  if (clientRest.length > 0) into.write(clientRest);
  if (rest.length > 0) client.write(rest);
  client.resume();
  out.resume();
}

const closing = new WeakSet<ExecSession>();

/** Ends the relay's input, so it finishes on its own. A relay still running after the grace period is killed. */
function closeBridge(session: ExecSession): void {
  if (closing.has(session)) return;
  closing.add(session);
  session.stream.end();
  const timer = setTimeout(() => void stopIfRunning(session), CLOSE_GRACE_MS);
  timer.unref();
}

async function stopIfRunning(session: ExecSession): Promise<void> {
  try {
    if ((await session.inspect()).running) await session.kill();
  } catch (error) {
    log.warn("preview.bridge_stop_failed", { error: String(error) });
  }
}

function stderrTail(stream: Readable): { text: () => string; closed: Promise<void> } {
  let tail = "";
  stream.on("data", (chunk: Buffer | string) => {
    tail = (tail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
  });
  stream.on("error", () => {});
  const closed = new Promise<void>((resolve) => {
    stream.once("end", resolve);
    stream.once("close", resolve);
  });
  return { text: () => tail.replace(/\s+/g, " ").trim(), closed };
}

function bridgeFailed(detail: string): AppError {
  return new AppError(502, "bad_gateway", msg("preview_bridge_failed", { detail }), undefined, {
    hint: msg("preview_bridge_hint"),
  });
}

function upstreamFailed(detail: string): AppError {
  return new AppError(502, "bad_gateway", msg("preview_upstream_failed", { detail }));
}

function textResponse(text: string): string {
  return `HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(text)}\r\nconnection: close\r\n\r\n${text}`;
}

/** The request head of a CONNECT, and whatever followed it in the same reads. */
function readHead(client: Socket): Promise<{ text: string; rest: Buffer } | null> {
  return new Promise((resolve) => {
    let seen = Buffer.alloc(0);
    const finish = (value: { text: string; rest: Buffer } | null) => {
      client.off("data", onData);
      client.off("end", onEnd);
      client.off("close", onEnd);
      client.pause();
      resolve(value);
    };
    const onData = (chunk: Buffer) => {
      seen = Buffer.concat([seen, chunk]);
      const end = seen.indexOf("\r\n\r\n");
      if (end >= 0) finish({ text: seen.subarray(0, end).toString("latin1"), rest: seen.subarray(end + 4) });
      else if (seen.length > MAX_HEAD_BYTES) finish(null);
    };
    const onEnd = () => finish(null);
    client.on("data", onData);
    client.once("end", onEnd);
    client.once("close", onEnd);
  });
}

function parseRequestHead(text: string): { method: string; target: string; token: string | undefined } {
  const [requestLine = "", ...headers] = text.split("\r\n");
  const [method = "", target = ""] = requestLine.split(" ");
  let token: string | undefined;
  for (const line of headers) {
    const colon = line.indexOf(":");
    if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === "proxy-authorization") {
      token = line.slice(colon + 1).trim();
    }
  }
  return { method, target, token };
}
