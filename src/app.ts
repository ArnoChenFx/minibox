import { ActivityLog } from "./activity";
import { LoginThrottle } from "./auth";
import type { Config } from "./config";
import { createDockerCtx, type DockerCtx } from "./docker/client";
import { HostMonitor } from "./host/metrics";

/** Shared application state passed to every route handler. */
export interface App {
  cfg: Config;
  docker: DockerCtx;
  monitor: HostMonitor;
  activity: ActivityLog;
  throttle: LoginThrottle;
  version: string;
  startedAt: Date;
}

export function createApp(cfg: Config, version: string): App {
  const docker = createDockerCtx(cfg);
  return {
    cfg,
    docker,
    monitor: new HostMonitor(docker, cfg.metricsIntervalMs, cfg.metricsHistory),
    activity: new ActivityLog(),
    throttle: new LoginThrottle(),
    version,
    startedAt: new Date(),
  };
}
