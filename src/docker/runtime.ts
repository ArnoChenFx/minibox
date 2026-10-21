import { createInterface } from "node:readline";
import type { Duplex, Readable } from "node:stream";

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
  isRuntimeError,
  type Runtime,
  type RuntimeEvent,
  RuntimeError,
} from "../runtime";
import { toRuntimeError } from "./errors";
import { demuxLogs } from "./logs";
import { computeStats } from "./stats";

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
    network: networkOf(info),
  };
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
  if (spec.mounts) {
    hostConfig.Binds = spec.mounts.map((m) => `${m.source}:${m.target}${m.mode === "ro" ? ":ro" : ""}`);
  }
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
  if (spec.labels !== undefined) opts.Labels = spec.labels;
  if (spec.env !== undefined) opts.Env = spec.env;
  if (Object.keys(hostConfig).length > 0) opts.HostConfig = hostConfig;
  return opts;
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
      };
    }
  } finally {
    signal?.removeEventListener("abort", stop);
    stop();
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

  async function inspectListed(id: string, state: string): Promise<ContainerInfo | null> {
    const hit = inspected.get(id);
    if (hit && hit.state === state && Date.now() - hit.at < INSPECT_TTL_MS) return hit.info;
    const generation = changes;
    try {
      const info = toContainerInfo(await call(() => docker.getContainer(id).inspect()));
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

    async listContainers({ labels }) {
      const list = await call(() => docker.listContainers({ all: true, filters: { label: labelFilter(labels) } }));
      const listed = new Set(list.map((c) => c.Id));
      for (const id of inspected.keys()) {
        if (!listed.has(id)) inspected.delete(id);
      }
      const infos = await Promise.all(list.map((c) => inspectListed(c.Id, c.State)));
      return infos.filter((info): info is ContainerInfo => info !== null);
    },

    async inspectContainer(id) {
      return toContainerInfo(await call(() => docker.getContainer(id).inspect()));
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

    async containerStats(id) {
      const raw = (await call(() => docker.getContainer(id).stats({ stream: false }))) as Docker.ContainerStats;
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

    async startExec(containerId, spec) {
      const exec = await call(() =>
        docker.getContainer(containerId).exec({
          Cmd: spec.cmd,
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
          Tty: true,
          Env: spec.env,
          WorkingDir: spec.workingDir,
        }),
      );
      const stream = (await call(() => exec.start({ hijack: true, stdin: true, Tty: true }))) as Duplex;
      return {
        id: exec.id,
        stream,
        async resize({ cols, rows }) {
          await call(() => docker.getExec(exec.id).resize({ h: rows, w: cols }));
        },
        async inspect() {
          const info = await call(() => docker.getExec(exec.id).inspect());
          return { running: info.Running, exitCode: info.ExitCode, pid: info.Pid || null };
        },
      };
    },

    async *events(filter, signal) {
      const filters: Record<string, string[]> = {};
      if (filter.labels) filters.label = labelFilter(filter.labels);
      if (filter.types) filters.type = filter.types;
      const options = Object.keys(filters).length > 0 ? { filters } : {};
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
            closable.destroy?.();
            closable.cancel?.();
            finish(abortError());
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
      return { name: info.Name, labels: info.Labels ?? {} };
    },

    async createVolume(name, labels) {
      await call(() => docker.createVolume({ Name: name, Labels: labels }));
    },

    async removeVolume(name) {
      await call(() => docker.getVolume(name).remove());
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

async function inspectNetwork(docker: Docker, name: string): Promise<Docker.NetworkInspectInfo | undefined> {
  try {
    return await docker.getNetwork(name).inspect();
  } catch (e) {
    const err = toRuntimeError(e);
    if (err instanceof RuntimeError && err.kind === "not_found") return undefined;
    throw err;
  }
}
