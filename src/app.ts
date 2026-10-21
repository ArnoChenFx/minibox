import { join } from "node:path";

import { ActivityLog } from "./activity";
import { LoginLimiter } from "./auth";
import type { Config } from "./config";
import { sessionsPath } from "./data-dir";
import { createDockerRuntime } from "./docker/runtime";
import { OutputStore } from "./events/outputs";
import { createRedactor, type Redactor } from "./events/redact";
import { RetentionJob } from "./events/retention";
import { StreamSlots } from "./events/slots";
import { EventStore, type StoredEvent } from "./events/store";
import { ulid } from "./events/ulid";
import type { LiveTopics } from "./host/live";
import type { HostMonitor } from "./host/metrics";
import { createLocalHost, HostRegistry } from "./host/registry";
import { Bus } from "./lib/bus";
import { log } from "./lib/logger";
import { McpSessions } from "./mcp/sessions";
import { Executor, type ExecutorHooks, logAudit, ownerOnly, type AuditEvent } from "./operations/executor";
import { OPERATIONS } from "./operations/registry";
import { OWNER } from "./routes/operations";
import type { Runtime } from "./runtime";
import { ContainerWatch } from "./services/container-watch";
import { ExecManager } from "./services/exec";
import { type RecordNote, TerminalService } from "./services/terminals";
import { SessionStore } from "./sessions";
import { SpecStore } from "./specs/store";
import { TaskManager } from "./tasks/manager";
import { TaskStore } from "./tasks/store";
import type { TaskStreamEvent } from "./tasks/types";

/**
 * What the in-process bus carries. The audit log and live box state share it, so one subscriber sees both. Only `event`
 * is written to the event store: the live topics are ephemeral and are never persisted.
 */
export type AppTopics = {
  /** A stored event. Reads merged into an earlier row of the same minute are not published again. */
  event: StoredEvent;
  /** A line of task output, or a task status change. The task stream and the UI subscribe to this. */
  task: TaskStreamEvent;
  box: LiveTopics["box"];
  sample: LiveTopics["sample"];
  link: LiveTopics["link"];
  host: LiveTopics["host"];
};

/** Shared application state passed to every route handler. */
export interface App {
  cfg: Config;
  hosts: HostRegistry;
  monitor: HostMonitor;
  activity: ActivityLog;
  events: EventStore;
  outputs: OutputStore;
  execs: ExecManager;
  terminals: TerminalService;
  containers: ContainerWatch;
  mcpSessions: McpSessions;
  bus: Bus<AppTopics>;
  retention: RetentionJob;
  tasks: TaskManager;
  operations: Executor;
  throttle: LoginLimiter;
  sessions: SessionStore;
  streams: StreamSlots;
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

/** Turns a note a service wrote, such as a terminal opening, into an event for the owner and hands it to the audit hook. */
function recordNoteWith(audit: (event: AuditEvent) => void): RecordNote {
  return (hostId, source, note) => {
    const ts = Date.now();
    audit({
      id: ulid(ts),
      ts,
      durationMs: note.durationMs ?? 0,
      status: note.status,
      op: note.op,
      kind: note.kind,
      principal: OWNER,
      source,
      hostId,
      summary: note.summary,
      target: note.target,
      detail: note.detail,
      ref: note.ref,
      error: note.error,
    });
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
  const bus = new Bus<AppTopics>();
  const local = createLocalHost(cfg, deps.runtime ?? createDockerRuntime(cfg.dockerSocket), specs, bus);
  hosts.add(local);
  const activity = new ActivityLog();
  const redactor = createRedactor({ knownSecrets: [cfg.accessKey] });
  const events = openEventStore(deps.eventsPath ?? join(cfg.dataDir, "events.db"), redactor);
  const outputs = new OutputStore(join(cfg.dataDir, "exec"), redactor);
  const execs = new ExecManager(outputs, (text) => redactor.text(text));
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
  const audit = deps.hooks?.audit ?? recordAudit(events, bus);
  const recordNote = recordNoteWith(audit);
  return {
    cfg,
    hosts,
    monitor: local.monitor,
    activity,
    events,
    outputs,
    execs,
    terminals: new TerminalService({
      record: recordNote,
      takeoverIdleMs: cfg.takeoverIdleSec * 1000,
    }),
    containers: new ContainerWatch(hosts, recordNote),
    mcpSessions: new McpSessions(),
    bus,
    retention,
    tasks,
    operations: new Executor(OPERATIONS, {
      activity,
      tasks,
      hooks: {
        authorize: deps.hooks?.authorize ?? ownerOnly,
        audit,
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
    streams: new StreamSlots(cfg.streamMaxConnections),
    version,
    startedAt: new Date(),
  };
}
