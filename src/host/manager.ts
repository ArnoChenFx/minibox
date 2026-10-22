import { AGENT_PROTOCOL, type PairRequest, type PairResponse, isEd25519PublicKey } from "../agent/protocol";
import type { Config } from "../config";
import { untilAborted } from "../lib/abort";
import { AppError, badRequest, conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { type Msg, type Params, msg } from "../lib/messages";
import { type EngineTarget, type Runtime, RuntimeError } from "../runtime";
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
import { AUTO_HOST, HOST_ID_RE, type HostStore, type StoredHost } from "./store";

export const PROBE_INTERVAL_MS = 30_000;
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
  /** Called when a remote host's engine becomes reachable, so its boxes are reconciled. */
  readonly onLive?: (host: HostCtx) => void;
  /** The agents that dial in. An agent host's engine is reached through its connection here. */
  readonly agents: AgentHub;
  readonly now?: () => Date;
}

interface Probe {
  latencyMs: number | null;
  capacity: HostCapacity | null;
  dockerVersion: string | null;
  containers: { running: number; total: number } | null;
  error: string | null;
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
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => Date;

  constructor(private readonly options: HostManagerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Registers every stored host. Opening a link never touches the network, so this returns at once. */
  load(): void {
    for (const host of this.options.store.load()) {
      this.stored.set(host.id, host);
      this.register(host);
    }
  }

  /** Starts the periodic check of every host's latency and capacity, and runs the first check now. Tests call `refresh`. */
  start(intervalMs: number = PROBE_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(), intervalMs);
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

  /** Probes each host's engine. A failed probe marks the host offline and records why. */
  async refresh(): Promise<void> {
    await Promise.all(this.options.registry.list().map((ctx) => this.probe(ctx)));
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
      await this.check(prepared);
      const host: StoredHost = {
        id,
        name: input.name?.trim() || id,
        endpoint: endpointLabel(prepared.endpoint),
        hostKeyFingerprint: prepared.presented,
        createdAt: this.now().toISOString(),
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

  private async probe(ctx: HostCtx): Promise<void> {
    const id = ctx.host.id;
    const previous = this.probes.get(id);
    try {
      const started = performance.now();
      await within(ctx.runtime.ping(), ENGINE_READ_TIMEOUT_MS);
      const latencyMs = Math.round(performance.now() - started);
      const info = await within(ctx.runtime.info(), ENGINE_READ_TIMEOUT_MS);
      ctx.host.status = "online";
      this.probes.set(id, {
        latencyMs,
        capacity: { cpus: info.cpus, memoryBytes: info.memoryBytes },
        dockerVersion: info.version,
        containers: { running: info.containers.running, total: info.containers.total },
        error: null,
      });
    } catch (e) {
      ctx.host.status = "offline";
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
    const volumes = host.volumes.list().filter((volume) => volume.hostId === id).length;
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
