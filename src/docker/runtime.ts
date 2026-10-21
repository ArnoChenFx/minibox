import { randomBytes } from "node:crypto";
import { statfsSync } from "node:fs";
import { createInterface } from "node:readline";
import { PassThrough, type Duplex, type Readable } from "node:stream";

import Docker from "dockerode";

import { stripSlash } from "../labels";
import { abortError, isAbortError } from "../lib/abort";
import {
  type CommitSpec,
  type ContainerChange,
  type ContainerHardening,
  type ContainerInfo,
  type ContainerMount,
  type ContainerUpdate,
  type CreateContainerSpec,
  type DiskUsage,
  type HelperSpec,
  isRuntimeError,
  type Mount,
  type Runtime,
  type RuntimeEvent,
  RuntimeError,
  type VolumeInfo,
} from "../runtime";
import { readFirstEntryOwner } from "./archive";
import { toRuntimeError } from "./errors";
import { demuxLogs } from "./logs";
import { computeStats } from "./stats";

/**
 * Runs the command as a child of this shell, with the exec's token in the shell's argv as `minibox-exec <token>`.
 * KILL_TREE_SCRIPT finds the exec through that argv, so the hint file is only a shortcut: a command that removes it,
 * or a box where it cannot be written, is still stopped. The shell is not replaced, so the hint also goes when the
 * command ends normally. Needs /bin/sh in the box.
 */
export const RUN_WRAPPER = `
token=$1
shift
(: > "/tmp/.minibox-exec-$token.$$") 2>/dev/null
"$@"
status=$?
rm -f "/tmp/.minibox-exec-$token.$$" 2>/dev/null
exit "$status"
`.trim();

/**
 * Stops one exec from inside the box. `$1` is the exec's token. The wrapper is matched on its cmdline: `$(cat)` drops
 * the NULs between argv entries, so `minibox-exec` followed by the token matches as one string. Hint files named
 * `/tmp/.minibox-exec-<token>.<pid>` only suggest pids, and each suggestion is checked the same way, because /tmp is
 * writable by every user. Children are found through the ppid in /proc/<pid>/stat, since some kernels have no
 * /proc/<pid>/task/<tid>/children. Processes in the wrapper's session or process group are taken too when the wrapper
 * leads one. Each process is stopped as it is found, and scans repeat until one finds nothing new, so a child forked
 * before its parent was stopped is caught by the next scan. Exit 0: nothing of the exec is left. Exit 1: a process
 * could not be signalled, and the rest resume; or a process survived, and the rest stay stopped for a retry. Exit 2:
 * no wrapper.
 */
export const KILL_TREE_SCRIPT = `
token=$1
pattern="minibox-exec$token"
self=$$
members=""
anchors=""
groups=" "
roots=0
grew=0

load() {
  read -r line 2>/dev/null < "/proc/$1/stat" || return 1
  rest=\${line##*) }
  set -- $rest
  st_state=$1 st_ppid=$2 st_pgid=$3 st_sid=$4 st_start=\${20}
}

enlist() {
  members="$members $1:$2"
  kill -STOP "$1" 2>/dev/null
  grew=1
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    load "$1" || return 0
    case $st_state in T | t | Z | X) return 0 ;; esac
    sleep 0.01 2>/dev/null
  done
}

try_root() {
  [ "$1" -gt 1 ] 2>/dev/null && [ "$1" != "$self" ] || return 0
  case " $members " in *" $1:"*) return 0 ;; esac
  load "$1" || return 0
  case $st_state in Z | X) return 0 ;; esac
  case $(cat "/proc/$1/cmdline" 2>/dev/null) in *"$pattern"*) ;; *) return 0 ;; esac
  roots=1
  anchors="$anchors $1:$st_start"
  if [ "$st_sid" = "$1" ] || [ "$st_pgid" = "$1" ]; then groups="$groups$1 "; fi
  enlist "$1" "$st_start"
}

expand() {
  grew=0
  for d in /proc/[0-9]*; do
    q=\${d#/proc/}
    [ "$q" -gt 1 ] && [ "$q" != "$self" ] || continue
    case " $members " in *" $q:"*) continue ;; esac
    load "$q" || continue
    case $st_state in Z | X) continue ;; esac
    joins=0
    case " $members " in *" $st_ppid:"*) joins=1 ;; esac
    case $groups in *" $st_sid "* | *" $st_pgid "*) joins=1 ;; esac
    [ "$joins" = 1 ] || continue
    enlist "$q" "$st_start"
  done
}

thaw() {
  for tok in $members; do
    q=\${tok%%:*}
    load "$q" || continue
    [ "$st_start" = "\${tok#*:}" ] || continue
    kill -CONT "$q" 2>/dev/null
  done
}

signalable() {
  for tok in $members; do
    q=\${tok%%:*}
    load "$q" || continue
    [ "$st_start" = "\${tok#*:}" ] || continue
    case $st_state in Z | X) continue ;; esac
    kill -0 "$q" 2>/dev/null || return 1
  done
}

drain() {
  rounds=0
  while :; do
    alive=0
    for tok in $members; do
      case " $anchors " in *" $tok "*) anchor=1 ;; *) anchor=0 ;; esac
      [ "$anchor" = "$1" ] || continue
      q=\${tok%%:*}
      load "$q" || continue
      [ "$st_start" = "\${tok#*:}" ] || continue
      case $st_state in Z | X) continue ;; esac
      alive=1
      kill -KILL "$q" 2>/dev/null
    done
    [ "$alive" = 1 ] || return 0
    rounds=$((rounds + 1))
    [ "$rounds" -lt 40 ] || return 1
    sleep 0.05 2>/dev/null
  done
}

for h in /tmp/.minibox-exec-"$token".*; do try_root "\${h##*.}"; done
for d in /proc/[0-9]*; do try_root "\${d#/proc/}"; done
if [ "$roots" = 0 ]; then rm -f /tmp/.minibox-exec-"$token".* 2>/dev/null; exit 2; fi

passes=0
while :; do
  while [ "$grew" = 1 ]; do expand; done
  signalable || { thaw; exit 1; }
  drain 0 || exit 1
  drain 1 || exit 1
  expand
  [ "$grew" = 1 ] || break
  passes=$((passes + 1))
  [ "$passes" -lt 5 ] || exit 1
done
rm -f /tmp/.minibox-exec-"$token".* 2>/dev/null
exit 0
`.trim();

/** How often the kill looks for the wrapper again, and how many times it looks before it gives up. */
const KILL_RETRY_MS = 60;
const KILL_ATTEMPTS = 10;
/** Upper bounds on waiting for the kill's own output to end, for its exit code, and for the exec to end after a 0. */
const KILL_STREAM_MS = 5000;
const KILL_EXIT_MS = 2000;
const KILL_CONFIRM_MS = 3000;

const NANO_CPUS_PER_CPU = 1e9;
const ICC_OPTION = "com.docker.network.bridge.enable_icc";
/** Longest a cached container inspect is reused when nothing MiniBox changed the container (see listContainers). */
const INSPECT_TTL_MS = 30_000;

/** Engine errors become RuntimeError. Cancellation stays an AbortError so a task is not reported as a Docker failure. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isAbortError(e)) throw e;
    throw toRuntimeError(e);
  }
}

/** Starting a running container, or stopping a stopped one, is a no-op rather than an error. */
async function ignore304(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode !== 304) throw e;
  }
}

const labelFilter = (labels: Record<string, string>) => Object.entries(labels).map(([k, v]) => `${k}=${v}`);

/**
 * dockerode's typings omit `abortSignal`, which dockerode and docker-modem forward to the request. The key is left out
 * when there is no signal, or the query string would carry `abortSignal=`.
 */
function withSignal<T extends object>(options: T, signal: AbortSignal | undefined): T {
  return signal ? ({ ...options, abortSignal: signal } as T) : options;
}

/** The engine reports the default bridge as `default` in some API versions. */
function networkOf(info: Docker.ContainerInspectInfo): string {
  const mode = info.HostConfig?.NetworkMode;
  return mode && mode !== "default" ? mode : "bridge";
}

/** A zero or negative process limit means the engine is not enforcing one. */
function pidsOf(value: number | undefined): number | null {
  return value !== undefined && value > 0 ? value : null;
}

function mountsOf(info: Docker.ContainerInspectInfo): ContainerMount[] {
  return (info.Mounts ?? []).flatMap((mount) => {
    const source = mount.Type === "volume" ? (mount.Name ?? mount.Source) : mount.Source;
    if (!source || !mount.Destination) return [];
    const readOnly = mount.RW === false || (mount.Mode ?? "").split(",").includes("ro");
    return [{ source, target: mount.Destination, mode: readOnly ? "ro" : "rw" }];
  });
}

export function toContainerInfo(info: Docker.ContainerInspectInfo): ContainerInfo {
  const started = info.State.StartedAt;
  const network = networkOf(info);
  return {
    id: info.Id,
    name: stripSlash(info.Name),
    image: info.Config.Image,
    imageId: info.Image,
    labels: info.Config?.Labels ?? {},
    created: info.Created,
    state: info.State.Status,
    running: info.State.Running,
    startedAt: started && !started.startsWith("0001") ? started : null,
    cpus: info.HostConfig?.NanoCpus ? info.HostConfig.NanoCpus / NANO_CPUS_PER_CPU : null,
    memoryBytes: info.HostConfig?.Memory || null,
    pidsLimit: pidsOf(info.HostConfig?.PidsLimit),
    restart: info.HostConfig?.RestartPolicy?.Name || "no",
    mounts: mountsOf(info),
    network,
    ipAddress: ipAddressOf(info, network),
  };
}

/** IPv4 on the container's primary network endpoint. Empty or IPv6-only endpoints yield null. */
function ipAddressOf(info: Docker.ContainerInspectInfo, network: string): string | null {
  const networks = info.NetworkSettings?.Networks ?? {};
  const endpoint = networks[network] ?? Object.values(networks)[0];
  const ip = endpoint?.IPAddress?.trim();
  return ip || null;
}

function applyHardening(hostConfig: Docker.HostConfig, hardening: ContainerHardening): void {
  if (hardening.capDrop?.length) hostConfig.CapDrop = hardening.capDrop;
  if (hardening.capAdd?.length) hostConfig.CapAdd = hardening.capAdd;
  if (hardening.noNewPrivileges) hostConfig.SecurityOpt = ["no-new-privileges:true"];
  if (hardening.pidsLimit !== undefined) hostConfig.PidsLimit = hardening.pidsLimit;
  if (hardening.ulimits?.length) {
    hostConfig.Ulimits = hardening.ulimits.map((u) => ({ Name: u.name, Soft: u.soft, Hard: u.hard }));
  }
  if (hardening.runtime) hostConfig.Runtime = hardening.runtime;
}

/** Only set the keys that are present: dockerode serialises `undefined` as an empty query parameter. */
export function toCreateOptions(spec: CreateContainerSpec): Docker.ContainerCreateOptions {
  const hostConfig: Docker.HostConfig = {};
  if (spec.mounts) hostConfig.Binds = spec.mounts.map((mount) => bindOf(mount));
  if (spec.restart) hostConfig.RestartPolicy = { Name: spec.restart };
  if (spec.cpus !== undefined) hostConfig.NanoCpus = Math.round(spec.cpus * NANO_CPUS_PER_CPU);
  if (spec.memoryBytes !== undefined) hostConfig.Memory = spec.memoryBytes;
  if (spec.swapBytes !== undefined) hostConfig.MemorySwap = spec.swapBytes;
  if (spec.init !== undefined) hostConfig.Init = spec.init;
  if (spec.network !== undefined) hostConfig.NetworkMode = spec.network;
  if (spec.hardening) applyHardening(hostConfig, spec.hardening);

  const opts: Docker.ContainerCreateOptions = { Image: spec.image };
  if (spec.name !== undefined) opts.name = spec.name;
  if (spec.cmd !== undefined) opts.Cmd = spec.cmd;
  if (spec.workingDir !== undefined) opts.WorkingDir = spec.workingDir;
  if (spec.hostname !== undefined) opts.Hostname = spec.hostname;
  if (spec.user !== undefined) opts.User = spec.user;
  if (spec.labels !== undefined) opts.Labels = spec.labels;
  if (spec.env !== undefined) opts.Env = spec.env;
  if (Object.keys(hostConfig).length > 0) opts.HostConfig = hostConfig;
  return opts;
}

const ROOT_OWNER_MOUNT = "/minibox-volume";

/**
 * The helper could not be created or started. MiniBox built that container from its own settings, so the engine's
 * refusal is an engine failure, whatever status it sent. An unreachable engine stays unavailable.
 */
function helperFailure(volume: string, e: unknown): RuntimeError {
  if (isRuntimeError(e, "unavailable")) return e;
  const reason = e instanceof RuntimeError ? e.detail : String(e);
  return new RuntimeError("engine", `the chown helper for ${volume} could not run: ${reason}`, reason);
}

function bindOf(mount: Mount): string {
  const mode = mount.mode === "ro" ? ":ro" : "";
  return `${mount.source}:${mount.target}${mode}`;
}

function volumeInfo(info: {
  Name: string;
  Labels?: Record<string, string> | null;
  Driver?: string;
  Options?: Record<string, string> | null;
}): VolumeInfo {
  return {
    name: info.Name,
    labels: info.Labels ?? {},
    driver: info.Driver,
    options: info.Options ?? undefined,
  };
}

/** An existing network can be used only if it is a bridge with the requested inter-container communication setting. */
function bridgeMatches(network: Docker.NetworkInspectInfo, interContainerComm: boolean): boolean {
  const enabled = network.Options?.[ICC_OPTION] !== "false";
  return network.Driver === "bridge" && enabled === interContainerComm;
}

function networkConflict(name: string, interContainerComm: boolean): RuntimeError {
  const message = `network ${name} exists but is not a bridge with inter-container communication ${interContainerComm ? "on" : "off"}`;
  return new RuntimeError("conflict", message, message);
}

function toCommitOptions(spec: CommitSpec): Record<string, unknown> {
  const opts: Record<string, unknown> = { repo: spec.repo, tag: spec.tag, changes: spec.changes };
  if (spec.comment !== undefined) opts.comment = spec.comment;
  if (spec.author !== undefined) opts.author = spec.author;
  if (spec.pause !== undefined) opts.pause = spec.pause;
  return opts;
}

/** Docker kind 0 is a modification, 1 an addition and 2 a deletion. Anything else is reported as modified. */
function toChange(change: { Path?: string; Kind?: number }): ContainerChange[] {
  if (!change.Path) return [];
  const kind = change.Kind === 1 ? "added" : change.Kind === 2 ? "deleted" : "modified";
  return [{ path: change.Path, kind }];
}

/**
 * The engine answers JSON null when nothing changed, and docker-modem hands that body back as a Buffer. An empty
 * body counts the same way. Any other body is an error: an empty diff for a container that could not be read would
 * let a rebuild be confirmed without showing the writable-layer changes it throws away.
 */
export function parseChanges(body: unknown): ContainerChange[] {
  if (Array.isArray(body)) return body.flatMap(toChange);
  if (body === null) return [];
  if (Buffer.isBuffer(body)) {
    const text = body.toString("utf8").trim();
    if (text === "" || text === "null") return [];
  }
  throw new RuntimeError("engine", `unexpected response from docker diff: ${describeBody(body)}`);
}

function describeBody(body: unknown): string {
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : (JSON.stringify(body) ?? String(body));
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

export function toUpdateOptions(limits: ContainerUpdate): Record<string, unknown> {
  const opts: Record<string, unknown> = {};
  if (limits.cpus !== undefined) opts.NanoCpus = Math.round(limits.cpus * NANO_CPUS_PER_CPU);
  if (limits.memoryBytes !== undefined) opts.Memory = limits.memoryBytes;
  if (limits.swapBytes !== undefined) opts.MemorySwap = limits.swapBytes;
  if (limits.pidsLimit !== undefined) opts.PidsLimit = limits.pidsLimit;
  if (limits.restart !== undefined) opts.RestartPolicy = { Name: limits.restart };
  return opts;
}

interface EngineEvent {
  Type: string;
  Action: string;
  Actor: { ID: string; Attributes?: Record<string, string> };
  time: number;
  timeNano?: number;
}

/**
 * Docker sends one JSON object per line. Destroying the stream alone does not end a pending readline iterator,
 * so the interface is closed explicitly; both are needed to release the socket on abort or early exit.
 */
async function* readEvents(stream: Readable, signal?: AbortSignal): AsyncGenerator<RuntimeEvent> {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const stop = () => {
    lines.close();
    stream.destroy();
  };
  if (signal?.aborted) stop();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const ev = JSON.parse(line) as EngineEvent;
      yield {
        type: ev.Type,
        action: ev.Action,
        id: ev.Actor.ID,
        attributes: ev.Actor.Attributes ?? {},
        time: new Date(ev.time * 1000).toISOString(),
        timeNano: ev.timeNano ?? ev.time * 1_000_000_000,
      };
    }
  } finally {
    signal?.removeEventListener("abort", stop);
    stop();
  }
}

/** Memory and process limits for a helper. Each helper runs one short command, so both are small. */
const HELPER_MEMORY_BYTES = 256 * 1024 * 1024;
const HELPER_PIDS_LIMIT = 64;
/** Scratch space for a helper's `/tmp`. Nothing is run from it. */
const HELPER_TMPFS = "rw,noexec,nosuid,nodev,size=16m";

/**
 * Helper mounts use the Mounts form, and named volumes are NoCopy. Without it Docker copies the image's directory at the
 * target into an empty volume and takes that directory's owner and mode, so a helper at `/mnt` would reset a volume an
 * earlier helper had chowned.
 */
function helperMountOf(mount: Mount): Docker.MountSettings {
  const shared = { Target: mount.target, Source: mount.source, ReadOnly: mount.mode === "ro" };
  if (mount.kind === "bind") return { ...shared, Type: "bind" };
  // @types/dockerode also requires Labels and DriverConfig here; the engine accepts NoCopy alone.
  return { ...shared, Type: "volume", VolumeOptions: { NoCopy: true } } as Docker.MountSettings;
}

/**
 * The options for a helper container. It joins no network, has a read-only root filesystem and only the capabilities it
 * names, cannot gain privileges, and is capped on memory and processes. AutoRemove lets the engine delete it on exit.
 */
export function toHelperOptions(spec: HelperSpec, name: string): Docker.ContainerCreateOptions {
  const memory = spec.memoryBytes ?? HELPER_MEMORY_BYTES;
  const readonlyRoot = spec.readonlyRoot !== false;
  const hostConfig: Docker.HostConfig = {
    Mounts: (spec.mounts ?? []).map(helperMountOf),
    NetworkMode: spec.network ? "bridge" : "none",
    ReadonlyRootfs: readonlyRoot,
    Memory: memory,
    MemorySwap: memory,
    AutoRemove: true,
  };
  if (readonlyRoot) hostConfig.Tmpfs = { "/tmp": HELPER_TMPFS };
  applyHardening(hostConfig, {
    capDrop: ["ALL"],
    capAdd: spec.capAdd,
    noNewPrivileges: true,
    pidsLimit: spec.pidsLimit ?? HELPER_PIDS_LIMIT,
  });
  const opts: Docker.ContainerCreateOptions = { Image: spec.image, name, Cmd: spec.cmd, HostConfig: hostConfig };
  if (spec.user !== undefined) opts.User = spec.user;
  if (spec.labels !== undefined) opts.Labels = spec.labels;
  if (spec.env !== undefined) opts.Env = spec.env;
  return opts;
}

async function readAll(stream: AsyncIterable<Buffer | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Exit code of a helper that ran past its timeout and was killed. */
const HELPER_TIMEOUT_EXIT = 124;
/** Longest a helper is waited for to exit after a kill, or to be removed after it exited. */
const HELPER_SETTLE_MS = 10_000;

/** Resolves with the value, or with undefined when `ms` passes first. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function exitCodeOf(
  container: Docker.Container,
  exited: Promise<{ StatusCode?: number }>,
  timeoutMs: number,
): Promise<number> {
  const status = await within(exited, timeoutMs);
  if (status) return status.StatusCode ?? 1;
  await container.kill().catch(() => undefined);
  await within(exited, HELPER_SETTLE_MS).catch(() => undefined);
  return HELPER_TIMEOUT_EXIT;
}

/**
 * Runs a helper to completion. Output comes from an attach made before the container starts, and the exit is waited for
 * before it starts too: AutoRemove deletes the container as soon as it exits, so neither can be read afterwards. Once it
 * has started the engine removes it, even if this process goes away. Until then nothing does, so a failed start removes
 * it here. Returns after the removal, so a volume the helper used can be removed straight after.
 */
async function runHelper(docker: Docker, spec: HelperSpec): Promise<{ exitCode: number; logs: string }> {
  const name = `mbxhlp${randomBytes(4).toString("hex")}`;
  const created = await call(() => docker.createContainer(toHelperOptions(spec, name)));
  const container = docker.getContainer(created.id);
  let started = false;
  try {
    const attached = await call(() => container.attach({ stream: true, stdout: true, stderr: true }));
    const output = readAll(attached).catch(() => Buffer.alloc(0));
    const exited = call(() => container.wait({ condition: "next-exit" })) as Promise<{ StatusCode?: number }>;
    exited.catch(() => undefined);
    await call(() => container.start());
    started = true;
    const exitCode = await exitCodeOf(container, exited, (spec.timeoutSec ?? 30) * 1000);
    const logs = demuxLogs(await output);
    await within(
      call(() => container.wait({ condition: "removed" })).catch(() => undefined),
      HELPER_SETTLE_MS,
    );
    return { exitCode, logs };
  } catch (e) {
    if (started) await container.kill().catch(() => undefined);
    else await container.remove({ force: true }).catch(() => undefined);
    throw e;
  }
}

/** The only module that talks to the Docker Engine API. */
export function createDockerRuntime(socketPath: string): Runtime {
  const docker = new Docker({ socketPath });
  // The list has each container's state but not its limits, start time or network, which take one inspect per
  // container. An inspect is reused while the list reports the same state. Every change made through this adapter
  // clears the cache, so only a change made outside MiniBox can go unseen, and then for at most INSPECT_TTL_MS.
  const inspected = new Map<string, { state: string; at: number; info: ContainerInfo }>();
  let changes = 0;

  const mutate = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await call(fn);
    } finally {
      changes += 1;
      inspected.clear();
    }
  };

  async function inspectListed(
    id: string,
    state: string,
    signal: AbortSignal | undefined,
  ): Promise<ContainerInfo | null> {
    const hit = inspected.get(id);
    if (hit && hit.state === state && Date.now() - hit.at < INSPECT_TTL_MS) return hit.info;
    const generation = changes;
    try {
      const info = toContainerInfo(await call(() => docker.getContainer(id).inspect(withSignal({}, signal))));
      if (generation === changes) inspected.set(id, { state, at: Date.now(), info });
      return info;
    } catch (e) {
      if (isRuntimeError(e, "not_found")) return null;
      throw e;
    }
  }

  return {
    async ping() {
      await call(() => docker.ping());
    },

    async info() {
      const [info, version] = await call(() =>
        Promise.all([docker.info() as Promise<Record<string, unknown>>, docker.version()]),
      );
      return {
        version: version.Version ?? null,
        rootDir: (info.DockerRootDir as string) ?? null,
        containers: { running: Number(info.ContainersRunning ?? 0), total: Number(info.Containers ?? 0) },
        images: Number(info.Images ?? 0),
      };
    },

    async listContainers({ labels }, opts) {
      const signal = opts?.signal;
      const list = await call(() =>
        docker.listContainers(withSignal({ all: true, filters: { label: labelFilter(labels) } }, signal)),
      );
      const listed = new Set(list.map((c) => c.Id));
      for (const id of inspected.keys()) {
        if (!listed.has(id)) inspected.delete(id);
      }
      const infos = await Promise.all(list.map((c) => inspectListed(c.Id, c.State, signal)));
      return infos.filter((info): info is ContainerInfo => info !== null);
    },

    async inspectContainer(id, opts) {
      return toContainerInfo(await call(() => docker.getContainer(id).inspect(withSignal({}, opts?.signal))));
    },

    async createContainer(spec) {
      const container = await mutate(() => docker.createContainer(toCreateOptions(spec)));
      return { id: container.id };
    },

    async startContainer(id) {
      await mutate(() => ignore304(docker.getContainer(id).start()));
    },

    async stopContainer(id, { timeoutSec }) {
      await mutate(() => ignore304(docker.getContainer(id).stop({ t: timeoutSec })));
    },

    async restartContainer(id, { timeoutSec }) {
      await mutate(() => docker.getContainer(id).restart({ t: timeoutSec }));
    },

    async removeContainer(id, { force }) {
      await mutate(() => docker.getContainer(id).remove({ force }));
    },

    async renameContainer(id, name) {
      await mutate(() => docker.getContainer(id).rename({ name }));
    },

    async updateContainer(id, limits) {
      await mutate(() => docker.getContainer(id).update(toUpdateOptions(limits)));
    },

    async containerLogs(id, { tail, timestamps }) {
      const out = await call(() => docker.getContainer(id).logs({ stdout: true, stderr: true, tail, timestamps }));
      return demuxLogs(Buffer.isBuffer(out) ? out : Buffer.from(String(out)));
    },

    async containerDiff(id) {
      return parseChanges(await call(() => docker.getContainer(id).changes()));
    },

    async containerStats(id, opts) {
      // dockerode's typings omit abortSignal, which docker-modem forwards to the request. A missing key is left out
      // because the query string would otherwise carry `abortSignal=`.
      const options: { stream: false; abortSignal?: AbortSignal } = opts?.signal
        ? { stream: false, abortSignal: opts.signal }
        : { stream: false };
      const raw = (await call(() => docker.getContainer(id).stats(options))) as Docker.ContainerStats;
      return computeStats(raw);
    },

    async commitContainer(id, spec) {
      if (spec.signal?.aborted) throw abortError();
      await call(() => docker.getContainer(id).commit(toCommitOptions(spec)));
      if (spec.signal?.aborted) throw abortError();
    },

    async putArchive(id, path, tar) {
      await call(() => docker.getContainer(id).putArchive(tar, { path }));
    },

    async getArchive(id, path) {
      return call(async () => (await docker.getContainer(id).getArchive({ path })) as Readable);
    },

    async volumeRootOwner(containerId, path) {
      const stream = await call(() => docker.getContainer(containerId).getArchive({ path }) as Promise<Readable>);
      try {
        return await readFirstEntryOwner(stream);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        throw new RuntimeError("engine", `could not read the owner of ${path} in ${containerId}: ${reason}`);
      }
    },

    async setVolumeRootOwner(volume, owner, image) {
      await call(() => docker.getVolume(volume).inspect());
      // Inspecting first matters: a mount of a missing named volume makes the engine create it.
      let result: { exitCode: number; logs: string };
      try {
        result = await runHelper(docker, {
          image,
          cmd: ["chown", `${owner.uid}:${owner.gid}`, ROOT_OWNER_MOUNT],
          user: "0:0",
          capAdd: ["CHOWN"],
          mounts: [{ source: volume, target: ROOT_OWNER_MOUNT, mode: "rw" }],
        });
      } catch (e) {
        throw helperFailure(volume, e);
      }
      if (result.exitCode !== 0) {
        const output = result.logs.trim();
        const suffix = output ? `: ${output}` : "";
        throw new RuntimeError("engine", `chown of ${volume} exited with status ${result.exitCode}${suffix}`);
      }
    },

    async startExec(containerId, spec) {
      // Every exec runs through the wrapper, terminal included, so kill() can stop its process tree from inside the box.
      // Absent tty is the web terminal: one stream. Command exec sets tty false so stdout and stderr stay separate.
      const tty = spec.tty !== false;
      const token = randomBytes(8).toString("hex");
      const exec = await call(() =>
        docker.getContainer(containerId).exec({
          Cmd: ["/bin/sh", "-c", RUN_WRAPPER, "minibox-exec", token, ...spec.cmd],
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
          Tty: tty,
          Env: spec.env,
          WorkingDir: spec.workingDir,
          ...(spec.user ? { User: spec.user } : {}),
        }),
      );
      const stream = (await call(() => exec.start({ hijack: true, stdin: true, Tty: tty }))) as Duplex;
      const stdout = tty ? stream : new PassThrough();
      const stderr = new PassThrough();
      if (!tty) docker.modem.demuxStream(stream, stdout, stderr);
      const finishOutputs = () => {
        if (!tty && !stdout.writableEnded) stdout.end();
        if (!stderr.writableEnded) stderr.end();
      };
      stream.on("end", finishOutputs);
      stream.on("close", finishOutputs);
      return {
        id: exec.id,
        stream,
        stdout,
        stderr,
        async resize({ cols, rows }) {
          await call(() => docker.getExec(exec.id).resize({ h: rows, w: cols }));
        },
        async inspect() {
          const info = await call(() => docker.getExec(exec.id).inspect());
          return { running: info.Running, exitCode: info.ExitCode, pid: info.Pid || null };
        },
        async kill() {
          try {
            await stopExec(docker, containerId, exec.id, token, spec.stopAs ?? spec.user);
          } catch (e) {
            if (isRuntimeError(e, "engine")) throw e;
            throw engineFailure(exec.id, e instanceof Error ? e.message : String(e));
          }
        },
      };
    },

    async *events(filter, signal) {
      const filters: Record<string, string[]> = {};
      if (filter.labels) filters.label = labelFilter(filter.labels);
      if (filter.types) filters.type = filter.types;
      const options: { filters?: Record<string, string[]>; since?: number } = {};
      if (Object.keys(filters).length > 0) options.filters = filters;
      if (filter.since !== undefined) options.since = filter.since;
      const stream = (await call(() => docker.getEvents(options))) as Readable;
      yield* readEvents(stream, signal);
    },

    async listImages({ labels }) {
      const images = await call(() => docker.listImages({ filters: { label: labelFilter(labels) } }));
      return images.map((img) => ({
        id: img.Id,
        repoTags: img.RepoTags ?? [],
        labels: img.Labels ?? {},
        createdAt: new Date(img.Created * 1000).toISOString(),
        size: img.Size,
      }));
    },

    async inspectImage(ref) {
      const info = await call(() => docker.getImage(ref).inspect());
      return { id: info.Id, labels: info.Config?.Labels ?? {} };
    },

    async removeImage(ref, { force }) {
      await call(() => docker.getImage(ref).remove({ force }));
    },

    async buildImage(spec) {
      if (spec.signal?.aborted) throw abortError();
      return call(async () => {
        const stream = await docker.buildImage(
          { context: spec.contextDir, src: [spec.dockerfile] },
          { t: spec.tag, labels: spec.labels },
        );
        return await new Promise<string>((resolve, reject) => {
          let out = "";
          let settled = false;
          const finish = (error: unknown) => {
            if (settled) return;
            settled = true;
            spec.signal?.removeEventListener("abort", onAbort);
            if (error) reject(error);
            else resolve(out);
          };
          const onAbort = () => {
            const closable = stream as { destroy?: () => void; cancel?: () => void };
            // The engine keeps building until this connection closes, so the build has not ended before then.
            stream.once("close", () => finish(abortError()));
            closable.destroy?.();
            closable.cancel?.();
          };
          if (spec.signal) spec.signal.addEventListener("abort", onAbort, { once: true });
          docker.modem.followProgress(
            stream,
            (err: Error | null) => finish(spec.signal?.aborted ? abortError() : err),
            (ev: { stream?: string; error?: string }) => {
              if (ev.stream) {
                out += ev.stream;
                spec.onLog?.(ev.stream);
              }
              if (ev.error) finish(spec.signal?.aborted ? abortError() : new Error(ev.error));
            },
          );
        });
      });
    },

    async inspectVolume(name) {
      const info = await call(() => docker.getVolume(name).inspect());
      return volumeInfo(info);
    },

    async listVolumes() {
      const listed = await call(() => docker.listVolumes());
      return (listed.Volumes ?? []).map((info) => volumeInfo(info));
    },

    async createVolume(name, labels, opts) {
      try {
        await call(() =>
          docker.createVolume({
            Name: name,
            Labels: labels,
            Driver: opts?.driver,
            DriverOpts: opts?.driverOpts,
          }),
        );
      } catch (e) {
        // An existing volume keeps the labels and options it was created with.
        if (e instanceof RuntimeError && e.kind === "conflict") return;
        throw e;
      }
    },

    async removeVolume(name) {
      await call(() => docker.getVolume(name).remove());
    },

    async runHelper(spec) {
      return runHelper(docker, spec);
    },

    async diskUsage(path): Promise<DiskUsage> {
      try {
        const stat = statfsSync(path);
        return { totalBytes: stat.blocks * stat.bsize, freeBytes: stat.bavail * stat.bsize };
      } catch (e) {
        const code = typeof e === "object" && e !== null && "code" in e ? String(e.code) : "";
        if (code === "ENOENT") throw new RuntimeError("not_found", `path not found: ${path}`);
        throw new RuntimeError("engine", e instanceof Error ? e.message : String(e));
      }
    },

    async ensureBridgeNetwork(name, { interContainerComm }) {
      const existing = await inspectNetwork(docker, name);
      if (existing) {
        if (!bridgeMatches(existing, interContainerComm)) throw networkConflict(name, interContainerComm);
        return;
      }
      try {
        await call(() =>
          docker.createNetwork({
            Name: name,
            Driver: "bridge",
            Options: interContainerComm ? {} : { [ICC_OPTION]: "false" },
          }),
        );
      } catch (e) {
        if (!(e instanceof RuntimeError) || e.kind !== "conflict") throw e;
        // Another request created it between our inspect and create; accept it only if it matches.
        const created = await inspectNetwork(docker, name);
        if (!created || !bridgeMatches(created, interContainerComm)) throw networkConflict(name, interContainerComm);
      }
    },

    async reattachNetwork(containerId, name) {
      const info = await call(() => docker.getContainer(containerId).inspect());
      if (networkOf(info) !== name) {
        throw new RuntimeError("invalid", `container ${containerId} is not on network ${name}`);
      }
      const network = await inspectNetwork(docker, name);
      if (!network) throw new RuntimeError("not_found", `network ${name} not found`);
      const endpoint = info.NetworkSettings.Networks[name];
      if (endpoint?.NetworkID === network.Id) return;
      // The engine rejects a disconnect from a network the container has no endpoint on.
      if (endpoint) await mutate(() => docker.getNetwork(name).disconnect({ Container: containerId }));
      await mutate(() => docker.getNetwork(name).connect({ Container: containerId }));
    },
  };
}

/**
 * Stops an exec from inside its box, as `stopAs`. An exec that has already ended has nothing left to stop. Exit 0 from
 * the kill is trusted only once Docker reports the exec ended: a wrapper that is still running is an error, and the
 * exec stays running so that a retry can finish the job.
 */
async function stopExec(
  docker: Docker,
  containerId: string,
  execId: string,
  token: string,
  stopAs: string | undefined,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    if (!(await execRunning(docker, execId))) return;
    const code = await runKillScript(docker, containerId, token, stopAs);
    if (code === 0) {
      if (await waitForEnd(docker, execId, KILL_CONFIRM_MS)) return;
      throw engineFailure(execId, "its process was still running after the kill");
    }
    if (code === 2 && attempt < KILL_ATTEMPTS) {
      await sleep(KILL_RETRY_MS);
      continue;
    }
    throw engineFailure(execId, killFailure(code));
  }
}

function killFailure(code: number | null): string {
  if (code === 1) return "a process is still running or could not be signalled";
  if (code === 2) return "its process was not found";
  return "the kill did not finish";
}

function engineFailure(execId: string, reason: string): RuntimeError {
  return new RuntimeError("engine", `exec ${execId} could not be stopped: ${reason}`);
}

/** A raw engine exec, not `startExec`, so a kill is never wrapped or recorded as a command of its own. */
async function runKillScript(
  docker: Docker,
  containerId: string,
  token: string,
  stopAs: string | undefined,
): Promise<number | null> {
  const exec = await call(() =>
    docker.getContainer(containerId).exec({
      Cmd: ["/bin/sh", "-c", KILL_TREE_SCRIPT, "minibox-kill", token],
      AttachStdout: true,
      AttachStderr: true,
      ...(stopAs ? { User: stopAs } : {}),
    }),
  );
  const stream = (await call(() => exec.start({ hijack: true }))) as Duplex;
  stream.resume();
  await streamEnds(stream, KILL_STREAM_MS);
  return exitStatusOf(docker, exec.id);
}

/** An exec the engine no longer knows has ended. */
async function execRunning(docker: Docker, execId: string): Promise<boolean> {
  try {
    return (await call(() => docker.getExec(execId).inspect())).Running;
  } catch (e) {
    if (isRuntimeError(e, "not_found")) return false;
    throw e;
  }
}

/** Whether the exec ends within `ms`. */
async function waitForEnd(docker: Docker, execId: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (await execRunning(docker, execId)) {
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
  return true;
}

/** The exit code of an ended exec, or null if it is still running after KILL_EXIT_MS. */
async function exitStatusOf(docker: Docker, execId: string): Promise<number | null> {
  const deadline = Date.now() + KILL_EXIT_MS;
  for (;;) {
    const info = await call(() => docker.getExec(execId).inspect());
    if (!info.Running) return info.ExitCode;
    if (Date.now() >= deadline) return null;
    await sleep(50);
  }
}

/**
 * Resolves when the stream ends or fails, or after `ms`. The kill's output is discarded, so this only bounds the wait.
 */
function streamEnds(stream: Duplex, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      resolve();
    }
    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", finish);
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function inspectNetwork(docker: Docker, name: string): Promise<Docker.NetworkInspectInfo | undefined> {
  try {
    return await docker.getNetwork(name).inspect();
  } catch (e) {
    const err = toRuntimeError(e);
    if (err instanceof RuntimeError && err.kind === "not_found") return undefined;
    throw err;
  }
}
