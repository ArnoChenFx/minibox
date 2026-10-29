import type { Readable } from "node:stream";

import Docker from "dockerode";

import { stripSlash } from "../labels";
import { abortError } from "../lib/abort";
import {
  type ContainerMount,
  type ContainerInfo,
  type ContainerHardening,
  type CreateContainerSpec,
  type Mount,
  type CommitSpec,
  type ContainerChange,
  RuntimeError,
  type ContainerUpdate,
  isRuntimeError,
} from "../runtime";
import type { Runtime } from "../runtime";
import { call, withSignal, labelFilter, ignore304, type Engine } from "./engine";
import { boundLogBytes, demuxLogs, followFailure, followedLines } from "./logs";
import { computeStats } from "./stats";

const NANO_CPUS_PER_CPU = 1e9;

/** Longest a cached container inspect is reused when nothing MiniBox changed the container (see listContainers). */
const INSPECT_TTL_MS = 30_000;

/** The engine's `since` for logs: Unix seconds with a fraction. The engine rejects an RFC 3339 time here. */
function engineSince(since: Date): string {
  const ms = since.getTime();
  return `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, "0")}`;
}

/** The engine reports the default bridge as `default` in some API versions. */
export function networkOf(info: Docker.ContainerInspectInfo): string {
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

export function applyHardening(hostConfig: Docker.HostConfig, hardening: ContainerHardening): void {
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
  if (spec.mounts?.length) {
    // NoCopy needs the Mounts form; mix with Binds only when every mount can stay on the bind string.
    if (spec.mounts.some((mount) => mount.noCopy)) {
      hostConfig.Mounts = spec.mounts.map((mount) => createMountOf(mount));
    } else {
      hostConfig.Binds = spec.mounts.map((mount) => bindOf(mount));
    }
  }
  if (spec.restart) hostConfig.RestartPolicy = { Name: spec.restart };
  if (spec.cpus !== undefined) hostConfig.NanoCpus = Math.round(spec.cpus * NANO_CPUS_PER_CPU);
  if (spec.memoryBytes !== undefined) hostConfig.Memory = spec.memoryBytes;
  if (spec.swapBytes !== undefined) hostConfig.MemorySwap = spec.swapBytes;
  if (spec.init !== undefined) hostConfig.Init = spec.init;
  if (spec.network !== undefined) hostConfig.NetworkMode = spec.network;
  if (spec.readonlyRootfs) hostConfig.ReadonlyRootfs = true;
  if (spec.tmpfs) hostConfig.Tmpfs = spec.tmpfs;
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

function bindOf(mount: Mount): string {
  const mode = mount.mode === "ro" ? ":ro" : "";
  return `${mount.source}:${mount.target}${mode}`;
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
function parseChanges(body: unknown): ContainerChange[] {
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

function toUpdateOptions(limits: ContainerUpdate): Record<string, unknown> {
  const opts: Record<string, unknown> = {};
  if (limits.cpus !== undefined) opts.NanoCpus = Math.round(limits.cpus * NANO_CPUS_PER_CPU);
  if (limits.memoryBytes !== undefined) opts.Memory = limits.memoryBytes;
  if (limits.swapBytes !== undefined) opts.MemorySwap = limits.swapBytes;
  if (limits.pidsLimit !== undefined) opts.PidsLimit = limits.pidsLimit;
  if (limits.restart !== undefined) opts.RestartPolicy = { Name: limits.restart };
  return opts;
}

/** Mounts form for `createContainer`. Named volumes with `noCopy` match helpers; binds stay Type=bind. */
function createMountOf(mount: Mount): Docker.MountSettings {
  const shared = { Target: mount.target, Source: mount.source, ReadOnly: mount.mode === "ro" };
  if (mount.kind === "bind") return { ...shared, Type: "bind" };
  if (mount.noCopy) {
    return { ...shared, Type: "volume", VolumeOptions: { NoCopy: true } } as Docker.MountSettings;
  }
  return { ...shared, Type: "volume" };
}

type ContainerMethods = Pick<
  Runtime,
  | "listContainers"
  | "inspectContainer"
  | "inspectEnv"
  | "createContainer"
  | "startContainer"
  | "stopContainer"
  | "restartContainer"
  | "pauseContainer"
  | "unpauseContainer"
  | "removeContainer"
  | "renameContainer"
  | "updateContainer"
  | "containerLogs"
  | "followLogs"
  | "containerDiff"
  | "containerStats"
  | "commitContainer"
>;

export function containerMethods(engine: Engine): ContainerMethods {
  const { docker, mutate, inspected } = engine;

  async function inspectListed(
    id: string,
    state: string,
    signal: AbortSignal | undefined,
  ): Promise<ContainerInfo | null> {
    const hit = inspected.get(id);
    if (hit && hit.state === state && Date.now() - hit.at < INSPECT_TTL_MS) return hit.info;
    const generation = engine.changes;
    try {
      const info = toContainerInfo(await call(() => docker.getContainer(id).inspect(withSignal({}, signal))));
      if (generation === engine.changes) inspected.set(id, { state, at: Date.now(), info });
      return info;
    } catch (e) {
      if (isRuntimeError(e, "not_found")) return null;
      throw e;
    }
  }
  return {
    async listContainers({ labels }, opts) {
      const signal = opts?.signal;
      const list = await call(() =>
        docker.listContainers(withSignal({ all: true, filters: { label: labelFilter(labels) } }, signal)),
      );
      const listed = new Set(list.map((c) => c.Id));
      for (const id of inspected.keys()) {
        if (!listed.has(id)) inspected.delete(id);
      }
      const infos: Array<ContainerInfo | null> = Array.from({ length: list.length }, () => null);
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(12, list.length) }, async () => {
          while (next < list.length) {
            signal?.throwIfAborted();
            const index = next++;
            const c = list[index];
            if (c) infos[index] = await inspectListed(c.Id, c.State, signal);
          }
        }),
      );
      return infos.filter((info): info is ContainerInfo => info !== null);
    },

    async inspectContainer(id, opts) {
      return toContainerInfo(await call(() => docker.getContainer(id).inspect(withSignal({}, opts?.signal))));
    },

    async inspectEnv(id) {
      const info = await call(() => docker.getContainer(id).inspect());
      return info.Config?.Env ?? [];
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

    async pauseContainer(id) {
      await mutate(() => docker.getContainer(id).pause());
    },

    async unpauseContainer(id) {
      // The engine answers 500 to an unpause of a running container, so the state is read first.
      const info = await call(() => docker.getContainer(id).inspect());
      if (!info.State.Paused) return;
      await mutate(() => docker.getContainer(id).unpause());
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
      return boundLogBytes(demuxLogs(Buffer.isBuffer(out) ? out : Buffer.from(String(out))));
    },

    async *followLogs(id, { tail, timestamps, since, signal }) {
      let stream: Readable;
      try {
        stream = (await call(() =>
          docker.getContainer(id).logs(
            withSignal<Docker.ContainerLogsOptions & { follow: true }>(
              {
                follow: true,
                stdout: true,
                stderr: true,
                tail,
                timestamps,
                ...(since ? { since: engineSince(since) } : {}),
              },
              signal,
            ),
          ),
        )) as Readable;
      } catch (e) {
        if (signal?.aborted) return;
        throw followFailure(e);
      }
      yield* followedLines(stream, signal);
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
  };
}
