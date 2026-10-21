import { randomBytes } from "node:crypto";
import { Duplex, Readable } from "node:stream";

import { abortError } from "../../src/lib/abort";
import {
  type BuildSpec,
  type CommitSpec,
  type ContainerChange,
  type ContainerInfo,
  type ContainerStats,
  type ContainerUpdate,
  type CreateContainerSpec,
  type ExecSession,
  type ExecSpec,
  type ExecStatus,
  type ImageDetails,
  type ImageSummary,
  type Runtime,
  type RuntimeEvent,
  type RuntimeInfo,
  RuntimeError,
  type VolumeInfo,
} from "../../src/runtime";

export type Op = keyof Runtime;

export interface Call {
  op: Op;
  args: unknown[];
}

export interface FakeContainer {
  id: string;
  name: string;
  imageId: string;
  labels: Record<string, string>;
  spec: CreateContainerSpec;
  created: string;
  running: boolean;
  startedAt: string | null;
  cpus: number | null;
  memoryBytes: number | null;
  swapBytes: number | null;
  pidsLimit: number | null;
  /** Engine restart policy. Updates can set values create does not offer, such as `always`. */
  restart: string;
  logs: string;
  /** Writable-layer changes returned by `containerDiff`. Empty unless a test seeds them. */
  diff: ContainerChange[];
  /** ID of the network the container's endpoint points at. Null until the container first starts, as in the engine. */
  networkId: string | null;
}

export interface FakeImage {
  id: string;
  tags: string[];
  labels: Record<string, string>;
  createdAt: string;
  size: number;
}

export interface FakeNetwork {
  id: string;
  name: string;
  driver: string;
  options: Record<string, string>;
}

export interface FakeExec extends ExecSession {
  readonly spec: ExecSpec;
  readonly containerId: string;
  readonly sizes: { cols: number; rows: number }[];
  /** Writes text to the terminal output, as a shell would. */
  print(text: string): void;
  /** Ends the session as if the process had exited. */
  exit(code?: number): void;
}

type GateResolve = () => void;

const now = () => new Date().toISOString();
const newContainerId = () => randomBytes(32).toString("hex");
const newNetworkId = () => randomBytes(32).toString("hex");
const newImageId = () => `sha256:${randomBytes(32).toString("hex")}`;
const normalizeRef = (ref: string) => (ref.includes(":") ? ref : `${ref}:latest`);
const matchesLabels = (labels: Record<string, string>, wanted: Record<string, string>) =>
  Object.entries(wanted).every(([key, value]) => labels[key] === value);
/** The engine's default bridge network, which needs no ensure step. */
const DEFAULT_NETWORK = "bridge";
/** The option name Docker stores for inter-container communication. */
const ICC_OPTION = "com.docker.network.bridge.enable_icc";
const networkMissing = (network: string) =>
  new RuntimeError("not_found", `failed to set up container networking: network ${network} not found`);

function matchesEvent(event: RuntimeEvent, filter: { labels?: Record<string, string>; types?: string[] }): boolean {
  if (filter.types && !filter.types.includes(event.type)) return false;
  return filter.labels === undefined || matchesLabels(event.attributes, filter.labels);
}

/** The `LABEL key=value` lines of a commit or build, as Docker would store them. */
function labelsFromChanges(changes: string[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const change of changes) {
    const match = /^LABEL\s+([^=\s]+)=(.*)$/.exec(change);
    if (match) labels[match[1] ?? ""] = (match[2] ?? "").replace(/^"(.*)"$/, "$1");
  }
  return labels;
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Echoes everything written to it, like a TTY, and ends when the write side ends. */
function echoStream(): Duplex {
  const stream: Duplex = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      stream.push(chunk);
      callback();
    },
    final(callback) {
      stream.push(null);
      callback();
    },
  });
  return stream;
}

function toInfo(c: FakeContainer): ContainerInfo {
  return {
    id: c.id,
    name: c.name,
    image: c.spec.image,
    imageId: c.imageId,
    labels: { ...c.labels },
    created: c.created,
    state: c.running ? "running" : c.startedAt ? "exited" : "created",
    running: c.running,
    startedAt: c.startedAt,
    cpus: c.cpus,
    memoryBytes: c.memoryBytes,
    pidsLimit: c.pidsLimit,
    restart: c.restart,
    mounts: (c.spec.mounts ?? []).map((mount) => ({
      source: mount.source,
      target: mount.target,
      mode: mount.mode === "ro" ? ("ro" as const) : ("rw" as const),
    })),
    network: c.spec.network ?? DEFAULT_NETWORK,
  };
}

function toSummary(img: FakeImage): ImageSummary {
  return {
    id: img.id,
    repoTags: img.tags.length > 0 ? [...img.tags] : ["<none>:<none>"],
    labels: { ...img.labels },
    createdAt: img.createdAt,
    size: img.size,
  };
}

/**
 * In-memory Runtime for unit tests. It follows the engine behavior the services rely on (name and image
 * conflicts, not_found, volumes in use, labels merged from the image on create and commit), records every call,
 * and can fail a given operation or make the whole engine unreachable. Helpers that seed state do not record calls.
 */
export class FakeRuntime implements Runtime {
  readonly calls: Call[] = [];
  readonly containers = new Map<string, FakeContainer>();
  readonly images = new Map<string, FakeImage>();
  readonly volumes = new Map<string, VolumeInfo>();
  readonly networks = new Map<string, FakeNetwork>();
  readonly execs: FakeExec[] = [];
  /** When true, every call fails as if the engine socket were unreachable. */
  down = false;
  /** Output returned by the next and later builds. */
  buildLog = "Successfully built fake\n";

  private readonly faults = new Map<Op, RuntimeError[]>();
  private readonly gates = new Map<Op, Promise<void>>();
  private readonly archives = new Map<string, Buffer>();
  private readonly subscribers = new Set<(event: RuntimeEvent) => void>();
  private execCount = 0;

  /**
   * Holds the next calls to `op` until `release`. `buildImage` reports its log before waiting. A held call does not
   * return when `signal` aborts, as an engine call already in flight does not: once released, it fails with
   * `AbortError` if `signal` has aborted.
   */
  hold(op: Op): { release(): void } {
    let resolveGate: GateResolve | undefined;
    const promise = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    this.gates.set(op, promise);
    return {
      release: () => {
        this.gates.delete(op);
        resolveGate?.();
      },
    };
  }

  /** The next call to `op` fails with `error`. Queue several errors to fail several calls. */
  fail(op: Op, error: RuntimeError): void {
    const queue = this.faults.get(op) ?? [];
    queue.push(error);
    this.faults.set(op, queue);
  }

  callsTo(op: Op): Call[] {
    return this.calls.filter((call) => call.op === op);
  }

  ops(): Op[] {
    return this.calls.map((call) => call.op);
  }

  seedImage(ref: string, labels: Record<string, string> = {}, createdAt = now()): string {
    const id = newImageId();
    this.images.set(id, { id, tags: [normalizeRef(ref)], labels: { ...labels }, createdAt, size: 1024 });
    return id;
  }

  /** A network that is created again gets a new ID, which containers that ran on the old one still point at. */
  seedNetwork(name: string, options: Record<string, string> = {}, driver = "bridge"): void {
    this.networks.set(name, { id: newNetworkId(), name, driver, options: { ...options } });
  }

  /** Removes networks that no running container uses, as `docker network prune` does. */
  pruneNetworks(): void {
    for (const name of this.networks.keys()) {
      const inUse = [...this.containers.values()].some((c) => c.running && c.spec.network === name);
      if (!inUse) this.networks.delete(name);
    }
  }

  /** Writable-layer changes the next `containerDiff` returns. Seeding does not record a call. */
  seedDiff(id: string, changes: ContainerChange[]): void {
    this.getContainer(id).diff = changes.map((change) => ({ ...change }));
  }

  /** `null` limits model a box created without them (unlimited). */
  seedContainer(
    spec: Omit<CreateContainerSpec, "cpus" | "memoryBytes" | "swapBytes"> & {
      running?: boolean;
      cpus?: number | null;
      memoryBytes?: number | null;
      swapBytes?: number | null;
    },
  ): string {
    const { running = false, cpus = null, memoryBytes = null, swapBytes = null, ...rest } = spec;
    const imageId = this.findImage(rest.image)?.id ?? this.seedImage(rest.image);
    return this.insertContainer(rest, imageId, running, { cpus, memoryBytes, swapBytes }).id;
  }

  emitEvent(event: RuntimeEvent): void {
    for (const subscriber of this.subscribers) subscriber(event);
  }

  private async gate(op: Op): Promise<void> {
    await this.gates.get(op);
  }

  private enter(op: Op, args: unknown[]): void {
    this.calls.push({ op, args });
    if (this.down) throw new RuntimeError("unavailable", "connect ECONNREFUSED fake-docker.sock");
    const error = this.faults.get(op)?.shift();
    if (error) throw error;
  }

  private findContainer(idOrName: string): FakeContainer | undefined {
    return this.containers.get(idOrName) ?? [...this.containers.values()].find((c) => c.name === idOrName);
  }

  private getContainer(idOrName: string): FakeContainer {
    const c = this.findContainer(idOrName);
    if (!c) throw new RuntimeError("not_found", `No such container: ${idOrName}`);
    return c;
  }

  /**
   * Like the engine, a container can be created on a missing network but fails to start on it. Its endpoint is set up
   * on the first start and keeps the ID of that network, so a start also fails while that network ID is gone.
   */
  private attach(c: FakeContainer): void {
    const name = c.spec.network ?? DEFAULT_NETWORK;
    if (name === DEFAULT_NETWORK) return;
    if (c.networkId === null) {
      const network = this.networks.get(name);
      if (!network) throw networkMissing(name);
      c.networkId = network.id;
    } else if (![...this.networks.values()].some((network) => network.id === c.networkId)) {
      throw networkMissing(c.networkId);
    }
  }

  private networkIdOf(name: string | undefined): string | null {
    if (name === undefined || name === DEFAULT_NETWORK) return null;
    return this.networks.get(name)?.id ?? null;
  }

  private findImage(ref: string): FakeImage | undefined {
    const tag = normalizeRef(ref);
    return [...this.images.values()].find((img) => img.id === ref || img.tags.includes(tag));
  }

  private getImage(ref: string): FakeImage {
    const img = this.findImage(ref);
    if (!img) throw new RuntimeError("not_found", `No such image: ${ref}`);
    return img;
  }

  private tag(image: FakeImage, ref: string): void {
    for (const other of this.images.values()) other.tags = other.tags.filter((t) => t !== ref);
    image.tags.push(ref);
  }

  private insertContainer(
    spec: CreateContainerSpec,
    imageId: string,
    running: boolean,
    limits: { cpus: number | null; memoryBytes: number | null; swapBytes: number | null },
  ): FakeContainer {
    const image = this.images.get(imageId);
    const c: FakeContainer = {
      id: newContainerId(),
      name: spec.name ?? `fake-${randomBytes(4).toString("hex")}`,
      imageId,
      labels: { ...image?.labels, ...spec.labels },
      spec,
      created: now(),
      running,
      startedAt: running ? now() : null,
      ...limits,
      pidsLimit: spec.hardening?.pidsLimit ?? null,
      restart: spec.restart ?? "no",
      logs: "",
      diff: [],
      networkId: running ? this.networkIdOf(spec.network) : null,
    };
    this.containers.set(c.id, c);
    return c;
  }

  async ping(): Promise<void> {
    this.enter("ping", []);
  }

  async info(): Promise<RuntimeInfo> {
    this.enter("info", []);
    const running = [...this.containers.values()].filter((c) => c.running).length;
    return {
      version: "fake",
      rootDir: "/fake/docker",
      containers: { running, total: this.containers.size },
      images: this.images.size,
    };
  }

  async listContainers(filter: { labels: Record<string, string> }): Promise<ContainerInfo[]> {
    this.enter("listContainers", [filter]);
    return [...this.containers.values()].filter((c) => matchesLabels(c.labels, filter.labels)).map(toInfo);
  }

  async inspectContainer(id: string): Promise<ContainerInfo> {
    this.enter("inspectContainer", [id]);
    return toInfo(this.getContainer(id));
  }

  async createContainer(spec: CreateContainerSpec): Promise<{ id: string }> {
    this.enter("createContainer", [spec]);
    const image = this.getImage(spec.image);
    if (spec.name !== undefined && this.findContainer(spec.name)) {
      throw new RuntimeError("conflict", `Conflict. The container name "/${spec.name}" is already in use`);
    }
    const limits = {
      cpus: spec.cpus ?? null,
      memoryBytes: spec.memoryBytes ?? null,
      swapBytes: spec.swapBytes ?? null,
    };
    return { id: this.insertContainer(spec, image.id, false, limits).id };
  }

  async startContainer(id: string): Promise<void> {
    this.enter("startContainer", [id]);
    const c = this.getContainer(id);
    if (!c.running) {
      this.attach(c);
      c.running = true;
      c.startedAt = now();
    }
  }

  async stopContainer(id: string, opts: { timeoutSec: number }): Promise<void> {
    this.enter("stopContainer", [id, opts]);
    this.getContainer(id).running = false;
  }

  async restartContainer(id: string, opts: { timeoutSec: number }): Promise<void> {
    this.enter("restartContainer", [id, opts]);
    const c = this.getContainer(id);
    this.attach(c);
    c.running = true;
    c.startedAt = now();
  }

  async removeContainer(id: string, opts: { force: boolean }): Promise<void> {
    this.enter("removeContainer", [id, opts]);
    const c = this.getContainer(id);
    if (c.running && !opts.force) {
      throw new RuntimeError("conflict", `You cannot remove a running container ${c.id}. Stop it or force removal.`);
    }
    this.containers.delete(c.id);
  }

  async renameContainer(id: string, name: string): Promise<void> {
    this.enter("renameContainer", [id, name]);
    const c = this.getContainer(id);
    const other = this.findContainer(name);
    if (other && other !== c)
      throw new RuntimeError("conflict", `Conflict. The container name "/${name}" is already in use`);
    c.name = name;
  }

  async updateContainer(id: string, limits: ContainerUpdate): Promise<void> {
    this.enter("updateContainer", [id, limits]);
    const c = this.getContainer(id);
    if (limits.cpus !== undefined) c.cpus = limits.cpus;
    if (limits.memoryBytes !== undefined) c.memoryBytes = limits.memoryBytes;
    if (limits.swapBytes !== undefined) c.swapBytes = limits.swapBytes;
    if (limits.pidsLimit !== undefined) c.pidsLimit = limits.pidsLimit;
    if (limits.restart !== undefined) c.restart = limits.restart;
  }

  async containerDiff(id: string): Promise<ContainerChange[]> {
    this.enter("containerDiff", [id]);
    return this.getContainer(id).diff.map((change) => ({ ...change }));
  }

  async containerLogs(id: string, opts: { tail: number; timestamps: boolean }): Promise<string> {
    this.enter("containerLogs", [id, opts]);
    return this.getContainer(id)
      .logs.split(/(?<=\n)/)
      .slice(-opts.tail)
      .join("");
  }

  async containerStats(id: string): Promise<ContainerStats> {
    this.enter("containerStats", [id]);
    const memLimit = this.getContainer(id).memoryBytes ?? 1024 ** 3;
    return { cpuPercent: 1.5, memUsage: Math.round(memLimit / 4), memLimit, memPercent: 25 };
  }

  async commitContainer(id: string, spec: CommitSpec): Promise<void> {
    this.enter("commitContainer", [id, spec]);
    await this.gate("commitContainer");
    if (spec.signal?.aborted) throw abortError();
    const c = this.getContainer(id);
    const image: FakeImage = {
      id: newImageId(),
      tags: [],
      labels: { ...c.labels, ...labelsFromChanges(spec.changes) },
      createdAt: now(),
      size: 1024,
    };
    this.images.set(image.id, image);
    this.tag(image, `${spec.repo}:${spec.tag}`);
    if (spec.signal?.aborted) throw abortError();
  }

  /** Keeps the last archive per container; paths are not interpreted. */
  async putArchive(id: string, path: string, tar: Readable | Buffer): Promise<void> {
    this.enter("putArchive", [id, path, tar]);
    const c = this.getContainer(id);
    this.archives.set(c.id, Buffer.isBuffer(tar) ? tar : await collect(tar));
  }

  async getArchive(id: string, path: string): Promise<Readable> {
    this.enter("getArchive", [id, path]);
    const bytes = this.archives.get(this.getContainer(id).id);
    if (!bytes) throw new RuntimeError("not_found", `Could not find the requested path ${path}`);
    return Readable.from([bytes]);
  }

  async startExec(containerId: string, spec: ExecSpec): Promise<ExecSession> {
    this.enter("startExec", [containerId, spec]);
    const c = this.getContainer(containerId);
    if (!c.running) throw new RuntimeError("conflict", `Container ${c.id} is not running`);
    const stream = echoStream();
    const sizes: { cols: number; rows: number }[] = [];
    let status: ExecStatus = { running: true, exitCode: null, pid: null };
    const session: FakeExec = {
      id: `exec-${++this.execCount}`,
      stream,
      spec,
      containerId: c.id,
      sizes,
      async resize(size) {
        sizes.push(size);
      },
      async inspect() {
        return status;
      },
      print(text) {
        stream.push(text);
      },
      exit(code = 0) {
        status = { running: false, exitCode: code, pid: null };
        stream.push(null);
      },
    };
    this.execs.push(session);
    session.print("$ ");
    return session;
  }

  async *events(
    filter: { labels?: Record<string, string>; types?: string[] },
    signal?: AbortSignal,
  ): AsyncGenerator<RuntimeEvent> {
    this.enter("events", [filter]);
    const queue: RuntimeEvent[] = [];
    let wake: (() => void) | undefined;
    const notify = () => wake?.();
    const subscriber = (event: RuntimeEvent) => {
      if (!matchesEvent(event, filter)) return;
      queue.push(event);
      notify();
    };
    this.subscribers.add(subscriber);
    signal?.addEventListener("abort", notify);
    try {
      for (;;) {
        if (signal?.aborted) return;
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    } finally {
      this.subscribers.delete(subscriber);
      signal?.removeEventListener("abort", notify);
    }
  }

  async listImages(filter: { labels: Record<string, string> }): Promise<ImageSummary[]> {
    this.enter("listImages", [filter]);
    return [...this.images.values()].filter((img) => matchesLabels(img.labels, filter.labels)).map(toSummary);
  }

  async inspectImage(ref: string): Promise<ImageDetails> {
    this.enter("inspectImage", [ref]);
    const img = this.getImage(ref);
    return { id: img.id, labels: { ...img.labels } };
  }

  /** Removes one reference. The image stays as a dangling image while a container still uses it. */
  async removeImage(ref: string, opts: { force: boolean }): Promise<void> {
    this.enter("removeImage", [ref, opts]);
    const img = this.getImage(ref);
    const tag = img.id === ref ? undefined : normalizeRef(ref);
    const remaining = tag === undefined ? [] : img.tags.filter((t) => t !== tag);
    const inUse = [...this.containers.values()].some((c) => c.imageId === img.id);
    if (remaining.length === 0 && inUse && !opts.force) {
      throw new RuntimeError("conflict", `conflict: unable to remove ${ref} (must force) - image is in use`);
    }
    img.tags = remaining;
    if (remaining.length === 0 && !inUse) this.images.delete(img.id);
  }

  async buildImage(spec: BuildSpec): Promise<string> {
    this.enter("buildImage", [spec]);
    spec.onLog?.(this.buildLog);
    await this.gate("buildImage");
    if (spec.signal?.aborted) throw abortError();
    const image: FakeImage = { id: newImageId(), tags: [], labels: { ...spec.labels }, createdAt: now(), size: 1024 };
    this.images.set(image.id, image);
    this.tag(image, normalizeRef(spec.tag));
    return this.buildLog;
  }

  async inspectVolume(name: string): Promise<VolumeInfo> {
    this.enter("inspectVolume", [name]);
    const volume = this.volumes.get(name);
    if (!volume) throw new RuntimeError("not_found", `get ${name}: no such volume`);
    return { name: volume.name, labels: { ...volume.labels } };
  }

  /** Like Docker, creating an existing volume succeeds and keeps the original labels. */
  async createVolume(name: string, labels: Record<string, string>): Promise<void> {
    this.enter("createVolume", [name, labels]);
    if (!this.volumes.has(name)) this.volumes.set(name, { name, labels: { ...labels } });
  }

  async removeVolume(name: string): Promise<void> {
    this.enter("removeVolume", [name]);
    if (!this.volumes.has(name)) throw new RuntimeError("not_found", `No such volume: ${name}`);
    const inUse = [...this.containers.values()].some((c) => c.spec.mounts?.some((m) => m.source === name));
    if (inUse) throw new RuntimeError("conflict", `remove ${name}: volume is in use`);
    this.volumes.delete(name);
  }

  async ensureBridgeNetwork(name: string, opts: { interContainerComm: boolean }): Promise<void> {
    this.enter("ensureBridgeNetwork", [name, opts]);
    const existing = this.networks.get(name);
    if (!existing) {
      this.seedNetwork(name, opts.interContainerComm ? {} : { [ICC_OPTION]: "false" });
      return;
    }
    const enabled = existing.options[ICC_OPTION] !== "false";
    if (existing.driver !== "bridge" || enabled !== opts.interContainerComm) {
      throw new RuntimeError("conflict", `network ${name} exists but is not a bridge with the requested settings`);
    }
  }

  async reattachNetwork(id: string, name: string): Promise<void> {
    this.enter("reattachNetwork", [id, name]);
    const c = this.getContainer(id);
    if ((c.spec.network ?? DEFAULT_NETWORK) !== name) {
      throw new RuntimeError("invalid", `container ${c.id} is not on network ${name}`);
    }
    const network = this.networks.get(name);
    if (!network) throw new RuntimeError("not_found", `network ${name} not found`);
    c.networkId = network.id;
  }
}
