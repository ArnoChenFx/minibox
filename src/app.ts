import { ActivityLog } from "./activity";
import { LoginLimiter } from "./auth";
import type { Config } from "./config";
import { createDockerRuntime } from "./docker/runtime";
import type { HostMonitor } from "./host/metrics";
import { createLocalHost, HostRegistry } from "./host/registry";
import { Executor, type ExecutorHooks, logAudit, ownerOnly } from "./operations/executor";
import { OPERATIONS } from "./operations/registry";
import type { Runtime } from "./runtime";

/** Shared application state passed to every route handler. */
export interface App {
  cfg: Config;
  hosts: HostRegistry;
  monitor: HostMonitor;
  activity: ActivityLog;
  operations: Executor;
  throttle: LoginLimiter;
  version: string;
  startedAt: Date;
}

/** Collaborators a caller may replace. Anything omitted is built from the config. */
export interface AppDeps {
  runtime?: Runtime;
  throttle?: LoginLimiter;
  hooks?: Partial<ExecutorHooks>;
}

export function createApp(cfg: Config, version: string, deps: AppDeps = {}): App {
  const hosts = new HostRegistry();
  const local = createLocalHost(cfg, deps.runtime ?? createDockerRuntime(cfg.dockerSocket));
  hosts.add(local);
  const activity = new ActivityLog();
  return {
    cfg,
    hosts,
    monitor: local.monitor,
    activity,
    operations: new Executor(OPERATIONS, {
      activity,
      hooks: {
        authorize: deps.hooks?.authorize ?? ownerOnly,
        audit: deps.hooks?.audit ?? logAudit,
      },
    }),
    throttle: deps.throttle ?? new LoginLimiter(),
    version,
    startedAt: new Date(),
  };
}
