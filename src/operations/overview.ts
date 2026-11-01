import { z } from "zod";

import type { StoredEvent } from "../events/store";
import { hostLabel } from "../host/label";
import type { HostCapacity, HostCtx } from "../host/registry";
import { untilAborted } from "../lib/abort";
import { log } from "../lib/logger";
import { checkpointFailed } from "../notify/rules";
import type { Box } from "../services/box-model";
import { listAllBoxes } from "../services/box-query";
import { type Booking, bookedOn } from "../services/capacity";
import { REMOTE_SYNC_FAILURE_THRESHOLD } from "../services/checkpoint-remote";
import type { ExecService } from "../services/exec";
import type { TargetService } from "../services/targets";
import { freePercent } from "../volumes/disk";
import { usageLevel } from "../volumes/limits";
import { defineOperation } from "./define";
import type { OperationContext } from "./types";

/** A box is in progress while its newest agent event is this recent, or while a command an agent started still runs. */
const ACTIVE_MS = 10 * 60_000;
/** How far back an agent's command is looked for. A background command can run longer than the activity window. */
const COMMAND_LOOKBACK_MS = 2 * 60 * 60_000;
/** Events that need attention stay listed for a day after they happen. */
const ATTENTION_MS = 24 * 60 * 60_000;
const AGENT_EVENT_LIMIT = 500;
const COMMAND_LIMIT = 100;
const FAILURE_LIMIT = 100;
const PROGRESS_LIMIT = 50;
const ATTENTION_LIMIT = 100;
const OUTPUT_LINES = 3;
const LINE_MAX = 200;
const COMMAND_MAX = 300;
const NOTE_MAX = 200;
/** Float sums of fractional CPU shares can land a hair above a limit they equal. */
const EPSILON = 1e-6;

const ATTENTION_KINDS = [
  "box.oom",
  "box.checkpoint_failed",
  "box.drift",
  "box.rollback_pending",
  "volume.over_limit",
  "pool.unreachable",
  "host.offline",
  "host.disk_low",
  "host.cpu_overcommit",
  "host.memory_overcommit",
  "host.forward_blocked",
  "host.remote_sync_failing",
] as const;

const BoxRef = z.object({
  id: z.string().meta({ description: "The box's container id, the id the console's box pages use." }),
  name: z.string(),
});

const CommandSchema = z.object({
  text: z.string().meta({ description: "The command as the agent sent it: `cmd`, or its `argv` joined by spaces." }),
  execId: z.string(),
  running: z.boolean(),
  output: z.array(z.string()).meta({
    description: `The last ${OUTPUT_LINES} lines of output of a running command, oldest first, with terminal escape sequences left in. Empty once the command has ended.`,
  }),
});

const ProgressSchema = z.object({
  box: BoxRef.extend({ hostId: z.string() }),
  principal: z.object({
    type: z.enum(["token", "box-self"]),
    id: z.string(),
    name: z.string().meta({ description: "The token's name, or the box's name for its own agent." }),
  }),
  lastAt: z.string().meta({ description: "When the newest agent activity on the box was recorded, ISO 8601." }),
  lastOp: z.string().meta({ description: "The operation of that activity, such as `exec.start` or `box.read`." }),
  command: CommandSchema.nullable().meta({
    description:
      "The command an agent started most recently: the one still running if there is one, else the last one.",
  }),
  session: z.string().nullable().meta({
    description: "The terminal session the agent used last. Null when it used none, or when the session is not known.",
  }),
  note: z
    .string()
    .nullable()
    .meta({ description: "The status note the box's agent reported last, if it reported one." }),
});

const AttentionSchema = z.object({
  kind: z.enum(ATTENTION_KINDS),
  severity: z.enum(["error", "warning"]),
  hostId: z.string(),
  at: z.string().nullable().meta({
    description:
      "When the condition was recorded, ISO 8601. Null for a condition read from current state, which has no time of its own.",
  }),
  subject: z.string().meta({ description: "The name of the box, volume, pool or host the condition is about." }),
  box: BoxRef.nullable().meta({ description: "The box the condition is about, when it is still there." }),
  params: z.record(z.string(), z.union([z.string(), z.number()])).meta({
    description:
      "Values the console words the condition with. `used` and `limit` are bytes for a volume, `action` is `warn` or `stop`, `fields` lists the drifted settings, `checkpoint` names the rolled-back checkpoint, `free` and `min` are percentages of a host's disk, `booked` and `limit` are CPU cores for a host's overcommitted CPU and bytes for its overcommitted memory, `detail` is the message the engine or the pool reported, and for a host whose forwarding is blocked `bridge` is the uplink interface, `boxes` names the `proxy-only` boxes that lost the internet, `count` is how many there are, `detail` is what the host's iptables backends said, and `cause` is `policy` when a chain fell off its end (the case MiniBox offers to repair), `rule` when a DROP of the host's own decides it, or `unclear` when the reading left a rule unread.",
  }),
});

const OverviewSchema = z.object({
  inProgress: z.array(ProgressSchema).meta({
    description: "Boxes an agent acted on recently, or is running a command on, newest first.",
  }),
  attention: z.array(AttentionSchema).meta({
    description: "Conditions the server knows about that need a person, errors first, then the newest.",
  }),
});

type OverviewView = z.output<typeof OverviewSchema>;
type Progress = OverviewView["inProgress"][number];
type Attention = OverviewView["attention"][number];

interface BoxIndex {
  readonly byContainer: ReadonlyMap<string, Box>;
  readonly byName: ReadonlyMap<string, Box>;
}

interface Row {
  box: Box;
  principal: Progress["principal"];
  lastAt: number;
  lastOp: string;
  command: Progress["command"];
  hasRunning: boolean;
  session: string | null;
  note: string | null;
}

function fieldsOf(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function textOf(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
}

const isoOf = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

function hostIdOf(box: Box, fallback: string): string {
  return box.hostId ?? fallback;
}

function indexBoxes(boxes: readonly Box[]): BoxIndex {
  return {
    byContainer: new Map(boxes.map((box) => [box.id, box])),
    byName: new Map(boxes.map((box) => [box.name, box])),
  };
}

/**
 * The box an event is about. The container id is the target's id, and a rebuild changes it, so a box that no longer has
 * that id is matched by name. A name only matches events recorded after the box was created, so a deleted box's events
 * never attach to a newer box that reused its name.
 */
function boxOf(index: BoxIndex, event: StoredEvent): Box | undefined {
  const target = event.target;
  if (target?.kind !== "box") return undefined;
  const byId = target.id === undefined ? undefined : index.byContainer.get(target.id);
  if (byId) return byId;
  const named = index.byName.get(target.name);
  return named && Date.parse(named.createdAt) <= event.ts ? named : undefined;
}

function commandOf(event: StoredEvent): string | null {
  const detail = fieldsOf(event.detail);
  if (typeof detail.cmd === "string" && detail.cmd.length > 0) return detail.cmd.slice(0, COMMAND_MAX);
  if (Array.isArray(detail.argv)) {
    const words = detail.argv.filter((word): word is string => typeof word === "string");
    return words.length > 0 ? words.join(" ").slice(0, COMMAND_MAX) : null;
  }
  return null;
}

/** `session.start` and `session.send` name the session as `session`. The other session operations name it as `name`. */
function sessionOf(event: StoredEvent): string | null {
  if (!event.op.startsWith("session.")) return null;
  const detail = fieldsOf(event.detail);
  return textOf(detail.session ?? detail.name, COMMAND_MAX);
}

function noteOf(event: StoredEvent): string | null {
  return event.op === "self.status" ? textOf(fieldsOf(event.detail).note, NOTE_MAX) : null;
}

function tailOf(stdout: string, stderr: string): string[] {
  return `${stdout}\n${stderr}`
    .split(/\r?\n|\r/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-OUTPUT_LINES)
    .map((line) => line.slice(0, LINE_MAX));
}

function principalOf(event: StoredEvent): Progress["principal"] {
  const { type, id, name } = event.principal;
  return { type: type === "box-self" ? "box-self" : "token", id, name };
}

function newRow(box: Box, event: StoredEvent): Row {
  return {
    box,
    principal: principalOf(event),
    lastAt: event.ts,
    lastOp: event.op,
    command: null,
    hasRunning: false,
    session: null,
    note: null,
  };
}

/**
 * The activity events and commands of agents, each attached to its box. Rows keep the newest agent's principal and
 * the newest session and note; a running command replaces a finished one, and the newest running one wins. A box with
 * no activity in the window is listed only for a command that still runs, so a finished command never lists its box.
 */
async function progressOf(
  events: OperationContext["events"],
  execs: ExecService | undefined,
  index: BoxIndex,
  hostFallback: string,
  now: number,
): Promise<Progress[]> {
  const rows = new Map<string, Row>();
  const recent = events.recent({ since: now - ACTIVE_MS, agents: true }, AGENT_EVENT_LIMIT);
  for (const event of recent) {
    const box = boxOf(index, event);
    if (!box) continue;
    const row = rows.get(box.id) ?? newRow(box, event);
    row.session ??= sessionOf(event);
    row.note ??= noteOf(event);
    rows.set(box.id, row);
  }

  const starts = events.recent({ since: now - COMMAND_LOOKBACK_MS, agents: true, op: "exec.start" }, COMMAND_LIMIT);
  const lives = await Promise.all(starts.map((start) => liveOf(execs, start)));
  for (const [position, start] of starts.entries()) {
    const box = boxOf(index, start);
    const execId = start.ref?.execId;
    const text = commandOf(start);
    if (!box || execId === undefined || text === null) continue;
    const live = lives[position] ?? null;
    const row = rows.get(box.id) ?? (live === null ? undefined : newRow(box, start));
    if (!row) continue;
    if (start.ts > row.lastAt) {
      row.lastAt = start.ts;
      row.lastOp = start.op;
      row.principal = principalOf(start);
    }
    rows.set(box.id, row);
    if (live !== null) {
      if (row.hasRunning) continue;
      row.hasRunning = true;
      row.command = { text, execId, running: true, output: live };
    } else if (row.command === null) {
      row.command = { text, execId, running: false, output: [] };
    }
  }

  return [...rows.values()]
    .map((row) => ({
      box: { id: row.box.id, name: row.box.name, hostId: hostIdOf(row.box, hostFallback) },
      principal: row.principal,
      lastAt: new Date(row.lastAt).toISOString(),
      lastOp: row.lastOp,
      command: row.command,
      session: row.session,
      note: row.note,
    }))
    .toSorted((a, b) => b.lastAt.localeCompare(a.lastAt))
    .slice(0, PROGRESS_LIMIT);
}

/** The last lines of a command still running, or null when it has ended or the server no longer holds it. */
async function liveOf(execs: ExecService | undefined, start: StoredEvent): Promise<string[] | null> {
  const execId = start.ref?.execId;
  if (!execs || execId === undefined) return null;
  try {
    const view = await execs.get(execId, 0);
    return view.status === "running" ? tailOf(view.stdout, view.stderr) : null;
  } catch {
    return null;
  }
}

function eventAttention(events: OperationContext["events"], index: BoxIndex, now: number): Attention[] {
  const since = now - ATTENTION_MS;
  const oom = events.recent({ since, op: "container.oom" }, FAILURE_LIMIT).map((event): Attention => {
    const box = boxOf(index, event);
    return {
      kind: "box.oom",
      severity: "error",
      hostId: event.hostId,
      at: isoOf(event.ts),
      subject: event.target?.name ?? "",
      box: box ? { id: box.id, name: box.name } : null,
      params: {},
    };
  });
  const failed = [
    ...events.recent({ since, op: "checkpoint.scheduled", status: "error" }, FAILURE_LIMIT),
    ...events.recent({ since, op: "checkpoint.create", status: "error" }, FAILURE_LIMIT),
  ].filter(checkpointFailed);
  const checkpoints = failed.map((event): Attention => {
    const box = boxOf(index, event);
    const detail = textOf(fieldsOf(event.detail).error, COMMAND_MAX);
    return {
      kind: "box.checkpoint_failed",
      severity: "error",
      hostId: event.hostId,
      at: isoOf(event.ts),
      subject: event.target?.name ?? "",
      box: box ? { id: box.id, name: box.name } : null,
      params: detail === null ? {} : { detail },
    };
  });
  return [...oom, ...checkpoints];
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * The CPU and memory the running boxes of a reachable host book, held against the limit its overcommit ratio allows.
 * One item per resource that is past that limit, so a host can report both. An offline host is skipped: its boxes are not
 * read, and `host.offline` already covers it. A figure the host does not report is not checked, and a total that only
 * equals its limit is not over it.
 */
async function overcommitAttention(host: HostCtx, hosts: readonly HostCtx[]): Promise<Attention[]> {
  if (host.host.status === "offline") return [];
  let capacity: HostCapacity;
  let booked: Booking;
  try {
    booked = await bookedOn(host);
    // Nothing is booked, so nothing can be over a limit the host reports. Skipping the read keeps an idle host cheap.
    if (booked.cpus <= 0 && booked.memoryBytes <= 0) return [];
    capacity = await untilAborted(host.capacity(), AbortSignal.timeout(host.readTimeoutMs));
  } catch (e) {
    log.warn("overview.capacity_failed", { host: host.host.id, error: String(e) });
    return [];
  }
  const ratio = host.capacityPolicy.overcommit;
  const items: Attention[] = [];
  const about = {
    severity: "warning" as const,
    hostId: host.host.id,
    at: null,
    subject: hostLabel(
      host.host,
      hosts.map((item) => item.host),
    ),
    box: null,
  };
  if (capacity.cpus !== null) {
    const limit = capacity.cpus * ratio;
    if (booked.cpus > limit + EPSILON) {
      items.push({
        ...about,
        kind: "host.cpu_overcommit",
        params: { booked: round1(booked.cpus), limit: round1(limit) },
      });
    }
  }
  if (capacity.memoryBytes !== null) {
    const limit = capacity.memoryBytes * ratio;
    if (booked.memoryBytes > limit) {
      items.push({
        ...about,
        kind: "host.memory_overcommit",
        params: { booked: booked.memoryBytes, limit: Math.round(limit) },
      });
    }
  }
  return items;
}

/**
 * The hosts whose `FORWARD` rules drop a `proxy-only` box's traffic. The check records one reading per host, and the
 * warning stays until a pass finds the rules right: MiniBox changes nothing on its own, so a repair the owner confirms
 * is a separate operation, and a repair that did not work leaves this here.
 */
function forwardAttention(hosts: readonly HostCtx[]): Attention[] {
  return hosts.flatMap((host): Attention[] => {
    // An offline host is already listed as offline, and its last reading is from before it went away. The host coming
    // back asks for a fresh reading, which is what decides this item again.
    if (host.host.status === "offline") return [];
    const state = host.forward.stateOf(host.host.id);
    if (!state || state.forwarding || state.skipped !== null || state.bridge === "") return [];
    return [
      {
        kind: "host.forward_blocked",
        severity: "error",
        hostId: host.host.id,
        at: state.at,
        subject: host.host.name,
        box: null,
        params: {
          bridge: state.bridge,
          boxes: state.boxes.join(", "),
          count: state.boxes.length,
          detail: state.detail,
          // Only a drop nobody asked for gets a button; anything else is reported as it is.
          cause: state.cause ?? "unclear",
        },
      },
    ];
  });
}

function remoteAttention(
  hosts: readonly HostCtx[],
  targets: TargetService | undefined,
  remote: OperationContext["checkpointRemote"],
): Attention[] {
  if (!targets || !remote) return [];
  return hosts.flatMap((host): Attention[] => {
    // An offline host is already listed as offline, and its last copy is from before it went away. It is read again
    // once it is back, which is what decides this item again.
    if (host.host.status === "offline") return [];
    const repo = targets.remoteOf(host.host.id);
    if (!repo) return [];
    // A remote-only host never copies: its checkpoints are taken on the remote, so there is no copy that can fail.
    if (repo.mode === "only") return [];
    const state = remote.stateOf(host.host.id);
    if (state.failures < REMOTE_SYNC_FAILURE_THRESHOLD) return [];
    return [
      {
        kind: "host.remote_sync_failing",
        severity: "warning",
        hostId: host.host.id,
        at: state.lastFailure?.at ?? null,
        subject: host.host.name,
        box: null,
        params: {
          target: repo.targetName,
          failures: state.failures,
          detail: state.lastFailure?.message ?? "",
        },
      },
    ];
  });
}

async function stateAttention(ctx: OperationContext, boxes: readonly Box[], hosts: readonly HostCtx[]) {
  const items: Attention[] = [];
  const fallback = ctx.host.host.id;
  const boxByBoxId = new Map(boxes.map((box) => [box.boxId, box]));

  for (const box of boxes) {
    if (box.drift.length === 0) continue;
    items.push({
      kind: "box.drift",
      severity: "warning",
      hostId: hostIdOf(box, fallback),
      at: null,
      subject: box.name,
      box: { id: box.id, name: box.name },
      params: { fields: box.drift.map((item) => item.field).join(", ") },
    });
  }

  for (const rollback of ctx.host.checkpoints.pendingRollbacks()) {
    const box = boxByBoxId.get(rollback.boxId);
    items.push({
      kind: "box.rollback_pending",
      severity: "warning",
      hostId: rollback.hostId,
      at: rollback.createdAt,
      subject: rollback.boxName,
      box: box ? { id: box.id, name: box.name } : null,
      params: { checkpoint: rollback.checkpointLabel },
    });
  }

  for (const volume of ctx.host.volumes.list()) {
    if (usageLevel(volume.bytes, volume.limits) !== "hard") continue;
    const owner = volume.ownerBoxId === null ? undefined : boxByBoxId.get(volume.ownerBoxId);
    items.push({
      kind: "volume.over_limit",
      severity: volume.limits.action === "stop" ? "error" : "warning",
      hostId: volume.hostId,
      at: volume.bytesAt,
      subject: volume.name,
      box: owner ? { id: owner.id, name: owner.name } : null,
      params: {
        used: volume.bytes ?? 0,
        limit: volume.limits.hardBytes ?? 0,
        action: volume.limits.action,
      },
    });
  }

  const pools = ctx.host.volumes.readPools().pools;
  // Every host's booking is read at once, so a slow engine does not hold up the next host.
  const overcommitted = await Promise.all(hosts.map((host) => overcommitAttention(host, hosts)));
  for (const [position, host] of hosts.entries()) {
    const hostId = host.host.id;
    for (const pool of pools) {
      const health = ctx.host.volumes.healthOf(hostId, pool.name);
      if (health?.status !== "unreachable") continue;
      items.push({
        kind: "pool.unreachable",
        severity: "error",
        hostId,
        at: health.checkedAt,
        subject: pool.name,
        box: null,
        params: { detail: health.message ?? "" },
      });
    }

    if (host.host.status === "offline") {
      items.push({
        kind: "host.offline",
        severity: "error",
        hostId,
        at: null,
        subject: hostLabel(
          host.host,
          hosts.map((item) => item.host),
        ),
        box: null,
        params: {},
      });
    }

    const disk = ctx.host.volumes.diskOf(hostId);
    const minFree = host.diskPolicy.minFreePercent;
    if (disk && minFree > 0 && freePercent(disk) < minFree) {
      items.push({
        kind: "host.disk_low",
        severity: "warning",
        hostId,
        at: isoOf(disk.at),
        subject: hostLabel(
          host.host,
          hosts.map((item) => item.host),
        ),
        box: null,
        params: { free: Math.floor(freePercent(disk)), min: minFree },
      });
    }

    items.push(...(overcommitted[position] ?? []));
  }
  items.push(...forwardAttention(hosts));
  items.push(...remoteAttention(hosts, ctx.targets, ctx.checkpointRemote));
  return items;
}

/** Errors before warnings, then the newest first. A condition without a time sorts last within its severity. */
function attentionOrder(a: Attention, b: Attention): number {
  const severity = (a.severity === "error" ? 0 : 1) - (b.severity === "error" ? 0 : 1);
  if (severity !== 0) return severity;
  return (b.at ?? "").localeCompare(a.at ?? "");
}

/**
 * What agents are doing and what needs a person, read from the event log and the current state of the hosts. Each
 * attention condition is one the server already tracks. Agent activity counts only events a token or a box's own agent
 * recorded, so the owner's own actions never mark a box as being worked on.
 */
async function overviewOf(ctx: OperationContext, now: number): Promise<OverviewView> {
  const hosts = ctx.allHosts?.() ?? [ctx.host];
  const boxes = await listAllBoxes(hosts, {});
  const index = indexBoxes(boxes);
  const fallback = ctx.host.host.id;
  const inProgress = await progressOf(ctx.events, ctx.execs, index, fallback, now);
  const attention = [...eventAttention(ctx.events, index, now), ...(await stateAttention(ctx, boxes, hosts))]
    .toSorted(attentionOrder)
    .slice(0, ATTENTION_LIMIT);
  return { inProgress, attention };
}

const overviewGet = defineOperation({
  name: "overview.get",
  tag: "overview",
  summary: "Read what agents are doing now and what needs attention",
  kind: "read",
  scope: "overview:read",
  async: false,
  input: z.object({}),
  output: OverviewSchema,
  rest: [{ method: "GET", path: "/api/overview" }],
  run: async (ctx) => overviewOf(ctx, Date.now()),
});

export const overviewOperations = [overviewGet];
