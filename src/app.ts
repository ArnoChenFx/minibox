import { join } from "node:path";

import { ActivityLog } from "./activity";
import { LoginLimiter } from "./auth";
import type { SnapshotEngine } from "./checkpoints/engine";
import { ResticEngine } from "./checkpoints/restic";
import { CheckpointStore } from "./checkpoints/store";
import type { Config } from "./config";
import { sessionsPath, tokensPath } from "./data-dir";
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
import { type AuditEvent, Executor, type ExecutorHooks, logAudit } from "./operations/executor";
import { OPERATIONS } from "./operations/registry";
import type { Runtime } from "./runtime";
import { ActivityPulse } from "./services/activity-pulse";
import { CheckpointSweep } from "./services/checkpoint-retention";
import { ContainerWatch } from "./services/container-watch";
import { ExecManager } from "./services/exec";
import { LifecycleWatcher } from "./services/lifecycle";
import { type RecordNote, TerminalService } from "./services/terminals";
import { SessionStore } from "./sessions";
import { SpecStore } from "./specs/store";
import { SshGateway } from "./ssh/gateway";
import { loadHostKey } from "./ssh/host-key";
import { TaskManager, type TaskSubject } from "./tasks/manager";
import { TaskStore } from "./tasks/store";
import type { TaskStreamEvent } from "./tasks/types";
import { authorizeOperation } from "./tokens/authorize";
import { TokenStore } from "./tokens/store";
import { VolumeStore } from "./volumes/store";

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
  /** Writes an audit note for an action a route takes outside the operation registry, such as opening a log stream. */
  recordNote: RecordNote;
  mcpSessions: McpSessions;
  bus: Bus<AppTopics>;
  retention: RetentionJob;
  /** Removes automatic checkpoints the retention policy no longer keeps, and reports repositories near their limit. */
  checkpointSweep: CheckpointSweep;
  tasks: TaskManager;
  operations: Executor;
  throttle: LoginLimiter;
  sessions: SessionStore;
  tokens: TokenStore;
  streams: StreamSlots;
  pulse: ActivityPulse;
  lifecycle: LifecycleWatcher;
  ssh: SshGateway;
  /** Writes an audit note for a request caused by a transport, such as a wake from a terminal or preview. */
  record: RecordNote;
  version: string;
  startedAt: Date;
}

/** Collaborators a caller may replace. Anything omitted is built from the config. */
export interface AppDeps {
  runtime?: Runtime;
  /** Where checkpoint volume contents go. Defaults to restic in a helper image. Tests pass an in-memory engine. */
  checkpointEngine?: SnapshotEngine;
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

/** Turns a note a service wrote, such as a terminal opening, into an event for the principal that caused it. */
function recordNoteWith(audit: (event: AuditEvent) => void): RecordNote {
  return (hostId, source, principal, note) => {
    const ts = Date.now();
    audit({
      id: ulid(ts),
      ts,
      durationMs: note.durationMs ?? 0,
      status: note.status,
      op: note.op,
      kind: note.kind,
      principal,
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

/**
 * A box task keeps the box awake while it runs. When it ends, its end is activity too, so the idle window starts from
 * there rather than from the last request before the task began (#12).
 */
function touchSettledBox(hosts: HostRegistry, pulse: ActivityPulse, subject: TaskSubject): void {
  const target = subject.target;
  if (target?.kind !== "box" || target.id === undefined) return;
  const host = hosts.list().find((candidate) => candidate.host.id === subject.hostId);
  const spec = host?.specs.findByContainer(target.id, target.name);
  if (spec) pulse.touch(spec.id, "task");
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
  const bus = new Bus<AppTopics>();
  const pulse = new ActivityPulse();
  const checkpoints = new CheckpointStore(cfg.dataDir);
  const checkpointEngine = deps.checkpointEngine ?? new ResticEngine({ dataDir: cfg.dataDir });
  const local = createLocalHost(
    cfg,
    deps.runtime ?? createDockerRuntime(cfg.dockerSocket),
    specs,
    volumes,
    bus,
    pulse,
    { checkpoints, checkpointEngine },
  );
  hosts.add(local);
  const activity = new ActivityLog();
  const knownSecrets = [cfg.accessKey];
  const redactor = createRedactor({ knownSecrets });
  const tokens = new TokenStore({
    file: tokensPath(cfg.dataDir),
    secrets: { add: (secret) => knownSecrets.push(secret) },
  });
  const events = openEventStore(deps.eventsPath ?? join(cfg.dataDir, "events.db"), redactor);
  const outputs = new OutputStore(join(cfg.dataDir, "exec"), redactor);
  const execs = new ExecManager(outputs, (text) => redactor.text(text));
  execs.setActivityHandler((boxId) => pulse.touch(boxId, "exec"));
  const tasks = new TaskManager(
    openTaskStore(join(cfg.dataDir, "tasks.db")),
    redactor,
    (event) => bus.publish("task", event),
    (subject) => touchSettledBox(hosts, pulse, subject),
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
  const terminals = new TerminalService({
    record: recordNote,
    takeoverIdleMs: cfg.takeoverIdleSec * 1000,
    onActivity: (boxId, kind) => pulse.touch(boxId, kind),
    hold: (boxId) => pulse.hold(boxId),
  });
  const ssh = new SshGateway({ hostKey: loadHostKey(cfg.dataDir), pulse, record: recordNote });
  bus.subscribe("box", (frame) => ssh.onBoxFrame(frame));
  const lifecycle = new LifecycleWatcher({
    hosts,
    pulse,
    terminals,
    execs,
    tasks,
    cfg,
    record: recordNote,
    ssh,
  });
  return {
    cfg,
    hosts,
    monitor: local.monitor,
    activity,
    events,
    outputs,
    execs,
    terminals,
    containers: new ContainerWatch(hosts, recordNote),
    recordNote,
    mcpSessions: new McpSessions((id, listener) => tokens.watch(id, listener)),
    bus,
    retention,
    checkpointSweep: new CheckpointSweep(hosts),
    tasks,
    operations: new Executor(OPERATIONS, {
      activity,
      tasks,
      hosts,
      hooks: {
        authorize: deps.hooks?.authorize ?? authorizeOperation,
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
    tokens,
    streams: new StreamSlots(cfg.streamMaxConnections),
    pulse,
    lifecycle,
    ssh,
    record: recordNote,
    version,
    startedAt: new Date(),
  };
}
