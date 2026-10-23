import { Duplex, PassThrough, type Readable } from "node:stream";

import type { AgentErrorInfo, ExecExit } from "../../agent/protocol";
import { abortError, untilAborted } from "../../lib/abort";
import { log } from "../../lib/logger";
import {
  type ContainerChange,
  type ContainerInfo,
  type ContainerStats,
  type ContainerUpdate,
  type CreateContainerSpec,
  type DiskUsage,
  type ExecSession,
  type ExecSpec,
  type HelperResult,
  type ImageDetails,
  type ImageSummary,
  type NetworkSummary,
  isRuntimeError,
  type PathStat,
  type Runtime,
  type RuntimeEvent,
  type RuntimeInfo,
  RuntimeError,
  type VolumeCreateOptions,
  type VolumeInfo,
  type VolumeOwner,
} from "../../runtime";

/** Where a stream's frames go. The hub calls it for each frame of the stream, in order. */
export interface StreamSink {
  item(value: unknown): void;
  data(channel: "stdout" | "stderr", bytes: Buffer): void;
  end(error?: AgentErrorInfo, exit?: ExecExit): void;
}

/** One open stream. `opened` settles with the operation's result when the agent answers the open. */
export interface StreamHandle {
  readonly id: string;
  readonly opened: Promise<unknown>;
  input(bytes: Uint8Array): void;
  inputEnd(): void;
  cancel(): void;
}

/** The connection to one agent, as the runtime uses it. The hub implements it. */
export interface AgentLink {
  request(agentId: string, op: string, args: unknown, opts: { timeoutMs: number }): Promise<unknown>;
  open(agentId: string, op: string, args: unknown, sink: StreamSink, opts: { timeoutMs: number }): StreamHandle;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const PULL_TIMEOUT_MS = 15 * 60_000;
const OWNER_TIMEOUT_MS = 5 * 60_000;
const STOP_GRACE_MS = 60_000;

/** Volume creation with a driver is how an NFS or path pool makes its volume, and an agent host has no such pools. */
const LOCAL_VOLUMES_ONLY = "volume driver options are not available on agent hosts";

function refused(op: string): RuntimeError {
  return new RuntimeError("unsupported", `${op} is not available on agent hosts`, `${op} is refused`);
}

function unavailable(reason: string): RuntimeError {
  return new RuntimeError("unavailable", reason, reason);
}

/** The error an agent reported for a call. An aborted call is the abort error the rest of MiniBox already handles. */
export function runtimeErrorOf(info: AgentErrorInfo): Error {
  if (info.kind === "aborted") return abortError();
  return new RuntimeError(info.kind, info.message, info.detail);
}

/** A queue an async iterator reads from. Items already pushed are read first; `finish` ends it, with an error if one is given. */
class Feed<T> {
  private readonly queue: T[] = [];
  private readonly waiting: Array<(step: Step<T>) => void> = [];
  private ended: { error: unknown } | null = null;

  push(value: T): void {
    if (this.ended) return;
    const wake = this.waiting.shift();
    if (wake) wake({ done: false, value });
    else this.queue.push(value);
  }

  finish(error?: unknown): void {
    if (this.ended) return;
    this.ended = { error };
    for (const wake of this.waiting.splice(0)) wake({ done: true, error });
  }

  next(): Promise<Step<T>> {
    if (this.queue.length > 0) return Promise.resolve({ done: false, value: this.queue.shift() as T });
    if (this.ended) return Promise.resolve({ done: true, error: this.ended.error });
    return new Promise<Step<T>>((resolve) => this.waiting.push(resolve));
  }
}

type Step<T> = { readonly done: false; readonly value: T } | { readonly done: true; readonly error: unknown };

/**
 * The two ends of an exec's bytes. A TTY exec has one stream for both directions, as the engine's TTY does. A command exec
 * keeps stdout and stderr apart, and its stdin is the writable side.
 */
class ExecChannels implements StreamSink {
  readonly stream: Duplex;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** The exec's exit state, once the agent has sent it. Null while it runs, or when the stream ended without one. */
  exit: ExecExit | null = null;
  private handle: StreamHandle | null = null;
  private finished = false;
  private readonly outPass = new PassThrough();
  private readonly errPass = new PassThrough();

  constructor(private readonly tty: boolean) {
    this.stream = new Duplex({
      read() {},
      write: (chunk: Buffer, _encoding, callback) => {
        if (!this.finished) this.handle?.input(chunk);
        callback();
      },
      final: (callback) => {
        if (!this.finished) this.handle?.inputEnd();
        callback();
      },
      destroy: (error, callback) => {
        if (!this.finished) this.handle?.cancel();
        callback(error);
      },
    });
    this.stdout = tty ? this.stream : this.outPass;
    this.stderr = this.errPass;
  }

  attach(handle: StreamHandle): void {
    this.handle = handle;
  }

  item(): void {}

  data(channel: "stdout" | "stderr", bytes: Buffer): void {
    if (this.tty) {
      this.stream.push(bytes);
      return;
    }
    (channel === "stderr" ? this.errPass : this.outPass).write(bytes);
  }

  end(error?: AgentErrorInfo, exit?: ExecExit): void {
    if (this.finished) return;
    this.finished = true;
    this.exit = exit ?? null;
    if (error) log.warn("agent.exec_failed", { error: error.message });
    if (this.tty) {
      this.stream.push(null);
      return;
    }
    this.outPass.end();
    this.errPass.end();
  }
}

/**
 * A `Runtime` that runs each call on an agent. Operations the agent is allowed to run cross the connection; the rest fail
 * here as `unsupported`, so the caller gets the same answer whether or not the agent is reachable. A call that the agent
 * cannot answer, because it is not connected or did not answer in time, fails as `unavailable`.
 */
export class AgentRuntime implements Runtime {
  constructor(
    private readonly agentId: string,
    private readonly link: AgentLink,
  ) {}

  ping(): Promise<void> {
    return this.call("ping", {}).then(() => undefined);
  }

  info(): Promise<RuntimeInfo> {
    return this.call("info", {}) as Promise<RuntimeInfo>;
  }

  listContainers(
    filter: { labels: Record<string, string> },
    opts?: { signal?: AbortSignal },
  ): Promise<ContainerInfo[]> {
    return this.call("listContainers", { labels: filter.labels }, opts?.signal) as Promise<ContainerInfo[]>;
  }

  inspectContainer(id: string, opts?: { signal?: AbortSignal }): Promise<ContainerInfo> {
    return this.call("inspectContainer", { id }, opts?.signal) as Promise<ContainerInfo>;
  }

  inspectEnv(id: string): Promise<string[]> {
    return this.call("inspectEnv", { id }) as Promise<string[]>;
  }

  createContainer(spec: CreateContainerSpec): Promise<{ id: string }> {
    return this.call("createContainer", { spec }) as Promise<{ id: string }>;
  }

  startContainer(id: string): Promise<void> {
    return this.call("startContainer", { id }).then(() => undefined);
  }

  stopContainer(id: string, opts: { timeoutSec: number }): Promise<void> {
    return this.call("stopContainer", { id, timeoutSec: opts.timeoutSec }, undefined, graceOf(opts.timeoutSec)).then(
      () => undefined,
    );
  }

  restartContainer(id: string, opts: { timeoutSec: number }): Promise<void> {
    return this.call("restartContainer", { id, timeoutSec: opts.timeoutSec }, undefined, graceOf(opts.timeoutSec)).then(
      () => undefined,
    );
  }

  pauseContainer(id: string): Promise<void> {
    return this.call("pauseContainer", { id }).then(() => undefined);
  }

  unpauseContainer(id: string): Promise<void> {
    return this.call("unpauseContainer", { id }).then(() => undefined);
  }

  removeContainer(id: string, opts: { force: boolean }): Promise<void> {
    return this.call("removeContainer", { id, force: opts.force }).then(() => undefined);
  }

  renameContainer(id: string, name: string): Promise<void> {
    return this.call("renameContainer", { id, name }).then(() => undefined);
  }

  updateContainer(id: string, limits: ContainerUpdate): Promise<void> {
    return this.call("updateContainer", { id, limits }).then(() => undefined);
  }

  containerLogs(id: string, opts: { tail: number; timestamps: boolean }): Promise<string> {
    return this.call("containerLogs", { id, tail: opts.tail, timestamps: opts.timestamps }) as Promise<string>;
  }

  followLogs(
    id: string,
    opts: { tail: number; timestamps: boolean; since?: Date; signal?: AbortSignal },
  ): AsyncIterable<string> {
    const args = {
      id,
      tail: opts.tail,
      timestamps: opts.timestamps,
      since: opts.since?.toISOString(),
    };
    return this.items<string>("followLogs", args, opts.signal);
  }

  containerDiff(id: string): Promise<ContainerChange[]> {
    return this.call("containerDiff", { id }) as Promise<ContainerChange[]>;
  }

  containerStats(id: string, opts?: { signal?: AbortSignal }): Promise<ContainerStats> {
    return this.call("containerStats", { id }, opts?.signal) as Promise<ContainerStats>;
  }

  async commitContainer(): Promise<void> {
    throw refused("commitContainer");
  }

  async putArchive(): Promise<void> {
    throw refused("putArchive");
  }

  async getArchive(): Promise<Readable> {
    throw refused("getArchive");
  }

  async statPath(): Promise<PathStat> {
    throw refused("statPath");
  }

  async volumeRootOwner(): Promise<VolumeOwner> {
    throw refused("volumeRootOwner");
  }

  setVolumeRootOwner(volume: string, owner: VolumeOwner, image: string): Promise<void> {
    return this.call("setVolumeRootOwner", { volume, owner, image }, undefined, OWNER_TIMEOUT_MS).then(() => undefined);
  }

  async startExec(containerId: string, spec: ExecSpec): Promise<ExecSession> {
    const channels = new ExecChannels(spec.tty !== false);
    const handle = this.link.open(this.agentId, "startExec", { containerId, spec }, channels, {
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    channels.attach(handle);
    const opened = (await handle.opened) as { execId: string };
    return {
      id: opened.execId,
      stream: channels.stream,
      stdout: channels.stdout,
      stderr: channels.stderr,
      resize: async ({ cols, rows }) => {
        if (channels.exit) return;
        await this.sessionCall("execResize", { session: handle.id, cols, rows });
      },
      inspect: async () => {
        if (channels.exit) return channels.exit;
        const status = await this.sessionCall("execInspect", { session: handle.id });
        return (status as ExecExit | undefined) ?? { running: false, exitCode: null, pid: null };
      },
      kill: async () => {
        if (channels.exit) return;
        await this.sessionCall("execKill", { session: handle.id });
      },
    };
  }

  events(
    filter: { labels?: Record<string, string>; types?: string[]; since?: number },
    signal?: AbortSignal,
  ): AsyncIterable<RuntimeEvent> {
    return this.items<RuntimeEvent>("events", { filter }, signal);
  }

  listImages(filter: { labels: Record<string, string> }): Promise<ImageSummary[]> {
    return this.call("listImages", { labels: filter.labels }) as Promise<ImageSummary[]>;
  }

  inspectImage(ref: string): Promise<ImageDetails> {
    return this.call("inspectImage", { ref }) as Promise<ImageDetails>;
  }

  pullImage(ref: string): Promise<void> {
    return this.call("pullImage", { ref }, undefined, PULL_TIMEOUT_MS).then(() => undefined);
  }

  async removeImage(): Promise<void> {
    throw refused("removeImage");
  }

  async saveImage(): Promise<Readable> {
    throw refused("saveImage");
  }

  async loadImage(): Promise<void> {
    throw refused("loadImage");
  }

  async buildImage(): Promise<string> {
    throw refused("buildImage");
  }

  inspectVolume(name: string): Promise<VolumeInfo> {
    return this.call("inspectVolume", { name }) as Promise<VolumeInfo>;
  }

  listVolumes(): Promise<VolumeInfo[]> {
    return this.call("listVolumes", {}) as Promise<VolumeInfo[]>;
  }

  createVolume(name: string, labels: Record<string, string>, opts?: VolumeCreateOptions): Promise<void> {
    if (opts?.driver !== undefined || opts?.driverOpts !== undefined) {
      return Promise.reject(new RuntimeError("unsupported", LOCAL_VOLUMES_ONLY, LOCAL_VOLUMES_ONLY));
    }
    return this.call("createVolume", { name, labels }).then(() => undefined);
  }

  removeVolume(name: string): Promise<void> {
    return this.call("removeVolume", { name }).then(() => undefined);
  }

  async runHelper(): Promise<HelperResult> {
    throw refused("runHelper");
  }

  async diskUsage(): Promise<DiskUsage> {
    throw refused("diskUsage");
  }

  ensureBridgeNetwork(
    name: string,
    opts: { interContainerComm: boolean; internal?: boolean; subnet?: string },
  ): Promise<void> {
    return this.call("ensureBridgeNetwork", { name, opts }).then(() => undefined);
  }

  removeNetwork(name: string): Promise<void> {
    return this.call("removeNetwork", { name }).then(() => undefined);
  }

  connectNetwork(containerId: string, name: string, opts?: { alias?: string }): Promise<void> {
    return this.call("connectNetwork", { containerId, name, opts }).then(() => undefined);
  }

  listNetworks(): Promise<NetworkSummary[]> {
    return this.call("listNetworks", {}) as Promise<NetworkSummary[]>;
  }

  reattachNetwork(containerId: string, name: string): Promise<void> {
    return this.call("reattachNetwork", { containerId, name }).then(() => undefined);
  }

  setHostIngressBlock(sources: string[]): Promise<void> {
    return this.call("setHostIngressBlock", { sources }).then(() => undefined);
  }

  private call(op: string, args: unknown, signal?: AbortSignal, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(abortError());
    const pending = this.link.request(this.agentId, op, args, { timeoutMs });
    return signal ? untilAborted(pending, signal) : pending;
  }

  /**
   * A call on an open exec session. The session ends on its own, so a call that finds it gone means it has ended: the
   * caller gets the same answer as for a session that ended, not an error.
   */
  private async sessionCall(op: string, args: unknown): Promise<unknown> {
    try {
      return await this.call(op, args);
    } catch (e) {
      if (isRuntimeError(e, "not_found")) return undefined;
      throw e;
    }
  }

  /** An operation that streams items. Stopping the iteration, or aborting `signal`, ends the stream on the agent. */
  private async *items<T>(op: string, args: unknown, signal?: AbortSignal): AsyncGenerator<T, void, void> {
    if (signal?.aborted) return;
    const feed = new Feed<T>();
    const handle = this.link.open(
      this.agentId,
      op,
      args,
      {
        item: (value) => feed.push(value as T),
        data: () => {},
        end: (error) => feed.finish(error ? runtimeErrorOf(error) : undefined),
      },
      { timeoutMs: DEFAULT_TIMEOUT_MS },
    );
    const onAbort = () => {
      handle.cancel();
      feed.finish();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      try {
        await handle.opened;
      } catch (e) {
        if (signal?.aborted) return;
        throw e;
      }
      for (;;) {
        const step = await feed.next();
        if (step.done) {
          if (step.error !== undefined) throw step.error;
          return;
        }
        yield step.value;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      handle.cancel();
    }
  }
}

/** How long a stop may take on the agent: its own grace period, then a margin for the reply. */
function graceOf(timeoutSec: number): number {
  return timeoutSec * 1000 + STOP_GRACE_MS;
}

export function agentUnavailable(reason: string): RuntimeError {
  return unavailable(reason);
}
