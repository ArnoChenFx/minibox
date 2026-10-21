import type { Duplex, Readable } from "node:stream";

export interface ContainerMount {
  /** Volume name, or the host path for a bind mount. */
  source: string;
  target: string;
  mode: "rw" | "ro";
}

export interface ContainerInfo {
  id: string;
  name: string;
  /** Image reference the container was created from (`Config.Image`). */
  image: string;
  /** Image id the container is currently based on, usually `sha256:…`. */
  imageId: string;
  labels: Record<string, string>;
  created: string;
  state: string;
  running: boolean;
  startedAt: string | null;
  cpus: number | null;
  memoryBytes: number | null;
  /** Null when the engine has no process limit. */
  pidsLimit: number | null;
  /** Engine restart policy name, such as `no` or `unless-stopped`. */
  restart: string;
  mounts: ContainerMount[];
  /** Name of the network the container is attached to. The engine's default bridge is `bridge`. */
  network: string;
}

export interface ContainerStats {
  cpuPercent: number;
  memUsage: number;
  memLimit: number;
  memPercent: number;
}

export interface Mount {
  source: string;
  target: string;
  /** Absent means writable, which is the engine default. */
  mode?: "rw" | "ro";
}

/** One writable-layer change from `docker diff`. `modified` is the engine's kind 0, `added` is 1, `deleted` is 2. */
export interface ContainerChange {
  path: string;
  kind: "added" | "modified" | "deleted";
}

export interface Ulimit {
  name: string;
  soft: number;
  hard: number;
}

/** Kernel-level restrictions on a container. An absent field keeps the engine's default. */
export interface ContainerHardening {
  /** Capabilities removed from the default set. `["ALL"]` removes every capability. */
  capDrop?: string[];
  /** Capabilities added back after `capDrop` is applied. */
  capAdd?: string[];
  /** Setuid binaries, including `sudo`, cannot gain privileges when this is set. */
  noNewPrivileges?: boolean;
  pidsLimit?: number;
  ulimits?: Ulimit[];
  /** OCI runtime name, such as `runsc` for gVisor. */
  runtime?: string;
}

/** A live change to an existing container. Absent fields stay as they are. */
export interface ContainerUpdate {
  cpus?: number;
  memoryBytes?: number;
  swapBytes?: number;
  pidsLimit?: number;
  restart?: "no" | "unless-stopped" | "always" | "on-failure";
}

export interface CreateContainerSpec {
  image: string;
  name?: string;
  cmd?: string[];
  workingDir?: string;
  hostname?: string;
  labels?: Record<string, string>;
  mounts?: Mount[];
  /** `NAME=value` entries merged over the image environment. Secrets are not passed here. */
  env?: string[];
  restart?: "no" | "unless-stopped";
  cpus?: number;
  memoryBytes?: number;
  swapBytes?: number;
  init?: boolean;
  /** Network name. Absent means the engine's default bridge. */
  network?: string;
  hardening?: ContainerHardening;
}

export interface ImageSummary {
  id: string;
  repoTags: string[];
  labels: Record<string, string>;
  createdAt: string;
  size: number;
}

export interface ImageDetails {
  id: string;
  labels: Record<string, string>;
}

export interface VolumeInfo {
  name: string;
  labels: Record<string, string>;
}

export interface CommitSpec {
  repo: string;
  tag: string;
  comment?: string;
  author?: string;
  pause?: boolean;
  /** Dockerfile instructions applied to the new image, e.g. `LABEL k=v` or `CMD [...]`. */
  changes: string[];
}

export interface BuildSpec {
  contextDir: string;
  dockerfile: string;
  tag: string;
  labels: Record<string, string>;
}

export interface ExecSpec {
  cmd: string[];
  env: string[];
  workingDir: string;
}

export interface ExecStatus {
  running: boolean;
  exitCode: number | null;
  pid: number | null;
}

/** An attached exec in TTY mode. */
export interface ExecSession {
  readonly id: string;
  readonly stream: Duplex;
  resize(size: { cols: number; rows: number }): Promise<void>;
  inspect(): Promise<ExecStatus>;
}

export interface RuntimeEvent {
  type: string;
  action: string;
  id: string;
  attributes: Record<string, string>;
  time: string;
}

export interface RuntimeInfo {
  version: string | null;
  rootDir: string | null;
  containers: { running: number; total: number };
  images: number;
}

export type RuntimeErrorKind = "not_found" | "conflict" | "invalid" | "unavailable" | "engine";

/**
 * The only error type business code receives from a Runtime for engine failures. `kind` selects the HTTP response
 * (lib/errors.ts). `detail` is the engine's own message shown to users; `message` is the full text used in logs.
 */
export class RuntimeError extends Error {
  readonly detail: string;

  constructor(
    readonly kind: RuntimeErrorKind,
    message: string,
    detail = message,
  ) {
    super(message);
    this.name = "RuntimeError";
    this.detail = detail;
  }
}

/**
 * Operations MiniBox needs from a container engine. Engine failures are RuntimeError; anything else is an
 * unexpected Error. See docs/runtime.md for the contract.
 */
export interface Runtime {
  ping(): Promise<void>;
  info(): Promise<RuntimeInfo>;

  /** Containers whose labels include every given key/value. Containers that disappear mid-list are skipped. */
  listContainers(filter: { labels: Record<string, string> }): Promise<ContainerInfo[]>;
  inspectContainer(id: string): Promise<ContainerInfo>;
  createContainer(spec: CreateContainerSpec): Promise<{ id: string }>;
  /** Starting a running container succeeds. Fails with `not_found` while the container's network is missing. */
  startContainer(id: string): Promise<void>;
  /** Stopping a stopped container succeeds. */
  stopContainer(id: string, opts: { timeoutSec: number }): Promise<void>;
  restartContainer(id: string, opts: { timeoutSec: number }): Promise<void>;
  removeContainer(id: string, opts: { force: boolean }): Promise<void>;
  renameContainer(id: string, name: string): Promise<void>;
  /** Only the fields that are present change. Restart policy changes do not recreate the container. */
  updateContainer(id: string, limits: ContainerUpdate): Promise<void>;
  /** Log text with any stream framing removed. */
  containerLogs(id: string, opts: { tail: number; timestamps: boolean }): Promise<string>;
  /** Writable-layer changes (`docker diff`). An unchanged container returns an empty list. */
  containerDiff(id: string): Promise<ContainerChange[]>;
  containerStats(id: string): Promise<ContainerStats>;
  commitContainer(id: string, spec: CommitSpec): Promise<void>;
  /** Extracts a tar archive into `path`. Works on created containers that are not running. */
  putArchive(id: string, path: string, tar: Readable | Buffer): Promise<void>;
  /** Tar archive of `path`. Works on created containers that are not running. */
  getArchive(id: string, path: string): Promise<Readable>;
  startExec(containerId: string, spec: ExecSpec): Promise<ExecSession>;
  /** Stops when the consumer stops iterating or `signal` aborts. */
  events(
    filter: { labels?: Record<string, string>; types?: string[] },
    signal?: AbortSignal,
  ): AsyncIterable<RuntimeEvent>;

  listImages(filter: { labels: Record<string, string> }): Promise<ImageSummary[]>;
  inspectImage(ref: string): Promise<ImageDetails>;
  removeImage(ref: string, opts: { force: boolean }): Promise<void>;
  /** Resolves with the build log. */
  buildImage(spec: BuildSpec): Promise<string>;

  inspectVolume(name: string): Promise<VolumeInfo>;
  createVolume(name: string, labels: Record<string, string>): Promise<void>;
  removeVolume(name: string): Promise<void>;

  /**
   * Creates a bridge network named `name` if it does not exist. An existing network must be a bridge whose
   * inter-container communication matches `interContainerComm`; otherwise this fails with `conflict`.
   */
  ensureBridgeNetwork(name: string, opts: { interContainerComm: boolean }): Promise<void>;

  /**
   * Attaches a container to the network named `name` as it is now. The engine pins a container to the ID of the
   * network it last ran on, so after that network is removed and created again the container cannot start until this
   * is called. Does nothing when the container is already attached to the current network. Fails with `invalid` when
   * the container's network is not `name`.
   */
  reattachNetwork(containerId: string, name: string): Promise<void>;
}
