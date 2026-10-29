import { createServer, type Server, type Socket } from "node:net";

import type { AuthContext } from "ssh2";

import type { AuditNote } from "../events/types";
import type { HostRegistry } from "../host/registry";
import { AppError } from "../lib/errors";
import { log } from "../lib/logger";
import type { OwnerPrincipal, Principal } from "../operations/types";
import { hostOfSpecRef } from "../services/box-query";
import type { RecordNote } from "../services/terminals";
import type { TokenStore } from "../tokens/store";
import {
  boxRefOfUser,
  DIRECT_METHODS,
  type DirectCredential,
  type DirectIdentity,
  identify,
  SSH_PASSWORD_MAX,
} from "./direct-auth";
import type { SshGateway, SshLease } from "./gateway";
import type { SshKeyStore } from "./keys";
import { SSH_ATTEMPTS_PER_CONNECTION, SshLoginLimiter } from "./limits";

/** A failed login is answered after this long, so guessing costs time even before the lockout. */
const FAIL_DELAY_MS = 1000;
/** Refused logins recorded in the event log per minute. A scan beyond it only reaches the server log. */
const FAILURE_EVENTS_PER_MINUTE = 60;
const USER_MAX = 64;

/** Refused logins have no principal. This one is owner-typed, so only the owner reads its events, and named apart. */
const SSH_ANONYMOUS: OwnerPrincipal = { type: "owner", id: "anonymous", name: "anonymous" };

export interface DirectSshDeps {
  readonly gateway: SshGateway;
  readonly hosts: HostRegistry;
  readonly keys: SshKeyStore;
  readonly tokens: TokenStore;
  readonly accessKey: string;
  readonly record: RecordNote;
  readonly limiter?: SshLoginLimiter;
  /** Tests shorten the delay of a refused login. */
  readonly failDelayMs?: number;
  readonly now?: () => number;
}

interface PendingState {
  attempts: number;
  socket: Socket;
}

type Refusal = "bad_credential" | "unknown_box" | "forbidden" | "locked_out" | "limit" | "start_failed" | "bad_user";

/**
 * The direct SSH listener: plain TCP for standard clients, which log in as the box (its name or id) with an agent token
 * or the access key as the password, or with one of the owner's SSH keys. After the login a connection is the same as
 * one over `minibox ssh-proxy`: the gateway checks the box, holds a slot, wakes the box and ends it with the box.
 */
export class DirectSshServer {
  private server: Server | null = null;
  private readonly limiter: SshLoginLimiter;
  private readonly sockets = new Set<Socket>();
  private readonly now: () => number;
  private failureMinute = 0;
  private failureEvents = 0;

  constructor(private readonly deps: DirectSshDeps) {
    this.limiter = deps.limiter ?? new SshLoginLimiter(deps.now);
    this.now = deps.now ?? Date.now;
  }

  /** The bound port while listening, else null. */
  get port(): number | null {
    const address = this.server?.listening ? this.server.address() : null;
    return typeof address === "object" && address ? address.port : null;
  }

  /** Starts listening. Resolves with the bound port, which is the asked one unless it was 0. */
  listen(bind: string, port: number): Promise<number> {
    const server = createServer({ noDelay: true, keepAlive: true }, (socket) => this.onSocket(socket));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, bind, () => {
        server.off("error", reject);
        server.on("error", (error) => log.error("ssh.direct_error", { error: String(error) }));
        resolve(this.port ?? port);
      });
    });
  }

  /** Stops accepting and ends every connection. */
  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private onSocket(socket: Socket): void {
    const ip = socket.remoteAddress ?? "unknown";
    const release = this.limiter.admit(ip);
    if (!release) {
      log.warn("ssh.direct_refused", { ip, reason: "too many pending connections" });
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    const state: PendingState = { attempts: 0, socket };
    let stopWatching: (() => void) | null = null;
    this.deps.gateway.accept(socket, (ctx) => this.login(ctx, ip, state), {
      onLogin: (connection) => {
        release();
        const principal = connection.principal;
        if (principal?.type === "token") {
          stopWatching = this.deps.tokens.watch(principal.id, () => connection.disconnect("token revoked"));
        }
      },
      onEnd: () => {
        release();
        stopWatching?.();
      },
    });
  }

  /** Answers one authentication attempt. Returns the lease of the one that logs in; every other is answered here. */
  private async login(ctx: AuthContext, ip: string, state: PendingState): Promise<SshLease | null> {
    const user = ctx.username.slice(0, USER_MAX);
    if (ctx.method === "none") {
      ctx.reject(DIRECT_METHODS);
      return null;
    }
    state.attempts += 1;
    if (state.attempts > SSH_ATTEMPTS_PER_CONNECTION) {
      ctx.reject([]);
      state.socket.destroy();
      return null;
    }
    const lockedFor = this.limiter.lockedFor(ip);
    if (lockedFor > 0) {
      return this.refuse(ctx, ip, user, "locked_out", null, { lockedForSec: Math.ceil(lockedFor / 1000) });
    }
    const credential = await this.credentialOf(ctx);
    if (credential === "query") return null;
    if (!credential) return this.refuse(ctx, ip, user, "bad_credential", null);
    const identity = identify(this.deps, credential, ip);
    if (!identity) return this.refuse(ctx, ip, user, "bad_credential", null);
    const ref = boxRefOfUser(ctx.username);
    if (!ref) return this.refuse(ctx, ip, user, "bad_user", identity);
    const host = hostOfSpecRef(this.deps.hosts, ref) ?? this.deps.hosts.get();
    const via: Record<string, string> = {
      transport: "direct",
      ip,
      method: ctx.method,
      credential: identity.credential,
      ...identity.detail,
    };
    let lease: SshLease;
    try {
      lease = await this.deps.gateway.enter(
        host,
        ref,
        { principal: identity.principal, sessionId: null },
        {
          source: "ssh",
          via,
        },
      );
    } catch (error) {
      const status = error instanceof AppError ? error.status : 500;
      const reason: Refusal =
        status === 404 ? "unknown_box" : status === 403 ? "forbidden" : status === 429 ? "limit" : "start_failed";
      if (reason === "start_failed") log.warn("ssh.direct_start_failed", { ip, user, error: String(error) });
      return this.refuse(ctx, ip, user, reason, identity);
    }
    this.limiter.succeed(ip);
    if (identity.keyId) this.deps.keys.touch(identity.keyId);
    return lease;
  }

  /**
   * The credential of an attempt. A key offered without a signature is a query: it gets PK_OK when it is one of the
   * owner's keys, so the client goes on to sign with it, and does not count as a failure either way.
   */
  private async credentialOf(ctx: AuthContext): Promise<DirectCredential | "query" | null> {
    switch (ctx.method) {
      case "password":
        return { method: "password", password: ctx.password };
      case "keyboard-interactive": {
        const answers = await new Promise<string[]>((resolve) => {
          ctx.prompt([{ prompt: "Password: ", echo: false }], (replies) => resolve(replies ?? []));
        });
        const password = answers[0] ?? "";
        return password.length > SSH_PASSWORD_MAX ? null : { method: "keyboard-interactive", password };
      }
      case "publickey": {
        if (!ctx.signature || !ctx.blob) {
          if (this.deps.keys.find(ctx.key.algo, ctx.key.data)) ctx.accept();
          else ctx.reject(DIRECT_METHODS);
          return "query";
        }
        return {
          method: "publickey",
          algorithm: ctx.key.algo,
          blob: ctx.key.data,
          data: ctx.blob,
          signature: ctx.signature,
          hashAlgo: ctx.hashAlgo,
        };
      }
      default:
        return null;
    }
  }

  /**
   * Refuses an attempt the same way whatever went wrong, after the fail delay, so the client cannot tell a wrong
   * password from a box that does not exist. The audit event, which only the owner reads, names the reason.
   */
  private async refuse(
    ctx: AuthContext,
    ip: string,
    user: string,
    reason: Refusal,
    identity: DirectIdentity | null,
    extra: Record<string, number> = {},
  ): Promise<null> {
    const counted = reason !== "limit" && reason !== "start_failed" && reason !== "locked_out";
    const lockout = counted ? this.limiter.fail(ip) : 0;
    log.warn("ssh.direct_login_refused", { ip, user, method: ctx.method, reason });
    this.recordFailure(identity?.principal ?? SSH_ANONYMOUS, {
      op: "ssh.connect",
      kind: "write",
      status: "denied",
      summary: `SSH login refused: ${user}`,
      detail: {
        user,
        transport: "direct",
        ip,
        method: ctx.method,
        reason,
        ...(identity ? { credential: identity.credential, ...identity.detail } : {}),
        ...(lockout > 0 ? { lockedForSec: Math.ceil(lockout / 1000) } : {}),
        ...extra,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, this.deps.failDelayMs ?? FAIL_DELAY_MS));
    ctx.reject(DIRECT_METHODS);
    return null;
  }

  private recordFailure(principal: Principal, note: AuditNote): void {
    const minute = Math.floor(this.now() / 60_000);
    if (minute !== this.failureMinute) {
      this.failureMinute = minute;
      this.failureEvents = 0;
    }
    this.failureEvents += 1;
    if (this.failureEvents > FAILURE_EVENTS_PER_MINUTE) return;
    this.deps.record(this.deps.hosts.get().host.id, "ssh", principal, note);
  }
}
