import type { BoxProfile } from "../box-profile";
import type { SnapshotEngine } from "../checkpoints/engine";
import type { CheckpointPolicy } from "../checkpoints/policy";
import { ResticEngine } from "../checkpoints/restic";
import { CheckpointStore } from "../checkpoints/store";
import type { Config } from "../config";
import { boxNetworkName, type LabelKeys, labelKeys } from "../labels";
import { type Runtime, RuntimeError } from "../runtime";
import { SecretStore } from "../secrets/store";
import { ActivityPulse } from "../services/activity-pulse";
import { BoxPower } from "../services/power";
import { SpecStore } from "../specs/store";
import { VolumeStore } from "../volumes/store";
import { type LiveSink, NO_LIVE } from "./live";
import { HostMonitor } from "./metrics";
import { HostSampler } from "./sampler";

export const LOCAL_HOST_ID = "local";

/** Longest one engine read of a box request may take. Past it the request fails as unavailable instead of waiting on. */
export const ENGINE_READ_TIMEOUT_MS = 5000;

export interface Host {
  id: string;
  name: string;
  kind: "docker";
  /** The endpoint as text, without any credential. */
  endpoint: string;
  labels: Record<string, string>;
  status: "online" | "offline" | "unknown";
  /** `local` is the machine MiniBox runs on. The others are the ways a remote engine is reached. */
  transport: "local" | "unix" | "tcp" | "ssh";
}

/** Box hardening settings that apply to one engine. Each box records the profile it was created with. */
export interface HostSecurity {
  defaultProfile: BoxProfile;
  pidsLimit: number;
  runtime: string | null;
  network: string;
}

/** What a host can give to boxes. Null where the engine does not report the figure. */
export interface HostCapacity {
  readonly cpus: number | null;
  readonly memoryBytes: number | null;
}

/** Everything business code needs to act on one host. `host.id` is the hostId the internal APIs are scoped by. */
export interface HostCtx {
  host: Host;
  runtime: Runtime;
  prefix: string;
  keys: LabelKeys;
  baseTemplateTag: string;
  stopTimeoutSec: number;
  /** Longest one engine read of a box request may take. See `ENGINE_READ_TIMEOUT_MS`. */
  readTimeoutMs: number;
  templatesDir: string;
  security: HostSecurity;
  /** The local machine's metrics. Only the local host runs it; a remote host's figures come from its engine. */
  monitor: HostMonitor;
  /** The one event subscription and box cache of this host. Started once the host has been reconciled. */
  sampler: HostSampler;
  /** Control-plane spec store. One store is shared by every host; files live under `DATA_DIR/boxes`. */
  specs: SpecStore;
  /** Control-plane volume and pool store. One store is shared by every host; files live under `DATA_DIR`. */
  volumes: VolumeStore;
  /** Secrets that box environment variables reference. One store is shared by every host; files live under `DATA_DIR/secrets/env`. */
  secrets: SecretStore;
  /** In-memory activity heartbeats for idle sleep (#12). Shared across hosts of one control plane. */
  pulse: ActivityPulse;
  /** Checkpoint records. One store is shared by every host, files live under `DATA_DIR/checkpoints`. */
  checkpoints: CheckpointStore;
  /** Stores volume contents for checkpoints. Each host keeps its own repository behind this engine. */
  checkpointEngine: SnapshotEngine;
  /** How automatic checkpoints are kept and how much repository space they may use. */
  checkpointPolicy: CheckpointPolicy;
  /** Serializes start, stop, sleep and wake of this host's boxes (#12). */
  power: BoxPower;
  /** CPU and memory a single box may take on this host. The local host reads the machine, others read the engine. */
  capacity(): Promise<HostCapacity>;
  /** True when the control plane holds more than one host. Box payloads name their host only then. */
  multiHost(): boolean;
}

/** The stores every host of one control plane shares. Hosts differ only in their runtime and identity. */
export interface SharedStores {
  readonly specs: SpecStore;
  readonly volumes: VolumeStore;
  readonly secrets: SecretStore;
  readonly live: LiveSink;
  readonly pulse: ActivityPulse;
  readonly checkpoints: CheckpointStore;
  readonly checkpointEngine: SnapshotEngine;
  readonly multiHost: () => boolean;
}

export interface HostIdentity {
  readonly id: string;
  readonly name: string;
  readonly transport: Host["transport"];
  readonly endpoint: string;
}

export interface LocalHostOptions {
  /** Host id. Defaults to `local`; a second host needs its own id. */
  readonly id?: string;
  readonly name?: string;
  /** Defaults to a store under `DATA_DIR/checkpoints`. */
  readonly checkpoints?: CheckpointStore;
  /** Defaults to the restic engine. */
  readonly checkpointEngine?: SnapshotEngine;
  /** Defaults to a store under `DATA_DIR/secrets/env`. */
  readonly secrets?: SecretStore;
  /** Defaults to a control plane with one host. The app passes the registry's count. */
  readonly multiHost?: () => boolean;
}

/** The host every box has when no other is configured. Its runtime is passed in, so a test can supply a fake. */
export function createHost(cfg: Config, runtime: Runtime, shared: SharedStores, identity: HostIdentity): HostCtx {
  const ctx: HostCtx = {
    host: {
      id: identity.id,
      name: identity.name,
      kind: "docker",
      endpoint: identity.endpoint,
      labels: {},
      status: "unknown",
      transport: identity.transport,
    },
    runtime,
    prefix: cfg.labelPrefix,
    keys: labelKeys(cfg.labelPrefix),
    baseTemplateTag: cfg.baseTemplateTag,
    stopTimeoutSec: cfg.stopTimeoutSec,
    readTimeoutMs: ENGINE_READ_TIMEOUT_MS,
    templatesDir: cfg.templatesDir,
    security: {
      defaultProfile: cfg.boxProfile,
      pidsLimit: cfg.boxPidsLimit,
      runtime: cfg.containerRuntime,
      network: boxNetworkName(cfg.labelPrefix),
    },
    monitor: new HostMonitor(() => ctx, cfg.metricsIntervalMs, cfg.metricsHistory, shared.live),
    sampler: new HostSampler(
      () => ctx,
      { intervalMs: cfg.metricsIntervalMs, history: cfg.metricsHistory },
      shared.live,
    ),
    specs: shared.specs,
    volumes: shared.volumes,
    secrets: shared.secrets,
    pulse: shared.pulse,
    checkpoints: shared.checkpoints,
    checkpointEngine: shared.checkpointEngine,
    checkpointPolicy: {
      keepLast: cfg.checkpointKeepLast,
      keepDays: cfg.checkpointKeepDays,
      capacityBytes: cfg.checkpointCapacityMb * 1024 * 1024,
    },
    power: new BoxPower(),
    capacity: async () => {
      if (identity.transport !== "local") return engineCapacity(runtime);
      const metrics = await ctx.monitor.snapshot();
      return { cpus: metrics.cpu.cores, memoryBytes: metrics.memory.total };
    },
    multiHost: shared.multiHost,
  };
  return ctx;
}

async function engineCapacity(runtime: Runtime): Promise<HostCapacity> {
  const info = await runtime.info();
  return { cpus: info.cpus, memoryBytes: info.memoryBytes };
}

/**
 * Single-machine installs get one implicit host with the configured Docker socket.
 * `specs` and `volumes` default to stores for `cfg.dataDir`. Pass one of each when several hosts share a control plane.
 * `live` receives the host's live frames (box state, samples, host metrics, link state).
 */
export function createLocalHost(
  cfg: Config,
  runtime: Runtime,
  specs: SpecStore = new SpecStore(cfg.dataDir),
  volumes: VolumeStore = new VolumeStore(cfg.dataDir),
  live: LiveSink = NO_LIVE,
  pulse: ActivityPulse = new ActivityPulse(),
  options: LocalHostOptions = {},
): HostCtx {
  return createHost(
    cfg,
    runtime,
    {
      specs,
      volumes,
      secrets: options.secrets ?? new SecretStore(cfg.dataDir),
      live,
      pulse,
      checkpoints: options.checkpoints ?? new CheckpointStore(cfg.dataDir),
      checkpointEngine: options.checkpointEngine ?? new ResticEngine({ dataDir: cfg.dataDir }),
      multiHost: options.multiHost ?? (() => false),
    },
    {
      id: options.id ?? LOCAL_HOST_ID,
      name: options.name ?? "Local",
      transport: "local",
      endpoint: `unix://${cfg.dockerSocket}`,
    },
  );
}

/**
 * The runtime of a host that could not be opened, such as one whose credential file was removed by hand. Every call fails
 * as unavailable, so the host stays listed and its boxes show as unreachable rather than vanishing.
 */
export function unreachableRuntime(reason: string): Runtime {
  const fail = () => Promise.reject(new RuntimeError("unavailable", reason));
  return new Proxy({} as Runtime, {
    get: (_target, property) => (property === "then" ? undefined : fail),
  });
}

export class HostRegistry {
  private readonly hosts = new Map<string, HostCtx>();

  add(ctx: HostCtx): void {
    if (this.hosts.has(ctx.host.id)) throw new Error(`host already registered: ${ctx.host.id}`);
    this.hosts.set(ctx.host.id, ctx);
  }

  /** Forgets a host. The local host cannot be forgotten, since every install has one. */
  remove(hostId: string): HostCtx | undefined {
    if (hostId === LOCAL_HOST_ID) throw new Error("the local host cannot be removed");
    const ctx = this.hosts.get(hostId);
    this.hosts.delete(hostId);
    return ctx;
  }

  has(hostId: string): boolean {
    return this.hosts.has(hostId);
  }

  list(): HostCtx[] {
    return [...this.hosts.values()];
  }

  /** Defaults to `local`. Unknown ids are a programming error: no route accepts a host id yet. */
  get(hostId: string = LOCAL_HOST_ID): HostCtx {
    const ctx = this.hosts.get(hostId);
    if (!ctx) throw new Error(`unknown host: ${hostId}`);
    return ctx;
  }
}

/** Pings the engine and records the result on the host. */
export async function probeHost(ctx: HostCtx): Promise<Host["status"]> {
  try {
    await ctx.runtime.ping();
    ctx.host.status = "online";
  } catch {
    ctx.host.status = "offline";
  }
  return ctx.host.status;
}
