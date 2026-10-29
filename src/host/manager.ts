import { AGENT_PROTOCOL, type PairRequest, type PairResponse, isEd25519PublicKey } from "../agent/protocol";
import type { Config } from "../config";
import { untilAborted } from "../lib/abort";
import { AppError, badRequest, conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { type Msg, type Params, msg } from "../lib/messages";
import { type EngineTarget, type DiskBreakdown, type Runtime, RuntimeError } from "../runtime";
import { bookedOn, type Booking } from "../services/capacity";
import type { AgentEvent, AgentHub, AgentStatus } from "./agent/hub";
import { type Endpoint, endpointLabel, parseEndpoint } from "./endpoint";
import {
  type HostCredentials,
  isAgentTarget,
  type Link,
  type LinkTarget,
  MissingCredentialsError,
  openLink,
} from "./link";
import type { LinkFrame } from "./live";
import {
  ENGINE_READ_TIMEOUT_MS,
  type Host,
  type HostCapacity,
  type HostCtx,
  type HostIdentity,
  type HostRegistry,
  LOCAL_HOST_ID,
  type SharedStores,
  createHost,
  unreachableRuntime,
} from "./registry";
import { checkSshKey, HostKeyMismatchError, HostKeyUnconfirmedError, probeHostKey, SshKeyError } from "./ssh";
import { AUTO_HOST, HOST_ID_RE, type HostStore, hostLabelsProblem, type StoredHost } from "./store";

const PROBE_INTERVAL_MS = 30_000;
/** The most ticks an offline host sits out between two checks. At the interval above, that is about five minutes. */
const MAX_SKIPPED_PROBES = 9;
/** Longest one connection check takes: the link, a ping and the engine's version and capacity. */
const CHECK_TIMEOUT_MS = 10_000;
const MAX_CREDENTIAL_CHARS = 16 * 1024;

const CERTIFICATE_PEM = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;
const PRIVATE_KEY_PEM = /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC )?PRIVATE KEY-----/;
const SSH_KEY_PEM = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z0-9 ]*PRIVATE KEY-----/;
const ENCRYPTED_KEY = /ENCRYPTED PRIVATE KEY|Proc-Type: 4,ENCRYPTED/;

/** What an operator sends to add or test a host. Credentials arrive here once and are then only files under DATA_DIR. */
export interface HostInput {
  readonly id: string;
  readonly name?: string;
  readonly endpoint: string;
  /** PEM bundle of the CA that signed the engine's certificate. TCP hosts only. */
  readonly ca?: string;
  /** PEM certificate this control plane presents to the engine. TCP hosts only. */
  readonly cert?: string;
  /** PEM private key matching `cert`. TCP hosts only. */
  readonly key?: string;
  /** OpenSSH or PKCS#8 private key used to log in. SSH hosts only. */
  readonly privateKey?: string;
  /** The SSH host key the operator confirmed, as `SHA256:…`. Required before an SSH host is added. */
  readonly hostKeyFingerprint?: string;
  /** Labels an `auto` create may select this host by. */
  readonly labels?: Record<string, string>;
}

/** A host as the API shows it. It never carries a credential: only where the host is and what it reported. */
export interface HostView {
  readonly id: string;
  readonly name: string;
  readonly transport: Host["transport"];
  readonly endpoint: string;
  readonly status: Host["status"];
  readonly latencyMs: number | null;
  readonly capacity: HostCapacity | null;
  readonly dockerVersion: string | null;
  /** The last failed check, as text. Null once a check succeeds. */
  readonly error: string | null;
  readonly boxes: number;
  readonly createdAt: string | null;
  /** Labels an `auto` create may select this host by. */
  readonly labels: Record<string, string>;
  /** The agent's connection and version. Present on an agent host only. */
  readonly agent?: AgentStatus;
}

/** A code issued for a host an agent will pair with. The code is shown once and expires. */
export interface PairingIssue {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly expiresAt: string;
}

/** What a host runs and uses now, for the overview. An offline host has no current figures. */
export interface HostUsage {
  readonly id: string;
  readonly status: Host["status"];
  /** Containers the engine reported at its last successful check, running and in total. */
  readonly containers: { readonly running: number; readonly total: number } | null;
  /** CPUs and memory the running boxes book. Null while the host is offline or its boxes cannot be listed. */
  readonly allocated: Booking | null;
  /** CPU cores and memory the running boxes use, approximated from their newest samples. Null while no sample is current. */
  readonly usage: { readonly cpus: number; readonly memoryBytes: number } | null;
}

/** Why a host has no `docker system df` reading. Null when it has one. */
type DiskBreakdownReason = "agent_host" | "offline" | "timeout" | "engine";

/**
 * What one host's engine holds, as `docker system df` reports it. An agent host cannot answer, and an engine that is
 * offline, too slow or refusing answers null: the console then says so instead of failing the page.
 */
export interface HostDiskView {
  readonly id: string;
  readonly status: Host["status"];
  /** When this reading was taken. */
  readonly checkedAt: string;
  /** Whether the host's engine can report this at all. False on an agent host. */
  readonly supported: boolean;
  readonly reason: DiskBreakdownReason | null;
  /** The engine's own message, when `reason` is `engine`. */
  readonly detail: string | null;
  readonly breakdown: DiskBreakdown | null;
}

export interface HostError {
  readonly key: string;
  readonly params?: Params;
  readonly message: string;
}

/** The outcome of a connection test. Nothing is saved. A failed test still reports the SSH host key it saw. */
export interface HostTest {
  readonly ok: boolean;
  readonly status: Host["status"];
  readonly latencyMs: number | null;
  readonly capacity: HostCapacity | null;
  readonly dockerVersion: string | null;
  readonly hostKeyFingerprint: string | null;
  readonly error: HostError | null;
}

export interface HostManagerOptions {
  readonly cfg: Config;
  readonly registry: HostRegistry;
  readonly store: HostStore;
  readonly shared: SharedStores;
  /** Builds the engine client for a target. The composition root passes the Docker adapter in. */
  readonly connect: (target: EngineTarget) => Runtime;
  /** Starts what a registered host needs: its sampler and its container watch. */
  readonly attach: (host: HostCtx) => void;
  /** Stops what `attach` started. */
  readonly detach: (host: HostCtx) => void;
  /** Lifts the shared tools volume a host is going away with, through the same guards as any delete. */
  readonly liftToolsVolume?: (host: HostCtx) => Promise<void>;
  /** Called when a remote host's engine becomes reachable, so its boxes are reconciled. */
  readonly onLive?: (host: HostCtx) => void;
  /** The agents that dial in. An agent host's engine is reached through its connection here. */
  readonly agents: AgentHub;
  /**
   * Labels of the local host from the configuration, such as `HOST_LABELS`. They are written into `hosts.json` under the
   * reserved id `local` when the host loads, so one record holds them and a change through the API is kept there.
   */
  readonly localLabels?: Record<string, string>;
  readonly now?: () => Date;
}

interface Probe {
  latencyMs: number | null;
  capacity: HostCapacity | null;
  dockerVersion: string | null;
  containers: { running: number; total: number } | null;
  error: string | null;
}

/** An offline host's failed checks in a row, and the ticks it still sits out before its next check. */
interface Backoff {
  failures: number;
  skip: number;
}

/** Ticks an offline host waits after its `failures`-th failure in a row: none, then 1, 3, 7, and the cap from then on. */
function skipAfter(failures: number): number {
  return Math.min(2 ** (failures - 1) - 1, MAX_SKIPPED_PROBES);
}

interface Prepared {
  readonly endpoint: Endpoint;
  readonly credentials: HostCredentials;
  /** The SSH host key the host presented. Null for TLS and unix hosts. */
  readonly presented: string | null;
}

/** Keeps an engine call from holding a request open. The call is no longer waited on, but it is not cancelled. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  const signal = AbortSignal.timeout(ms);
  try {
    return await untilAborted(promise, signal);
  } catch (e) {
    if (signal.aborted) throw new RuntimeError("unavailable", `no answer within ${ms} ms`);
    throw e;
  }
}

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * One host's `docker system df` reading, with every way of not having one reported instead of thrown. An agent host is
 * never asked: its engine is behind the agent's own connection, which does not carry this read.
 */
async function diskView(ctx: HostCtx, checkedAt: string): Promise<HostDiskView> {
  const base = { id: ctx.host.id, status: ctx.host.status, checkedAt };
  if (ctx.host.transport === "agent") {
    return { ...base, supported: false, reason: "agent_host", detail: null, breakdown: null };
  }
  if (ctx.host.status === "offline") {
    return { ...base, supported: true, reason: "offline", detail: null, breakdown: null };
  }
  const signal = AbortSignal.timeout(ctx.readTimeoutMs);
  try {
    const breakdown = await untilAborted(ctx.runtime.diskBreakdown({ signal }), signal);
    return { ...base, supported: true, reason: null, detail: null, breakdown };
  } catch (e) {
    const detail = e instanceof RuntimeError ? e.detail : reasonOf(e);
    log.warn("host.disk_failed", { host: ctx.host.id, error: detail });
    const reason: DiskBreakdownReason = signal.aborted
      ? "timeout"
      : e instanceof RuntimeError && e.kind === "unavailable"
        ? "offline"
        : "engine";
    return { ...base, supported: true, reason, detail, breakdown: null };
  }
}

/**
 * A checked copy of the labels a caller sends. The rules are the ones the hosts file enforces, and a set that breaks one
 * is a 400 that names the problem, so a label that would never match is refused here instead of on the next start.
 */
function labelsOf(raw: Record<string, string> | undefined): Record<string, string> {
  const labels = raw ?? {};
  const problem = hostLabelsProblem(labels);
  if (problem !== null) throw badRequest(msg("host_labels_invalid", { reason: problem }), { field: "labels" });
  return { ...labels };
}

/** Whether two label sets hold the same entries, so a file that already says what the configuration says is not rewritten. */
function sameLabels(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => b[key] === a[key]);
}

function pemOf(value: string | undefined, field: "ca" | "cert" | "key" | "privateKey", pattern: RegExp): string {
  const text = value?.trim() ?? "";
  if (text === "") throw badRequest(msg("host_credentials_missing", { field }), { field });
  if (text.length > MAX_CREDENTIAL_CHARS || !pattern.test(text)) {
    throw badRequest(msg("host_credentials_invalid", { field }), { field });
  }
  if (ENCRYPTED_KEY.test(text)) throw badRequest(msg("host_key_encrypted", { field }), { field });
  return text;
}

/** The problem with the host key the operator gave, or null when it matches the one the host presented. */
function keyProblem(presented: string | null, given: string | undefined): Msg | null {
  if (presented === null) return null;
  if (given === undefined) return msg("host_key_unconfirmed", { fingerprint: presented });
  if (given !== presented) return msg("host_key_mismatch", { expected: given, presented });
  return null;
}

function hostErrorOf(error: Msg): HostError {
  return { key: error.key, params: error.params, message: error.text };
}

/** The agent a stored host is served by, or null for a host reached by address. */
function agentIdOf(stored: StoredHost): string | null {
  const endpoint = parseEndpoint(stored.endpoint);
  return endpoint.kind === "agent" ? endpoint.agentId : null;
}

/** The engine target of a link that has a socket or address. Only an agent link has none, and it is never checked here. */
function engineTargetOf(target: LinkTarget): EngineTarget {
  if (isAgentTarget(target)) throw new Error("an agent link has no engine target of its own");
  return target;
}

/**
 * Owns the hosts beyond the local one: validates and tests them, stores their credentials, keeps their status and
 * capacity current, and removes them. Every change runs one at a time, so two requests cannot write `hosts.json` at once.
 */
export class HostManager {
  private readonly stored = new Map<string, StoredHost>();
  private readonly links = new Map<string, Link>();
  private readonly probes = new Map<string, Probe>();
  private readonly backoff = new Map<string, Backoff>();
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => Date;

  constructor(private readonly options: HostManagerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Registers every stored host. Opening a link never touches the network, so this returns at once. */
  load(): void {
    const stored = this.options.store.load();
    for (const host of stored) {
      this.stored.set(host.id, host);
      // The local runtime, monitor and sampler already exist. Its record supplies metadata, never another engine.
      if (host.id !== LOCAL_HOST_ID) this.register(host);
    }
    this.adoptConfiguredLocalLabels(stored);
  }

  /**
   * Records the labels the configuration gives the local host. `HOST_LABELS` is a startup default, so it is written into
   * `hosts.json` under the reserved id `local` and the registry's copy of the local host is updated to match. A host that
   * already has a labels field keeps it, including an empty set: an API change or clear must survive an old `.env`.
   */
  private adoptConfiguredLocalLabels(stored: readonly StoredHost[]): void {
    const configured = this.options.localLabels ?? {};
    const existing = stored.find((host) => host.id === LOCAL_HOST_ID);
    const labels = existing?.labels ?? configured;
    if (existing === undefined && Object.keys(labels).length === 0) return;
    if (this.options.registry.has(LOCAL_HOST_ID)) this.options.registry.get(LOCAL_HOST_ID).host.labels = { ...labels };
    if (existing === undefined || !sameLabels(existing.labels ?? {}, labels)) {
      const record: StoredHost = {
        id: LOCAL_HOST_ID,
        name: existing?.name ?? "Local",
        endpoint: existing?.endpoint ?? `unix://${this.options.cfg.dockerSocket}`,
        hostKeyFingerprint: existing?.hostKeyFingerprint ?? null,
        createdAt: existing?.createdAt ?? this.now().toISOString(),
        labels: { ...labels },
      };
      this.persistRecord(record);
    }
  }

  /**
   * Writes one host's record and keeps the rest, in the order the hosts are registered. That order is the order a
   * placement breaks a tie in, and it is the order the file had, so a rewritten file never reorders the hosts. A record
   * for a host that is not registered yet, such as the local host on the first write, goes at the end.
   */
  private persistRecord(record: StoredHost): void {
    this.stored.set(record.id, record);
    const registered = this.options.registry.list().map((ctx) => this.stored.get(ctx.host.id));
    const known = new Set(registered.map((host) => host?.id));
    const rest = [...this.stored.values()].filter((host) => !known.has(host.id));
    this.options.store.save([...registered, ...rest].filter((host): host is StoredHost => host !== undefined));
  }

  /** Starts the periodic check of every host's latency and capacity, and runs the first check of each now. Tests call `probeDue`. */
  start(intervalMs: number = PROBE_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.probeDue(), intervalMs);
    this.timer.unref?.();
    void this.refresh();
  }

  /** Stops the probe timer, what `attach` started for each remote host, and every link. */
  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const ctx of this.options.registry.list()) {
      if (ctx.host.transport !== "local") this.options.detach(ctx);
    }
    for (const link of this.links.values()) link.close();
    this.links.clear();
  }

  list(): HostView[] {
    return this.options.registry.list().map((ctx) => this.view(ctx));
  }

  /** What each host runs and uses now. Each online host is asked once, in parallel. */
  usage(): Promise<HostUsage[]> {
    return Promise.all(this.options.registry.list().map((ctx) => this.usageView(ctx)));
  }

  /**
   * What one host's engine holds (`docker system df`). The read is bounded by the host's read timeout, so a host that
   * does not answer cannot hold up the caller, and every way of having no reading is reported rather than thrown: an
   * agent host, an offline host, a timeout and an engine failure all answer `breakdown: null` with a reason.
   */
  disk(id: string): Promise<HostDiskView> {
    if (!this.options.registry.has(id)) throw notFound(msg("host_not_found", { host: id }));
    return diskView(this.options.registry.get(id), this.now().toISOString());
  }

  /** Probes each host's engine now, whatever its backoff. A failed probe marks the host offline and records why. */
  async refresh(): Promise<void> {
    await Promise.all(this.options.registry.list().map((ctx) => this.probe(ctx)));
  }

  /**
   * One tick of the background check. An online host is probed on every tick. An offline host is probed less often after
   * each failure in a row, so a host that stays down is not dialled every interval. Its link, when it has one, still
   * reports a return at once.
   */
  async probeDue(): Promise<void> {
    const due = this.options.registry.list().filter((ctx) => this.takesTurn(ctx.host.id));
    await Promise.all(due.map((ctx) => this.probe(ctx)));
  }

  /**
   * Adds a host once its connection checks out and, for SSH, once the key it presents is the one the operator confirmed.
   * A failure leaves nothing behind: no credential file, no hosts-file entry, no registered host.
   */
  add(input: HostInput): Promise<HostView> {
    return this.exclusive(async () => {
      const id = this.idOf(input.id);
      if (this.options.registry.has(id) || this.stored.has(id)) throw conflict(msg("host_exists", { host: id }));
      const prepared = await this.prepare(input);
      const problem = keyProblem(prepared.presented, input.hostKeyFingerprint);
      if (problem) throw new AppError(409, "conflict", problem, { fingerprint: prepared.presented });
      const labels = labelsOf(input.labels);
      await this.check(prepared);
      const host: StoredHost = {
        id,
        name: input.name?.trim() || id,
        endpoint: endpointLabel(prepared.endpoint),
        hostKeyFingerprint: prepared.presented,
        createdAt: this.now().toISOString(),
        labels,
      };
      this.persist(host, prepared.credentials);
      this.register(host);
      const ctx = this.options.registry.get(id);
      await this.probe(ctx);
      log.info("host.added", { host: id, transport: ctx.host.transport });
      return this.view(ctx);
    });
  }

  /** Checks a connection without saving anything. A failure is a result, not an error, so the form can show it. */
  async test(input: HostInput): Promise<HostTest> {
    let prepared: Prepared;
    try {
      prepared = await this.prepare(input);
    } catch (e) {
      return this.failed(e, null);
    }
    const problem = keyProblem(prepared.presented, input.hostKeyFingerprint);
    if (problem) return this.failed(new AppError(409, "conflict", problem), prepared.presented);
    try {
      const result = await this.check(prepared);
      return { ok: true, status: "online", hostKeyFingerprint: prepared.presented, error: null, ...result };
    } catch (e) {
      return this.failed(e, prepared.presented);
    }
  }

  /** Forgets a host and deletes its credentials. A host that still holds boxes, volumes or checkpoints is refused. */
  remove(id: string): Promise<HostView> {
    return this.exclusive(async () => {
      if (id === LOCAL_HOST_ID) throw conflict(msg("host_is_local"));
      if (!this.options.registry.has(id)) throw notFound(msg("host_not_found", { host: id }));
      const ctx = this.options.registry.get(id);
      const usage = this.usageOf(id);
      if (usage.total > 0) {
        throw new AppError(409, "conflict", msg("host_in_use", { host: id, count: usage.total }), usage);
      }
      if (this.options.liftToolsVolume) await this.options.liftToolsVolume(ctx);
      const view = this.view(ctx);
      const stored = this.stored.get(id);
      const agentId = stored ? agentIdOf(stored) : null;
      if (agentId !== null) this.options.agents.forget(agentId);
      this.options.store.save([...this.stored.values()].filter((host) => host.id !== id));
      this.options.detach(ctx);
      this.options.registry.remove(id);
      this.links.get(id)?.close();
      this.links.delete(id);
      this.stored.delete(id);
      this.probes.delete(id);
      this.backoff.delete(id);
      this.options.store.removeCredentials(id);
      log.info("host.removed", { host: id });
      return view;
    });
  }

  /**
   * Issues a one-time code for an agent host that does not exist yet. The host is created when an agent pairs with the
   * code, so a code that is never used leaves nothing behind.
   */
  createPairing(input: { readonly id: string; readonly name?: string }): Promise<PairingIssue> {
    return this.exclusive(async () => {
      const id = this.idOf(input.id);
      if (this.options.registry.has(id) || this.stored.has(id)) throw conflict(msg("host_exists", { host: id }));
      const name = input.name?.trim() || id;
      const issued = this.options.agents.issueCode(id, name);
      return { id, name, code: issued.code, expiresAt: issued.expiresAt };
    });
  }

  /**
   * Completes an agent's pairing. The code is spent only once the key and protocol are acceptable, so an agent that
   * speaks another protocol can retry with the same code after it is upgraded. A failure leaves no host and no record.
   */
  pairAgent(input: PairRequest): Promise<PairResponse> {
    return this.exclusive(async () => {
      if (!isEd25519PublicKey(input.publicKey)) throw badRequest(msg("agent_key_invalid"), { field: "publicKey" });
      if (input.protocol !== AGENT_PROTOCOL) {
        throw conflict(msg("agent_protocol_mismatch", { agent: input.protocol, server: AGENT_PROTOCOL }));
      }
      const grant = this.options.agents.spendCode(input.code);
      if (this.options.registry.has(grant.hostId) || this.stored.has(grant.hostId)) {
        throw conflict(msg("host_exists", { host: grant.hostId }));
      }
      const now = this.now().toISOString();
      const record = this.options.agents.enroll({
        hostId: grant.hostId,
        publicKeyPem: input.publicKey,
        version: input.version,
        protocol: input.protocol,
        pairedAt: now,
      });
      const host: StoredHost = {
        id: grant.hostId,
        name: grant.name,
        endpoint: `agent://${record.agentId}`,
        hostKeyFingerprint: null,
        createdAt: now,
        labels: {},
      };
      try {
        this.persist(host, {});
      } catch (e) {
        this.options.agents.forget(record.agentId);
        throw e;
      }
      this.register(host);
      await this.probe(this.options.registry.get(grant.hostId));
      log.info("host.added", { host: grant.hostId, transport: "agent" });
      return { agentId: record.agentId, hostId: grant.hostId, protocol: AGENT_PROTOCOL };
    });
  }

  /** Revokes an agent host's agent. Its connection drops at once and it cannot reconnect. The host stays listed until removed. */
  revoke(id: string): Promise<HostView> {
    return this.exclusive(async () => {
      const agentId = this.agentIdOfHost(id);
      this.options.agents.revoke(agentId);
      const ctx = this.options.registry.get(id);
      ctx.host.status = "offline";
      log.info("agent.revoked", { host: id });
      return this.view(ctx);
    });
  }

  /**
   * Replaces the labels of one host, the local host included. An `auto` create selects a host by these labels, so the
   * change reaches the registry's copy of the host at once and the file keeps it across a restart. An empty set clears
   * them. A label that is not acceptable is refused before anything is written.
   */
  setLabels(id: string, labels: Record<string, string>): Promise<HostView> {
    return this.exclusive(async () => {
      if (!this.options.registry.has(id)) throw notFound(msg("host_not_found", { host: id }));
      const next = labelsOf(labels);
      const ctx = this.options.registry.get(id);
      const stored = this.stored.get(id);
      const record: StoredHost = {
        id,
        name: stored?.name ?? ctx.host.name,
        endpoint: stored?.endpoint ?? ctx.host.endpoint,
        hostKeyFingerprint: stored?.hostKeyFingerprint ?? null,
        createdAt: stored?.createdAt ?? this.now().toISOString(),
        labels: next,
      };
      this.persistRecord(record);
      ctx.host.labels = { ...next };
      log.info("host.labels_set", { host: id, count: Object.keys(next).length });
      return this.view(ctx);
    });
  }

  /** Keeps an agent host's state in step with its agent's connection. A connection that comes back is retried at once. */
  onAgent(event: AgentEvent): void {
    const hostId = this.hostOfAgent(event.agentId);
    if (hostId === null || !this.options.registry.has(hostId)) return;
    const ctx = this.options.registry.get(hostId);
    if (event.type === "connected") {
      ctx.sampler.reconnect();
      void this.probe(ctx);
      return;
    }
    ctx.host.status = "offline";
  }

  /** Records the link state the sampler reports. A remote host that comes live is handed on to be reconciled. */
  onLink(frame: LinkFrame): void {
    if (!this.options.registry.has(frame.hostId)) return;
    const ctx = this.options.registry.get(frame.hostId);
    ctx.host.status = frame.state === "live" ? "online" : "offline";
    if (frame.state === "live" && ctx.host.transport !== "local") this.options.onLive?.(ctx);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private idOf(raw: string): string {
    if (!HOST_ID_RE.test(raw)) throw badRequest(msg("host_id_invalid"), { field: "id" });
    if (raw === LOCAL_HOST_ID) throw conflict(msg("host_exists", { host: raw }));
    if (raw === AUTO_HOST) throw badRequest(msg("host_id_reserved", { host: raw }), { field: "id" });
    return raw;
  }

  /** Validates the endpoint and the credentials the request carries. For SSH it also reads the host key it presents. */
  private async prepare(input: HostInput): Promise<Prepared> {
    const endpoint = this.endpointOf(input.endpoint);
    switch (endpoint.kind) {
      case "unix":
        return { endpoint, credentials: {}, presented: null };
      case "tcp": {
        const tls = {
          ca: pemOf(input.ca, "ca", CERTIFICATE_PEM),
          cert: pemOf(input.cert, "cert", CERTIFICATE_PEM),
          key: pemOf(input.key, "key", PRIVATE_KEY_PEM),
        };
        return { endpoint, credentials: { tls }, presented: null };
      }
      case "ssh": {
        const privateKey = pemOf(input.privateKey, "privateKey", SSH_KEY_PEM);
        this.checkKey(privateKey);
        const presented = await probeHostKey(endpoint.hostname, endpoint.port).catch((e: unknown) => {
          throw new AppError(503, "docker_unavailable", msg("host_unreachable", { detail: reasonOf(e) }));
        });
        return { endpoint, credentials: { ssh: { privateKey, hostKeyFingerprint: presented } }, presented };
      }
      case "agent":
        throw badRequest(msg("host_endpoint_agent"), { field: "endpoint" });
    }
  }

  private endpointOf(raw: string): Endpoint {
    try {
      return parseEndpoint(raw);
    } catch (e) {
      throw badRequest(msg("host_endpoint_invalid", { reason: reasonOf(e) }), { field: "endpoint" });
    }
  }

  private checkKey(privateKey: string): void {
    try {
      checkSshKey(privateKey);
    } catch (e) {
      if (!(e instanceof SshKeyError)) throw e;
      throw badRequest(msg("host_key_invalid", { reason: e.message }), { field: "privateKey" });
    }
  }

  /** Opens a link, connects it and asks the engine for its latency, version and capacity. Throws when a step fails. */
  private async check(prepared: Prepared): Promise<Pick<HostTest, "latencyMs" | "capacity" | "dockerVersion">> {
    const link = openLink(prepared.endpoint, prepared.credentials);
    try {
      const runtime = this.options.connect(engineTargetOf(link.target));
      await within(link.connect(), CHECK_TIMEOUT_MS).catch((e: unknown) => {
        if (e instanceof HostKeyMismatchError) {
          throw new AppError(
            409,
            "conflict",
            msg("host_key_mismatch", { expected: e.expected, presented: e.presented }),
          );
        }
        throw e;
      });
      const started = performance.now();
      await within(runtime.ping(), CHECK_TIMEOUT_MS);
      const latencyMs = Math.round(performance.now() - started);
      const info = await within(runtime.info(), CHECK_TIMEOUT_MS);
      return { latencyMs, capacity: { cpus: info.cpus, memoryBytes: info.memoryBytes }, dockerVersion: info.version };
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(503, "docker_unavailable", msg("host_unreachable", { detail: reasonOf(e) }));
    } finally {
      link.close();
    }
  }

  private failed(e: unknown, presented: string | null): HostTest {
    return {
      ok: false,
      status: "offline",
      latencyMs: null,
      capacity: null,
      dockerVersion: null,
      hostKeyFingerprint: presented,
      error: this.errorOf(e),
    };
  }

  private errorOf(e: unknown): HostError {
    if (e instanceof AppError && e.key !== undefined) {
      return { key: e.key, params: e.params, message: e.message };
    }
    if (e instanceof HostKeyUnconfirmedError) {
      return hostErrorOf(msg("host_key_unconfirmed", { fingerprint: e.presented }));
    }
    return hostErrorOf(msg("host_unreachable", { detail: reasonOf(e) }));
  }

  /** Writes the credential files, then the hosts file. If the hosts file cannot be written, the new files are removed. */
  private persist(host: StoredHost, credentials: HostCredentials): void {
    const { store } = this.options;
    if (credentials.tls) {
      store.writeCredentials(host.id, {
        ca: credentials.tls.ca,
        cert: credentials.tls.cert,
        key: credentials.tls.key,
      });
    } else if (credentials.ssh) {
      store.writeCredentials(host.id, { sshKey: credentials.ssh.privateKey });
    }
    try {
      store.save([...this.stored.values(), host]);
    } catch (e) {
      store.removeCredentials(host.id);
      throw e;
    }
    this.stored.set(host.id, host);
  }

  /** Builds the host's context and attaches it. A host whose credentials are missing is still registered, and every call fails. */
  private register(stored: StoredHost): void {
    const endpoint = parseEndpoint(stored.endpoint);
    const identity: HostIdentity = {
      id: stored.id,
      name: stored.name,
      transport: endpoint.kind,
      endpoint: stored.endpoint,
      labels: stored.labels ?? {},
    };
    let runtime: Runtime;
    if (endpoint.kind === "agent") {
      runtime = this.options.agents.runtimeFor(endpoint.agentId);
    } else {
      try {
        const link = openLink(endpoint, this.credentialsOf(stored, endpoint));
        this.links.set(stored.id, link);
        runtime = this.options.connect(engineTargetOf(link.target));
      } catch (e) {
        const reason = reasonOf(e);
        log.warn("host.credentials_unavailable", { host: stored.id, error: reason });
        runtime = unreachableRuntime(reason);
      }
    }
    const ctx = createHost(this.options.cfg, runtime, this.options.shared, identity);
    this.options.registry.add(ctx);
    this.options.attach(ctx);
  }

  private credentialsOf(stored: StoredHost, endpoint: Endpoint): HostCredentials {
    const { store } = this.options;
    if (endpoint.kind === "unix" || endpoint.kind === "agent") return {};
    if (endpoint.kind === "tcp") {
      const ca = store.readCredential(stored.id, "ca");
      const cert = store.readCredential(stored.id, "cert");
      const key = store.readCredential(stored.id, "key");
      if (ca === null || cert === null || key === null) throw new MissingCredentialsError("tls");
      return { tls: { ca, cert, key } };
    }
    const privateKey = store.readCredential(stored.id, "sshKey");
    if (privateKey === null) throw new MissingCredentialsError("ssh");
    return { ssh: { privateKey, hostKeyFingerprint: stored.hostKeyFingerprint } };
  }

  private takesTurn(id: string): boolean {
    const backoff = this.backoff.get(id);
    if (backoff === undefined || backoff.skip === 0) return true;
    backoff.skip -= 1;
    return false;
  }

  private async probe(ctx: HostCtx): Promise<void> {
    const id = ctx.host.id;
    const previous = this.probes.get(id);
    try {
      const started = performance.now();
      await within(ctx.runtime.ping(), ENGINE_READ_TIMEOUT_MS);
      const latencyMs = Math.round(performance.now() - started);
      const info = await within(ctx.runtime.info(), ENGINE_READ_TIMEOUT_MS);
      ctx.host.status = "online";
      this.backoff.delete(id);
      this.probes.set(id, {
        latencyMs,
        capacity: { cpus: info.cpus, memoryBytes: info.memoryBytes },
        dockerVersion: info.version,
        containers: { running: info.containers.running, total: info.containers.total },
        error: null,
      });
    } catch (e) {
      ctx.host.status = "offline";
      const failures = (this.backoff.get(id)?.failures ?? 0) + 1;
      this.backoff.set(id, { failures, skip: skipAfter(failures) });
      this.probes.set(id, {
        latencyMs: null,
        capacity: previous?.capacity ?? null,
        dockerVersion: previous?.dockerVersion ?? null,
        containers: previous?.containers ?? null,
        error: reasonOf(e),
      });
    }
  }

  private async usageView(ctx: HostCtx): Promise<HostUsage> {
    const id = ctx.host.id;
    const lastKnown = this.probes.get(id)?.containers ?? null;
    if (ctx.host.status !== "online")
      return { id, status: ctx.host.status, containers: lastKnown, allocated: null, usage: null };
    const [info] = await Promise.all([
      within(ctx.runtime.info(), ENGINE_READ_TIMEOUT_MS).catch(() => null),
      ctx.sampler.sampleSoon(),
    ]);
    const containers = info ? { running: info.containers.running, total: info.containers.total } : lastKnown;
    const allocated = await bookedOn(ctx).catch(() => null);
    return { id, status: ctx.host.status, containers, allocated, usage: ctx.sampler.usage() };
  }

  /** What a host still holds. Removal is refused while any of it exists. */
  private usageOf(id: string): { boxes: number; volumes: number; checkpoints: number; total: number } {
    const { registry, shared } = this.options;
    const host = registry.get(id);
    const boxes = host.specs.list().filter((spec) => spec.hostId === id).length;
    // The host's shared tools volumes are its own infrastructure and go with it, so they hold nothing back.
    const volumes = host.volumes.list().filter((volume) => volume.hostId === id && volume.role !== "tools").length;
    const checkpoints = shared.checkpoints.list().filter((checkpoint) => checkpoint.hostId === id).length;
    return { boxes, volumes, checkpoints, total: boxes + volumes + checkpoints };
  }

  private view(ctx: HostCtx): HostView {
    const id = ctx.host.id;
    const probe = this.probes.get(id);
    return {
      id,
      name: ctx.host.name,
      transport: ctx.host.transport,
      endpoint: ctx.host.endpoint,
      status: ctx.host.status,
      latencyMs: probe?.latencyMs ?? null,
      capacity: probe?.capacity ?? null,
      dockerVersion: probe?.dockerVersion ?? null,
      error: probe?.error ?? null,
      boxes: ctx.specs.list().filter((spec) => spec.hostId === id).length,
      createdAt: this.stored.get(id)?.createdAt ?? null,
      labels: { ...ctx.host.labels },
      ...this.agentFieldOf(id),
    };
  }

  /** The agent connection, on an agent host only. Other hosts keep the view they always had. */
  private agentFieldOf(id: string): { agent?: AgentStatus } {
    const status = this.agentStatusOf(id);
    return status ? { agent: status } : {};
  }

  /** The agent id of a host that must be an agent host. Any other host is refused, since it has no agent to revoke. */
  private agentIdOfHost(id: string): string {
    if (!this.options.registry.has(id)) throw notFound(msg("host_not_found", { host: id }));
    const stored = this.stored.get(id);
    const agentId = stored ? agentIdOf(stored) : null;
    if (agentId === null) throw badRequest(msg("host_not_agent", { host: id }), { field: "id" });
    return agentId;
  }

  private hostOfAgent(agentId: string): string | null {
    for (const stored of this.stored.values()) {
      if (agentIdOf(stored) === agentId) return stored.id;
    }
    return null;
  }

  private agentStatusOf(id: string): AgentStatus | null {
    const stored = this.stored.get(id);
    const agentId = stored ? agentIdOf(stored) : null;
    return agentId === null ? null : this.options.agents.status(agentId);
  }
}
