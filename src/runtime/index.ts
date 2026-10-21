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
  /** `bind` is a host path. Absent means a named volume. Both use the engine's bind string. */
  kind?: "volume" | "bind";
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
  /** Numeric user, such as `0:0` for a root helper. Absent keeps the image user. */
  user?: string;
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
  driver?: string;
  /** Driver options. Absent when the engine did not report any. */
  options?: Record<string, string>;
}

export interface VolumeCreateOptions {
  driver?: string;
  driverOpts?: Record<string, string>;
}

export interface HelperResult {
  exitCode: number;
  logs: string;
}

export interface HelperSpec {
  image: string;
  cmd: string[];
  mounts?: Mount[];
  /** Numeric user, such as `0:0`. Absent keeps the image user. */
  user?: string;
  /** Capabilities granted on top of none. A helper that changes ownership or reads other users' files names them. */
  capAdd?: string[];
  timeoutSec?: number;
  labels?: Record<string, string>;
}

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
}

export interface CommitSpec {
  repo: string;
  tag: string;
  comment?: string;
  author?: string;
  pause?: boolean;
  /** Dockerfile instructions applied to the new image, e.g. `LABEL k=v` or `CMD [...]`. */
  changes: string[];
  /**
   * Checked before the commit starts and after it returns. A commit that has already finished is not rolled back
   * when this aborts.
   */
  signal?: AbortSignal;
}

export interface BuildSpec {
  contextDir: string;
  dockerfile: string;
  tag: string;
  labels: Record<string, string>;
  /** Called with each chunk of build output as the engine produces it. */
  onLog?: (chunk: string) => void;
  /** Closes the build stream. The call rejects with `AbortError` once that connection has closed. */
  signal?: AbortSignal;
}

export interface ExecSpec {
  cmd: string[];
  env: string[];
  workingDir: string;
  /** Container user. Absent keeps the container's own user. Command exec passes `dev`. */
  user?: string;
  /**
   * User the kill runs as, when it is not the exec's own. A setuid program can start a child that the exec's user
   * cannot signal, so a kill as that user would leave the child running. Absent means `user`.
   */
  stopAs?: string;
  /**
   * Interactive terminal. Absent means a TTY, which is what the web terminal uses.
   * Command exec sets this to false so stdout and stderr stay separate.
   */
  tty?: boolean;
}

export interface ExecStatus {
  running: boolean;
  exitCode: number | null;
  /** The engine's host pid. Informational only: `kill()` never signals it. */
  pid: number | null;
}

/**
 * An attached exec. A TTY session uses `stream` for both directions. A command exec (`tty: false`) also fills
 * `stdout` and `stderr` separately. `inspect()` is the exit code. `kill()` stops the process and its descendants from
 * inside the box, as `stopAs` or else the exec's user. It resolves once the exec has ended, and rejects with an
 * `engine` error if a process survives or the exec does not end. A TTY session cannot be stopped this way.
 */
export interface ExecSession {
  readonly id: string;
  readonly stream: Duplex;
  readonly stdout: Readable;
  readonly stderr: Readable;
  resize(size: { cols: number; rows: number }): Promise<void>;
  inspect(): Promise<ExecStatus>;
  kill(): Promise<void>;
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

/** Business code branches on the kind of an engine failure, never on its message. */
export const isRuntimeError = (e: unknown, kind: RuntimeErrorKind): e is RuntimeError =>
  e instanceof RuntimeError && e.kind === kind;

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
  /**
   * Resolves with the build log. `onLog` receives the same text as it arrives. An aborted `signal` rejects with
   * `AbortError` rather than a RuntimeError, once the connection to the engine has closed.
   */
  buildImage(spec: BuildSpec): Promise<string>;

  inspectVolume(name: string): Promise<VolumeInfo>;
  listVolumes(): Promise<VolumeInfo[]>;
  /**
   * Creating an existing volume succeeds and keeps its labels and driver options.
   * `opts` selects a driver, for example the local driver with NFS or bind options.
   */
  createVolume(name: string, labels: Record<string, string>, opts?: VolumeCreateOptions): Promise<void>;
  removeVolume(name: string): Promise<void>;
  /**
   * Runs a short-lived container to completion. It has no network, a read-only root filesystem with a small `/tmp`,
   * no capabilities beyond `capAdd`, no privilege escalation, and fixed memory and process limits. The engine removes it
   * when it exits, and this returns once it is gone. A timeout kills the container and returns exit code 124. Used for
   * chown, NFS directory setup, pool probes and measuring. The image is the base template.
   */
  runHelper(spec: HelperSpec): Promise<HelperResult>;
  /** Bytes on the filesystem that holds `path`, as seen by this runtime's host. */
  diskUsage(path: string): Promise<DiskUsage>;

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
