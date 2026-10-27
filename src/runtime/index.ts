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
  /**
   * IPv4 address on `network`, or null when the container is not running or has no endpoint.
   * Used by the path-mode preview proxy; never published as a host port.
   */
  ipAddress: string | null;
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
  /**
   * Named volumes only. When true, create via the Mounts API with NoCopy so an empty volume is not seeded from the
   * image directory at the mount target (same as helpers).
   */
  noCopy?: boolean;
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
  /** `NAME=value` entries merged over the image environment. The caller resolves a box's secrets into these. */
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
  /** Read-only container root filesystem (archive helpers mirror `runHelper`). */
  readonlyRootfs?: boolean;
  /** Extra tmpfs mounts, such as `{ "/tmp": "rw,noexec,nosuid,nodev,size=16m" }` for archive helpers. */
  tmpfs?: Record<string, string>;
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
  /** The `repo:tag` references the engine holds for the image. A dangling image has none. */
  tags: string[];
  /** The machine architecture the image was built for, as the engine reports it (`x86_64`, `aarch64`). */
  arch: string;
  labels: Record<string, string>;
  /** The image's own `NAME=value` entries, as the engine reports them in the image configuration. */
  env: string[];
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

/** A network the engine holds, with the IPv4 subnets it has. */
export interface NetworkSummary {
  name: string;
  /** IPv4 subnets the engine assigned or was given. Empty when the network has none. */
  subnets: string[];
}

/** Where a helper finds its `HelperSpec.secrets`, read-only. */
export const HELPER_SECRETS_DIR = "/run/secrets";

/**
 * Marks the volume that stages a helper's secrets for one run. The volume also carries the helper's own labels, so a
 * startup sweep can find the ones a crash left behind on this instance's prefix and remove them.
 */
export const HELPER_SECRETS_LABEL = "minibox.helper-secrets";

/** A file-sized secret for one helper run. `name` is a plain file name, not a path. */
export interface HelperSecret {
  name: string;
  value: string;
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
  /** `NAME=value` entries. Used by tool installs for HTTP_PROXY and npm/pip settings. */
  env?: string[];
  /**
   * Secrets the helper reads from `/run/secrets/<name>`, read-only. A secret never goes into `env` or the container
   * config, which the engine shows to anyone who can inspect the container. The engine stages them in a volume that
   * exists only for the run.
   */
  secrets?: HelperSecret[];
  /** Owner of the staged secret files, so a helper that runs as another user can read them. Absent means root. */
  secretsOwner?: VolumeOwner;
  /**
   * When true, the helper joins the engine's default bridge so it can reach npm / PyPI / GitHub.
   * Absent or false keeps NetworkMode `none` (volume probes and chown).
   */
  network?: boolean;
  /**
   * Joins the engine host's network namespace, so that firewall changes made by the helper apply to the host. Only the
   * host firewall sets this, with `capAdd` NET_ADMIN.
   */
  hostNetwork?: boolean;
  /**
   * When false, the root filesystem is writable (needed for package managers that write outside the tools mount).
   * Absent or true keeps the read-only root with a small `/tmp`.
   */
  readonlyRoot?: boolean;
  /** Memory cap in bytes. Absent keeps the 256 MiB helper default. Tool installs raise this. */
  memoryBytes?: number;
  /** Process limit. Absent keeps 64. */
  pidsLimit?: number;
  /** Size in bytes of the `/tmp` tmpfs on a read-only root. Absent keeps 16 MiB. */
  tmpfsBytes?: number;
}

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
}

/**
 * One class of what an engine holds, as `docker system df` counts it. Every figure is null when the engine did not
 * report it, which engines of different versions do: a missing field is null, never an error.
 */
export interface DiskBreakdownEntry {
  /** Entries of this class the engine holds. */
  count: number | null;
  /** Entries in use: images a container uses, running containers, volumes a container mounts, build cache in use. */
  activeCount: number | null;
  /** Bytes this class takes. */
  totalBytes: number | null;
  /** Bytes that removing everything unused would free. */
  reclaimableBytes: number | null;
}

/** The engine's own accounting of what it holds (`docker system df`). A class the engine did not report is null. */
export interface DiskBreakdown {
  images: DiskBreakdownEntry | null;
  containers: DiskBreakdownEntry | null;
  volumes: DiskBreakdownEntry | null;
  buildCache: DiskBreakdownEntry | null;
}

/** Numeric owner of a file or directory. */
/** Metadata of one path in a container, without its contents (`HEAD /containers/{id}/archive`). */
export interface PathStat {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  /** Go `os.FileMode` bits as the engine reports them. */
  mode: number;
  /**
   * For a symlink, the engine's fully evaluated container path of its target (not the raw `readlink` text). Empty
   * otherwise. Read the raw target from the first archive entry when the literal link text matters.
   */
  linkTarget: string;
}

export interface VolumeOwner {
  uid: number;
  gid: number;
}

/** Largest uid or gid a `VolumeOwner` can hold. 4294967295 is -1, which chown reads as "leave the owner as it is". */
export const MAX_OWNER_ID = 4294967294;

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
  /** Top-level entries of `contextDir` to send. Absent sends only `dockerfile`. */
  src?: string[];
  /** Build arguments, passed as `--build-arg`. */
  args?: Record<string, string>;
  /** The stage to build, as `--target`. Absent builds the last stage. */
  target?: string;
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
 * inside the box, as `stopAs` or else the exec's user, for TTY and non-TTY execs alike. It resolves once the exec has
 * ended, and rejects with an `engine` error if a process survives or the exec does not end.
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
  /** The engine's clock in nanoseconds. It tells an event the engine replays from a new one of the same action. */
  timeNano: number;
}

export interface RuntimeInfo {
  version: string | null;
  rootDir: string | null;
  containers: { running: number; total: number };
  images: number;
  /** CPUs the engine can schedule on. Null when the engine does not report it. */
  cpus: number | null;
  /** Memory the engine can allocate, in bytes. Null when the engine does not report it. */
  memoryBytes: number | null;
}

/**
 * Where a runtime connects. A socket path for a local daemon or a tunnel, or a TCP endpoint that must present a
 * certificate the client trusts and accept the client's own certificate (mutual TLS).
 */
export type EngineTarget =
  | { readonly socketPath: string }
  | { readonly host: string; readonly port: number; readonly ca: string; readonly cert: string; readonly key: string };

export type RuntimeErrorKind = "not_found" | "conflict" | "invalid" | "unavailable" | "engine" | "unsupported";

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
 * unexpected Error.
 */
export interface Runtime {
  ping(): Promise<void>;
  info(): Promise<RuntimeInfo>;

  /**
   * Containers whose labels include every given key/value. Containers that disappear mid-list are skipped. An aborted
   * `signal` rejects with `AbortError` once the engine call is cancelled.
   */
  listContainers(filter: { labels: Record<string, string> }, opts?: { signal?: AbortSignal }): Promise<ContainerInfo[]>;
  /** An aborted `signal` rejects with `AbortError` once the engine call is cancelled. */
  inspectContainer(id: string, opts?: { signal?: AbortSignal }): Promise<ContainerInfo>;
  /**
   * The `NAME=value` entries the container was created with. The values are for a caller that compares them in memory:
   * they are never stored, logged or returned.
   */
  inspectEnv(id: string): Promise<string[]>;
  createContainer(spec: CreateContainerSpec): Promise<{ id: string }>;
  /** Starting a running container succeeds. Fails with `not_found` while the container's network is missing. */
  startContainer(id: string): Promise<void>;
  /** Stopping a stopped container succeeds. */
  stopContainer(id: string, opts: { timeoutSec: number }): Promise<void>;
  restartContainer(id: string, opts: { timeoutSec: number }): Promise<void>;
  /**
   * Freezes every process in a running container, so its files stop changing. Pausing a paused or stopped container
   * fails with `conflict`.
   */
  pauseContainer(id: string): Promise<void>;
  /** Resumes a paused container. One that is not paused is left as it is, so a cleanup step can always call it. */
  unpauseContainer(id: string): Promise<void>;
  removeContainer(id: string, opts: { force: boolean }): Promise<void>;
  renameContainer(id: string, name: string): Promise<void>;
  /** Only the fields that are present change. Restart policy changes do not recreate the container. */
  updateContainer(id: string, limits: ContainerUpdate): Promise<void>;
  /** Log text with any stream framing removed. */
  containerLogs(id: string, opts: { tail: number; timestamps: boolean }): Promise<string>;
  /**
   * The lines a container writes: its last `tail` lines, then each line as it is written, with the engine's timestamps
   * when `timestamps` is set. A line is yielded without its newline once the newline arrives. The iterator ends when the
   * container stops or is removed, after yielding any final partial line, and a container that is not running yields
   * its tail and ends at once. With `since`, lines stamped before it are left out; the engine takes `tail` before that
   * filter, so the tail counts the lines it reads, and a line stamped at `since` is kept. An aborted `signal` ends the
   * iterator without an error. A broken engine connection throws a RuntimeError of kind `unavailable`.
   */
  followLogs(
    id: string,
    opts: { tail: number; timestamps: boolean; since?: Date; signal?: AbortSignal },
  ): AsyncIterable<string>;
  /** Writable-layer changes (`docker diff`). An unchanged container returns an empty list. */
  containerDiff(id: string): Promise<ContainerChange[]>;
  /** One sample of a container's usage. An aborted `signal` rejects with `AbortError` once the engine call is cancelled. */
  containerStats(id: string, opts?: { signal?: AbortSignal }): Promise<ContainerStats>;
  commitContainer(id: string, spec: CommitSpec): Promise<void>;
  /** Extracts a tar archive into `path`. Works on created containers that are not running. */
  putArchive(id: string, path: string, tar: Readable | Buffer): Promise<void>;
  /**
   * Writes one file into a running container through a process in it. putArchive cannot place a file under a tmpfs
   * mount: it writes beneath the mount, and the mount hides the file. The file gets `mode` and belongs to `user`, the
   * user the write runs as. A sibling temporary file is completed before it atomically replaces the destination.
   * `data` goes in on stdin, so it is never in a command line or an environment.
   */
  writeContainerFile(id: string, path: string, data: Buffer, opts: { user: string; mode: number }): Promise<void>;
  /** Tar archive of `path`. Works on created containers that are not running. */
  getArchive(id: string, path: string): Promise<Readable>;
  /**
   * Stat of `path` (the final component is not followed) with no archive body, so it costs the same for a directory
   * of any size. Works on created containers that are not running. Fails with `not_found` when `path` does not exist;
   * a symlink loop on the final component fails as an engine error with no detail.
   */
  statPath(id: string, path: string): Promise<PathStat>;
  /**
   * Owner of the directory or file at `path` in the container, read from the first entry of the engine's archive for
   * it. Only that entry is read, so a large directory is not streamed. Works on created containers that are not
   * running. Fails with `not_found` when `path` does not exist.
   */
  volumeRootOwner(containerId: string, path: string): Promise<VolumeOwner>;
  /**
   * Sets the owner of the root directory of `volume`, and not of its contents. A short-lived helper runs `chown` from
   * `image` as root with CHOWN as its only capability, no network and no new privileges, and is removed however the
   * chown ends. Fails with `not_found` when the volume does not exist, and with `engine` when the helper cannot run or
   * its chown fails.
   */
  setVolumeRootOwner(volume: string, owner: VolumeOwner, image: string): Promise<void>;
  startExec(containerId: string, spec: ExecSpec): Promise<ExecSession>;
  /**
   * Stops when the consumer stops iterating or `signal` aborts. `since` (Unix seconds) also yields the events the
   * engine still holds from that time, so a subscriber that lists containers after subscribing misses nothing.
   */
  events(
    filter: { labels?: Record<string, string>; types?: string[]; since?: number },
    signal?: AbortSignal,
  ): AsyncIterable<RuntimeEvent>;

  listImages(filter: { labels: Record<string, string> }): Promise<ImageSummary[]>;
  inspectImage(ref: string): Promise<ImageDetails>;
  /**
   * Makes `ref` present locally. An image that is already present is left alone and no registry is contacted. A
   * reference the registry does not have fails with `not_found`. `onLog` receives a line each time the status of a layer
   * or of the pull changes.
   */
  pullImage(ref: string, opts?: { onLog?(text: string): void }): Promise<void>;
  removeImage(ref: string, opts: { force: boolean }): Promise<void>;
  /**
   * The image `ref` as a tar archive, the form `docker save` writes, with the tags it has. The caller reads the stream
   * and destroys it when it stops early.
   */
  saveImage(ref: string): Promise<Readable>;
  /**
   * Loads an archive written by `saveImage`, on this engine. The image keeps its id, and the tags in the archive name it
   * here, so a tag the engine already holds for another image moves to the loaded one.
   */
  loadImage(archive: Readable): Promise<void>;
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
   * What the engine itself holds, the way `docker system df` reports it: images, containers, volumes and build cache,
   * each with the bytes it takes and the bytes removing what is unused would free. This is the engine's accounting, not
   * the host filesystem's (`diskUsage`): a class or a figure the engine does not report is null, so an older or newer
   * engine yields nulls instead of an error. An aborted `signal` rejects with `AbortError`.
   */
  diskBreakdown(opts?: { signal?: AbortSignal }): Promise<DiskBreakdown>;

  /**
   * Creates a bridge network named `name` if it does not exist. An existing network must be a bridge whose
   * inter-container communication matches `interContainerComm`, whose `internal` flag matches, and whose subnet is
   * `subnet` when one is given. Otherwise this fails with `conflict`.
   * An `internal` network has no route out of the host: its containers reach each other and the host, and nothing
   * else. Traffic to the host is not stopped here; see `setHostIngressBlock`.
   */
  ensureBridgeNetwork(
    name: string,
    opts: { interContainerComm: boolean; internal?: boolean; subnet?: string },
  ): Promise<void>;

  /** Removes a network. One that does not exist is left alone. A network that still has containers attached fails with `conflict`. */
  removeNetwork(name: string): Promise<void>;

  /**
   * Attaches a container to a second network, with `alias` as a name the containers on that network resolve it by. A
   * container already attached to `name` is left as it is, and one attached to an older network with that name is
   * moved to the current one.
   */
  connectNetwork(containerId: string, name: string, opts?: { alias?: string }): Promise<void>;

  /** The networks the engine holds, with their IPv4 subnets. */
  listNetworks(): Promise<NetworkSummary[]>;

  /**
   * Replaces one install's host firewall rules: new connections that the host itself receives from any of `sources`
   * (IPv4 CIDRs) are dropped. A container's connection to the bridge gateway is one of these, so this is what stops a
   * box reaching services on the host. `owner` is the install's label prefix: each owner has its own chain, so two
   * installs on one host do not replace each other's rules. An owner's rules are replaced as a whole, and an empty
   * list removes them. Runs a short-lived privileged helper on the host network, so a remote agent host runs it on its
   * own engine.
   */
  setHostIngressBlock(owner: string, sources: string[]): Promise<void>;

  /**
   * Attaches a container to the network named `name` as it is now. The engine pins a container to the ID of the
   * network it last ran on, so after that network is removed and created again the container cannot start until this
   * is called. Does nothing when the container is already attached to the current network. Fails with `invalid` when
   * the container's network is not `name`.
   */
  reattachNetwork(containerId: string, name: string): Promise<void>;
}
