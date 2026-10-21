import { join } from "node:path";

import { ActivityLog } from "./activity";
import { LoginLimiter } from "./auth";
import type { Config } from "./config";
import { sessionsPath } from "./data-dir";
import { createDockerRuntime } from "./docker/runtime";
import { OutputStore } from "./events/outputs";
import { createRedactor, type Redactor } from "./events/redact";
import { RetentionJob } from "./events/retention";
import { EventStore, type StoredEvent } from "./events/store";
import type { HostMonitor } from "./host/metrics";
import { createLocalHost, HostRegistry } from "./host/registry";
import { Bus } from "./lib/bus";
import { log } from "./lib/logger";
import { Executor, type ExecutorHooks, logAudit, ownerOnly, type AuditEvent } from "./operations/executor";
import { OPERATIONS } from "./operations/registry";
import type { Runtime } from "./runtime";
import { SessionStore } from "./sessions";
import { SpecStore } from "./specs/store";
import { TaskManager } from "./tasks/manager";
import { TaskStore } from "./tasks/store";
import type { TaskStreamEvent } from "./tasks/types";
import { VolumeStore } from "./volumes/store";

/** What the in-process bus carries. Box status (#17) can add its topic here. */
export type AppTopics = {
  /** A stored event. Reads merged into an earlier row of the same minute are not published again. */
  event: StoredEvent;
  /** A line of task output, or a task status change. The task stream and the UI subscribe to this. */
  task: TaskStreamEvent;
};

/** Shared application state passed to every route handler. */
export interface App {
  cfg: Config;
  hosts: HostRegistry;
  monitor: HostMonitor;
  activity: ActivityLog;
  events: EventStore;
  outputs: OutputStore;
  bus: Bus<AppTopics>;
  retention: RetentionJob;
  tasks: TaskManager;
  operations: Executor;
  throttle: LoginLimiter;
  sessions: SessionStore;
  version: string;
  startedAt: Date;
}

/** Collaborators a caller may replace. Anything omitted is built from the config. */
export interface AppDeps {
  runtime?: Runtime;
  throttle?: LoginLimiter;
  hooks?: Partial<ExecutorHooks>;
  /** The SQLite file of the event store. Defaults to `events.db` under DATA_DIR. Tests pass `:memory:`. */
  eventsPath?: string;
  sessions?: SessionStore;
}

const MB = 1024 * 1024;

/** Logs each execution, stores it, and publishes it unless it was merged into an earlier read. */
function recordAudit(events: EventStore, bus: Bus<AppTopics>): (event: AuditEvent) => void {
  return (event) => {
    logAudit(event);
    const { event: stored, merged } = events.append(event);
    if (!merged) bus.publish("event", stored);
  };
}

function openEventStore(path: string, redactor: Redactor): EventStore {
  try {
    return new EventStore(path, redactor);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`The event store at ${path} cannot be opened (${reason}). Make DATA_DIR writable.`, { cause: e });
  }
}

function openTaskStore(path: string): TaskStore {
  try {
    return new TaskStore(path);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`The task store at ${path} cannot be opened (${reason}). Make DATA_DIR writable.`, { cause: e });
  }
}

export function createApp(cfg: Config, version: string, deps: AppDeps = {}): App {
  const hosts = new HostRegistry();
  const specs = new SpecStore(cfg.dataDir);
  const volumes = new VolumeStore(cfg.dataDir);
  const local = createLocalHost(cfg, deps.runtime ?? createDockerRuntime(cfg.dockerSocket), specs, volumes);
  hosts.add(local);
  const activity = new ActivityLog();
  const redactor = createRedactor({ knownSecrets: [cfg.accessKey] });
  const events = openEventStore(deps.eventsPath ?? join(cfg.dataDir, "events.db"), redactor);
  const outputs = new OutputStore(join(cfg.dataDir, "exec"), redactor);
  const bus = new Bus<AppTopics>();
  const tasks = new TaskManager(openTaskStore(join(cfg.dataDir, "tasks.db")), redactor, (event) =>
    bus.publish("task", event),
  );
  const interrupted = tasks.recover();
  if (interrupted > 0) log.info("task.interrupted", { count: interrupted });
  const retention = new RetentionJob(events, outputs, {
    auditDays: cfg.eventRetentionAuditDays,
    activityDays: cfg.eventRetentionActivityDays,
    outputDays: cfg.eventOutputRetentionDays,
    outputMaxBytes: cfg.eventOutputMaxMb * MB,
  });
  return {
    cfg,
    hosts,
    monitor: local.monitor,
    activity,
    events,
    outputs,
    bus,
    retention,
    tasks,
    operations: new Executor(OPERATIONS, {
      activity,
      tasks,
      hooks: {
        authorize: deps.hooks?.authorize ?? ownerOnly,
        audit: deps.hooks?.audit ?? recordAudit(events, bus),
      },
    }),
    throttle: deps.throttle ?? new LoginLimiter(),
    sessions:
      deps.sessions ??
      new SessionStore({
        file: sessionsPath(cfg.dataDir),
        accessKey: cfg.accessKey,
        ttlMs: cfg.sessionTtlMs,
        idleMs: cfg.sessionIdleMs,
      }),
    version,
    startedAt: new Date(),
  };
}
