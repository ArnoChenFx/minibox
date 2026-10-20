import { ActivityLog } from "./activity";
import { LoginLimiter } from "./auth";
import type { Config } from "./config";
import { createDockerCtx, type DockerCtx } from "./docker/client";
import { HostMonitor } from "./host/metrics";

/** Shared application state passed to every route handler. */
export interface App {
  cfg: Config;
  docker: DockerCtx;
  monitor: HostMonitor;
  activity: ActivityLog;
  throttle: LoginLimiter;
  version: string;
  startedAt: Date;
}

export function createApp(cfg: Config, version: string, throttle = new LoginLimiter()): App {
  const docker = createDockerCtx(cfg);
  return {
    cfg,
    docker,
    monitor: new HostMonitor(docker, cfg.metricsIntervalMs, cfg.metricsHistory),
    activity: new ActivityLog(),
    throttle,
    version,
    startedAt: new Date(),
  };
}
