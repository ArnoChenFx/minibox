import { type BoxProfile, hardeningFor } from "../box-profile";
import type { HostCtx } from "../host/registry";
import { containerName, parseBoxLabels, volumeName } from "../labels";
import { badRequest, conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { type ContainerInfo, type ContainerStats, RuntimeError } from "../runtime";

export interface CreateBoxInput {
  name: string;
  image?: string;
  cpus: number;
  memoryMb: number;
  /** Absent means the host's default profile. */
  profile?: BoxProfile;
}

export interface Box {
  id: string;
  name: string;
  state: string;
  status: string;
  running: boolean;
  image: string;
  template: string;
  /** Null for boxes created before profiles existed. */
  profile: BoxProfile | null;
  /** Boxes created before profiles stay on the engine's default `bridge` network. */
  network: string;
  cpus: number | null;
  memory: number | null;
  createdAt: string;
  startedAt: string | null;
  volume: string;
  stats?: ContainerStats | null;
}

const STOP_TIMEOUT_SEC = 3;

function toBox(host: HostCtx, info: ContainerInfo): Box {
  const labels = parseBoxLabels(info.labels, host.keys);
  const name = labels.name ?? info.name;
  return {
    id: info.id,
    name,
    state: info.state,
    status: info.state,
    running: info.running,
    image: info.image,
    template: labels.template,
    profile: labels.profile,
    network: info.network,
    cpus: info.cpus,
    memory: info.memoryBytes,
    createdAt: labels.created ?? info.created,
    startedAt: info.startedAt,
    volume: volumeName(host.prefix, name),
  };
}

/** Inspect a container and assert it is a MiniBox box. */
export async function getBox(host: HostCtx, id: string): Promise<Box> {
  let info: ContainerInfo;
  try {
    info = await host.runtime.inspectContainer(id);
  } catch (e) {
    if (e instanceof RuntimeError && e.kind === "not_found") throw notFound(msg("box_not_found"));
    throw e;
  }
  if (!parseBoxLabels(info.labels, host.keys).isBox) throw notFound(msg("box_not_found"));
  return toBox(host, info);
}

export async function listBoxes(host: HostCtx, opts: { withStats?: boolean } = {}): Promise<Box[]> {
  const infos = await host.runtime.listContainers({ labels: { [host.keys.box]: "true" } });
  const boxes = await Promise.all(
    infos.map(async (info) => {
      const box = toBox(host, info);
      if (opts.withStats) {
        box.stats = box.running ? await host.runtime.containerStats(info.id).catch(() => null) : null;
      }
      return box;
    }),
  );
  return boxes.toSorted((a, b) => a.name.localeCompare(b.name));
}

async function ensureImage(host: HostCtx, image: string): Promise<void> {
  try {
    await host.runtime.inspectImage(image);
  } catch {
    throw badRequest(msg("template_image_missing", { image }), { field: "template" });
  }
}

/** Boxes share one bridge network with inter-container communication off. A network that differs is never reused. */
async function ensureBoxNetwork(host: HostCtx): Promise<void> {
  try {
    await host.runtime.ensureBridgeNetwork(host.security.network, { interContainerComm: false });
  } catch (e) {
    if (e instanceof RuntimeError && e.kind === "conflict") {
      throw conflict(msg("box_network_conflict", { network: host.security.network }));
    }
    throw e;
  }
}

/**
 * A stopped box keeps the ID of the network it last ran on. After `docker network prune` removes that network, the box
 * starts only once it is attached to the network that now has the same name. A running box's network is in use, so it
 * cannot have been removed and is left alone.
 */
async function attachToBoxNetwork(host: HostCtx, box: Box): Promise<void> {
  if (box.network !== host.security.network || box.running) return;
  await ensureBoxNetwork(host);
  await host.runtime.reattachNetwork(box.id, host.security.network);
}

export async function createBox(host: HostCtx, input: CreateBoxInput & { templateLabel?: string }): Promise<Box> {
  const { runtime, keys, prefix, security } = host;
  const image = input.image ?? host.baseTemplateTag;
  const profile = input.profile ?? security.defaultProfile;
  const existing = await listBoxes(host);
  if (existing.some((b) => b.name === input.name)) throw conflict(msg("box_exists", { name: input.name }));
  await ensureImage(host, image);
  await ensureBoxNetwork(host);

  const volume = volumeName(prefix, input.name);
  try {
    await runtime.inspectVolume(volume);
  } catch {
    await runtime.createVolume(volume, { [keys.box]: "true", [keys.name]: input.name });
  }

  const memoryBytes = input.memoryMb * 1024 * 1024;
  const { id } = await runtime.createContainer({
    name: containerName(prefix, input.name),
    image,
    cmd: ["sleep", "infinity"],
    workingDir: "/workspace",
    hostname: input.name.slice(0, 63),
    labels: {
      [keys.box]: "true",
      [keys.name]: input.name,
      [keys.template]: input.templateLabel ?? image,
      [keys.created]: new Date().toISOString(),
      [keys.profile]: profile,
    },
    mounts: [{ source: volume, target: "/workspace" }],
    restart: "unless-stopped",
    cpus: input.cpus,
    memoryBytes,
    swapBytes: memoryBytes,
    init: true,
    network: security.network,
    hardening: hardeningFor(profile, security),
  });
  await runtime.startContainer(id);
  log.info("box.created", { name: input.name, image, profile, cpus: input.cpus, memoryMb: input.memoryMb });
  return getBox(host, id);
}

export async function startBox(host: HostCtx, id: string): Promise<Box> {
  await attachToBoxNetwork(host, await getBox(host, id));
  await host.runtime.startContainer(id);
  return getBox(host, id);
}

export async function stopBox(host: HostCtx, id: string): Promise<Box> {
  await getBox(host, id);
  await host.runtime.stopContainer(id, { timeoutSec: STOP_TIMEOUT_SEC });
  return getBox(host, id);
}

export async function restartBox(host: HostCtx, id: string): Promise<Box> {
  await attachToBoxNetwork(host, await getBox(host, id));
  await host.runtime.restartContainer(id, { timeoutSec: STOP_TIMEOUT_SEC });
  return getBox(host, id);
}

export async function deleteBox(
  host: HostCtx,
  id: string,
  deleteVolume: boolean,
): Promise<{ name: string; volumeDeleted: boolean }> {
  const box = await getBox(host, id);
  await host.runtime.removeContainer(id, { force: true });
  let volumeDeleted = false;
  if (deleteVolume) {
    try {
      await host.runtime.removeVolume(box.volume);
      volumeDeleted = true;
    } catch (e) {
      log.warn("box.volume_remove_failed", { volume: box.volume, error: String(e) });
    }
  }
  log.info("box.deleted", { name: box.name, volumeDeleted });
  return { name: box.name, volumeDeleted };
}

export async function updateResources(
  host: HostCtx,
  id: string,
  res: { cpus?: number; memoryMb?: number },
): Promise<Box> {
  await getBox(host, id);
  const memoryBytes = res.memoryMb === undefined ? undefined : res.memoryMb * 1024 * 1024;
  await host.runtime.updateContainer(id, { cpus: res.cpus, memoryBytes, swapBytes: memoryBytes });
  return getBox(host, id);
}

export async function getLogs(host: HostCtx, id: string, tail: number): Promise<string> {
  await getBox(host, id);
  return host.runtime.containerLogs(id, { tail, timestamps: true });
}

export async function getStats(host: HostCtx, id: string): Promise<ContainerStats | null> {
  const box = await getBox(host, id);
  return box.running ? host.runtime.containerStats(id) : null;
}
