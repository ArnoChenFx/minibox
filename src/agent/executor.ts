import { z } from "zod";

import { type ExecSession, type ExecSpec, MAX_OWNER_ID, type Runtime, RuntimeError } from "../runtime";
import { type AgentErrorInfo, type ExecExit, REFUSED_OPERATIONS } from "./protocol";

/** Where the executor sends what it produces. The connection implements it; a test records it. */
export interface AgentSink {
  respond(id: string, outcome: { ok: true; result: unknown } | { ok: false; error: AgentErrorInfo }): void;
  item(id: string, value: unknown): void;
  data(id: string, channel: "stdout" | "stderr", bytes: Uint8Array): void;
  end(id: string, error?: AgentErrorInfo, exit?: ExecExit): void;
}

interface Reply {
  result: unknown;
  /** Starts forwarding a stream. Runs after the response is sent, so the stream's frames follow it. */
  after?: () => void;
}

type OpenStream =
  | { readonly kind: "exec"; readonly session: ExecSession; readonly tty: boolean }
  | { readonly kind: "abort"; readonly abort: AbortController };

const NAME = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
const IMAGE = z.string().min(1).max(512).regex(/^\S+$/);
const NETWORK = NAME.refine((name) => name !== "host", "the host network is not allowed on an agent");
const REF = z.string().min(1).max(256);
const TEXT = z.string().max(65536);
const LABELS = z.record(z.string().max(256), z.string().max(4096));
const COUNT = z.number().int().min(0).max(100_000);
const TIMEOUT = z.number().int().min(0).max(3600);
const OWNER_ID = z.number().int().min(0).max(MAX_OWNER_ID);

/** Only named volumes: a source that is a path would be a bind mount, which an agent never creates. */
const MountSchema = z
  .object({
    source: NAME,
    target: z.string().min(1).max(4096).startsWith("/"),
    mode: z.enum(["rw", "ro"]).optional(),
    kind: z.literal("volume").optional(),
    noCopy: z.boolean().optional(),
  })
  .strict();

/**
 * The capabilities a container on an agent host may be given: Docker's default set, which is what the `relaxed` profile
 * keeps and a superset of what `standard` adds back. Anything else (SYS_ADMIN, SYS_MODULE, SYS_PTRACE, NET_ADMIN,
 * DAC_READ_SEARCH and the rest) would let a container reach past it to the host, so a console cannot ask for it.
 */
export const AGENT_ALLOWED_CAPS = [
  "AUDIT_WRITE",
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "FSETID",
  "KILL",
  "MKNOD",
  "NET_BIND_SERVICE",
  "NET_RAW",
  "SETFCAP",
  "SETGID",
  "SETPCAP",
  "SETUID",
  "SYS_CHROOT",
] as const;

const HardeningSchema = z
  .object({
    capDrop: z.array(z.string().max(64)).max(64).optional(),
    capAdd: z.array(z.enum(AGENT_ALLOWED_CAPS)).max(64).optional(),
    noNewPrivileges: z.boolean().optional(),
    pidsLimit: z.number().int().positive().optional(),
    ulimits: z
      .array(z.object({ name: z.string().max(64), soft: z.number().int(), hard: z.number().int() }).strict())
      .max(32)
      .optional(),
    runtime: NAME.optional(),
  })
  .strict();

const CreateSpecSchema = z
  .object({
    image: IMAGE,
    name: NAME.optional(),
    cmd: z.array(TEXT).max(1024).optional(),
    workingDir: z.string().max(4096).optional(),
    hostname: z.string().max(253).optional(),
    labels: LABELS.optional(),
    mounts: z.array(MountSchema).max(64).optional(),
    env: z.array(TEXT).max(1024).optional(),
    restart: z.enum(["no", "unless-stopped"]).optional(),
    cpus: z.number().positive().max(1024).optional(),
    memoryBytes: z.number().int().positive().optional(),
    swapBytes: z.number().int().optional(),
    init: z.boolean().optional(),
    network: NETWORK.optional(),
    hardening: HardeningSchema.optional(),
    user: z.string().max(64).optional(),
    readonlyRootfs: z.boolean().optional(),
    tmpfs: z.record(z.string().max(4096), z.string().max(256)).optional(),
  })
  .strict();

const ExecSpecSchema = z
  .object({
    cmd: z.array(TEXT).min(1).max(1024),
    env: z.array(TEXT).max(1024),
    workingDir: z.string().max(4096),
    user: z.string().max(64).optional(),
    stopAs: z.string().max(64).optional(),
    tty: z.boolean().optional(),
  })
  .strict();

const UpdateSchema = z
  .object({
    cpus: z.number().positive().max(1024).optional(),
    memoryBytes: z.number().int().positive().optional(),
    swapBytes: z.number().int().optional(),
    pidsLimit: z.number().int().positive().optional(),
    restart: z.enum(["no", "unless-stopped", "always", "on-failure"]).optional(),
  })
  .strict();

const EventsFilterSchema = z
  .object({
    labels: LABELS.optional(),
    types: z.array(z.string().max(64)).max(32).optional(),
    since: z.number().int().min(0).optional(),
  })
  .strict();

const Empty = z.object({}).strict();
const ById = z.object({ id: NAME }).strict();
const ByLabels = z.object({ labels: LABELS }).strict();
const ByRef = z.object({ ref: REF }).strict();
const ByName = z.object({ name: NAME }).strict();

const ops = {
  ping: Empty,
  info: Empty,
  listContainers: ByLabels,
  inspectContainer: ById,
  inspectEnv: ById,
  createContainer: z.object({ spec: CreateSpecSchema }).strict(),
  startContainer: ById,
  stopContainer: ById.extend({ timeoutSec: TIMEOUT }).strict(),
  restartContainer: ById.extend({ timeoutSec: TIMEOUT }).strict(),
  pauseContainer: ById,
  unpauseContainer: ById,
  removeContainer: ById.extend({ force: z.boolean() }).strict(),
  renameContainer: ById.extend({ name: NAME }).strict(),
  updateContainer: ById.extend({ limits: UpdateSchema }).strict(),
  containerLogs: ById.extend({ tail: COUNT, timestamps: z.boolean() }).strict(),
  containerStats: ById,
  containerDiff: ById,
  listImages: ByLabels,
  inspectImage: ByRef,
  pullImage: ByRef,
  inspectVolume: ByName,
  listVolumes: Empty,
  createVolume: ByName.extend({ labels: LABELS }).strict(),
  removeVolume: ByName,
  setVolumeRootOwner: z
    .object({
      volume: NAME,
      owner: z.object({ uid: OWNER_ID, gid: OWNER_ID }).strict(),
      image: IMAGE,
    })
    .strict(),
  ensureBridgeNetwork: ByName.extend({ opts: z.object({ interContainerComm: z.boolean() }).strict() }).strict(),
  reattachNetwork: z.object({ containerId: NAME, name: NETWORK }).strict(),
  startExec: z.object({ containerId: NAME, spec: ExecSpecSchema }).strict(),
  followLogs: ById.extend({
    tail: COUNT,
    timestamps: z.boolean(),
    since: z
      .string()
      .max(64)
      .refine((value) => !Number.isNaN(Date.parse(value)), "since is not a date")
      .optional(),
  }).strict(),
  events: z.object({ filter: EventsFilterSchema }).strict(),
  execResize: z
    .object({
      session: z.string().min(1).max(64),
      cols: z.number().int().min(1).max(10_000),
      rows: z.number().int().min(1).max(10_000),
    })
    .strict(),
  execInspect: z.object({ session: z.string().min(1).max(64) }).strict(),
  execKill: z.object({ session: z.string().min(1).max(64) }).strict(),
} as const;

/** The names the executor runs. Anything else is refused, so a new Runtime method stays off the wire until it is listed here. */
export const AGENT_OPERATION_NAMES = Object.keys(ops) as (keyof typeof ops)[];

function invalid(op: string, error: z.ZodError): RuntimeError {
  const issue = error.issues[0];
  const where = issue?.path.length ? issue.path.join(".") : "arguments";
  return new RuntimeError("invalid", `${op}: ${where} is not valid`, issue?.message ?? "invalid arguments");
}

function parse<S extends z.ZodType>(op: string, schema: S, raw: unknown): z.output<S> {
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) throw invalid(op, parsed.error);
  return parsed.data;
}

/** The error an agent reports for a failed call. A RuntimeError keeps its kind; anything else is an engine failure. */
export function errorInfo(e: unknown): AgentErrorInfo {
  if (e instanceof RuntimeError) return { kind: e.kind, message: e.message, detail: e.detail };
  if (e instanceof Error && e.name === "AbortError") return { kind: "aborted", message: e.message, detail: e.message };
  const text = e instanceof Error ? e.message : String(e);
  return { kind: "engine", message: text, detail: text };
}

function ended(stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve();
    stream.once("end", done);
    stream.once("close", done);
    stream.once("error", done);
  });
}

/**
 * Runs the operations an agent accepts, against a runtime, and reports each result through a sink. Every request is
 * answered once. Streams (exec, logs, events) answer with their request and then send items, output and an end. An
 * unknown or refused operation is answered with an error, never run.
 */
export class AgentExecutor {
  private readonly open = new Map<string, OpenStream>();
  /** Requests whose operation is still running. An id is taken until its response is sent. */
  private readonly starting = new Set<string>();
  private closed = false;

  constructor(
    private readonly runtime: Runtime,
    private readonly sink: AgentSink,
  ) {}

  async request(id: string, op: string, args: unknown): Promise<void> {
    if (this.open.has(id) || this.starting.has(id)) {
      this.sink.respond(id, { ok: false, error: { kind: "invalid", message: "request id is in use", detail: id } });
      return;
    }
    this.starting.add(id);
    let reply: Reply;
    try {
      reply = await this.run(id, op, args);
    } catch (e) {
      this.starting.delete(id);
      this.sink.respond(id, { ok: false, error: errorInfo(e) });
      return;
    }
    this.starting.delete(id);
    this.sink.respond(id, { ok: true, result: reply.result });
    reply.after?.();
  }

  /** Detaches an open stream. An exec's process keeps running; only its attachment ends. */
  cancel(id: string): void {
    const stream = this.open.get(id);
    if (stream?.kind === "abort") stream.abort.abort();
    if (stream?.kind === "exec") stream.session.stream.destroy();
  }

  input(id: string, bytes: Uint8Array): void {
    const stream = this.open.get(id);
    if (stream?.kind !== "exec") return;
    if (!stream.session.stream.destroyed && stream.session.stream.writable) stream.session.stream.write(bytes);
  }

  inputEnd(id: string): void {
    const stream = this.open.get(id);
    if (stream?.kind === "exec" && stream.session.stream.writable) stream.session.stream.end();
  }

  /** The connection closed: every open stream ends without reporting, and each exec is detached. */
  close(): void {
    this.closed = true;
    for (const stream of this.open.values()) {
      if (stream.kind === "abort") stream.abort.abort();
      else stream.session.stream.destroy();
    }
    this.open.clear();
  }

  private async run(id: string, op: string, raw: unknown): Promise<Reply> {
    const r = this.runtime;
    switch (op) {
      case "ping":
        parse(op, ops.ping, raw);
        await r.ping();
        return { result: {} };
      case "info":
        parse(op, ops.info, raw);
        return { result: await r.info() };
      case "listContainers":
        return { result: await r.listContainers({ labels: parse(op, ops.listContainers, raw).labels }) };
      case "inspectContainer":
        return { result: await r.inspectContainer(parse(op, ops.inspectContainer, raw).id) };
      case "inspectEnv":
        return { result: await r.inspectEnv(parse(op, ops.inspectEnv, raw).id) };
      case "createContainer":
        return { result: await r.createContainer(parse(op, ops.createContainer, raw).spec) };
      case "startContainer":
        await r.startContainer(parse(op, ops.startContainer, raw).id);
        return { result: {} };
      case "stopContainer": {
        const a = parse(op, ops.stopContainer, raw);
        await r.stopContainer(a.id, { timeoutSec: a.timeoutSec });
        return { result: {} };
      }
      case "restartContainer": {
        const a = parse(op, ops.restartContainer, raw);
        await r.restartContainer(a.id, { timeoutSec: a.timeoutSec });
        return { result: {} };
      }
      case "pauseContainer":
        await r.pauseContainer(parse(op, ops.pauseContainer, raw).id);
        return { result: {} };
      case "unpauseContainer":
        await r.unpauseContainer(parse(op, ops.unpauseContainer, raw).id);
        return { result: {} };
      case "removeContainer": {
        const a = parse(op, ops.removeContainer, raw);
        await r.removeContainer(a.id, { force: a.force });
        return { result: {} };
      }
      case "renameContainer": {
        const a = parse(op, ops.renameContainer, raw);
        await r.renameContainer(a.id, a.name);
        return { result: {} };
      }
      case "updateContainer": {
        const a = parse(op, ops.updateContainer, raw);
        await r.updateContainer(a.id, a.limits);
        return { result: {} };
      }
      case "containerLogs": {
        const a = parse(op, ops.containerLogs, raw);
        return { result: await r.containerLogs(a.id, { tail: a.tail, timestamps: a.timestamps }) };
      }
      case "containerStats":
        return { result: await r.containerStats(parse(op, ops.containerStats, raw).id) };
      case "containerDiff":
        return { result: await r.containerDiff(parse(op, ops.containerDiff, raw).id) };
      case "listImages":
        return { result: await r.listImages({ labels: parse(op, ops.listImages, raw).labels }) };
      case "inspectImage":
        return { result: await r.inspectImage(parse(op, ops.inspectImage, raw).ref) };
      case "pullImage":
        await r.pullImage(parse(op, ops.pullImage, raw).ref);
        return { result: {} };
      case "inspectVolume":
        return { result: await r.inspectVolume(parse(op, ops.inspectVolume, raw).name) };
      case "listVolumes":
        parse(op, ops.listVolumes, raw);
        return { result: await r.listVolumes() };
      case "createVolume": {
        const a = parse(op, ops.createVolume, raw);
        await r.createVolume(a.name, a.labels);
        return { result: {} };
      }
      case "removeVolume":
        await r.removeVolume(parse(op, ops.removeVolume, raw).name);
        return { result: {} };
      case "setVolumeRootOwner": {
        const a = parse(op, ops.setVolumeRootOwner, raw);
        await r.setVolumeRootOwner(a.volume, a.owner, a.image);
        return { result: {} };
      }
      case "ensureBridgeNetwork": {
        const a = parse(op, ops.ensureBridgeNetwork, raw);
        await r.ensureBridgeNetwork(a.name, a.opts);
        return { result: {} };
      }
      case "reattachNetwork": {
        const a = parse(op, ops.reattachNetwork, raw);
        await r.reattachNetwork(a.containerId, a.name);
        return { result: {} };
      }
      case "startExec":
        return this.startExec(id, parse(op, ops.startExec, raw));
      case "followLogs":
        return this.followLogs(id, parse(op, ops.followLogs, raw));
      case "events":
        return this.events(id, parse(op, ops.events, raw));
      case "execResize": {
        const a = parse(op, ops.execResize, raw);
        await this.session(a.session).resize({ cols: a.cols, rows: a.rows });
        return { result: {} };
      }
      case "execInspect":
        return { result: await this.session(parse(op, ops.execInspect, raw).session).inspect() };
      case "execKill":
        await this.session(parse(op, ops.execKill, raw).session).kill();
        return { result: {} };
      default:
        if ((REFUSED_OPERATIONS as readonly string[]).includes(op)) {
          throw new RuntimeError("unsupported", `${op} is not available on agent hosts`, `${op} is refused`);
        }
        throw new RuntimeError("invalid", `unknown operation ${op}`, `unknown operation ${op}`);
    }
  }

  private async startExec(id: string, a: { containerId: string; spec: ExecSpec }): Promise<Reply> {
    const session = await this.runtime.startExec(a.containerId, a.spec);
    if (this.closed) {
      session.stream.destroy();
      throw new RuntimeError("unavailable", "the connection closed", "the connection closed");
    }
    const tty = a.spec.tty !== false;
    this.open.set(id, { kind: "exec", session, tty });
    return {
      result: { execId: session.id },
      after: () => this.pumpExec(id, session, tty),
    };
  }

  private pumpExec(id: string, session: ExecSession, tty: boolean): void {
    const done = tty
      ? ended(session.stream)
      : Promise.all([ended(session.stdout), ended(session.stderr)]).then(() => undefined);
    if (tty) {
      session.stream.on("data", (chunk: Buffer) => this.sink.data(id, "stdout", chunk));
    } else {
      session.stdout.on("data", (chunk: Buffer) => this.sink.data(id, "stdout", chunk));
      session.stderr.on("data", (chunk: Buffer) => this.sink.data(id, "stderr", chunk));
    }
    void done.then(() => this.completeExec(id, session));
  }

  /** The exit state is read before the end frame, so the control plane never has to ask about a session that is gone. */
  private async completeExec(id: string, session: ExecSession): Promise<void> {
    const status = await session.inspect().catch(() => undefined);
    const exit = status && { running: status.running, exitCode: status.exitCode, pid: status.pid };
    this.finish(id, undefined, exit);
  }

  private followLogs(id: string, a: z.output<typeof ops.followLogs>): Reply {
    const abort = new AbortController();
    this.open.set(id, { kind: "abort", abort });
    const lines = this.runtime.followLogs(a.id, {
      tail: a.tail,
      timestamps: a.timestamps,
      since: a.since === undefined ? undefined : new Date(a.since),
      signal: abort.signal,
    });
    return { result: {}, after: () => void this.pump(id, lines) };
  }

  private events(id: string, a: z.output<typeof ops.events>): Reply {
    const abort = new AbortController();
    this.open.set(id, { kind: "abort", abort });
    const events = this.runtime.events(a.filter, abort.signal);
    return { result: {}, after: () => void this.pump(id, events) };
  }

  private async pump(id: string, source: AsyncIterable<unknown>): Promise<void> {
    try {
      for await (const value of source) {
        if (!this.open.has(id)) break;
        this.sink.item(id, value);
      }
      this.finish(id);
    } catch (e) {
      this.finish(id, errorInfo(e));
    }
  }

  private finish(id: string, error?: AgentErrorInfo, exit?: ExecExit): void {
    const stream = this.open.get(id);
    if (!stream) return;
    this.open.delete(id);
    if (stream.kind === "exec") stream.session.stream.destroy();
    this.sink.end(id, error, exit);
  }

  private session(id: string): ExecSession {
    const stream = this.open.get(id);
    if (stream?.kind !== "exec") throw new RuntimeError("not_found", `no open exec session ${id}`, id);
    return stream.session;
  }
}
