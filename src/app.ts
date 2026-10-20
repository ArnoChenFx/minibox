import { ActivityLog } from "./activity";
import { LoginLimiter } from "./auth";
import type { Config } from "./config";
import { createDockerRuntime } from "./docker/runtime";
import { HostMonitor } from "./host/metrics";
import { createLocalHost, HostRegistry } from "./host/registry";
import type { Runtime } from "./runtime";

/** Shared application state passed to every route handler. */
export interface App {
  cfg: Config;
  hosts: HostRegistry;
  monitor: HostMonitor;
  activity: ActivityLog;
  throttle: LoginLimiter;
  version: string;
  startedAt: Date;
}

/** Collaborators a caller may replace. Anything omitted is built from the config. */
export interface AppDeps {
  runtime?: Runtime;
  throttle?: LoginLimiter;
}

export function createApp(cfg: Config, version: string, deps: AppDeps = {}): App {
  const hosts = new HostRegistry();
  const local = createLocalHost(cfg, deps.runtime ?? createDockerRuntime(cfg.dockerSocket));
  hosts.add(local);
  return {
    cfg,
    hosts,
    monitor: new HostMonitor(local, cfg.metricsIntervalMs, cfg.metricsHistory),
    activity: new ActivityLog(),
    throttle: deps.throttle ?? new LoginLimiter(),
    version,
    startedAt: new Date(),
  };
}
