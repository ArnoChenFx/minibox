import { join } from "node:path";

import { ActivityLog } from "./activity";
import { LoginLimiter } from "./auth";
import type { SnapshotEngine } from "./checkpoints/engine";
import { ResticEngine } from "./checkpoints/restic";
import { CheckpointStore } from "./checkpoints/store";
import { type CliBuilder } from "./cli-dist/build";
import { CliDistribution } from "./cli-dist/distribution";
import { type Config, ROOT } from "./config";
import { questionsPath, selfTokensPath, sessionsPath, tokensPath } from "./data-dir";
import { createDockerRuntime } from "./docker/runtime";
import { OutputStore } from "./events/outputs";
import { createRedactor, type Redactor } from "./events/redact";
import { RetentionJob } from "./events/retention";
import { StreamSlots } from "./events/slots";
import { EventStore, type StoredEvent } from "./events/store";
import { ulid } from "./events/ulid";
import { AgentHub } from "./host/agent/hub";
import { PairingBook } from "./host/agent/pairing";
import { AgentStore } from "./host/agent/store";
import type { LiveTopics } from "./host/live";
import { HostManager } from "./host/manager";
import type { HostMonitor } from "./host/metrics";
import { createLocalHost, type HostCtx, HostRegistry } from "./host/registry";
import { HostStore } from "./host/store";
import { Bus } from "./lib/bus";
import { log } from "./lib/logger";
import { McpSessions } from "./mcp/sessions";
import { Notifications, type NotificationsOptions } from "./notify/service";
import { NotifyStore } from "./notify/store";
import { type AuditEvent, Executor, type ExecutorHooks, logAudit } from "./operations/executor";
import { OPERATIONS } from "./operations/registry";
import { OWNER } from "./operations/types";
import { PreviewGrants } from "./preview/grants";
import { PreviewRelay } from "./preview/relay";
import { type PreviewProbe, systemProbe } from "./preview/selfcheck";
import { QuestionStore } from "./questions/store";
import type { EngineTarget, Runtime } from "./runtime";
import { SecretStore } from "./secrets/store";
import { ActivityPulse } from "./services/activity-pulse";
import { BackupService } from "./services/backup";
import { CheckpointSweep } from "./services/checkpoint-retention";
import { CheckpointScheduler } from "./services/checkpoint-schedule";
import { ContainerWatch } from "./services/container-watch";
import { FirewallStore } from "./services/egress-firewall";
import { EgressLog } from "./services/egress-log";
import { ExecManager } from "./services/exec";
import { LifecycleWatcher } from "./services/lifecycle";
import { reconcileHost } from "./services/reconcile";
import { StartupWatch } from "./services/startup-watch";
import { TargetService } from "./services/targets";
import { type RecordNote, TerminalService } from "./services/terminals";
import { VolumeUsageWatcher } from "./services/volume-usage";
import { deleteVolume } from "./services/volumes";
import { SessionStore } from "./sessions";
import { SpecStore } from "./specs/store";
import { DirectSshServer } from "./ssh/direct";
import { SshGateway } from "./ssh/gateway";
import { loadHostKey } from "./ssh/host-key";
import { SshKeyStore } from "./ssh/keys";
import { TaskManager, type TaskSubject } from "./tasks/manager";
import { TaskStore } from "./tasks/store";
import type { TaskStreamEvent } from "./tasks/types";
import { authorizeOperation } from "./tokens/authorize";
import { isTokenId } from "./tokens/model";
import { SelfTokenStore } from "./tokens/self-store";
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
  /** Adds, tests, removes and probes the hosts beyond the local one. */
  hostAdmin: HostManager;
  /** The connections of the host agents that dial in, and the codes they pair with. */
  agents: AgentHub;
  monitor: HostMonitor;
  activity: ActivityLog;
  events: EventStore;
  outputs: OutputStore;
  execs: ExecManager;
  terminals: TerminalService;
  containers: ContainerWatch;
  /** Relaunches startup commands when the engine starts a box's container again. Stopped on shutdown. */
  startups: StartupWatch;
  /** Writes an audit note for an action a route takes outside the operation registry, such as opening a log stream. */
  recordNote: RecordNote;
  /** Sends notices to the notification channels. The event bus feeds it, and the channel operations reach it. */
  notify: Notifications;
  mcpSessions: McpSessions;
  bus: Bus<AppTopics>;
  retention: RetentionJob;
  /** Removes automatic checkpoints the retention policy no longer keeps, and reports repositories near their limit. */
  checkpointSweep: CheckpointSweep;
  /** Takes the checkpoints that box schedules are due for. Only runs once the server has started. */
  checkpointScheduler: CheckpointScheduler;
  tasks: TaskManager;
  /** Backups of DATA_DIR: created, kept, and streamed to a download or a target. */
  backups: BackupService;
  /** Off-site targets that packages and backups are pushed to and pulled from. */
  targets: TargetService;
  operations: Executor;
  throttle: LoginLimiter;
  sessions: SessionStore;
  /** Tickets and grants that open subdomain previews. Tied to the console sessions that minted them. */
  previewGrants: PreviewGrants;
  /** Carries previews of boxes on other hosts through an exec in the box. Stopped on shutdown. */
  previewRelay: PreviewRelay;
  /** The network the preview self-check uses. Tests replace it. */
  previewProbe: PreviewProbe;
  tokens: TokenStore;
  /** The `self` token each box's agent holds. Authenticates the box-self principal; see `tokens/self-store`. */
  selfTokens: SelfTokenStore;
  streams: StreamSlots;
  pulse: ActivityPulse;
  lifecycle: LifecycleWatcher;
  /** Samples each volume's usage and raises the limit and host disk events. See `VOLUME_USAGE_INTERVAL_SEC`. */
  volumeUsage: VolumeUsageWatcher;
  ssh: SshGateway;
  /** The owner's SSH public keys, which log in to every box over direct SSH. */
  sshKeys: SshKeyStore;
  /** The direct SSH listener, when SSH_PORT is set. `startDirectSsh` opens its port. */
  sshDirect: DirectSshServer | null;
  /** The CLI binaries served under /cli, built on first request for this version. */
  cli: CliDistribution;
  /** Writes an audit note for a request caused by a transport, such as a wake from a terminal or preview. */
  record: RecordNote;
  version: string;
  startedAt: Date;
}

/** Collaborators a caller may replace. Anything omitted is built from the config. */
export interface AppDeps {
  runtime?: Runtime;
  /** Builds the engine client of a host added at runtime. Defaults to the Docker adapter. Tests pass a fake. */
  connect?: (target: EngineTarget) => Runtime;
  /** Where checkpoint volume contents go. Defaults to restic in a helper image. Tests pass an in-memory engine. */
  checkpointEngine?: SnapshotEngine;
  throttle?: LoginLimiter;
  hooks?: Partial<ExecutorHooks>;
  /** The SQLite file of the event store. Defaults to `events.db` under DATA_DIR. Tests pass `:memory:`. */
  eventsPath?: string;
  sessions?: SessionStore;
  /** Probes the network for the preview self-check. Defaults to real DNS and HTTPS. Tests pass a stub. */
  previewProbe?: PreviewProbe;
  /** Compiles a CLI binary. Defaults to `bun build --compile`. Tests pass a stub, because a real build takes seconds. */
  cliBuild?: CliBuilder;
  /** Replaces how a notification is sent, so a test reaches no channel. Anything omitted keeps its default. */
  notify?: Pick<NotificationsOptions, "transport" | "sleep" | "telegramBase" | "maxAttempts" | "timeoutMs" | "dedupMs">;
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
  const spec = host?.specs.findByContainer(target.id, target.name, subject.hostId);
  if (spec) pulse.touch(spec.id, "task");
}

/**
 * Makes a remote host's boxes match their specs each time its engine becomes reachable again. The engine's restart policy
 * is off, so a host that rebooted needs this pass to start its boxes. The pass is logged rather than awaited, so the
 * link that reported the host live is not held up.
 */
function reconcileOnLive(host: HostCtx): void {
  reconcileHost(host).then(
    (report) => log.info("box.reconciled", { host: host.host.id, ...report }),
    (e: unknown) => log.error("box.reconcile_failed", { host: host.host.id, error: String(e) }),
  );
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
  const checkpoints = new CheckpointStore(cfg.dataDir, { packageMaxBytes: cfg.checkpointPackageMaxMb * MB });
  const checkpointEngine = deps.checkpointEngine ?? new ResticEngine({ dataDir: cfg.dataDir });
  const multiHost = () => hosts.list().length > 1;
  const secrets = new SecretStore(cfg.dataDir);
  const egress = new EgressLog((hostId, note) => recordNote(hostId, "system", OWNER, note));
  const firewall = new FirewallStore(join(cfg.dataDir, "egress-firewall.json"));
  const selfTokens = new SelfTokenStore({ file: selfTokensPath(cfg.dataDir) });
  const questions = new QuestionStore({ file: questionsPath(cfg.dataDir) });
  const activity = new ActivityLog();
  const local = createLocalHost(
    cfg,
    deps.runtime ?? createDockerRuntime(cfg.dockerSocket),
    specs,
    volumes,
    bus,
    pulse,
    {
      checkpoints,
      checkpointEngine,
      multiHost,
      secrets,
      egress,
      firewall,
      selfTokens,
      questions,
      activity,
      labels: cfg.localHostLabels,
    },
  );
  hosts.add(local);
  const knownSecrets = [cfg.accessKey];
  const redactor = createRedactor({ knownSecrets });
  const tokens = new TokenStore({
    file: tokensPath(cfg.dataDir),
    secrets: { add: (secret) => knownSecrets.push(secret) },
  });
  const sessions =
    deps.sessions ??
    new SessionStore({
      file: sessionsPath(cfg.dataDir),
      accessKey: cfg.accessKey,
      ttlMs: cfg.sessionTtlMs,
      idleMs: cfg.sessionIdleMs,
    });
  const eventsPath = deps.eventsPath ?? join(cfg.dataDir, "events.db");
  const tasksPath = join(cfg.dataDir, "tasks.db");
  const events = openEventStore(eventsPath, redactor);
  const backups = new BackupService({
    dataDir: cfg.dataDir,
    databases: [
      { name: "events.db", path: eventsPath },
      { name: "tasks.db", path: tasksPath },
    ],
  });
  const swept = backups.sweepPartial();
  if (swept > 0) log.info("backup.partial_swept", { count: swept });
  const targets = new TargetService({
    dataDir: cfg.dataDir,
    secrets,
    checkpoints,
    backups,
    onSecret: (value) => knownSecrets.push(value),
  });
  targets.start();
  const outputs = new OutputStore(join(cfg.dataDir, "exec"), redactor);
  const execs = new ExecManager(outputs, (text) => redactor.text(text));
  execs.setActivityHandler((boxId) => pulse.touch(boxId, "exec"));
  const tasks = new TaskManager(
    openTaskStore(tasksPath),
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
  const notifyStore = new NotifyStore(cfg.dataDir, {
    secrets: new SecretStore(cfg.dataDir, "notify"),
    onSecret: (value) => knownSecrets.push(value),
  });
  notifyStore.load();
  const notify = new Notifications({
    store: notifyStore,
    version,
    allowPrivate: cfg.notifyAllowPrivate,
    record: (note) => recordNote(local.host.id, "system", OWNER, note),
    redact: (text) => redactor.text(text),
    ...deps.notify,
  });
  const containers = new ContainerWatch(hosts, recordNote);
  const startups = new StartupWatch(hosts);
  const agents = new AgentHub({
    store: new AgentStore(cfg.dataDir),
    pairing: new PairingBook(),
    serverVersion: version,
  });
  const hostAdmin = new HostManager({
    cfg,
    registry: hosts,
    store: new HostStore(cfg.dataDir),
    shared: {
      specs,
      volumes,
      secrets,
      live: bus,
      pulse,
      checkpoints,
      checkpointEngine,
      multiHost,
      egress,
      firewall,
      selfTokens,
      questions,
      activity,
    },
    connect: deps.connect ?? createDockerRuntime,
    attach: (host) => {
      containers.watch(host);
      startups.watch(host);
      host.sampler.start();
    },
    detach: (host) => {
      containers.unwatch(host.host.id);
      startups.unwatch(host.host.id);
      host.sampler.stop();
    },
    liftToolsVolume: async (host) => {
      // A host that is going away cannot keep its shared tools volumes: they are the one kind of volume no other
      // delete may remove, and the host cannot be forgotten while it holds one. Each pool's volume is lifted here,
      // before the host is detached, through the same guards every other delete answers to.
      for (const tools of host.volumes.list().filter((v) => v.hostId === host.host.id && v.role === "tools")) {
        await deleteVolume(host, tools.id, { skipTrash: true, teardown: true });
      }
    },
    onLive: reconcileOnLive,
    agents,
    localLabels: cfg.localHostLabels,
  });
  hostAdmin.load();
  bus.subscribe("link", (frame) => hostAdmin.onLink(frame));
  bus.subscribe("link", (frame) => notify.onLink(frame));
  bus.subscribe("event", (event) => notify.onEvent(event));
  agents.subscribe((event) => hostAdmin.onAgent(event));
  const terminals = new TerminalService({
    record: recordNote,
    takeoverIdleMs: cfg.takeoverIdleSec * 1000,
    onActivity: (boxId, kind) => pulse.touch(boxId, kind),
    hold: (boxId) => pulse.hold(boxId),
  });
  const ssh = new SshGateway({ hostKey: loadHostKey(cfg.dataDir), pulse, record: recordNote });
  bus.subscribe("box", (frame) => ssh.onBoxFrame(frame));
  const sshKeys = new SshKeyStore(cfg.dataDir);
  const sshDirect =
    cfg.sshPort === null
      ? null
      : new DirectSshServer({
          gateway: ssh,
          hosts,
          keys: sshKeys,
          tokens,
          accessKey: cfg.accessKey,
          record: recordNote,
        });
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
  const volumeUsage = new VolumeUsageWatcher({ hosts, record: recordNote, cfg });
  return {
    cfg,
    hosts,
    hostAdmin,
    agents,
    monitor: local.monitor,
    activity,
    events,
    outputs,
    execs,
    terminals,
    containers,
    startups,
    recordNote,
    mcpSessions: new McpSessions((id, listener) =>
      isTokenId(id) ? tokens.watch(id, listener) : selfTokens.watch(id, listener),
    ),
    bus,
    retention,
    checkpointSweep: new CheckpointSweep(hosts, undefined, recordNote),
    checkpointScheduler: new CheckpointScheduler(hosts, recordNote),
    tasks,
    backups,
    targets,
    operations: new Executor(OPERATIONS, {
      activity,
      tasks,
      hosts,
      hostAdmin,
      previewBaseDomain: cfg.previewBaseDomain,
      notify,
      backups,
      targets,
      sshKeys,
      hooks: {
        authorize: deps.hooks?.authorize ?? authorizeOperation,
        audit,
      },
    }),
    throttle: deps.throttle ?? new LoginLimiter(),
    sessions,
    previewGrants: new PreviewGrants({ sessionLive: (id) => sessions.hasLive(id) }),
    previewRelay: new PreviewRelay(),
    previewProbe: deps.previewProbe ?? systemProbe,
    tokens,
    selfTokens,
    streams: new StreamSlots(cfg.streamMaxConnections),
    pulse,
    lifecycle,
    volumeUsage,
    ssh,
    sshKeys,
    sshDirect,
    cli: new CliDistribution({ dataDir: cfg.dataDir, version, root: ROOT, build: deps.cliBuild }),
    record: recordNote,
    notify,
    version,
    startedAt: new Date(),
  };
}
