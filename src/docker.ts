import Docker from "dockerode";
import { join } from "path";
import { ROOT } from "./auth";

export const docker = new Docker({ socketPath: "/var/run/docker.sock" });

const LABEL_BOX = "minibox";
const LABEL_NAME = "minibox.name";
const LABEL_TEMPLATE = "minibox.template";
const LABEL_TEMPLATE_NAME = "minibox.template.name";
const LABEL_TEMPLATE_DESC = "minibox.template.description";
const LABEL_SNAPSHOT = "minibox.snapshot";
const LABEL_SNAPSHOT_OF = "minibox.snapshot.of";
const LABEL_CREATED = "minibox.created";

export const BASE_TEMPLATE_TAG = "minibox-template:base";
export const BASE_TEMPLATE_DIR = join(ROOT, "templates/base");

function volName(boxName: string) {
  return `minibox-ws-${boxName}`;
}

function parseNanoCpus(info: Docker.ContainerInspectInfo): number | null {
  const n = info.HostConfig?.NanoCpus;
  if (!n) return null;
  return n / 1e9;
}

function parseMemory(info: Docker.ContainerInspectInfo): number | null {
  const m = info.HostConfig?.Memory;
  if (!m) return null;
  return m;
}

export type BoxSummary = {
  id: string;
  name: string;
  status: string;
  state: string;
  image: string;
  template: string;
  cpus: number | null;
  memory: number | null;
  created: string;
  volume: string;
};

export async function listBoxes(): Promise<BoxSummary[]> {
  const containers = await docker.listContainers({
    all: true,
    filters: { label: [`${LABEL_BOX}=true`] },
  });
  return containers.map((c) => {
    const name = (c.Labels?.[LABEL_NAME] || c.Names?.[0]?.replace(/^\//, "") || c.Id.slice(0, 12)).toString();
    return {
      id: c.Id,
      name,
      status: c.Status,
      state: c.State,
      image: c.Image,
      template: c.Labels?.[LABEL_TEMPLATE] || "",
      cpus: null,
      memory: null,
      created: c.Labels?.[LABEL_CREATED] || new Date(c.Created * 1000).toISOString(),
      volume: volName(name),
    };
  });
}

export async function inspectBox(id: string) {
  const c = docker.getContainer(id);
  const info = await c.inspect();
  if (info.Config?.Labels?.[LABEL_BOX] !== "true") {
    throw Object.assign(new Error("不是 minibox 容器"), { status: 404 });
  }
  const name = info.Config.Labels[LABEL_NAME] || info.Name.replace(/^\//, "");
  return {
    id: info.Id,
    name,
    status: info.State.Status,
    state: info.State.Status,
    running: info.State.Running,
    image: info.Config.Image,
    template: info.Config.Labels[LABEL_TEMPLATE] || "",
    cpus: parseNanoCpus(info),
    memory: parseMemory(info),
    created: info.Config.Labels[LABEL_CREATED] || info.Created,
    volume: volName(name),
    startedAt: info.State.StartedAt,
    finishedAt: info.State.FinishedAt,
  };
}

export async function createBox(opts: {
  name: string;
  template: string;
  cpus?: number;
  memoryMb?: number;
  fromImage?: string;
}) {
  const name = opts.name.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(name)) {
    throw Object.assign(new Error("名称只能含字母数字._-，且以字母数字开头"), { status: 400 });
  }
  const existing = await listBoxes();
  if (existing.some((b) => b.name === name)) {
    throw Object.assign(new Error("同名 box 已存在"), { status: 409 });
  }

  const image = opts.fromImage || opts.template;
  const volume = volName(name);
  // ensure volume
  try {
    await docker.getVolume(volume).inspect();
  } catch {
    await docker.createVolume({ Name: volume, Labels: { [LABEL_BOX]: "true", [LABEL_NAME]: name } });
  }

  const hostConfig: Docker.ContainerCreateOptions["HostConfig"] = {
    Binds: [`${volume}:/workspace`],
    RestartPolicy: { Name: "unless-stopped" },
  };
  if (opts.cpus && opts.cpus > 0) hostConfig.NanoCpus = Math.round(opts.cpus * 1e9);
  if (opts.memoryMb && opts.memoryMb > 0) hostConfig.Memory = opts.memoryMb * 1024 * 1024;

  const container = await docker.createContainer({
    name: `minibox-${name}`,
    Image: image,
    Cmd: ["sleep", "infinity"],
    WorkingDir: "/workspace",
    Labels: {
      [LABEL_BOX]: "true",
      [LABEL_NAME]: name,
      [LABEL_TEMPLATE]: opts.template,
      [LABEL_CREATED]: new Date().toISOString(),
    },
    HostConfig: hostConfig,
  });
  await container.start();
  return inspectBox(container.id);
}

export async function startBox(id: string) {
  await inspectBox(id);
  await docker.getContainer(id).start();
  return inspectBox(id);
}

export async function stopBox(id: string) {
  await inspectBox(id);
  try {
    await docker.getContainer(id).stop({ t: 10 });
  } catch (e: any) {
    if (e.statusCode !== 304) throw e;
  }
  return inspectBox(id);
}

export async function restartBox(id: string) {
  await inspectBox(id);
  await docker.getContainer(id).restart({ t: 10 });
  return inspectBox(id);
}

export async function deleteBox(id: string, deleteVolume = false) {
  const box = await inspectBox(id);
  const c = docker.getContainer(id);
  try {
    await c.stop({ t: 5 });
  } catch {}
  await c.remove({ force: true });
  if (deleteVolume) {
    try {
      await docker.getVolume(box.volume).remove();
    } catch (e: any) {
      // volume may be in use or missing
    }
  }
  return { ok: true, name: box.name, volumeDeleted: deleteVolume };
}

export async function updateResources(id: string, opts: { cpus?: number; memoryMb?: number }) {
  await inspectBox(id);
  const update: Record<string, number> = {};
  if (opts.cpus != null && opts.cpus > 0) update.NanoCpus = Math.round(opts.cpus * 1e9);
  if (opts.memoryMb != null && opts.memoryMb > 0) update.Memory = opts.memoryMb * 1024 * 1024;
  if (Object.keys(update).length === 0) {
    throw Object.assign(new Error("需要提供 cpus 或 memoryMb"), { status: 400 });
  }
  await docker.getContainer(id).update(update as any);
  return inspectBox(id);
}

export async function getLogs(id: string, tail = 200): Promise<string> {
  await inspectBox(id);
  const buf = await docker.getContainer(id).logs({
    stdout: true,
    stderr: true,
    tail,
    timestamps: true,
  });
  // dockerode may return Buffer with multiplexed stream header
  return demuxLogs(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)));
}

function demuxLogs(buf: Buffer): string {
  // If multiplexed (8-byte headers), strip them; else return utf8
  if (buf.length >= 8 && buf[0] <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0) {
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

export async function getStats(id: string) {
  await inspectBox(id);
  const raw = await docker.getContainer(id).stats({ stream: false });
  const cpuDelta = raw.cpu_stats.cpu_usage.total_usage - raw.precpu_stats.cpu_usage.total_usage;
  const systemDelta = (raw.cpu_stats.system_cpu_usage || 0) - (raw.precpu_stats.system_cpu_usage || 0);
  const online = raw.cpu_stats.online_cpus || raw.cpu_stats.cpu_usage.percpu_usage?.length || 1;
  let cpuPercent = 0;
  if (systemDelta > 0 && cpuDelta > 0) {
    cpuPercent = (cpuDelta / systemDelta) * online * 100;
  }
  const memUsage = raw.memory_stats.usage || 0;
  const memLimit = raw.memory_stats.limit || 0;
  return {
    cpuPercent: Math.round(cpuPercent * 100) / 100,
    memUsage,
    memLimit,
    memPercent: memLimit ? Math.round((memUsage / memLimit) * 10000) / 100 : 0,
  };
}

export async function snapshotBox(id: string, snapName?: string) {
  const box = await inspectBox(id);
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const tag = `minibox-snap:${snapName || box.name}-${ts}`;
  const img = await docker.getContainer(id).commit({
    repo: tag.split(":")[0],
    tag: tag.split(":")[1],
    comment: `snapshot of ${box.name}`,
    author: "minibox",
    changes: [
      `LABEL ${LABEL_SNAPSHOT}=true`,
      `LABEL ${LABEL_SNAPSHOT_OF}=${box.name}`,
      `LABEL ${LABEL_CREATED}=${new Date().toISOString()}`,
      `LABEL ${LABEL_NAME}=${snapName || box.name}`,
      `CMD [\"sleep\",\"infinity\"]`,
    ],
  } as any);
  return { id: img.Id || (img as any).id, tag, of: box.name };
}

export type ImageItem = {
  id: string;
  tags: string[];
  created: number;
  size: number;
  labels: Record<string, string>;
};

export async function listSnapshots(): Promise<ImageItem[]> {
  const images = await docker.listImages({ filters: { label: [`${LABEL_SNAPSHOT}=true`] } });
  return images.map((img) => ({
    id: img.Id,
    tags: img.RepoTags || [],
    created: img.Created,
    size: img.Size,
    labels: img.Labels || {},
  }));
}

export async function listTemplates(): Promise<ImageItem[]> {
  const images = await docker.listImages({ filters: { label: [`${LABEL_TEMPLATE}=true`] } });
  return images.map((img) => ({
    id: img.Id,
    tags: img.RepoTags || [],
    created: img.Created,
    size: img.Size,
    labels: img.Labels || {},
  }));
}

export async function deleteImage(idOrTag: string) {
  await docker.getImage(idOrTag).remove({ force: true });
  return { ok: true };
}

export async function promoteSnapshot(idOrTag: string, templateName: string) {
  const name = templateName.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(name)) {
    throw Object.assign(new Error("模板名不合法"), { status: 400 });
  }
  const tag = `minibox-template:${name}`;
  // tag the image, then we need labels — commit from a temp container is heavy;
  // use docker tag + build a tiny Dockerfile FROM the snapshot with LABELs
  const img = docker.getImage(idOrTag);
  await img.tag({ repo: "minibox-template", tag: name });
  // Ensure template labels via a no-op commit rebuild
  const tmp = await docker.createContainer({
    Image: tag,
    Cmd: ["true"],
    Labels: {
      [LABEL_TEMPLATE]: "true",
      [LABEL_TEMPLATE_NAME]: name,
      [LABEL_TEMPLATE_DESC]: `从快照提升: ${idOrTag}`,
      [LABEL_BOX]: "false",
    },
  });
  try {
    await tmp.commit({
      repo: "minibox-template",
      tag: name,
      changes: [
        `LABEL ${LABEL_TEMPLATE}=true`,
        `LABEL ${LABEL_TEMPLATE_NAME}=${name}`,
        `LABEL ${LABEL_TEMPLATE_DESC}=promoted-from-snapshot`,
        `CMD [\"sleep\",\"infinity\"]`,
      ],
    } as any);
  } finally {
    await tmp.remove({ force: true });
  }
  return { tag, name };
}

export async function buildBaseTemplate(): Promise<{ tag: string; stream: string }> {
  const stream = await docker.buildImage(
    {
      context: BASE_TEMPLATE_DIR,
      src: ["Dockerfile"],
    },
    {
      t: BASE_TEMPLATE_TAG,
      labels: {
        [LABEL_TEMPLATE]: "true",
        [LABEL_TEMPLATE_NAME]: "base",
        [LABEL_TEMPLATE_DESC]: "Debian + Node 24 + git/curl/python3/build-essential",
      },
    }
  );
  const log = await new Promise<string>((resolve, reject) => {
    let out = "";
    docker.modem.followProgress(
      stream,
      (err: Error | null, res: any[]) => {
        if (err) reject(err);
        else resolve(out + "\n" + JSON.stringify(res?.slice(-3) || []));
      },
      (event: any) => {
        if (event.stream) out += event.stream;
        if (event.error) out += event.error + "\n";
      }
    );
  });
  return { tag: BASE_TEMPLATE_TAG, stream: log };
}

export async function enrichBoxesWithResources(boxes: BoxSummary[]): Promise<BoxSummary[]> {
  const out: BoxSummary[] = [];
  for (const b of boxes) {
    try {
      const info = await docker.getContainer(b.id).inspect();
      out.push({
        ...b,
        cpus: parseNanoCpus(info),
        memory: parseMemory(info),
      });
    } catch {
      out.push(b);
    }
  }
  return out;
}
