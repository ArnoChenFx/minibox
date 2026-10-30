import { randomBytes } from "node:crypto";

import {
  AGENT_CLOSE,
  AGENT_HEARTBEAT_MS,
  AGENT_HELLO_TIMEOUT_MS,
  AGENT_PROTOCOL,
  type AgentErrorInfo,
  type AgentFrame,
  AgentFrameSchema,
  decodeBytes,
  encodeBytes,
  type ExecExit,
  parseFrame,
  type ServerFrame,
  verifyHello,
} from "../../agent/protocol";
import { abortError } from "../../lib/abort";
import { log } from "../../lib/logger";
import { msg } from "../../lib/messages";
import type { Runtime } from "../../runtime";
import type { PairingBook, PairingCode, PairingGrant, WaitingName } from "./pairing";
import {
  type AgentLink,
  AgentRuntime,
  agentUnavailable,
  type StreamHandle,
  type StreamSink,
  runtimeErrorOf,
} from "./runtime";
import type { AgentRecord, AgentStore } from "./store";

/** A connection that stays silent this long is dropped. Three heartbeats, so one late heartbeat does not drop it. */
const AGENT_SILENT_MS = 3 * AGENT_HEARTBEAT_MS;

const NOT_CONNECTED = "the agent is not connected";

/**
 * How many sockets one address may have open without a verified hello at once. Each of them holds a challenge, a hello
 * timer and a descriptor, and none has proved who it is, so a single caller could otherwise take every place there is and
 * lock every real agent out. A paired agent holds one socket at a time and a handshake takes milliseconds, so eight
 * sockets waiting at once leaves room for a fleet behind one address, with jittered retries for the rest.
 */
export const AGENT_PENDING_PER_ADDRESS_MAX = 8;

/**
 * How many sockets may be open without a verified hello at once, counted across the control plane: the backstop behind
 * the per-address limit, so a crowd spread over many addresses cannot take the door either. A paired agent holds one
 * socket at a time and a fleet reconnecting after a restart opens one each, so 64 leaves room for a few dozen agents
 * retrying at once while a crowd of strangers is refused.
 *
 * Both numbers are constants, not settings: a deployment cannot widen them, and `AgentHubOptions` carries them only so a
 * test can reach a limit without opening sixty-four sockets.
 */
export const AGENT_PENDING_MAX = 64;

/**
 * The most bytes a socket may send before its hello verifies. A hello is a few hundred bytes, so a socket that has not
 * proved who it is has no use for a large frame; the limit is checked before the frame is parsed. Authenticated frames
 * are not bounded here, only by the server's frame limit (`MAX_SOCKET_FRAME_BYTES`, 16 MiB): a `containerLogs` answer is
 * one frame, which the engine adapter keeps to `MAX_LOG_READ_BYTES` of text.
 */
export const AGENT_HELLO_MAX_BYTES = 4 * 1024;

/** Refusals are logged at most once per this many milliseconds, so a flood of sockets cannot flood the log as well. */
const PENDING_LOG_INTERVAL_MS = 60_000;

/** What the hub needs from a WebSocket. The Bun socket fits it; a test passes a recorder. */
export interface AgentSocket {
  send(text: string): void;
  close(code: number, reason: string): void;
}

/** The hub's end of one socket. The socket handler passes it what arrives and reports the close. */
export interface AgentSession {
  receive(text: string): void;
  detach(): void;
}

export interface AgentStatus {
  readonly connected: boolean;
  readonly version: string;
  readonly protocol: number;
  readonly lastSeenAt: string | null;
  /** The agent speaks another protocol than this control plane, so it must be upgraded before it can serve. */
  readonly upgradeRequired: boolean;
  readonly revoked: boolean;
}

export interface AgentEvent {
  readonly type: "connected" | "disconnected" | "revoked";
  readonly agentId: string;
}

export interface AgentHubOptions {
  readonly store: AgentStore;
  readonly pairing: PairingBook;
  readonly serverVersion: string;
  /** The control plane's `LABEL_PREFIX`, sent in the welcome so an agent can tell its operator which prefix it names. */
  readonly labelPrefix?: string;
  readonly now?: () => Date;
  /** How many sockets may wait for a hello at once. Defaults to `AGENT_PENDING_MAX`. A test seam, not a setting. */
  readonly pendingMax?: number;
  /** How many sockets one address may wait with at once. Defaults to `AGENT_PENDING_PER_ADDRESS_MAX`. */
  readonly pendingPerAddressMax?: number;
}

/**
 * Why a socket may not wait for a hello: its own address already has `max` sockets waiting, or the control plane has `max`
 * waiting in all. The server asks before it upgrades, so the caller is answered with 429 instead of an opened socket.
 */
export interface PendingRefusal {
  readonly scope: "address" | "total";
  readonly pending: number;
  readonly max: number;
}

type Refusal = { readonly code: "auth_failed" | "protocol_mismatch" | "revoked"; readonly message: string };
type Outcome = { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: unknown };

/** One socket from the moment it opens. Until its hello verifies, `agentId` is null and only the hello timer runs. */
interface Session {
  readonly socket: AgentSocket;
  /** The bucket the socket is counted under, from `clientAddress` + `rateLimitKey`: the peer, or the proxy's client. */
  readonly address: string;
  readonly nonce: string;
  agentId: string | null;
  done: boolean;
  /** The hello timer until the hello verifies, then the silence timer. */
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** A request, or a stream's open and frames, the control plane has in flight on an agent. Settled once. */
interface Call {
  readonly agentId: string;
  readonly sink: StreamSink | null;
  readonly settle: (outcome: Outcome) => void;
  opened: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

function newId(): string {
  return randomBytes(16).toString("hex");
}

function failureOf(error: AgentErrorInfo | undefined): AgentErrorInfo {
  return error ?? { kind: "engine", message: "the agent failed the request", detail: "the agent failed the request" };
}

function inertHandle(id: string, opened: Promise<unknown>): StreamHandle {
  return { id, opened, input: () => {}, inputEnd: () => {}, cancel: () => {} };
}

/** The hub's end of a socket it refused before it became a session: nothing arrives, and there is nothing to detach. */
const NO_SESSION: AgentSession = { receive: () => {}, detach: () => {} };

/**
 * The control plane's side of the agent connections. It verifies each agent's key, keeps one live connection per agent,
 * and carries requests and streams over it. It implements `AgentLink`, so an `AgentRuntime` reaches a host through it.
 */
export class AgentHub implements AgentLink {
  private readonly all = new Set<Session>();
  private readonly live = new Map<string, Session>();
  private readonly calls = new Map<string, Call>();
  private readonly seen = new Map<string, string>();
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly now: () => Date;
  private readonly pendingMax: number;
  private readonly pendingPerAddressMax: number;
  /** When a pending refusal was last logged, and how many were dropped since. See `logPendingRefusal`. */
  private refusalLoggedAt = Number.NEGATIVE_INFINITY;
  private refusalSuppressed = 0;

  constructor(private readonly options: AgentHubOptions) {
    this.now = options.now ?? (() => new Date());
    this.pendingMax = options.pendingMax ?? AGENT_PENDING_MAX;
    this.pendingPerAddressMax = options.pendingPerAddressMax ?? AGENT_PENDING_PER_ADDRESS_MAX;
  }

  /** A pairing code for a host that does not exist yet. */
  issueCode(hostId: string, name: string): PairingCode {
    return this.options.pairing.create(hostId, name);
  }

  /** Spends a pairing code. A code allows one pairing, so a second spend is refused. */
  spendCode(code: string): PairingGrant {
    return this.options.pairing.redeem(code);
  }

  /** The waiting pairing code, for a host other than `forHost`, that holds `name`, or null when none does. */
  waitingName(name: string, forHost: string, exists?: (hostId: string) => boolean): WaitingName | null {
    return this.options.pairing.waitingName(name, forHost, exists);
  }

  /** Records a paired agent. The id is generated here, so no caller picks one. */
  enroll(fields: Pick<AgentRecord, "hostId" | "publicKeyPem" | "version" | "protocol" | "pairedAt">): AgentRecord {
    const record: AgentRecord = { ...fields, agentId: newId(), lastSeenAt: null, revokedAt: null };
    this.options.store.put(record);
    return record;
  }

  record(agentId: string): AgentRecord | undefined {
    return this.options.store.get(agentId);
  }

  status(agentId: string): AgentStatus | null {
    const record = this.options.store.get(agentId);
    if (!record) return null;
    return {
      connected: this.live.has(agentId),
      version: record.version,
      protocol: record.protocol,
      lastSeenAt: this.seen.get(agentId) ?? record.lastSeenAt,
      upgradeRequired: record.protocol !== AGENT_PROTOCOL,
      revoked: record.revokedAt !== null,
    };
  }

  runtimeFor(agentId: string): Runtime {
    return new AgentRuntime(agentId, this);
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Whether a socket from `address` may wait for a hello, or why it may not. The server asks this before it upgrades, so
   * an over-limit caller is answered with 429 and no socket at all; `attach` asks again, so the count cannot be talked
   * past between the check and the open.
   */
  pendingRefusal(address: string): PendingRefusal | null {
    const forAddress = this.pendingFor(address);
    if (forAddress >= this.pendingPerAddressMax) {
      return { scope: "address", pending: forAddress, max: this.pendingPerAddressMax };
    }
    const total = this.pendingCount();
    if (total >= this.pendingMax) return { scope: "total", pending: total, max: this.pendingMax };
    return null;
  }

  /**
   * Takes a socket that just opened from `address`. The challenge is sent at once, and the socket must answer it with a
   * hello in time. A socket that arrives while its address or the control plane is full is closed instead: it never
   * becomes a session, so it holds no nonce, no timer and no entry in `all`.
   */
  attach(socket: AgentSocket, address: string): AgentSession {
    const refusal = this.pendingRefusal(address);
    if (refusal) {
      this.logPendingRefusal(address, refusal);
      socket.close(AGENT_CLOSE.tooManyPending, "too many sockets waiting for a hello");
      return NO_SESSION;
    }
    const session: Session = { socket, address, nonce: newId(), agentId: null, done: false, timer: undefined };
    this.all.add(session);
    try {
      this.send(session, {
        type: "challenge",
        nonce: session.nonce,
        protocol: AGENT_PROTOCOL,
        serverVersion: this.options.serverVersion,
      });
    } catch (e) {
      // A socket that cannot be written to is not waiting for a hello, so it holds no place. Nothing else would ever
      // give it back: the caller never gets a session to detach, and no timer has been set. Nothing would close it
      // either, so that is done here, as far as it can still be.
      session.done = true;
      this.all.delete(session);
      try {
        socket.close(1011, "the challenge could not be sent");
      } catch {
        // It is gone already, which is likely why the send failed. The failure to report is the send's.
      }
      throw e;
    }
    session.timer = setTimeout(() => this.end(session, AGENT_CLOSE.helloTimeout, "no hello"), AGENT_HELLO_TIMEOUT_MS);
    return {
      receive: (text) => this.receive(session, text),
      detach: () => this.detach(session),
    };
  }

  /**
   * Revokes an agent. The record is marked first, so a failed write refuses the revoke rather than leaving the agent
   * free to reconnect. Its live connection then drops at once.
   */
  revoke(agentId: string): void {
    const record = this.requireRecord(agentId);
    if (record.revokedAt === null) this.options.store.update(agentId, { revokedAt: this.now().toISOString() });
    this.dropLive(agentId, AGENT_CLOSE.revoked, "revoked", {
      code: "revoked",
      message: msg("agent_refused_revoked").text,
    });
    this.emit({ type: "revoked", agentId });
  }

  /** Forgets an agent's record. It is revoked first, so it cannot connect while the record is going. */
  forget(agentId: string): void {
    const record = this.options.store.get(agentId);
    if (record && record.revokedAt === null)
      this.options.store.update(agentId, { revokedAt: this.now().toISOString() });
    this.dropLive(agentId, AGENT_CLOSE.revoked, "removed", {
      code: "revoked",
      message: "This agent was removed from MiniBox. Pair it again with a new code.",
    });
    if (record) this.options.store.remove(agentId);
    this.seen.delete(agentId);
  }

  request(agentId: string, op: string, args: unknown, opts: { timeoutMs: number }): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.live.has(agentId)) {
        reject(agentUnavailable(NOT_CONNECTED));
        return;
      }
      const id = newId();
      this.track(
        id,
        {
          agentId,
          sink: null,
          opened: false,
          timer: undefined,
          settle: (outcome) => (outcome.ok ? resolve(outcome.result) : reject(outcome.error)),
        },
        opts.timeoutMs,
      );
      this.sendTo(agentId, { type: "request", id, op, args });
    });
  }

  open(agentId: string, op: string, args: unknown, sink: StreamSink, opts: { timeoutMs: number }): StreamHandle {
    const id = newId();
    let settle!: (outcome: Outcome) => void;
    const opened = new Promise<unknown>((resolve, reject) => {
      settle = (outcome) => (outcome.ok ? resolve(outcome.result) : reject(outcome.error));
    });
    opened.catch(() => {});
    if (!this.live.has(agentId)) {
      settle({ ok: false, error: agentUnavailable(NOT_CONNECTED) });
      return inertHandle(id, opened);
    }
    this.track(id, { agentId, sink, opened: false, timer: undefined, settle }, opts.timeoutMs);
    this.sendTo(agentId, { type: "request", id, op, args });
    return {
      id,
      opened,
      input: (bytes) => this.sendWhileOpen(agentId, id, { type: "input", id, data: encodeBytes(bytes) }),
      inputEnd: () => this.sendWhileOpen(agentId, id, { type: "input_end", id }),
      cancel: () => this.cancel(agentId, id),
    };
  }

  /** Ends every connection and fails every call. The server calls it on shutdown. */
  close(): void {
    for (const session of this.all) this.end(session, 1001, "the control plane is stopping");
  }

  private receive(session: Session, text: string): void {
    if (session.done) return;
    // A socket that has not proved who it is may send nothing large: its hello is a few hundred bytes. The length is read
    // before the frame is parsed, so a stranger cannot spend a multi-megabyte JSON parse on one frame.
    if (session.agentId === null && Buffer.byteLength(text) > AGENT_HELLO_MAX_BYTES) {
      this.end(session, 1009, "frame too large before the hello");
      return;
    }
    const frame = parseFrame(AgentFrameSchema, text);
    if (!frame) return;
    if (frame.type === "hello") {
      this.hello(session, frame);
      return;
    }
    const agentId = session.agentId;
    if (agentId === null) return;
    this.seen.set(agentId, this.now().toISOString());
    this.touch(session);
    if (frame.type === "response") this.onResponse(agentId, frame);
    else if (frame.type === "item") this.onItem(agentId, frame.id, frame.value);
    else if (frame.type === "data") this.onData(agentId, frame.id, frame.channel, frame.data);
    else if (frame.type === "end") this.onEnd(agentId, frame.id, frame.error, frame.exit);
  }

  private hello(session: Session, frame: Extract<AgentFrame, { type: "hello" }>): void {
    if (session.agentId !== null) return;
    const record = this.options.store.get(frame.agentId);
    if (!record || !verifyHello(record.publicKeyPem, session.nonce, frame.agentId, frame.protocol, frame.signature)) {
      this.end(session, AGENT_CLOSE.authFailed, "auth failed", {
        code: "auth_failed",
        message: msg("agent_refused_auth").text,
      });
      return;
    }
    if (record.revokedAt !== null) {
      this.end(session, AGENT_CLOSE.revoked, "revoked", {
        code: "revoked",
        message: msg("agent_refused_revoked").text,
      });
      return;
    }
    // From here the session is authenticated, so `pendingCount` no longer counts it: the pending slot is given back
    // here, at the one moment authentication succeeds, rather than in each of the ending paths below.
    session.agentId = frame.agentId;
    this.seen.set(frame.agentId, this.now().toISOString());
    this.save(frame.agentId, { version: frame.version, protocol: frame.protocol });
    if (frame.protocol !== AGENT_PROTOCOL) {
      this.end(session, AGENT_CLOSE.protocolMismatch, "protocol mismatch", {
        code: "protocol_mismatch",
        message: msg("agent_refused_protocol", { protocol: AGENT_PROTOCOL }).text,
      });
      return;
    }
    const previous = this.live.get(frame.agentId);
    if (previous) this.end(previous, AGENT_CLOSE.replaced, "replaced by a newer connection");
    this.live.set(frame.agentId, session);
    this.touch(session);
    this.send(session, {
      type: "welcome",
      hostId: record.hostId,
      protocol: AGENT_PROTOCOL,
      ...(this.options.labelPrefix === undefined ? {} : { labelPrefix: this.options.labelPrefix }),
    });
    log.info("agent.accepted", { agentId: frame.agentId, hostId: record.hostId, version: frame.version });
    this.emit({ type: "connected", agentId: frame.agentId });
  }

  private onResponse(agentId: string, frame: Extract<AgentFrame, { type: "response" }>): void {
    const call = this.callOf(agentId, frame.id);
    if (!call) return;
    clearTimeout(call.timer);
    if (frame.ok) {
      call.opened = true;
      if (call.sink === null) this.calls.delete(frame.id);
      call.settle({ ok: true, result: frame.result });
      return;
    }
    this.calls.delete(frame.id);
    call.settle({ ok: false, error: runtimeErrorOf(failureOf(frame.error)) });
  }

  private onItem(agentId: string, id: string, value: unknown): void {
    const call = this.callOf(agentId, id);
    if (call?.sink && call.opened) call.sink.item(value);
  }

  private onData(agentId: string, id: string, channel: "stdout" | "stderr", data: string): void {
    const call = this.callOf(agentId, id);
    if (call?.sink && call.opened) call.sink.data(channel, decodeBytes(data));
  }

  private onEnd(agentId: string, id: string, error: AgentErrorInfo | undefined, exit: ExecExit | undefined): void {
    const call = this.callOf(agentId, id);
    if (!call) return;
    clearTimeout(call.timer);
    this.calls.delete(id);
    if (call.sink && call.opened) call.sink.end(error, exit);
    else call.settle({ ok: false, error: runtimeErrorOf(failureOf(error)) });
  }

  /**
   * The sockets open without a verified hello. It is read from `all` rather than kept as a counter, so a session gives its
   * slot back the moment its hello verifies, and no ending path can leak one or give one back twice.
   */
  private pendingCount(): number {
    let pending = 0;
    for (const session of this.all) if (session.agentId === null) pending += 1;
    return pending;
  }

  /** The sockets from one address that are still waiting for a hello. */
  private pendingFor(address: string): number {
    let pending = 0;
    for (const session of this.all) if (session.agentId === null && session.address === address) pending += 1;
    return pending;
  }

  /** One line per minute, however many sockets are refused: a flood must not flood the log too. */
  private logPendingRefusal(address: string, refusal: PendingRefusal): void {
    const now = this.now().getTime();
    if (now - this.refusalLoggedAt < PENDING_LOG_INTERVAL_MS) {
      this.refusalSuppressed += 1;
      return;
    }
    const suppressed = this.refusalSuppressed;
    this.refusalLoggedAt = now;
    this.refusalSuppressed = 0;
    log.warn("agent.pending_limit", {
      address,
      scope: refusal.scope,
      pending: refusal.pending,
      max: refusal.max,
      ...(suppressed > 0 ? { suppressed } : {}),
    });
  }

  private detach(session: Session): void {
    if (session.done) return;
    session.done = true;
    clearTimeout(session.timer);
    this.all.delete(session);
    this.finish(session, "the agent disconnected");
  }

  /** Ends a socket: sends the refusal when one is given, closes it, and drops the connection if it was the agent's live one. */
  private end(session: Session, code: number, reason: string, refusal?: Refusal): void {
    if (session.done) return;
    session.done = true;
    clearTimeout(session.timer);
    this.all.delete(session);
    if (refusal) this.send(session, { type: "refused", ...refusal });
    session.socket.close(code, reason);
    this.finish(session, reason);
  }

  private dropLive(agentId: string, code: number, reason: string, refusal: Refusal): void {
    const session = this.live.get(agentId);
    if (session) this.end(session, code, reason, refusal);
  }

  /** Clears a session the agent held. Its calls fail, and the agent's last-seen time is kept. */
  private finish(session: Session, reason: string): void {
    const agentId = session.agentId;
    if (agentId === null || this.live.get(agentId) !== session) return;
    this.live.delete(agentId);
    this.failCalls(agentId, reason);
    const seen = this.seen.get(agentId);
    if (seen) this.save(agentId, { lastSeenAt: seen });
    log.info("agent.disconnected", { agentId, reason });
    this.emit({ type: "disconnected", agentId });
  }

  private failCalls(agentId: string, reason: string): void {
    for (const [id, call] of this.calls) {
      if (call.agentId !== agentId) continue;
      this.calls.delete(id);
      clearTimeout(call.timer);
      if (call.sink && call.opened) call.sink.end({ kind: "unavailable", message: reason, detail: reason });
      else call.settle({ ok: false, error: agentUnavailable(reason) });
    }
  }

  private track(id: string, call: Call, timeoutMs: number): void {
    this.calls.set(id, call);
    call.timer = setTimeout(() => this.expire(id, timeoutMs), timeoutMs);
  }

  /** A call that has not been answered in time fails. A stream that has opened is not timed out. */
  private expire(id: string, timeoutMs: number): void {
    const call = this.calls.get(id);
    if (!call || call.opened) return;
    this.calls.delete(id);
    call.settle({ ok: false, error: agentUnavailable(`the agent did not answer within ${timeoutMs} ms`) });
  }

  private cancel(agentId: string, id: string): void {
    const call = this.callOf(agentId, id);
    if (!call) return;
    this.calls.delete(id);
    clearTimeout(call.timer);
    if (!call.opened) call.settle({ ok: false, error: abortError() });
    this.sendTo(agentId, { type: "cancel", id });
  }

  private sendWhileOpen(agentId: string, id: string, frame: ServerFrame): void {
    if (this.callOf(agentId, id)?.opened) this.sendTo(agentId, frame);
  }

  private callOf(agentId: string, id: string): Call | undefined {
    const call = this.calls.get(id);
    return call?.agentId === agentId ? call : undefined;
  }

  private touch(session: Session): void {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => this.end(session, AGENT_CLOSE.silent, "silent"), AGENT_SILENT_MS);
  }

  private sendTo(agentId: string, frame: ServerFrame): void {
    const session = this.live.get(agentId);
    if (session) this.send(session, frame);
  }

  private send(session: Session, frame: ServerFrame): void {
    session.socket.send(JSON.stringify(frame));
  }

  private requireRecord(agentId: string): AgentRecord {
    const record = this.options.store.get(agentId);
    if (!record) throw new Error(`unknown agent: ${agentId}`);
    return record;
  }

  private save(agentId: string, patch: Partial<Omit<AgentRecord, "agentId">>): void {
    if (!this.options.store.get(agentId)) return;
    try {
      this.options.store.update(agentId, patch);
    } catch (e) {
      log.error("agent.record_failed", { agentId, error: String(e) });
    }
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        log.error("agent.listener_failed", { agentId: event.agentId, error: String(e) });
      }
    }
  }
}
