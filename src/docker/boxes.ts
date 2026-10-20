import type Docker from "dockerode";
import { containerName, parseBoxLabels, stripSlash, volumeName } from "../labels";
import { badRequest, conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import type { CreateBoxInput } from "../lib/validation";
import { type DockerCtx, ignore304 } from "./client";
import { type BoxStats, getContainerStats } from "./stats";

export interface Box {
  id: string;
  name: string;
  state: string;
  status: string;
  running: boolean;
  image: string;
  template: string;
  cpus: number | null;
  memory: number | null;
  createdAt: string;
  startedAt: string | null;
  volume: string;
  stats?: BoxStats | null;
}

function toBox(ctx: DockerCtx, info: Docker.ContainerInspectInfo): Box {
  const labels = parseBoxLabels(info.Config?.Labels, ctx.keys);
  const name = labels.name ?? stripSlash(info.Name);
  const started = info.State.StartedAt;
  return {
    id: info.Id,
    name,
    state: info.State.Status,
    status: info.State.Status,
    running: info.State.Running,
    image: info.Config.Image,
    template: labels.template,
    cpus: info.HostConfig?.NanoCpus ? info.HostConfig.NanoCpus / 1e9 : null,
    memory: info.HostConfig?.Memory || null,
    createdAt: labels.created ?? info.Created,
    startedAt: started && !started.startsWith("0001") ? started : null,
    volume: volumeName(ctx.prefix, name),
  };
}

/** Inspect a container and assert it is a MiniBox box. */
export async function getBox(ctx: DockerCtx, id: string): Promise<Box> {
  let info: Docker.ContainerInspectInfo;
  try {
    info = await ctx.docker.getContainer(id).inspect();
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode === 404) throw notFound("找不到该 Box。");
    throw e;
  }
  if (!parseBoxLabels(info.Config?.Labels, ctx.keys).isBox) throw notFound("找不到该 Box。");
  return toBox(ctx, info);
}

export async function listBoxes(ctx: DockerCtx, opts: { withStats?: boolean } = {}): Promise<Box[]> {
  const list = await ctx.docker.listContainers({ all: true, filters: { label: [`${ctx.keys.box}=true`] } });
  const boxes = await Promise.all(
    list.map(async (c) => {
      try {
        const box = toBox(ctx, await ctx.docker.getContainer(c.Id).inspect());
        if (opts.withStats) {
          box.stats = box.running ? await getContainerStats(ctx.docker, c.Id).catch(() => null) : null;
        }
        return box;
      } catch {
        return null;
      }
    }),
  );
  return boxes.filter((b): b is Box => b !== null).sort((a, b) => a.name.localeCompare(b.name));
}

async function ensureImage(ctx: DockerCtx, image: string): Promise<void> {
  try {
    await ctx.docker.getImage(image).inspect();
  } catch {
    throw badRequest(`模板镜像 ${image} 不存在，请先在「模板」页构建或选择其他模板。`, { field: "template" });
  }
}

export async function createBox(ctx: DockerCtx, input: CreateBoxInput & { templateLabel?: string }): Promise<Box> {
  const image = input.image ?? ctx.baseTemplateTag;
  const existing = await listBoxes(ctx);
  if (existing.some((b) => b.name === input.name)) throw conflict(`名为「${input.name}」的 Box 已存在。`);
  await ensureImage(ctx, image);

  const volume = volumeName(ctx.prefix, input.name);
  try {
    await ctx.docker.getVolume(volume).inspect();
  } catch {
    await ctx.docker.createVolume({ Name: volume, Labels: { [ctx.keys.box]: "true", [ctx.keys.name]: input.name } });
  }

  const container = await ctx.docker.createContainer({
    name: containerName(ctx.prefix, input.name),
    Image: image,
    Cmd: ["sleep", "infinity"],
    WorkingDir: "/workspace",
    Hostname: input.name.slice(0, 63),
    Labels: {
      [ctx.keys.box]: "true",
      [ctx.keys.name]: input.name,
      [ctx.keys.template]: input.templateLabel ?? image,
      [ctx.keys.created]: new Date().toISOString(),
    },
    HostConfig: {
      Binds: [`${volume}:/workspace`],
      RestartPolicy: { Name: "unless-stopped" },
      NanoCpus: Math.round(input.cpus * 1e9),
      Memory: input.memoryMb * 1024 * 1024,
      MemorySwap: input.memoryMb * 1024 * 1024,
      Init: true,
    },
  });
  await container.start();
  log.info("box.created", { name: input.name, image, cpus: input.cpus, memoryMb: input.memoryMb });
  return getBox(ctx, container.id);
}

export async function startBox(ctx: DockerCtx, id: string): Promise<Box> {
  await getBox(ctx, id);
  await ignore304(ctx.docker.getContainer(id).start());
  return getBox(ctx, id);
}

export async function stopBox(ctx: DockerCtx, id: string): Promise<Box> {
  await getBox(ctx, id);
  await ignore304(ctx.docker.getContainer(id).stop({ t: 3 }));
  return getBox(ctx, id);
}

export async function restartBox(ctx: DockerCtx, id: string): Promise<Box> {
  await getBox(ctx, id);
  await ctx.docker.getContainer(id).restart({ t: 3 });
  return getBox(ctx, id);
}

export async function deleteBox(
  ctx: DockerCtx,
  id: string,
  deleteVolume: boolean,
): Promise<{ name: string; volumeDeleted: boolean }> {
  const box = await getBox(ctx, id);
  await ctx.docker.getContainer(id).remove({ force: true });
  let volumeDeleted = false;
  if (deleteVolume) {
    try {
      await ctx.docker.getVolume(box.volume).remove();
      volumeDeleted = true;
    } catch (e) {
      log.warn("box.volume_remove_failed", { volume: box.volume, error: String(e) });
    }
  }
  log.info("box.deleted", { name: box.name, volumeDeleted });
  return { name: box.name, volumeDeleted };
}

export async function updateResources(
  ctx: DockerCtx,
  id: string,
  res: { cpus?: number; memoryMb?: number },
): Promise<Box> {
  await getBox(ctx, id);
  const update: Record<string, number> = {};
  if (res.cpus !== undefined) update.NanoCpus = Math.round(res.cpus * 1e9);
  if (res.memoryMb !== undefined) {
    update.Memory = res.memoryMb * 1024 * 1024;
    update.MemorySwap = update.Memory;
  }
  await ctx.docker.getContainer(id).update(update);
  return getBox(ctx, id);
}

/** Strip Docker's 8-byte multiplexing headers from a non-TTY log stream. */
export function demuxLogs(buf: Buffer): string {
  const first = buf[0];
  if (buf.length >= 8 && first !== undefined && first <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0) {
    const chunks: string[] = [];
    let i = 0;
    while (i + 8 <= buf.length) {
      const size = buf.readUInt32BE(i + 4);
      i += 8;
      chunks.push(buf.subarray(i, i + size).toString("utf8"));
      i += size;
    }
    return chunks.join("");
  }
  return buf.toString("utf8");
}

export async function getLogs(ctx: DockerCtx, id: string, tail: number): Promise<string> {
  await getBox(ctx, id);
  const out = await ctx.docker.getContainer(id).logs({ stdout: true, stderr: true, tail, timestamps: true });
  return demuxLogs(Buffer.isBuffer(out) ? out : Buffer.from(String(out)));
}

export async function getStats(ctx: DockerCtx, id: string): Promise<BoxStats | null> {
  const box = await getBox(ctx, id);
  return box.running ? getContainerStats(ctx.docker, id) : null;
}
