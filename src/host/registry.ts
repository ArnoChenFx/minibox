import type { Config } from "../config";
import { type LabelKeys, labelKeys } from "../labels";
import type { Runtime } from "../runtime";
import { HostMonitor } from "./metrics";

export const LOCAL_HOST_ID = "local";

export interface Host {
  id: string;
  name: string;
  kind: "docker";
  endpoint: string;
  labels: Record<string, string>;
  status: "online" | "offline" | "unknown";
}

/** Everything business code needs to act on one host. `host.id` is the hostId the internal APIs are scoped by. */
export interface HostCtx {
  host: Host;
  runtime: Runtime;
  prefix: string;
  keys: LabelKeys;
  baseTemplateTag: string;
  templatesDir: string;
  monitor: HostMonitor;
}

/** Single-machine installs get one implicit host with the configured Docker socket. */
export function createLocalHost(cfg: Config, runtime: Runtime): HostCtx {
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
    templatesDir: cfg.templatesDir,
    monitor: new HostMonitor(() => ctx, cfg.metricsIntervalMs, cfg.metricsHistory),
  };
  return ctx;
}

export class HostRegistry {
  private readonly hosts = new Map<string, HostCtx>();

  add(ctx: HostCtx): void {
    if (this.hosts.has(ctx.host.id)) throw new Error(`host already registered: ${ctx.host.id}`);
    this.hosts.set(ctx.host.id, ctx);
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
