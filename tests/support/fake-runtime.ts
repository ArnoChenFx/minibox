import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Duplex, PassThrough, Readable } from "node:stream";

import { templateOwnerOf } from "../../src/labels";
import { abortError } from "../../src/lib/abort";
import { ipv4Overlaps, parseIpv4Cidr } from "../../src/lib/cidr";
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
  type DiskUsage,
  type HelperResult,
  type HelperSpec,
  type ImageSummary,
  type Mount,
  type NetworkSummary,
  type PathStat,
  type Runtime,
  type RuntimeEvent,
  type RuntimeInfo,
  RuntimeError,
  type VolumeCreateOptions,
  type VolumeInfo,
  type VolumeOwner,
} from "../../src/runtime";
import { FakeTmux, type TmuxClient, type TmuxRun } from "./fake-tmux";

export type Op = keyof Runtime;

export interface Call {
  op: Op;
  args: unknown[];
}

/** The regular files a build sends, read from disk: the top-level entries named by `src`, or the Dockerfile alone. */
function contextFiles(spec: BuildSpec): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (abs: string, rel: string) => {
    const info = statSync(abs, { throwIfNoEntry: false });
    if (!info) return;
    if (info.isDirectory()) {
      for (const name of readdirSync(abs)) walk(join(abs, name), rel === "" ? name : `${rel}/${name}`);
    } else if (info.isFile()) {
      files.set(rel, readFileSync(abs, "utf8"));
    }
  };
  for (const entry of spec.src ?? [spec.dockerfile]) walk(join(spec.contextDir, entry), entry);
  return files;
}

/** A file a process wrote into a container, with the mode and user it was given. */
export interface FakeContainerFile {
  readonly data: Buffer;
  readonly mode: number;
  readonly user: string;
}

export interface FakeContainer {
  id: string;
  name: string;
  imageId: string;
  labels: Record<string, string>;
  spec: CreateContainerSpec;
  created: string;
  running: boolean;
  /** A paused container is still running, as the engine reports it. */
  paused: boolean;
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
  /** Endpoints on networks other than the primary one, which `connectNetwork` adds. */
  extraEndpoints: { name: string; networkId: string; aliases: string[] }[];
  /** Files written through a process in the container. Files under a tmpfs mount go when the container stops. */
  files: Map<string, FakeContainerFile>;
}

export interface FakeImage {
  id: string;
  tags: string[];
  /** The machine architecture the image was built for, as the engine would report it. */
  arch: string;
  labels: Record<string, string>;
  /** `NAME=value` entries of the image configuration, as `docker commit` copies them from the container. */
  env: string[];
  createdAt: string;
  size: number;
}

/** What `saveImage` writes in place of the tar archive, and `loadImage` reads back. */
interface FakeImageArchive {
  id: string;
  tags: string[];
  labels: Record<string, string>;
  env: string[];
  createdAt: string;
  size: number;
}

export interface FakeFsEntry {
  type: "file" | "dir" | "symlink";
  content?: Buffer;
  target?: string;
  mode?: number;
  uid?: number;
  gid?: number;
  /** Modification time in seconds since the epoch. Entries written without one read as FAKE_MTIME. */
  mtime?: number;
}

/** The mtime of an entry the fake wrote without a header time, so listings are stable. */
const FAKE_MTIME = 1_700_000_000;

export interface FakeNetwork {
  id: string;
  name: string;
  driver: string;
  options: Record<string, string>;
  /** An internal network has no route out of the host. Set by `ensureBridgeNetwork`. */
  internal: boolean;
  /** IPv4 subnets the network was created with. Empty for networks the engine sized itself. */
  subnets: string[];
}

export interface FakeExec extends ExecSession {
  readonly spec: ExecSpec;
  readonly containerId: string;
  readonly sizes: { cols: number; rows: number }[];
  /** Set when `kill()` stopped the process. A normal exit leaves this false. */
  killed: boolean;
  /** Calls to `kill()`, including the ones that failed. */
  kills: number;
  /** Writes text to the terminal output, as a shell would. */
  print(text: string): void;
  /** Writes text to stderr. Command exec (`tty: false`) reads this stream. */
  printStderr(text: string): void;
  /** Bytes written to stdin so far. */
  stdin(): string;
  /** Ends the session as if the process had exited. */
  exit(code?: number): void;
}

type GateResolve = () => void;

/** What a non-TTY exec prints and returns. `null` hangs until `kill()`. */
export interface FakeExecScript {
  stdout: string;
  stderr: string;
  code: number;
}

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
const ROOT_OWNER: VolumeOwner = { uid: 0, gid: 0 };
const WORKSPACE = "/workspace";

function matchesEvent(event: RuntimeEvent, filter: { labels?: Record<string, string>; types?: string[] }): boolean {
  if (filter.types && !filter.types.includes(event.type)) return false;
  return filter.labels === undefined || matchesLabels(event.attributes, filter.labels);
}

/** The complete lines of `text`, without their newlines. A final partial line is kept. */
function linesOf(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

const FAKE_LOG_EPOCH_MS = Date.UTC(2026, 9, 21, 12);

/** The time the fake stamps the line at `index` of a container's log with: one second per line. */
export function fakeStampMs(index: number): number {
  return FAKE_LOG_EPOCH_MS + index * 1000;
}

/** The RFC 3339 stamp with nanoseconds that the engine prefixes a line with, for the line at `index`. */
export function fakeStamp(index: number): string {
  return new Date(fakeStampMs(index)).toISOString().replace(".000Z", ".000000000Z");
}

/** A line of a container's log, numbered by its place in the log. */
interface LogLine {
  index: number;
  text: string;
}

/** An open `followLogs`. `wake` resumes it to read what changed, `ended` marks a stopped container, `failure` ends it. */
interface LogFollow {
  readonly container: string;
  ended: boolean;
  failure: RuntimeError | undefined;
  wake: (() => void) | undefined;
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

/** The `ENV NAME=value` lines of a commit, as `NAME=value` entries. A quoted value has its escapes read, as Docker does. */
function envFromChanges(changes: string[]): string[] {
  const entries: string[] = [];
  for (const change of changes) {
    const match = /^ENV\s+([^=\s]+)=(.*)$/.exec(change);
    if (!match) continue;
    const raw = match[2] ?? "";
    const value = /^".*"$/.test(raw) ? raw.slice(1, -1).replace(/\\([\\"$])/g, "$1") : raw;
    entries.push(`${match[1]}=${value}`);
  }
  return entries;
}

/** Entries over a base, one per name. A name in `overrides` takes its value and keeps its place, as Docker's environment does. */
function mergeEnv(base: readonly string[], overrides: readonly string[]): string[] {
  const merged = new Map<string, string>();
  for (const entry of [...base, ...overrides]) {
    const at = entry.indexOf("=");
    merged.set(at < 0 ? entry : entry.slice(0, at), at < 0 ? "" : entry.slice(at + 1));
  }
  return [...merged].map(([name, value]) => `${name}=${value}`);
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Echoes everything written to it, like a TTY, and ends when the write side ends. */
function echoStream(onWrite?: (chunk: Buffer) => void): Duplex {
  const stream: Duplex = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      const copy = Buffer.from(chunk);
      onWrite?.(copy);
      stream.push(copy);
      callback();
    },
    final(callback) {
      stream.push(null);
      callback();
    },
  });
  return stream;
}

function defaultHelper(spec: HelperSpec): HelperResult {
  const cmd = spec.cmd.join(" ");
  if (cmd.includes("du")) return { exitCode: 0, logs: "0\t/mnt\n" };
  if (cmd.includes("df") || cmd.includes("test -f")) {
    return {
      exitCode: 0,
      logs: "Filesystem 1B-blocks Used Available Use% Mounted\nfake 100000000000 1 80000000000 1% /mnt\n",
    };
  }
  return { exitCode: 0, logs: "" };
}

/** Collects stdin and does not echo it. Command exec closes this when it has finished writing. */
function stdinStream(onWrite: (chunk: Buffer) => void): Duplex {
  return new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      onWrite(Buffer.from(chunk));
      callback();
    },
    final(callback) {
      callback();
    },
  });
}

function toInfo(c: FakeContainer): ContainerInfo {
  return {
    id: c.id,
    name: c.name,
    image: c.spec.image,
    imageId: c.imageId,
    labels: { ...c.labels },
    created: c.created,
    state: c.paused ? "paused" : c.running ? "running" : c.startedAt ? "exited" : "created",
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
    ipAddress: c.running ? fakeIpOf(c) : null,
  };
}

/** Stable fake IPv4 from the container id so preview tests can resolve an upstream. */
function fakeIpOf(c: FakeContainer): string {
  const n = Number.parseInt(c.id.replace(/\D/g, "").slice(-2) || "1", 10) || 1;
  return `10.255.0.${(n % 254) + 1}`;
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
  /**
   * Owner of each volume's root directory. A volume takes the template's owner when it is first mounted at
   * `/workspace` by an image that names one, as Docker's copy-up gives it. Otherwise it is owned by root.
   */
  readonly volumeOwners = new Map<string, VolumeOwner>();
  /**
   * In-memory files per named volume, keyed by relative path without a leading slash. The volume root is `""`.
   * getArchive / putArchive and find/cp helpers read and write this map when a mount points at the volume.
   */
  readonly volumeFiles = new Map<string, Map<string, FakeFsEntry>>();
  /**
   * Host/container paths outside any named volume. Used when archive/cp follow a symlink that leaves the volume
   * (mirrors Docker Engine), so regression tests can prove the escape without the service-level jail.
   */
  readonly outsideFiles = new Map<string, FakeFsEntry>();
  /** Archive bytes callers actually pulled from getArchive streams (sent in 16 KiB chunks, so destroy stops it). */
  archiveBytesRead = 0;
  readonly networks = new Map<string, FakeNetwork>();
  readonly execs: FakeExec[] = [];
  /** When true, every call fails as if the engine socket were unreachable. */
  down = false;
  /** The size `info()` reports for the engine, which bounds a box's CPU and memory on it. */
  engine = { cpus: 8, memoryBytes: 16 * 1024 * 1024 * 1024 };
  /** Output returned by the next and later builds. */
  buildLog = "Successfully built fake\n";
  /** References a pull cannot fetch, as a registry without that repository answers. Others are pulled on demand. */
  readonly unpullable = new Set<string>();
  /** Each build context as `buildImage` received it: the files on disk when the call was made, keyed by relative path. */
  readonly builds: {
    tag: string;
    dockerfile: string;
    args: Record<string, string>;
    target: string | undefined;
    files: Map<string, string>;
  }[] = [];
  /** Bytes reported by `diskUsage`. Tests shrink `freeBytes` to exercise the low-space flag. */
  disk: DiskUsage = { totalBytes: 100_000_000_000, freeBytes: 40_000_000_000 };
  /** Answers `runHelper`. The default pretends `df`, `du` and `chown` succeeded. */
  helperHandler: (spec: HelperSpec) => HelperResult = defaultHelper;
  /** The sources the last `setHostIngressBlock` installed. Empty when nothing is blocked. */
  hostIngressBlock: string[] = [];
  /** The owner the last `setHostIngressBlock` named. */
  hostIngressOwner: string | null = null;
  /**
   * Output of the next non-TTY exec. The default is a successful empty command, which is what `true` does.
   * `null` leaves the command running until `kill()`, which is how tests model `sleep`.
   */
  execScript: FakeExecScript | null = { stdout: "", stderr: "", code: 0 };

  private readonly faults = new Map<Op, RuntimeError[]>();
  private readonly execKillFaults: RuntimeError[] = [];
  private readonly execKillHold: { gate: Promise<void> | null } = { gate: null };
  private readonly gates = new Map<Op, { promise: Promise<void>; where?: (args: unknown[]) => boolean }>();
  private readonly archives = new Map<string, Buffer>();
  private readonly subscribers = new Set<(event: RuntimeEvent) => void>();
  private readonly interrupts = new Set<(error: RuntimeError) => void>();
  private readonly logFollows = new Set<LogFollow>();
  private execCount = 0;
  private eventSeq = 0;
  /** The tmux server of each container. A `tmux` exec runs against it, and a box that stops loses it. */
  readonly tmux = new FakeTmux();
  /** When true, `tmux` is not installed: its commands exit 127, as a shell reports a missing program. */
  tmuxMissing = false;
  /** When true, `tmux` is present but cannot run: its commands exit 126, as a shell reports a file it may not execute. */
  tmuxNotExecutable = false;

  /**
   * Holds the next calls to `op` until `release`. With `where`, only the calls whose arguments it accepts are held,
   * so a test can hang the inspect of one container and leave the others answering. `buildImage` reports its log
   * before waiting. A held call does not return when `signal` aborts, as an engine call already in flight does not:
   * once released, it fails with `AbortError` if `signal` has aborted.
   */
  hold(op: Op, where?: (args: unknown[]) => boolean): { release(): void } {
    let resolveGate: GateResolve | undefined;
    const promise = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    this.gates.set(op, { promise, where });
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

  /** The next exec `kill()` fails with `error` and leaves the process running, as when a process survives the kill. */
  failExecKill(error: RuntimeError): void {
    this.execKillFaults.push(error);
  }

  /** Holds every exec `kill()` until the returned `release` is called, so a second kill can overlap the first. */
  holdExecKill(): { release(): void } {
    let resolveGate: GateResolve | undefined;
    this.execKillHold.gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    return {
      release: () => {
        this.execKillHold.gate = null;
        resolveGate?.();
      },
    };
  }

  callsTo(op: Op): Call[] {
    return this.calls.filter((call) => call.op === op);
  }

  ops(): Op[] {
    return this.calls.map((call) => call.op);
  }

  seedImage(
    ref: string,
    labels: Record<string, string> = {},
    createdAt = now(),
    env: string[] = [],
    arch = "x86_64",
  ): string {
    const id = newImageId();
    this.images.set(id, {
      id,
      tags: [normalizeRef(ref)],
      arch,
      labels: { ...labels },
      env: [...env],
      createdAt,
      size: 1024,
    });
    return id;
  }

  /**
   * Points `ref` at a new image, as a rebuilt template does. The image the tag named before keeps its ID and any
   * container that runs it. Seeding does not record a call.
   */
  moveTag(ref: string, labels: Record<string, string> = {}): string {
    const image: FakeImage = {
      id: newImageId(),
      tags: [],
      arch: "x86_64",
      labels: { ...labels },
      env: [],
      createdAt: now(),
      size: 1024,
    };
    this.images.set(image.id, image);
    this.tag(image, normalizeRef(ref));
    return image.id;
  }

  /** A network that is created again gets a new ID, which containers that ran on the old one still point at. */
  seedNetwork(name: string, options: Record<string, string> = {}, driver = "bridge"): void {
    this.networks.set(name, {
      id: newNetworkId(),
      name,
      driver,
      options: { ...options },
      internal: false,
      subnets: [],
    });
  }

  /** Removes networks that no running container uses, as `docker network prune` does. */
  pruneNetworks(): void {
    for (const name of this.networks.keys()) {
      if (!this.isAttached(name)) this.networks.delete(name);
    }
  }

  /** Whether a running container has an endpoint on the network named `name`, as primary or additional. */
  private isAttached(name: string): boolean {
    return [...this.containers.values()].some(
      (c) =>
        c.running && ((c.spec.network ?? DEFAULT_NETWORK) === name || c.extraEndpoints.some((e) => e.name === name)),
    );
  }

  /** Writable-layer changes the next `containerDiff` returns. Seeding does not record a call. */
  seedDiff(id: string, changes: ContainerChange[]): void {
    this.getContainer(id).diff = changes.map((change) => ({ ...change }));
  }

  /** Owner of a volume root, as a volume left behind by an earlier box has it. Seeding does not record a call. */
  seedVolumeOwner(volume: string, owner: VolumeOwner): void {
    this.volumeOwners.set(volume, { ...owner });
  }

  /** Seed a file, directory or symlink on a volume. Paths are volume-relative without a leading slash. */
  seedVolumeFile(volume: string, path: string, entry: FakeFsEntry): void {
    let files = this.volumeFiles.get(volume);
    if (!files) {
      files = new Map();
      this.volumeFiles.set(volume, files);
    }
    if (path !== "") {
      const parts = path.split("/");
      let built = "";
      for (let i = 0; i < parts.length - 1; i++) {
        built = built === "" ? parts[i]! : `${built}/${parts[i]}`;
        if (!files.has(built)) files.set(built, { type: "dir", mode: 0o755, uid: 1000, gid: 1000 });
      }
    }
    files.set(path, { ...entry, content: entry.content ? Buffer.from(entry.content) : entry.content });
  }

  /** Seed an absolute path outside volumes (e.g. `/tmp/secret`) for symlink-escape regression tests. */
  seedOutsideFile(absPath: string, entry: FakeFsEntry): void {
    const path = absPath.startsWith("/") ? absPath : `/${absPath}`;
    if (path !== "/") {
      const parts = path.split("/").filter(Boolean);
      let built = "";
      for (let i = 0; i < parts.length - 1; i++) {
        built += `/${parts[i]}`;
        if (!this.outsideFiles.has(built)) {
          this.outsideFiles.set(built, { type: "dir", mode: 0o755, uid: 0, gid: 0 });
        }
      }
    }
    this.outsideFiles.set(path, {
      ...entry,
      content: entry.content ? Buffer.from(entry.content) : entry.content,
    });
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
    const c = this.insertContainer(rest, imageId, running, { cpus, memoryBytes, swapBytes });
    this.announce("create", c);
    if (running) this.announce("start", c);
    return c.id;
  }

  emitEvent(event: RuntimeEvent): void {
    for (const subscriber of this.subscribers) subscriber(event);
  }

  /** Ends every open `events()` stream with `error`, as a dropped connection to the engine does. */
  interruptEvents(error: RuntimeError): void {
    for (const interrupt of new Set(this.interrupts)) interrupt(error);
  }

  /** The event the engine sends after a container change. Attributes carry the labels, as Docker's do. */
  private announce(action: string, c: FakeContainer): void {
    this.eventSeq += 1;
    this.emitEvent({
      type: "container",
      action,
      id: c.id,
      attributes: { ...c.labels, name: c.name, image: c.spec.image },
      time: now(),
      timeNano: Date.now() * 1_000_000 + this.eventSeq,
    });
  }

  private async gate(op: Op, args: unknown[]): Promise<void> {
    const held = this.gates.get(op);
    if (held && (held.where?.(args) ?? true)) await held.promise;
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

  /**
   * As the engine does, a named volume that a container or helper mounts is created when it is missing. A bind mount
   * (`kind: "bind"`, or a source that is an absolute path) names a host path and never creates a volume.
   */
  private ensureVolumes(mounts: Mount[] | undefined): void {
    for (const mount of mounts ?? []) {
      const named = mount.kind !== "bind" && !mount.source.startsWith("/");
      if (named && !this.volumes.has(mount.source)) this.volumes.set(mount.source, { name: mount.source, labels: {} });
    }
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
      paused: false,
      startedAt: running ? now() : null,
      ...limits,
      pidsLimit: spec.hardening?.pidsLimit ?? null,
      restart: spec.restart ?? "no",
      logs: "",
      diff: [],
      networkId: running ? this.networkIdOf(spec.network) : null,
      extraEndpoints: [],
      files: new Map(),
    };
    this.containers.set(c.id, c);
    for (const mount of spec.mounts ?? []) {
      if (this.volumeOwners.has(mount.source)) continue;
      const owner = mount.target === WORKSPACE ? templateOwnerOf(image?.labels) : null;
      this.volumeOwners.set(mount.source, owner ?? ROOT_OWNER);
    }
    return c;
  }

  /** A tmpfs mount lives as long as its container process, so its files go when the container stops or restarts. */
  private dropTmpfsFiles(c: FakeContainer): void {
    const mounts = Object.keys(c.spec.tmpfs ?? {});
    for (const path of c.files.keys()) {
      if (mounts.some((mount) => path === mount || path.startsWith(`${mount}/`))) c.files.delete(path);
    }
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
      cpus: this.engine.cpus,
      memoryBytes: this.engine.memoryBytes,
    };
  }

  /** The listing is read when the call is made. A held call returns it unless its signal has aborted by then. */
  async listContainers(
    filter: { labels: Record<string, string> },
    opts?: { signal?: AbortSignal },
  ): Promise<ContainerInfo[]> {
    const args = [filter, opts];
    this.enter("listContainers", args);
    const infos = [...this.containers.values()].filter((c) => matchesLabels(c.labels, filter.labels)).map(toInfo);
    await this.gate("listContainers", args);
    if (opts?.signal?.aborted) throw abortError();
    return infos;
  }

  /** The state is read when the call is made. A held call returns it unless its signal has aborted by then. */
  async inspectContainer(id: string, opts?: { signal?: AbortSignal }): Promise<ContainerInfo> {
    const args = [id, opts];
    this.enter("inspectContainer", args);
    const info = toInfo(this.getContainer(id));
    await this.gate("inspectContainer", args);
    if (opts?.signal?.aborted) throw abortError();
    return info;
  }

  async inspectEnv(id: string): Promise<string[]> {
    this.enter("inspectEnv", [id]);
    const env = [...(this.getContainer(id).spec.env ?? [])];
    await this.gate("inspectEnv", [id]);
    return env;
  }

  async createContainer(spec: CreateContainerSpec): Promise<{ id: string }> {
    this.enter("createContainer", [spec]);
    const image = this.getImage(spec.image);
    if (spec.name !== undefined && this.findContainer(spec.name)) {
      throw new RuntimeError("conflict", `Conflict. The container name "/${spec.name}" is already in use`);
    }
    this.ensureVolumes(spec.mounts);
    const limits = {
      cpus: spec.cpus ?? null,
      memoryBytes: spec.memoryBytes ?? null,
      swapBytes: spec.swapBytes ?? null,
    };
    const c = this.insertContainer(spec, image.id, false, limits);
    this.announce("create", c);
    return { id: c.id };
  }

  async startContainer(id: string): Promise<void> {
    this.enter("startContainer", [id]);
    const c = this.getContainer(id);
    if (!c.running) {
      this.ensureVolumes(c.spec.mounts);
      this.attach(c);
      c.running = true;
      c.startedAt = now();
      this.announce("start", c);
    }
  }

  async stopContainer(id: string, opts: { timeoutSec: number }): Promise<void> {
    this.enter("stopContainer", [id, opts]);
    const c = this.getContainer(id);
    this.tmux.stop(c.id);
    if (!c.running) return;
    c.running = false;
    c.paused = false;
    this.dropTmpfsFiles(c);
    this.announce("die", c);
    this.announce("stop", c);
    this.endLogFollows(c.id);
  }

  async restartContainer(id: string, opts: { timeoutSec: number }): Promise<void> {
    this.enter("restartContainer", [id, opts]);
    const c = this.getContainer(id);
    this.ensureVolumes(c.spec.mounts);
    this.attach(c);
    this.tmux.stop(c.id);
    this.dropTmpfsFiles(c);
    c.running = true;
    c.startedAt = now();
    this.announce("restart", c);
    this.endLogFollows(c.id);
  }

  async pauseContainer(id: string): Promise<void> {
    this.enter("pauseContainer", [id]);
    const c = this.getContainer(id);
    if (!c.running) throw new RuntimeError("conflict", `Container ${c.id} is not running`);
    if (c.paused) throw new RuntimeError("conflict", `Container ${c.id} is already paused`);
    c.paused = true;
    this.announce("pause", c);
  }

  async unpauseContainer(id: string): Promise<void> {
    this.enter("unpauseContainer", [id]);
    const c = this.getContainer(id);
    if (!c.paused) return;
    c.paused = false;
    this.announce("unpause", c);
  }

  async removeContainer(id: string, opts: { force: boolean }): Promise<void> {
    this.enter("removeContainer", [id, opts]);
    const c = this.getContainer(id);
    if (c.running && !opts.force) {
      throw new RuntimeError("conflict", `You cannot remove a running container ${c.id}. Stop it or force removal.`);
    }
    this.containers.delete(c.id);
    this.tmux.stop(c.id);
    this.announce("destroy", c);
    this.endLogFollows(c.id);
  }

  async renameContainer(id: string, name: string): Promise<void> {
    this.enter("renameContainer", [id, name]);
    const c = this.getContainer(id);
    const other = this.findContainer(name);
    if (other && other !== c)
      throw new RuntimeError("conflict", `Conflict. The container name "/${name}" is already in use`);
    c.name = name;
    this.announce("rename", c);
  }

  async updateContainer(id: string, limits: ContainerUpdate): Promise<void> {
    this.enter("updateContainer", [id, limits]);
    const c = this.getContainer(id);
    if (limits.cpus !== undefined) c.cpus = limits.cpus;
    if (limits.memoryBytes !== undefined) c.memoryBytes = limits.memoryBytes;
    if (limits.swapBytes !== undefined) c.swapBytes = limits.swapBytes;
    if (limits.pidsLimit !== undefined) c.pidsLimit = limits.pidsLimit;
    if (limits.restart !== undefined) c.restart = limits.restart;
    this.announce("update", c);
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

  /**
   * The tail, then the lines `appendLogs` writes, as the engine streams them. Each line is numbered by its place in the
   * log, and carries the stamp `fakeStampMs` gives that number when `timestamps` is set. `since` filters after `tail`,
   * as the engine does, so a tail of lines before `since` yields nothing.
   */
  async *followLogs(
    id: string,
    opts: { tail: number; timestamps: boolean; since?: Date; signal?: AbortSignal },
  ): AsyncGenerator<string> {
    this.enter("followLogs", [id, opts]);
    const c = this.getContainer(id);
    const { signal } = opts;
    let seen = c.logs.lastIndexOf("\n") + 1;
    const complete = linesOf(c.logs.slice(0, seen));
    let index = complete.length;
    const head = opts.tail > 0 ? complete.slice(-opts.tail) : [];
    const queue: LogLine[] = head.map((text, k) => ({ index: index - head.length + k, text }));
    const follow: LogFollow = { container: c.id, ended: !c.running, failure: undefined, wake: undefined };
    const abort = () => follow.wake?.();
    this.logFollows.add(follow);
    signal?.addEventListener("abort", abort);
    try {
      for (;;) {
        if (signal?.aborted) return;
        if (follow.failure) throw follow.failure;
        const next = queue.shift();
        if (next !== undefined) {
          if (opts.since === undefined || fakeStampMs(next.index) >= opts.since.getTime()) {
            yield opts.timestamps ? `${fakeStamp(next.index)} ${next.text}` : next.text;
          }
          continue;
        }
        const fresh = c.logs.slice(seen);
        const cut = follow.ended ? fresh.length : fresh.lastIndexOf("\n") + 1;
        if (cut > 0) {
          seen += cut;
          for (const text of linesOf(fresh.slice(0, cut))) queue.push({ index: index++, text });
          continue;
        }
        if (follow.ended) return;
        await new Promise<void>((resolve) => {
          follow.wake = resolve;
        });
        follow.wake = undefined;
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      this.logFollows.delete(follow);
    }
  }

  /** Writes `text` to the container's log as it runs. Open follows read the lines it completes. */
  appendLogs(id: string, text: string): void {
    const c = this.getContainer(id);
    c.logs += text;
    for (const follow of this.logFollows) if (follow.container === c.id) follow.wake?.();
  }

  /** Ends every open `followLogs` with `error`, as a dropped engine connection does. */
  interruptLogs(error: RuntimeError): void {
    for (const follow of this.logFollows) {
      follow.failure = error;
      follow.wake?.();
    }
  }

  /** A container that stops or is removed ends its follows, as the engine closes the log stream then. */
  private endLogFollows(containerId: string): void {
    for (const follow of this.logFollows) {
      if (follow.container !== containerId) continue;
      follow.ended = true;
      follow.wake?.();
    }
  }

  async containerStats(id: string, opts?: { signal?: AbortSignal }): Promise<ContainerStats> {
    this.enter("containerStats", [id, opts]);
    await this.gate("containerStats", [id, opts]);
    if (opts?.signal?.aborted) throw abortError();
    const memLimit = this.getContainer(id).memoryBytes ?? 1024 ** 3;
    return { cpuPercent: 1.5, memUsage: Math.round(memLimit / 4), memLimit, memPercent: 25 };
  }

  async commitContainer(id: string, spec: CommitSpec): Promise<void> {
    this.enter("commitContainer", [id, spec]);
    await this.gate("commitContainer", [id, spec]);
    if (spec.signal?.aborted) throw abortError();
    const c = this.getContainer(id);
    const imageEnv = this.images.get(c.imageId)?.env ?? [];
    const image: FakeImage = {
      id: newImageId(),
      tags: [],
      arch: this.images.get(c.imageId)?.arch ?? "x86_64",
      labels: { ...c.labels, ...labelsFromChanges(spec.changes) },
      env: mergeEnv(mergeEnv(imageEnv, c.spec.env ?? []), envFromChanges(spec.changes)),
      createdAt: now(),
      size: 1024,
    };
    this.images.set(image.id, image);
    this.tag(image, `${spec.repo}:${spec.tag}`);
    if (spec.signal?.aborted) throw abortError();
  }

  async putArchive(id: string, path: string, tar: Readable | Buffer): Promise<void> {
    this.enter("putArchive", [id, path, tar]);
    const c = this.getContainer(id);
    const bytes = Buffer.isBuffer(tar) ? tar : await collect(tar);
    this.archives.set(c.id, bytes);
    const resolved = resolveMountPath(c, path);
    if (!resolved) return;
    // Engine follows intermediate *and* final directory symlinks for putArchive destinations.
    const walked = walkVolumePath(this, resolved.volume, resolved.relative, {
      followFinal: true,
      allowMissing: true,
      mountRoot: resolved.root,
    });
    if (!walked) throw new RuntimeError("not_found", `Could not find the requested path ${path}`);
    applyTarToVolume(walked.store, walked.relative, bytes);
  }

  async writeContainerFile(
    id: string,
    path: string,
    data: Buffer,
    opts: { user: string; mode: number },
  ): Promise<void> {
    this.enter("writeContainerFile", [id, path, data, opts]);
    await this.gate("writeContainerFile", [id, path, data, opts]);
    const c = this.getContainer(id);
    if (!c.running) throw new RuntimeError("conflict", `Container ${c.id} is not running`);
    c.files.set(path, { data: Buffer.from(data), mode: opts.mode, user: opts.user });
  }

  /** The file a process wrote into a container at `path`, if any. Reading does not record a call. */
  containerFile(id: string, path: string): FakeContainerFile | undefined {
    return this.getContainer(id).files.get(path);
  }

  async getArchive(id: string, path: string): Promise<Readable> {
    this.enter("getArchive", [id, path]);
    const c = this.getContainer(id);
    const resolved = resolveMountPath(c, path);
    if (resolved) {
      // Follow intermediate directory symlinks; leave a final symlink as metadata (Engine behaviour).
      const walked = walkVolumePath(this, resolved.volume, resolved.relative, {
        followFinal: false,
        mountRoot: resolved.root,
      });
      if (!walked) throw new RuntimeError("not_found", `Could not find the requested path ${path}`);
      const bytes = tarFromVolume(walked.store, walked.relative);
      if (!bytes) throw new RuntimeError("not_found", `Could not find the requested path ${path}`);
      return this.countedStream(bytes);
    }
    const bytes = this.archives.get(c.id);
    if (!bytes) throw new RuntimeError("not_found", `Could not find the requested path ${path}`);
    return Readable.from([bytes]);
  }

  private countedStream(bytes: Buffer): Readable {
    return Readable.from(
      chunked(bytes, (n) => (this.archiveBytesRead += n)),
      { objectMode: false, highWaterMark: 1 },
    );
  }

  /** HEAD archive stat: metadata only, the final component is not followed (Engine behaviour). */
  async statPath(id: string, path: string): Promise<PathStat> {
    this.enter("statPath", [id, path]);
    const c = this.getContainer(id);
    const resolved = resolveMountPath(c, path);
    const walked = resolved
      ? walkVolumePath(this, resolved.volume, resolved.relative, { followFinal: false, mountRoot: resolved.root })
      : null;
    const entry = walked?.store.get(walked.relative);
    if (!walked || !entry) throw new RuntimeError("not_found", `Could not find the requested path ${path}`);
    const name = walked.relative.split("/").pop() ?? "";
    const typeBits = entry.type === "dir" ? 2 ** 31 : entry.type === "symlink" ? 2 ** 27 : 0;
    return {
      name,
      type: entry.type,
      size: entry.type === "file" ? (entry.content?.length ?? 0) : 0,
      mode: typeBits + (entry.mode ?? 0o644),
      linkTarget: entry.type === "symlink" ? (entry.target ?? "") : "",
    };
  }

  filesOf(volume: string): Map<string, FakeFsEntry> {
    let files = this.volumeFiles.get(volume);
    if (!files) {
      files = new Map([["", { type: "dir", mode: 0o755, uid: 1000, gid: 1000 }]]);
      this.volumeFiles.set(volume, files);
    } else if (!files.has("")) {
      files.set("", { type: "dir", mode: 0o755, uid: 1000, gid: 1000 });
    }
    return files;
  }

  /** Only a mounted path has an owner in the fake, which is its volume's root owner. */
  async volumeRootOwner(id: string, path: string): Promise<VolumeOwner> {
    this.enter("volumeRootOwner", [id, path]);
    const mount = (this.getContainer(id).spec.mounts ?? []).find((m) => m.target === path);
    if (!mount) throw new RuntimeError("not_found", `Could not find the requested path ${path}`);
    return { ...(this.volumeOwners.get(mount.source) ?? ROOT_OWNER) };
  }

  /** The helper image must exist, and the volume must exist, as in the engine. The helper itself is not modelled. */
  async setVolumeRootOwner(volume: string, owner: VolumeOwner, image: string): Promise<void> {
    this.enter("setVolumeRootOwner", [volume, owner, image]);
    if (!this.volumes.has(volume)) throw new RuntimeError("not_found", `get ${volume}: no such volume`);
    if (!this.findImage(image)) throw new RuntimeError("engine", `helper image ${image} is missing`);
    this.volumeOwners.set(volume, { ...owner });
  }

  async startExec(containerId: string, spec: ExecSpec): Promise<ExecSession> {
    this.enter("startExec", [containerId, spec]);
    await this.gate("startExec", [containerId, spec]);
    const c = this.getContainer(containerId);
    if (!c.running) throw new RuntimeError("conflict", `Container ${c.id} is not running`);
    const tty = spec.tty !== false;
    if (spec.cmd[0] === "tmux") return this.startTmux(c.id, spec, tty);
    const stdinChunks: Buffer[] = [];
    const stream = tty
      ? echoStream((chunk) => stdinChunks.push(chunk))
      : stdinStream((chunk) => stdinChunks.push(chunk));
    const stdout = tty ? stream : new PassThrough();
    const stderr = new PassThrough();
    const sizes: { cols: number; rows: number }[] = [];
    const killFaults = this.execKillFaults;
    const killHold = this.execKillHold;
    let status: ExecStatus = { running: true, exitCode: null, pid: tty ? null : 4242 };
    const session: FakeExec = {
      id: `exec-${++this.execCount}`,
      stream,
      stdout,
      stderr,
      spec,
      containerId: c.id,
      sizes,
      killed: false,
      kills: 0,
      async resize(size) {
        sizes.push(size);
      },
      async inspect() {
        return status;
      },
      async kill() {
        session.kills += 1;
        if (killHold.gate) await killHold.gate;
        const fault = killFaults.shift();
        if (fault) throw fault;
        if (session.killed || !status.running) {
          session.killed = true;
          return;
        }
        session.killed = true;
        session.exit(137);
      },
      print(text) {
        if (tty) stream.push(text);
        else stdout.write(text);
      },
      printStderr(text) {
        stderr.write(text);
      },
      stdin() {
        return Buffer.concat(stdinChunks).toString("utf8");
      },
      exit(code = 0) {
        if (!status.running) return;
        status = { running: false, exitCode: code, pid: null };
        if (tty) stream.push(null);
        else if (!stdout.writableEnded) stdout.end();
        if (!stderr.writableEnded) stderr.end();
      },
    };
    this.execs.push(session);
    if (tty) {
      session.print("$ ");
      return session;
    }
    const script = this.execScript;
    if (script) {
      setTimeout(() => {
        if (!status.running) return;
        if (script.stdout) stdout.write(script.stdout);
        if (script.stderr) stderr.write(script.stderr);
        session.exit(script.code);
      }, 0);
    }
    return session;
  }

  /**
   * A `tmux` exec. A command exec (`tty: false`) runs once against the emulated server and exits with its status. A TTY
   * exec attaches a client to the session it names: the session's output goes to the stream, and what is written to the
   * stream is typed into the session. Ending the exec detaches the client, as a killed attach does in the box.
   */
  private startTmux(containerId: string, spec: ExecSpec, tty: boolean): FakeExec {
    const argv = spec.cmd.slice(1);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const exitHooks: (() => void)[] = [];
    const typed: Buffer[] = [];
    const killFaults = this.execKillFaults;
    const killHold = this.execKillHold;
    let status: ExecStatus = { running: true, exitCode: null, pid: null };
    const finish = (code: number) => {
      if (!status.running) return;
      status = { running: false, exitCode: code, pid: null };
      for (const hook of exitHooks) hook();
      if (!stdout.writableEnded) stdout.end();
      if (!stderr.writableEnded) stderr.end();
      if (tty) stream.push(null);
    };
    let stream: Duplex = new PassThrough();
    if (tty) {
      const name = (argv[argv.indexOf("-t") + 1] ?? "").replace(/^=/, "").replace(/:.*$/, "");
      stream = new Duplex({
        read() {},
        write: (chunk: Buffer, _encoding, callback) => {
          typed.push(Buffer.from(chunk));
          this.tmux.type(containerId, name, Buffer.from(chunk).toString("utf8"));
          callback();
        },
      });
      const client: TmuxClient = {
        output: (text) => stream.push(Buffer.from(text)),
        end: () => finish(0),
      };
      if (this.tmux.attach(containerId, name, client)) {
        exitHooks.push(() => this.tmux.detach(containerId, name, client));
      } else {
        stream.push(Buffer.from(`can't find session: ${name}\r\n`));
        finish(1);
      }
    } else {
      const run = this.tmuxRun(containerId, argv);
      setTimeout(() => {
        if (run.stdout) stdout.write(run.stdout);
        if (run.stderr) stderr.write(run.stderr);
        finish(run.code);
      }, 0);
    }
    const session: FakeExec = {
      id: `exec-${++this.execCount}`,
      stream,
      stdout,
      stderr,
      spec,
      containerId,
      sizes: [],
      killed: false,
      kills: 0,
      async resize(size) {
        session.sizes.push(size);
      },
      async inspect() {
        return status;
      },
      async kill() {
        session.kills += 1;
        if (killHold.gate) await killHold.gate;
        const fault = killFaults.shift();
        if (fault) throw fault;
        if (status.running) {
          session.killed = true;
          finish(137);
        }
      },
      print(text) {
        stream.push(Buffer.from(text));
      },
      printStderr(text) {
        stderr.write(text);
      },
      stdin() {
        return Buffer.concat(typed).toString("utf8");
      },
      exit(code = 0) {
        finish(code);
      },
    };
    this.execs.push(session);
    return session;
  }

  /** What a command-mode `tmux` exec reports: the shell's status when the binary is missing or cannot run. */
  private tmuxRun(containerId: string, argv: string[]): TmuxRun {
    if (this.tmuxMissing) return { code: 127, stdout: "", stderr: "sh: tmux: not found\n" };
    if (this.tmuxNotExecutable) return { code: 126, stdout: "", stderr: "sh: tmux: Permission denied\n" };
    return this.tmux.run(containerId, argv);
  }

  async *events(
    filter: { labels?: Record<string, string>; types?: string[] },
    signal?: AbortSignal,
  ): AsyncGenerator<RuntimeEvent> {
    this.enter("events", [filter]);
    const queue: RuntimeEvent[] = [];
    let wake: (() => void) | undefined;
    let failure: RuntimeError | undefined;
    const notify = () => wake?.();
    const subscriber = (event: RuntimeEvent) => {
      if (!matchesEvent(event, filter)) return;
      queue.push(event);
      notify();
    };
    const interrupt = (error: RuntimeError) => {
      failure = error;
      notify();
    };
    this.subscribers.add(subscriber);
    this.interrupts.add(interrupt);
    signal?.addEventListener("abort", notify);
    try {
      for (;;) {
        if (failure) throw failure;
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
      this.interrupts.delete(interrupt);
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
    return { id: img.id, tags: [...img.tags], arch: img.arch, labels: { ...img.labels }, env: [...img.env] };
  }

  /**
   * A missing reference is pulled unless it is in `unpullable`, which is how a test models a repository that does not
   * exist: the pull fails with `not_found`, as Docker reports it. `onLog` receives a line per layer, then the image is present.
   */
  async pullImage(ref: string, opts?: { onLog?(text: string): void }): Promise<void> {
    this.enter("pullImage", [ref]);
    if (this.findImage(ref)) return;
    if (this.unpullable.has(normalizeRef(ref))) {
      throw new RuntimeError("not_found", `${ref}: manifest unknown`);
    }
    opts?.onLog?.(`${ref}: Pulling fs layer\n`);
    opts?.onLog?.(`${ref}: Pull complete\n`);
    this.seedImage(ref);
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

  /** The image as its JSON record, which stands in for the tar `docker save` writes. */
  async saveImage(ref: string): Promise<Readable> {
    this.enter("saveImage", [ref]);
    const img = this.getImage(ref);
    const archive: FakeImageArchive = {
      id: img.id,
      tags: [...img.tags],
      labels: { ...img.labels },
      env: [...img.env],
      createdAt: img.createdAt,
      size: img.size,
    };
    await this.gate("saveImage", [ref]);
    return Readable.from([Buffer.from(JSON.stringify(archive))]);
  }

  async loadImage(archive: Readable): Promise<void> {
    this.enter("loadImage", [archive]);
    const loaded = JSON.parse((await collect(archive)).toString("utf8")) as FakeImageArchive;
    await this.gate("loadImage", [archive]);
    const image = this.images.get(loaded.id) ?? {
      id: loaded.id,
      tags: [],
      arch: "x86_64",
      labels: { ...loaded.labels },
      env: [...loaded.env],
      createdAt: loaded.createdAt,
      size: loaded.size,
    };
    this.images.set(image.id, image);
    for (const ref of loaded.tags) this.tag(image, ref);
  }

  async buildImage(spec: BuildSpec): Promise<string> {
    this.enter("buildImage", [spec]);
    const files = contextFiles(spec);
    if (!files.has(spec.dockerfile)) {
      throw new RuntimeError("engine", `failed to read dockerfile: open ${spec.dockerfile}: no such file or directory`);
    }
    this.builds.push({
      tag: spec.tag,
      dockerfile: spec.dockerfile,
      args: { ...spec.args },
      target: spec.target,
      files,
    });
    spec.onLog?.(this.buildLog);
    await this.gate("buildImage", [spec]);
    if (spec.signal?.aborted) throw abortError();
    const image: FakeImage = {
      id: newImageId(),
      tags: [],
      arch: "x86_64",
      labels: { ...spec.labels },
      env: [],
      createdAt: now(),
      size: 1024,
    };
    this.images.set(image.id, image);
    this.tag(image, normalizeRef(spec.tag));
    return this.buildLog;
  }

  async inspectVolume(name: string): Promise<VolumeInfo> {
    this.enter("inspectVolume", [name]);
    const volume = this.volumes.get(name);
    if (!volume) throw new RuntimeError("not_found", `get ${name}: no such volume`);
    return {
      name: volume.name,
      labels: { ...volume.labels },
      driver: volume.driver,
      options: volume.options ? { ...volume.options } : undefined,
    };
  }

  async listVolumes(): Promise<VolumeInfo[]> {
    this.enter("listVolumes", []);
    return [...this.volumes.values()].map((volume) => ({
      name: volume.name,
      labels: { ...volume.labels },
      driver: volume.driver,
      options: volume.options ? { ...volume.options } : undefined,
    }));
  }

  /** Like Docker, creating an existing volume succeeds and keeps the original labels and driver options. */
  async createVolume(name: string, labels: Record<string, string>, opts?: VolumeCreateOptions): Promise<void> {
    this.enter("createVolume", [name, labels, opts]);
    if (this.volumes.has(name)) return;
    this.volumes.set(name, {
      name,
      labels: { ...labels },
      driver: opts?.driver,
      options: opts?.driverOpts ? { ...opts.driverOpts } : undefined,
    });
  }

  async removeVolume(name: string): Promise<void> {
    this.enter("removeVolume", [name]);
    if (!this.volumes.has(name)) throw new RuntimeError("not_found", `No such volume: ${name}`);
    const inUse = [...this.containers.values()].some((c) => c.spec.mounts?.some((m) => m.source === name));
    if (inUse) throw new RuntimeError("conflict", `remove ${name}: volume is in use`);
    this.volumes.delete(name);
    this.volumeOwners.delete(name);
    this.volumeFiles.delete(name);
  }

  async runHelper(spec: HelperSpec): Promise<HelperResult> {
    this.enter("runHelper", [spec]);
    await this.gate("runHelper", [spec]);
    this.getImage(spec.image);
    this.ensureVolumes(spec.mounts);
    if (this.helperHandler !== defaultHelper) return this.helperHandler(spec);
    return volumeAwareHelper(this, spec);
  }

  async diskUsage(path: string): Promise<DiskUsage> {
    this.enter("diskUsage", [path]);
    return { totalBytes: this.disk.totalBytes, freeBytes: this.disk.freeBytes };
  }

  /** Docker refuses a network whose subnet overlaps one another network already holds. */
  private overlapsAnotherPool(subnet: string): boolean {
    const wanted = parseIpv4Cidr(subnet);
    if (wanted === null) return false;
    return [...this.networks.values()].some((network) =>
      network.subnets.some((cidr) => {
        const held = parseIpv4Cidr(cidr);
        return held !== null && ipv4Overlaps(held, wanted);
      }),
    );
  }

  async ensureBridgeNetwork(
    name: string,
    opts: { interContainerComm: boolean; internal?: boolean; subnet?: string },
  ): Promise<void> {
    this.enter("ensureBridgeNetwork", [name, opts]);
    const internal = opts.internal ?? false;
    const existing = this.networks.get(name);
    if (!existing) {
      if (opts.subnet !== undefined && this.overlapsAnotherPool(opts.subnet)) {
        throw new RuntimeError("conflict", "Pool overlaps with other one on this address space");
      }
      this.seedNetwork(name, opts.interContainerComm ? {} : { [ICC_OPTION]: "false" });
      const created = this.networks.get(name);
      if (created) {
        created.internal = internal;
        created.subnets = opts.subnet === undefined ? [] : [opts.subnet];
      }
      return;
    }
    const enabled = existing.options[ICC_OPTION] !== "false";
    const subnetMatches = opts.subnet === undefined || existing.subnets.includes(opts.subnet);
    if (
      existing.driver !== "bridge" ||
      enabled !== opts.interContainerComm ||
      existing.internal !== internal ||
      !subnetMatches
    ) {
      throw new RuntimeError("conflict", `network ${name} exists but is not a bridge with the requested settings`);
    }
  }

  async removeNetwork(name: string): Promise<void> {
    this.enter("removeNetwork", [name]);
    if (!this.networks.has(name)) return;
    if (this.isAttached(name)) {
      throw new RuntimeError("conflict", `network ${name} still has containers attached`);
    }
    this.networks.delete(name);
  }

  async connectNetwork(id: string, name: string, opts?: { alias?: string }): Promise<void> {
    this.enter("connectNetwork", [id, name, opts]);
    const c = this.getContainer(id);
    const network = this.networks.get(name);
    if (!network) throw new RuntimeError("not_found", `network ${name} not found`);
    const aliases = opts?.alias === undefined ? [] : [opts.alias];
    if ((c.spec.network ?? DEFAULT_NETWORK) === name) {
      if (c.networkId !== null) c.networkId = network.id;
      return;
    }
    const current = c.extraEndpoints.find((endpoint) => endpoint.name === name);
    if (current?.networkId === network.id) return;
    c.extraEndpoints = [
      ...c.extraEndpoints.filter((endpoint) => endpoint.name !== name),
      { name, networkId: network.id, aliases },
    ];
  }

  async listNetworks(): Promise<NetworkSummary[]> {
    this.enter("listNetworks", []);
    return [...this.networks.values()].map((network) => ({ name: network.name, subnets: [...network.subnets] }));
  }

  async setHostIngressBlock(owner: string, sources: string[]): Promise<void> {
    this.enter("setHostIngressBlock", [owner, sources]);
    this.hostIngressOwner = owner;
    this.hostIngressBlock = [...sources];
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

/**
 * Resolve a volume-relative path the way the kernel does under Docker archive/cp: the volume is mounted at
 * `mountRoot` in a single absolute namespace, every intermediate symlink is followed (and the final one when
 * `followFinal` is set, as putArchive does), chains are re-looked-up hop by hop, `..` is walked against the physical
 * path, and absolute targets restart at `/`. Anything that lands outside the mount resolves onto `outsideFiles`,
 * keyed by absolute path. Returns null for a missing intermediate (unless `allowMissing`) or a symlink loop.
 */
function walkVolumePath(
  rt: FakeRuntime,
  volume: string,
  relative: string,
  opts: { followFinal: boolean; allowMissing?: boolean; mountRoot?: string },
): { store: Map<string, FakeFsEntry>; relative: string } | null {
  const rootParts = (opts.mountRoot ?? "/minibox-volume").split("/").filter(Boolean);
  const locate = (abs: string[]): { store: Map<string, FakeFsEntry>; key: string } => {
    const inVolume = abs.length >= rootParts.length && rootParts.every((part, i) => abs[i] === part);
    if (inVolume) return { store: rt.filesOf(volume), key: abs.slice(rootParts.length).join("/") };
    return { store: rt.outsideFiles, key: `/${abs.join("/")}` };
  };
  const entryAt = (abs: string[]): FakeFsEntry | undefined => {
    const { store, key } = locate(abs);
    if (store === rt.outsideFiles && key === "/") return { type: "dir", mode: 0o755, uid: 0, gid: 0 };
    return store.get(key);
  };

  const queue = relative.split("/").filter((part) => part !== "" && part !== ".");
  let current = [...rootParts];
  let missing = false;
  let hops = 0;
  while (queue.length > 0) {
    const part = queue.shift() as string;
    if (part === ".") continue;
    if (part === "..") {
      if (missing) return null;
      current.pop();
      continue;
    }
    if (missing) {
      current.push(part);
      continue;
    }
    const isFinal = queue.length === 0;
    const next = [...current, part];
    const entry = entryAt(next);
    if (!entry) {
      if (!isFinal && !opts.allowMissing) return null;
      missing = true;
      current = next;
      continue;
    }
    if (entry.type === "symlink" && (!isFinal || opts.followFinal)) {
      hops += 1;
      if (hops > 40) return null;
      const target = entry.target ?? "";
      if (target.startsWith("/")) current = [];
      queue.unshift(...target.split("/").filter((seg) => seg !== "" && seg !== "."));
      continue;
    }
    current = next;
  }
  const { store, key } = locate(current);
  return { store, relative: key };
}

function* chunked(bytes: Buffer, onChunk: (n: number) => void): Generator<Buffer> {
  for (let at = 0; at < bytes.length; at += 16 * 1024) {
    const chunk = bytes.subarray(at, at + 16 * 1024);
    onChunk(chunk.length);
    yield chunk;
  }
}

function resolveMountPath(
  c: FakeContainer,
  requested: string,
): { volume: string; relative: string; root: string } | null {
  const absPath = requested.replace(/\/\.$/, "") || "/";
  const mounts = [...(c.spec.mounts ?? [])].toSorted((a, b) => b.target.length - a.target.length);
  for (const mount of mounts) {
    const root = mount.target.replace(/\/+$/, "") || "/";
    if (absPath === root || absPath.startsWith(`${root}/`)) {
      const relative = absPath === root ? "" : absPath.slice(root.length + 1);
      return { volume: mount.source, relative, root };
    }
  }
  return null;
}

const BLOCK = 512;
function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}
function seal(block: Buffer): Buffer {
  block.fill(0x20, 148, 156);
  block.write(
    `${octal(
      block.reduce((sum, byte) => sum + byte, 0),
      7,
    )} `,
    148,
    "ascii",
  );
  return block;
}
function tarHeader(name: string, type: string, size: number, uid: number, gid: number, link = ""): Buffer {
  if (Buffer.byteLength(name) > 100) {
    const longName = Buffer.from(`${name}\0`);
    return Buffer.concat([
      tarHeader("././@LongLink", "L", longName.length, 0, 0),
      tarPad(longName),
      tarHeader(Buffer.from(name).subarray(0, 100).toString("utf8"), type, size, uid, gid, link),
    ]);
  }
  const block = Buffer.alloc(BLOCK);
  block.write(name.slice(0, 100), 0, 100, "utf8");
  block.write(octal(type === "5" ? 0o755 : 0o644, 8), 100, "ascii");
  block.write(octal(uid, 8), 108, "ascii");
  block.write(octal(gid, 8), 116, "ascii");
  block.write(octal(size, 12), 124, "ascii");
  block.write(octal(0, 12), 136, "ascii");
  block.write(type, 156, "ascii");
  if (link) block.write(link.slice(0, 100), 157, "utf8");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  return seal(block);
}
function tarPad(data: Buffer): Buffer {
  const padding = (BLOCK - (data.length % BLOCK)) % BLOCK;
  return padding === 0 ? data : Buffer.concat([data, Buffer.alloc(padding)]);
}

function tarFromVolume(files: Map<string, FakeFsEntry>, relative: string): Buffer | null {
  const entry = files.get(relative);
  if (!entry) return null;
  const base =
    relative === "" ? "." : relative.includes("/") ? relative.slice(relative.lastIndexOf("/") + 1) : relative;
  if (entry.type === "file") {
    const data = entry.content ?? Buffer.alloc(0);
    return Buffer.concat([
      tarHeader(base, "0", data.length, entry.uid ?? 1000, entry.gid ?? 1000),
      tarPad(data),
      Buffer.alloc(BLOCK * 2),
    ]);
  }
  if (entry.type === "symlink") {
    return Buffer.concat([
      tarHeader(base, "2", 0, entry.uid ?? 1000, entry.gid ?? 1000, entry.target ?? ""),
      Buffer.alloc(BLOCK * 2),
    ]);
  }
  // Directory: include the directory and its immediate... actually for getArchive of a dir Docker includes the tree.
  const chunks: Buffer[] = [];
  const prefix = relative === "" ? "" : relative;
  const names = [...files.keys()]
    .filter((name) => name === prefix || (prefix === "" ? name !== "" : name.startsWith(`${prefix}/`)))
    .toSorted();
  for (const name of names) {
    const node = files.get(name)!;
    const entryName = name === prefix ? base : prefix === "" ? name : name.slice(prefix.length + 1);
    const shown = entryName === "" ? base : entryName;
    if (node.type === "dir") {
      chunks.push(tarHeader(shown.endsWith("/") ? shown : `${shown}/`, "5", 0, node.uid ?? 1000, node.gid ?? 1000));
    } else if (node.type === "symlink") {
      chunks.push(tarHeader(shown, "2", 0, node.uid ?? 1000, node.gid ?? 1000, node.target ?? ""));
    } else {
      const data = node.content ?? Buffer.alloc(0);
      chunks.push(tarHeader(shown, "0", data.length, node.uid ?? 1000, node.gid ?? 1000), tarPad(data));
    }
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(chunks);
}

function applyTarToVolume(files: Map<string, FakeFsEntry>, destRelative: string, tar: Buffer): void {
  let offset = 0;
  let pendingName: string | null = null;
  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every((b) => b === 0)) break;
    const typeFlag = String.fromCharCode(block[156] ?? 0);
    const sizeText = (block.subarray(124, 136).toString("ascii").split("\0")[0] ?? "").trim();
    const size = /^[0-7]+$/.test(sizeText) ? Number.parseInt(sizeText, 8) : 0;
    const uidText = (block.subarray(108, 116).toString("ascii").split("\0")[0] ?? "").trim();
    const gidText = (block.subarray(116, 124).toString("ascii").split("\0")[0] ?? "").trim();
    const uid = /^[0-7]+$/.test(uidText) ? Number.parseInt(uidText, 8) : 1000;
    const gid = /^[0-7]+$/.test(gidText) ? Number.parseInt(gidText, 8) : 1000;
    const nameField = block.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const linkField = block.subarray(157, 257).toString("utf8").replace(/\0.*$/, "");
    const bodyStart = offset + BLOCK;
    const data = Buffer.from(tar.subarray(bodyStart, bodyStart + size));
    offset = bodyStart + Math.ceil(size / BLOCK) * BLOCK;
    if (typeFlag === "L") {
      pendingName = data.toString("utf8").replace(/\0.*$/, "");
      continue;
    }
    if (typeFlag === "x" || typeFlag === "g" || typeFlag === "K") continue;
    const rawName = (pendingName ?? nameField).replace(/^\.\//, "").replace(/\/$/, "");
    pendingName = null;
    const full = destRelative === "" ? rawName : rawName === "." ? destRelative : `${destRelative}/${rawName}`;
    // Ensure parents
    if (full.includes("/")) {
      const parts = full.split("/");
      let built = "";
      for (let i = 0; i < parts.length - 1; i++) {
        built = built === "" ? parts[i]! : `${built}/${parts[i]}`;
        if (!files.has(built)) files.set(built, { type: "dir", mode: 0o755, uid, gid });
      }
    }
    const mtimeText = (block.subarray(136, 148).toString("ascii").split("\0")[0] ?? "").trim();
    const mtime = /^[0-7]+$/.test(mtimeText) ? Number.parseInt(mtimeText, 8) : undefined;
    if (typeFlag === "5" || nameField.endsWith("/")) {
      files.set(full, { type: "dir", mode: 0o755, uid, gid, mtime });
    } else if (typeFlag === "2") {
      files.set(full, { type: "symlink", target: linkField, uid, gid, mtime });
    } else {
      files.set(full, { type: "file", content: data, mode: 0o644, uid, gid, mtime });
    }
  }
  if (!files.has("")) files.set("", { type: "dir", mode: 0o755, uid: 1000, gid: 1000 });
}

/**
 * `mv -T [-f|-n] -- SRC DST` and `rm (-f|-rf) -- PATH` on a mounted volume, as coreutils 9.1 runs them: `mv -n` over an
 * existing destination leaves the source in place and exits 0, which the service has to notice.
 */
function mutateVolume(files: Map<string, FakeFsEntry>, root: string, cmd: string[]): HelperResult {
  const operands = cmd.slice(cmd.indexOf("--") + 1);
  const relative = (abs: string | undefined): string | null => {
    if (abs === undefined) return null;
    if (abs === root) return "";
    return abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : null;
  };
  const subtree = (key: string): string[] => [...files.keys()].filter((k) => k === key || k.startsWith(`${key}/`));

  if (cmd[0] === "rm") {
    const target = relative(operands[0]);
    if (target === null || target === "") return { exitCode: 1, logs: "rm: refusing to remove the volume root\n" };
    const entry = files.get(target);
    if (!entry) return { exitCode: 0, logs: "" };
    if (entry.type === "dir" && !cmd.includes("-rf") && !cmd.includes("-r")) {
      return { exitCode: 1, logs: `rm: cannot remove '${operands[0]}': Is a directory\n` };
    }
    for (const key of subtree(target)) files.delete(key);
    return { exitCode: 0, logs: "" };
  }

  const from = relative(operands[0]);
  const to = relative(operands[1]);
  if (from === null || to === null || from === "" || to === "") {
    return { exitCode: 1, logs: "mv: cannot move the volume root\n" };
  }
  if (!files.has(from)) return { exitCode: 1, logs: `mv: cannot stat '${operands[0]}': No such file or directory\n` };
  const parent = to.includes("/") ? to.slice(0, to.lastIndexOf("/")) : "";
  if (!files.has(parent))
    return { exitCode: 1, logs: `mv: cannot move to '${operands[1]}': No such file or directory\n` };
  if (to === from || to.startsWith(`${from}/`))
    return { exitCode: 1, logs: "mv: cannot move a directory into itself\n" };
  if (files.has(to)) {
    if (cmd.includes("-n")) return { exitCode: 0, logs: "" };
    const target = files.get(to);
    if (target?.type === "dir" && files.get(from)?.type !== "dir") {
      return { exitCode: 1, logs: `mv: cannot overwrite directory '${operands[1]}' with non-directory\n` };
    }
    if (target?.type === "dir" && subtree(to).length > 1) {
      return { exitCode: 1, logs: `mv: cannot move '${operands[0]}' to '${operands[1]}': Directory not empty\n` };
    }
    for (const key of subtree(to)) files.delete(key);
  }
  const moved = subtree(from).map((key) => [key, files.get(key)] as const);
  for (const [key] of moved) files.delete(key);
  for (const [key, entry] of moved) {
    if (entry) files.set(key === from ? to : `${to}/${key.slice(from.length + 1)}`, entry);
  }
  return { exitCode: 0, logs: "" };
}

export function volumeAwareHelper(rt: FakeRuntime, spec: HelperSpec): HelperResult {
  const mount = spec.mounts?.[0];
  const volume = mount?.source;
  const root = (mount?.target ?? "/minibox-volume").replace(/\/+$/, "");
  const files = volume ? rt.filesOf(volume) : new Map<string, FakeFsEntry>();
  const cmd0 = spec.cmd[0] ?? "";

  if (cmd0 === "du") {
    const bytes = [...files.values()].reduce((sum, entry) => sum + (entry.content?.length ?? 0), 0);
    return { exitCode: 0, logs: `${bytes}\t${root}\n` };
  }

  if (cmd0 === "find") {
    // find -P <search> -maxdepth N ( -type f -o ... ) -printf ...
    const searchIdx = spec.cmd.indexOf("-P") >= 0 ? spec.cmd.indexOf("-P") + 1 : 1;
    const search = spec.cmd[searchIdx] ?? root;
    const depthIdx = spec.cmd.indexOf("-maxdepth");
    const maxDepth = depthIdx >= 0 ? Number(spec.cmd[depthIdx + 1] ?? "2") : 2;
    if (!search.startsWith(root)) return { exitCode: 1, logs: "find: path escapes mount\n" };
    const relRoot = search === root ? "" : search.slice(root.length + 1);
    if (relRoot !== "" && !files.has(relRoot)) return { exitCode: 1, logs: "No such file or directory\n" };
    const lines: string[] = [];
    for (const [name, entry] of [...files.entries()].toSorted((a, b) => a[0].localeCompare(b[0]))) {
      if (relRoot !== "" && name !== relRoot && !name.startsWith(`${relRoot}/`)) continue;
      const depth =
        name === relRoot
          ? 0
          : name === ""
            ? 0
            : (relRoot === "" ? name : name.slice(relRoot.length + 1)).split("/").length;
      if (name !== relRoot && depth > maxDepth) continue;
      if (name === "" && relRoot !== "") continue;
      const kind = entry.type === "file" ? "f" : entry.type === "dir" ? "d" : entry.type === "symlink" ? "l" : "o";
      const size = entry.type === "file" ? String(entry.content?.length ?? 0) : "0";
      const mtime = `${entry.mtime ?? FAKE_MTIME}.0000000000`;
      const full = name === "" ? root : `${root}/${name}`;
      lines.push(`${kind}\t${size}\t${mtime}\t${full}\0`);
    }
    return { exitCode: 0, logs: lines.join("") };
  }

  if (cmd0 === "du") {
    let bytes = 0;
    for (const entry of files.values()) if (entry.type === "file") bytes += entry.content?.byteLength ?? 0;
    return { exitCode: 0, logs: `${bytes}\t/mnt\n` };
  }

  if (cmd0 === "mv" || cmd0 === "rm") return mutateVolume(files, root, spec.cmd);

  if (cmd0 === "sh" && spec.cmd.includes("minibox-cp")) {
    // sh -c '...' minibox-cp fromAbs toAbs — follow intermediate symlinks like the Engine.
    const fromAbs = spec.cmd[spec.cmd.length - 2] ?? "";
    const toAbs = spec.cmd[spec.cmd.length - 1] ?? "";
    if (!fromAbs.startsWith(root) || !toAbs.startsWith(root)) return { exitCode: 1, logs: "cp: path escapes\n" };
    const fromRel = fromAbs === root ? "" : fromAbs.slice(root.length + 1);
    const toRel = toAbs === root ? "" : toAbs.slice(root.length + 1);
    if (!volume) return { exitCode: 1, logs: "cp: no volume\n" };
    const walkedFrom = walkVolumePath(rt, volume, fromRel, { followFinal: false, mountRoot: root });
    if (!walkedFrom) return { exitCode: 1, logs: "No such file or directory\n" };
    const src = walkedFrom.store.get(walkedFrom.relative);
    if (!src) return { exitCode: 1, logs: "No such file or directory\n" };
    const walkedTo = walkVolumePath(rt, volume, toRel, { followFinal: true, allowMissing: true, mountRoot: root });
    if (!walkedTo) return { exitCode: 1, logs: "cp: destination escapes\n" };
    const destStore = walkedTo.store;
    const to = walkedTo.relative;
    // Copy the source node (and children when it is a directory still on the volume map).
    const fromStore = walkedFrom.store;
    const from = walkedFrom.relative;
    const toCopy =
      src.type === "dir" && fromStore === rt.filesOf(volume)
        ? [...fromStore.entries()].filter(([name]) => name === from || name.startsWith(from === "" ? "" : `${from}/`))
        : ([[from, src]] as [string, FakeFsEntry][]);
    for (const [name, entry] of toCopy) {
      const suffix = name === from ? "" : name.slice(from.length + (from === "" ? 0 : 1));
      const dest = suffix === "" ? to : to === "" ? suffix : `${to}/${suffix}`;
      const absStyle = dest.startsWith("/");
      if (dest.includes("/")) {
        const parentParts = absStyle ? dest.split("/").filter(Boolean).slice(0, -1) : dest.split("/").slice(0, -1);
        let built = "";
        for (const part of parentParts) {
          built = absStyle ? `${built}/${part}` : built === "" ? part : `${built}/${part}`;
          if (!destStore.has(built)) destStore.set(built, { type: "dir", mode: 0o755, uid: 1000, gid: 1000 });
        }
      }
      destStore.set(dest, {
        type: entry.type,
        content: entry.content ? Buffer.from(entry.content) : undefined,
        target: entry.target,
        mode: entry.mode,
        uid: entry.uid,
        gid: entry.gid,
      });
    }
    return { exitCode: 0, logs: "" };
  }

  return defaultHelper(spec);
}
