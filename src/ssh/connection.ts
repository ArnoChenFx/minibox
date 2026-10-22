import type { Socket } from "node:net";
import { finished } from "node:stream/promises";

import {
  type AcceptConnection,
  type Algorithms,
  type AuthContext,
  type Connection,
  type RejectConnection,
  Server,
  type ServerChannel,
  type Session,
  type TcpipRequestInfo,
} from "ssh2";

import type { AuditNote, EventStatus, Source } from "../events/types";
import type { HostCtx } from "../host/registry";
import { log } from "../lib/logger";
import type { Principal } from "../operations/types";
import { type ExecSession, RuntimeError } from "../runtime";
import type { ActivityPulse } from "../services/activity-pulse";
import { type Box, ensureRunning } from "../services/boxes";
import type { RecordNote } from "../services/terminals";
import { type FrameSocket, WsDuplex } from "./duplex";
import {
  commandAllowed,
  defaultEnv,
  envAllowed,
  execArgv,
  forwardAllowed,
  REMOTE_FORWARD_REQUESTS,
  relayArgv,
  SSH_CHANNELS_PER_CONNECTION,
  SSH_USER,
  SSH_WORKDIR,
  sftpArgv,
  shellArgv,
  termName,
  userAllowed,
} from "./policy";

const ALGORITHMS: Algorithms = {
  kex: ["curve25519-sha256", "curve25519-sha256@libssh.org"],
  cipher: ["aes128-gcm@openssh.com", "aes256-gcm@openssh.com", "aes256-ctr", "aes128-ctr"],
  serverHostKey: ["ssh-ed25519"],
  hmac: ["hmac-sha2-256", "hmac-sha2-512"],
};

/** Keeps a quiet session alive through proxies, and tells a dead client from a slow one. */
const KEEPALIVE_MS = 30_000;
const KEEPALIVE_COUNT_MAX = 3;
/** A socket that has not authenticated within this time is closed, so an idle handshake cannot hold a slot. */
const READY_TIMEOUT_MS = 30_000;
/** Client input touches the box's activity at most this often, so a busy terminal costs one touch a minute. */
const ACTIVITY_TOUCH_MS = 60_000;
const NAME_MAX = 64;

/** What one SSH connection is bound to: a box, reached as the principal that opened the WebSocket. */
export interface SshTarget {
  readonly host: HostCtx;
  readonly box: Box;
  readonly principal: Principal;
  readonly source: Source;
  /** Whether the principal may forward ports, which needs `port:expose` on top of `box:ssh`. */
  readonly forward: boolean;
}

export interface SshConnectionOptions {
  /** OpenSSH-format private host key. */
  readonly hostKey: string;
  readonly pulse: ActivityPulse;
  readonly record: RecordNote;
  /** Called once when the connection ends, so the gateway can count it out. */
  readonly onEnd: () => void;
}

/** The box with its container running. A stopped or sleeping box is started, which is how a connection wakes it. */
export async function awakeBox(host: HostCtx, boxId: string, record: (note: AuditNote) => void): Promise<Box> {
  const { box } = await ensureRunning(host, boxId, { record });
  return box;
}

interface SessionState {
  pty: { term: string | null } | null;
  env: Record<string, string>;
  size: { cols: number; rows: number } | null;
  active: ExecSession | null;
  started: boolean;
}

interface ChildRequest {
  readonly type: "exec" | "shell" | "sftp";
  readonly tty: boolean;
  readonly argv: string[];
  readonly command?: string;
}

const noop = () => undefined;

function failureText(error: unknown): string {
  if (error instanceof RuntimeError) return error.detail;
  return error instanceof Error ? error.message : String(error);
}

/** Polls until the process has exited and returns its status. Repeated failures to read it count as a failed exit. */
async function exitStatus(exec: ExecSession): Promise<number> {
  let failures = 0;
  for (let delay = 10; ; delay = Math.min(delay * 2, 500)) {
    try {
      const status = await exec.inspect();
      if (!status.running) return status.exitCode ?? 1;
    } catch {
      failures += 1;
      if (failures >= 5) return 1;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/**
 * One SSH protocol session carried over one WebSocket. The WebSocket handshake has already proved who the caller is, so
 * the SSH layer accepts any method for the box's `dev` user or its id, and refuses every other name. Each channel runs as
 * one process in the box, and every process is stopped when its channel or the whole connection goes away.
 */
export class SshConnection {
  private readonly duplex: WsDuplex;
  private readonly server: Server;
  private readonly socket: FrameSocket;
  private client: Connection | null = null;
  private readonly live = new Set<ExecSession>();
  private readonly startedAt = Date.now();
  private readonly readyTimer: ReturnType<typeof setTimeout>;
  private channels = 0;
  private user: string | null = null;
  private touchedAt = 0;
  private ended = false;

  constructor(
    private readonly target: SshTarget,
    private readonly options: SshConnectionOptions,
    socket: FrameSocket,
  ) {
    this.socket = socket;
    this.duplex = new WsDuplex(socket);
    this.server = new Server(
      {
        hostKeys: [options.hostKey],
        algorithms: ALGORITHMS,
        keepaliveInterval: KEEPALIVE_MS,
        keepaliveCountMax: KEEPALIVE_COUNT_MAX,
      },
      (client) => this.bind(client),
    );
    this.server.on("error", (error: Error) => log.debug("ssh.server_error", { box: this.boxId, error: String(error) }));
    // ssh2 types injectSocket as net.Socket, but it only reads and writes the stream methods a Duplex has.
    this.server.injectSocket(this.duplex as unknown as Socket);
    this.readyTimer = setTimeout(() => socket.close(1008, "ssh handshake timed out"), READY_TIMEOUT_MS);
    this.readyTimer.unref();
  }

  receive(bytes: Uint8Array): void {
    this.duplex.onMessage(bytes);
  }

  drained(): void {
    this.duplex.onDrain();
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.readyTimer);
    for (const exec of this.live) this.stop(exec);
    if (this.user !== null) {
      this.audit("ssh.disconnect", "ok", `SSH disconnect: ${this.target.box.name}`, {
        user: this.user,
        durationMs: Date.now() - this.startedAt,
      });
    }
    this.duplex.onClosed();
    this.options.onEnd();
  }

  /** The container the connection was opened to. A rebuild replaces it, which ends the connection. */
  get containerId(): string {
    return this.target.box.id;
  }

  /**
   * Ends the connection from the server side: the client gets an SSH disconnect, then the WebSocket closes with the
   * reason, which `minibox ssh-proxy` prints. The socket's close handler then runs `close()`.
   */
  disconnect(reason: string): void {
    if (this.ended) return;
    try {
      this.client?.end();
    } catch {
      // The protocol already ended.
    }
    try {
      this.socket.close(1001, reason);
    } catch {
      // The socket already closed.
    }
  }

  private get boxId(): string {
    return this.target.box.boxId;
  }

  private bind(client: Connection): void {
    this.client = client;
    client.on("error", (error: Error) => log.debug("ssh.client_error", { box: this.boxId, error: String(error) }));
    client.on("authentication", (ctx) => this.authenticate(ctx));
    client.on("request", (_accept, reject, name) => {
      if (REMOTE_FORWARD_REQUESTS.has(name)) this.refuse(name);
      reject?.();
    });
    client.on("openssh.streamlocal", (_accept, reject, info) => {
      this.refuse("direct-streamlocal@openssh.com", { path: info.socketPath.slice(0, 256) });
      reject();
    });
    client.on("session", (accept, reject) => this.openSession(accept, reject));
    client.on("tcpip", (accept, reject, info) => this.openForward(accept, reject, info));
  }

  private authenticate(ctx: AuthContext): void {
    const user = ctx.username.slice(0, NAME_MAX);
    if (!userAllowed(ctx.username, this.boxId)) {
      this.audit("ssh.connect", "denied", `SSH refused: ${this.target.box.name}`, { user, method: ctx.method });
      ctx.reject([]);
      return;
    }
    this.user = user;
    clearTimeout(this.readyTimer);
    ctx.accept();
    this.audit("ssh.connect", "ok", `SSH connect: ${this.target.box.name}`, { user, method: ctx.method });
  }

  /**
   * Channel requests reply through `accept` and `reject`, but ssh2 defines them only when the client asked for a reply.
   * An env or window-change request usually does not, and calling an undefined reply throws inside the protocol parser
   * and drops the connection, so every reply to a request is called with `?.`.
   */
  private openSession(accept: AcceptConnection<Session>, reject: RejectConnection): void {
    const release = this.takeChannel();
    if (!release) {
      reject();
      return;
    }
    const session = accept();
    session.once("close", release);
    const state: SessionState = { pty: null, env: {}, size: null, active: null, started: false };

    session.on("env", (acceptEnv, rejectEnv, info) => {
      if (!envAllowed(info.key, info.val)) {
        rejectEnv?.();
        return;
      }
      state.env[info.key] = info.val;
      acceptEnv?.();
    });
    session.on("pty", (acceptPty, _rejectPty, info) => {
      state.pty = { term: termName(info.term) };
      state.size = { cols: info.cols, rows: info.rows };
      acceptPty?.();
    });
    session.on("window-change", (acceptChange, _rejectChange, info) => {
      const size = { cols: info.cols, rows: info.rows };
      state.size = size;
      if (state.active) void state.active.resize(size).catch(noop);
      acceptChange?.();
    });
    session.on("x11", (_acceptX11, rejectX11) => {
      this.refuse("x11");
      rejectX11?.();
    });
    session.on("auth-agent", (_acceptAgent, rejectAgent) => {
      this.refuse("auth-agent");
      rejectAgent?.();
    });
    session.on("exec", (acceptExec, rejectExec, info) => {
      if (!commandAllowed(info.command)) {
        this.refuse("exec", { command: info.command.slice(0, 256) });
        rejectExec?.();
        return;
      }
      this.childSession(acceptExec, rejectExec, state, {
        type: "exec",
        tty: state.pty !== null,
        argv: execArgv(info.command),
        command: info.command,
      });
    });
    session.on("shell", (acceptShell, rejectShell) => {
      this.childSession(acceptShell, rejectShell, state, { type: "shell", tty: state.pty !== null, argv: shellArgv() });
    });
    session.on("subsystem", (acceptSub, rejectSub, info) => {
      if (info.name !== "sftp") {
        this.refuse("subsystem", { name: info.name.slice(0, NAME_MAX) });
        rejectSub?.();
        return;
      }
      this.childSession(acceptSub, rejectSub, state, { type: "sftp", tty: false, argv: sftpArgv() });
    });
  }

  private childSession(
    accept: AcceptConnection<ServerChannel>,
    reject: RejectConnection,
    state: SessionState,
    request: ChildRequest,
  ): void {
    if (state.started) {
      reject?.();
      return;
    }
    state.started = true;
    const channel = accept();
    this.audit("ssh.channel", "ok", `SSH ${request.type}: ${this.target.box.name}`, {
      type: request.type,
      tty: request.tty,
      ...(request.command === undefined ? {} : { command: request.command }),
    });
    void this.runChild(channel, state, request);
  }

  private async runChild(channel: ServerChannel, state: SessionState, request: ChildRequest): Promise<void> {
    channel.on("error", noop);
    let closed = false;
    channel.once("close", () => {
      closed = true;
    });
    const env = defaultEnv(state.pty?.term ?? null, state.env);
    const exec = await this.start(request.argv, request.tty, env).catch((error: unknown) => {
      log.warn("ssh.start_failed", { box: this.boxId, error: failureText(error) });
      if (!closed) {
        channel.stderr.write(`minibox: ${failureText(error)}\n`);
        channel.exit(1);
        channel.end();
      }
      return null;
    });
    if (!exec) return;
    this.live.add(exec);
    state.active = exec;
    channel.once("close", () => this.stop(exec));
    if (closed) this.stop(exec);
    if (request.tty && state.size) void exec.resize(state.size).catch(noop);
    await this.pump(channel, exec, request.tty);
    const code = await exitStatus(exec);
    this.live.delete(exec);
    if (state.active === exec) state.active = null;
    channel.unpipe(exec.stream);
    if (!closed) {
      channel.exit(code);
      channel.end();
    }
  }

  private async pump(channel: ServerChannel, exec: ExecSession, tty: boolean): Promise<void> {
    channel.on("data", () => this.noteInput());
    exec.stream.on("error", noop);
    if (tty) {
      channel.pipe(exec.stream);
      exec.stream.pipe(channel, { end: false });
      await finished(exec.stream, { writable: false }).catch(noop);
      return;
    }
    exec.stdout.on("error", noop);
    exec.stderr.on("error", noop);
    channel.pipe(exec.stream);
    exec.stdout.pipe(channel, { end: false });
    exec.stderr.pipe(channel.stderr, { end: false });
    await Promise.all([finished(exec.stdout), finished(exec.stderr)].map((done) => done.catch(noop)));
  }

  private openForward(accept: AcceptConnection<ServerChannel>, reject: RejectConnection, info: TcpipRequestInfo): void {
    if (!this.target.forward || !forwardAllowed(info.destIP, info.destPort)) {
      this.refuse("forward", { host: info.destIP.slice(0, NAME_MAX), port: info.destPort });
      reject();
      return;
    }
    const release = this.takeChannel();
    if (!release) {
      reject();
      return;
    }
    void this.relay(accept, reject, info.destPort, release);
  }

  private async relay(
    accept: AcceptConnection<ServerChannel>,
    reject: RejectConnection,
    port: number,
    release: () => void,
  ): Promise<void> {
    const exec = await this.start(relayArgv(port), false, defaultEnv(null, {}), "/").catch((error: unknown) => {
      log.warn("ssh.relay_failed", { box: this.boxId, port, error: failureText(error) });
      return null;
    });
    if (!exec) {
      release();
      reject();
      return;
    }
    const channel = accept();
    channel.on("error", noop);
    this.audit("ssh.channel", "ok", `SSH forward: ${this.target.box.name}`, { type: "direct-tcpip", port });
    this.live.add(exec);
    let closed = false;
    channel.once("close", () => {
      closed = true;
      release();
      this.stop(exec);
    });
    channel.on("data", () => this.noteInput());
    exec.stream.on("error", noop);
    exec.stdout.on("error", noop);
    exec.stderr.on("error", noop);
    exec.stderr.resume();
    channel.pipe(exec.stream);
    exec.stdout.pipe(channel, { end: false });
    await finished(exec.stdout).catch(noop);
    await exitStatus(exec);
    this.live.delete(exec);
    channel.unpipe(exec.stream);
    if (!closed) channel.end();
  }

  /**
   * Starts one process in the box as dev. A process that started after the connection ended is stopped at once, so a
   * channel opened just before a disconnect cannot leave a shell or a relay running in the box. A relay names no path,
   * so it starts in `/`, where a stuck volume cannot hold it.
   */
  private async start(argv: string[], tty: boolean, env: string[], workingDir = SSH_WORKDIR): Promise<ExecSession> {
    if (this.ended) throw new Error("the SSH connection has ended");
    const box = await awakeBox(this.target.host, this.boxId, (note) => this.recordFor(note));
    const exec = await this.target.host.runtime.startExec(box.id, {
      cmd: argv,
      env,
      workingDir,
      user: SSH_USER,
      stopAs: box.profile === "strict" ? SSH_USER : "root",
      tty,
    });
    if (this.ended) {
      exec
        .kill()
        .catch((error: unknown) => log.warn("ssh.kill_failed", { box: this.boxId, error: failureText(error) }));
      throw new Error("the SSH connection has ended");
    }
    return exec;
  }

  private takeChannel(): (() => void) | null {
    if (this.channels >= SSH_CHANNELS_PER_CONNECTION) return null;
    this.channels += 1;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.channels -= 1;
    };
  }

  private stop(exec: ExecSession): void {
    if (!this.live.delete(exec)) return;
    exec.kill().catch((error: unknown) => log.warn("ssh.kill_failed", { box: this.boxId, error: failureText(error) }));
  }

  private noteInput(): void {
    const now = Date.now();
    if (now - this.touchedAt < ACTIVITY_TOUCH_MS) return;
    this.touchedAt = now;
    this.options.pulse.touch(this.boxId, "ssh", now);
  }

  private refuse(type: string, detail: Record<string, string | number> = {}): void {
    this.audit("ssh.channel", "denied", `SSH refused ${type}: ${this.target.box.name}`, { type, ...detail });
  }

  private audit(op: string, status: EventStatus, summary: string, detail: Record<string, unknown>): void {
    this.recordFor({
      op,
      kind: "write",
      status,
      summary,
      target: { kind: "box", id: this.target.box.id, name: this.target.box.name },
      detail,
    });
  }

  private recordFor(note: AuditNote): void {
    this.options.record(this.target.host.host.id, this.target.source, this.target.principal, note);
  }
}
