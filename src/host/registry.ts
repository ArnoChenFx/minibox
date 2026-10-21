import type { BoxProfile } from "../box-profile";
import type { Config } from "../config";
import { boxNetworkName, type LabelKeys, labelKeys } from "../labels";
import type { Runtime } from "../runtime";
import { SpecStore } from "../specs/store";
import { VolumeStore } from "../volumes/store";
import { type LiveSink, NO_LIVE } from "./live";
import { HostMonitor } from "./metrics";
import { HostSampler } from "./sampler";

export const LOCAL_HOST_ID = "local";

export interface Host {
  id: string;
  name: string;
  kind: "docker";
  endpoint: string;
  labels: Record<string, string>;
  status: "online" | "offline" | "unknown";
}

/** Box hardening settings that apply to one engine. Each box records the profile it was created with. */
export interface HostSecurity {
  defaultProfile: BoxProfile;
  pidsLimit: number;
  runtime: string | null;
  network: string;
}

/** Everything business code needs to act on one host. `host.id` is the hostId the internal APIs are scoped by. */
export interface HostCtx {
  host: Host;
  runtime: Runtime;
  prefix: string;
  keys: LabelKeys;
  baseTemplateTag: string;
  stopTimeoutSec: number;
  templatesDir: string;
  security: HostSecurity;
  monitor: HostMonitor;
  /** The one event subscription and box cache of this host. Started once the host has been reconciled. */
  sampler: HostSampler;
  /** Control-plane spec store. One store is shared by every host; files live under `DATA_DIR/boxes`. */
  specs: SpecStore;
  /** Control-plane volume and pool store. One store is shared by every host; files live under `DATA_DIR`. */
  volumes: VolumeStore;
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
): HostCtx {
  const ctx: HostCtx = {
    host: {
      id: LOCAL_HOST_ID,
      name: "Local",
      kind: "docker",
      endpoint: `unix://${cfg.dockerSocket}`,
      labels: {},
      status: "unknown",
    },
    runtime,
    prefix: cfg.labelPrefix,
    keys: labelKeys(cfg.labelPrefix),
    baseTemplateTag: cfg.baseTemplateTag,
    stopTimeoutSec: cfg.stopTimeoutSec,
    templatesDir: cfg.templatesDir,
    security: {
      defaultProfile: cfg.boxProfile,
      pidsLimit: cfg.boxPidsLimit,
      runtime: cfg.containerRuntime,
      network: boxNetworkName(cfg.labelPrefix),
    },
    monitor: new HostMonitor(() => ctx, cfg.metricsIntervalMs, cfg.metricsHistory, live),
    sampler: new HostSampler(() => ctx, { intervalMs: cfg.metricsIntervalMs, history: cfg.metricsHistory }, live),
    specs,
    volumes,
  };
  return ctx;
}

export class HostRegistry {
  private readonly hosts = new Map<string, HostCtx>();

  add(ctx: HostCtx): void {
    if (this.hosts.has(ctx.host.id)) throw new Error(`host already registered: ${ctx.host.id}`);
    this.hosts.set(ctx.host.id, ctx);
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
