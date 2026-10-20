import { createInterface } from "node:readline";
import type { Duplex, Readable } from "node:stream";

import Docker from "dockerode";

import { stripSlash } from "../labels";
import type { CommitSpec, ContainerInfo, CreateContainerSpec, Runtime, RuntimeEvent } from "../runtime";
import { toRuntimeError } from "./errors";
import { demuxLogs } from "./logs";
import { computeStats } from "./stats";

const NANO_CPUS_PER_CPU = 1e9;

/** Engine errors become RuntimeError; anything else passes through untouched. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
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

function toContainerInfo(info: Docker.ContainerInspectInfo): ContainerInfo {
  const started = info.State.StartedAt;
  return {
    id: info.Id,
    name: stripSlash(info.Name),
    image: info.Config.Image,
    labels: info.Config?.Labels ?? {},
    created: info.Created,
    state: info.State.Status,
    running: info.State.Running,
    startedAt: started && !started.startsWith("0001") ? started : null,
    cpus: info.HostConfig?.NanoCpus ? info.HostConfig.NanoCpus / NANO_CPUS_PER_CPU : null,
    memoryBytes: info.HostConfig?.Memory || null,
  };
}

/** Only set the keys that are present: dockerode serialises `undefined` as an empty query parameter. */
function toCreateOptions(spec: CreateContainerSpec): Docker.ContainerCreateOptions {
  const hostConfig: Docker.HostConfig = {};
  if (spec.mounts) hostConfig.Binds = spec.mounts.map((m) => `${m.source}:${m.target}`);
  if (spec.restart) hostConfig.RestartPolicy = { Name: spec.restart };
  if (spec.cpus !== undefined) hostConfig.NanoCpus = Math.round(spec.cpus * NANO_CPUS_PER_CPU);
  if (spec.memoryBytes !== undefined) hostConfig.Memory = spec.memoryBytes;
  if (spec.swapBytes !== undefined) hostConfig.MemorySwap = spec.swapBytes;
  if (spec.init !== undefined) hostConfig.Init = spec.init;

  const opts: Docker.ContainerCreateOptions = { Image: spec.image };
  if (spec.name !== undefined) opts.name = spec.name;
  if (spec.cmd !== undefined) opts.Cmd = spec.cmd;
  if (spec.workingDir !== undefined) opts.WorkingDir = spec.workingDir;
  if (spec.hostname !== undefined) opts.Hostname = spec.hostname;
  if (spec.labels !== undefined) opts.Labels = spec.labels;
  if (Object.keys(hostConfig).length > 0) opts.HostConfig = hostConfig;
  return opts;
}

function toCommitOptions(spec: CommitSpec): Record<string, unknown> {
  const opts: Record<string, unknown> = { repo: spec.repo, tag: spec.tag, changes: spec.changes };
  if (spec.comment !== undefined) opts.comment = spec.comment;
  if (spec.author !== undefined) opts.author = spec.author;
  if (spec.pause !== undefined) opts.pause = spec.pause;
  return opts;
}

function toUpdateOptions(limits: { cpus?: number; memoryBytes?: number; swapBytes?: number }): Record<string, number> {
  const opts: Record<string, number> = {};
  if (limits.cpus !== undefined) opts.NanoCpus = Math.round(limits.cpus * NANO_CPUS_PER_CPU);
  if (limits.memoryBytes !== undefined) opts.Memory = limits.memoryBytes;
  if (limits.swapBytes !== undefined) opts.MemorySwap = limits.swapBytes;
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
      const infos = await Promise.all(
        list.map(async (c) => {
          try {
            return toContainerInfo(await docker.getContainer(c.Id).inspect());
          } catch {
            return null;
          }
        }),
      );
      return infos.filter((info): info is ContainerInfo => info !== null);
    },

    async inspectContainer(id) {
      return toContainerInfo(await call(() => docker.getContainer(id).inspect()));
    },

    async createContainer(spec) {
      const container = await call(() => docker.createContainer(toCreateOptions(spec)));
      return { id: container.id };
    },

    async startContainer(id) {
      await call(() => ignore304(docker.getContainer(id).start()));
    },

    async stopContainer(id, { timeoutSec }) {
      await call(() => ignore304(docker.getContainer(id).stop({ t: timeoutSec })));
    },

    async restartContainer(id, { timeoutSec }) {
      await call(() => docker.getContainer(id).restart({ t: timeoutSec }));
    },

    async removeContainer(id, { force }) {
      await call(() => docker.getContainer(id).remove({ force }));
    },

    async renameContainer(id, name) {
      await call(() => docker.getContainer(id).rename({ name }));
    },

    async updateContainer(id, limits) {
      await call(() => docker.getContainer(id).update(toUpdateOptions(limits)));
    },

    async containerLogs(id, { tail, timestamps }) {
      const out = await call(() => docker.getContainer(id).logs({ stdout: true, stderr: true, tail, timestamps }));
      return demuxLogs(Buffer.isBuffer(out) ? out : Buffer.from(String(out)));
    },

    async containerStats(id) {
      const raw = (await call(() => docker.getContainer(id).stats({ stream: false }))) as Docker.ContainerStats;
      return computeStats(raw);
    },

    async commitContainer(id, spec) {
      await call(() => docker.getContainer(id).commit(toCommitOptions(spec)));
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

    async buildImage({ contextDir, dockerfile, tag, labels }) {
      return call(async () => {
        const stream = await docker.buildImage({ context: contextDir, src: [dockerfile] }, { t: tag, labels });
        return new Promise<string>((resolve, reject) => {
          let out = "";
          docker.modem.followProgress(
            stream,
            (err: Error | null) => (err ? reject(err) : resolve(out)),
            (ev: { stream?: string; error?: string }) => {
              if (ev.stream) out += ev.stream;
              if (ev.error) reject(new Error(ev.error));
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
  };
}
