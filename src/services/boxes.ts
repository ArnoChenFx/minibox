import { type BoxProfile, hardeningFor } from "../box-profile";
import type { HostCtx } from "../host/registry";
import { containerName, parseBoxLabels, volumeName } from "../labels";
import { badRequest, conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { NAME_RE } from "../lib/validation";
import {
  type ContainerInfo,
  type ContainerStats,
  type ContainerUpdate,
  type ImageDetails,
  isRuntimeError,
  RuntimeError,
} from "../runtime";
import { ClaimError, ensureSpec } from "../specs/claim";
import { detectDrift } from "../specs/drift";
import { newBoxId, revisionMismatch } from "../specs/revision";
import type { BoxMount, BoxRecovery, BoxSpec, DesiredState } from "../specs/types";

export interface CreateBoxInput {
  name: string;
  image?: string;
  cpus: number;
  memoryMb: number;
  /** Absent means the host's default profile. */
  profile?: BoxProfile;
  /** Principal that created the box. Defaults to `owner` until scoped tokens exist. */
  createdBy?: string;
}

export interface BoxUpdate {
  name?: string;
  cpus?: number;
  memoryMb?: number;
  pids?: number;
  labels?: Record<string, string>;
  /** `null` clears the timeout. */
  idleTimeoutSec?: number | null;
  /** `null` clears the TTL. */
  ttlSec?: number | null;
}

export interface Box {
  /** Docker container id. Terminals, snapshots and older clients keep using this. */
  id: string;
  /** Stable id (`bx_…`). Survives a rebuild; a claim of an unlabeled container mints a new one. */
  boxId: string;
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
  /** Observed on the container. A difference from the spec is reported in `drift`. */
  cpus: number | null;
  memory: number | null;
  pids: number | null;
  createdAt: string;
  startedAt: string | null;
  volume: string;
  revision: number;
  desired: DesiredState;
  idleTimeoutSec: number | null;
  ttlSec: number | null;
  /** User labels. These live in the spec and are never written onto the container. */
  labels: Record<string, string>;
  createdBy: string | null;
  /** Live container name. Claim does not change it. */
  containerName: string;
  drift: { field: string; expected: string; actual: string }[];
  recovery: BoxRecovery | null;
  mounts: BoxMount[];
  stats?: ContainerStats | null;
}

const MB = 1024 * 1024;

function workspaceVolume(host: HostCtx, spec: BoxSpec): string {
  const workspace = spec.mounts.find((mount) => mount.path === "/workspace");
  return workspace?.volume ?? volumeName(host.prefix, spec.createdName);
}

/** Observed container fields stay on the box so drift is visible. Desired fields come from the spec. */
function project(host: HostCtx, spec: BoxSpec, info: ContainerInfo): Box {
  return {
    id: info.id,
    boxId: spec.id,
    name: spec.name,
    state: info.state,
    status: info.state,
    running: info.running,
    image: info.image,
    template: spec.template.ref,
    profile: spec.profile,
    network: info.network,
    cpus: info.cpus,
    memory: info.memoryBytes,
    pids: info.pidsLimit,
    createdAt: spec.createdAt,
    startedAt: info.startedAt,
    volume: workspaceVolume(host, spec),
    revision: spec.revision,
    desired: spec.lifecycle.desired,
    idleTimeoutSec: spec.lifecycle.idleTimeoutSec,
    ttlSec: spec.lifecycle.ttlSec,
    labels: spec.labels,
    createdBy: spec.createdBy,
    containerName: info.name,
    drift: detectDrift(spec, info),
    recovery: spec.recovery,
    mounts: spec.mounts,
  };
}

function specForRef(host: HostCtx, ref: string): BoxSpec | null {
  const direct = host.specs.read(ref);
  if (direct?.hostId === host.host.id) return direct;
  const named = host.specs.findByName(ref);
  if (named?.hostId === host.host.id) return named;
  return host.specs.list().find((spec) => spec.hostId === host.host.id && spec.containerName === ref) ?? null;
}

async function inspectKnown(host: HostCtx, spec: BoxSpec): Promise<ContainerInfo> {
  try {
    return await host.runtime.inspectContainer(spec.containerId);
  } catch (e) {
    if (!(e instanceof RuntimeError && e.kind === "not_found")) throw e;
    return host.runtime.inspectContainer(spec.containerName);
  }
}

/** Container id, container name, stable id, box name, or `prefix-<name>` for a box that has no spec yet. */
async function inspectRef(host: HostCtx, ref: string): Promise<ContainerInfo> {
  try {
    return await host.runtime.inspectContainer(ref);
  } catch (e) {
    if (!(e instanceof RuntimeError && e.kind === "not_found") || !NAME_RE.test(ref)) throw e;
    return host.runtime.inspectContainer(containerName(host.prefix, ref));
  }
}

function asMissing(e: unknown): never {
  if (e instanceof RuntimeError && e.kind === "not_found") throw notFound(msg("box_not_found"));
  throw e;
}

/** Inspect a container and assert it is a MiniBox box. Claims a spec the first time a container is seen. */
export async function getBox(host: HostCtx, ref: string): Promise<Box> {
  const known = specForRef(host, ref);
  if (known) {
    try {
      const info = await inspectKnown(host, known);
      if (!parseBoxLabels(info.labels, host.keys).isBox) throw notFound(msg("box_not_found"));
      return project(host, known, info);
    } catch (e) {
      if (e instanceof RuntimeError) asMissing(e);
      throw e;
    }
  }

  let info: ContainerInfo;
  try {
    info = await inspectRef(host, ref);
  } catch (e) {
    asMissing(e);
  }
  if (!parseBoxLabels(info.labels, host.keys).isBox) throw notFound(msg("box_not_found"));
  try {
    const { spec } = await ensureSpec(host, info);
    return project(host, spec, info);
  } catch (e) {
    if (e instanceof ClaimError) throw conflict(msg("box_claim_failed", { detail: e.message }));
    throw e;
  }
}

export async function listBoxes(host: HostCtx, opts: { withStats?: boolean } = {}): Promise<Box[]> {
  const infos = await host.runtime.listContainers({ labels: { [host.keys.box]: "true" } });
  const boxes: Box[] = [];
  for (const info of infos) {
    let spec: BoxSpec;
    try {
      spec = (await ensureSpec(host, info)).spec;
    } catch (e) {
      if (e instanceof ClaimError) {
        log.warn("box.claim_skipped", { container: info.name, host: host.host.id, error: e.message });
        continue;
      }
      throw e;
    }
    const box = project(host, spec, info);
    if (opts.withStats) {
      box.stats = box.running ? await host.runtime.containerStats(info.id).catch(() => null) : null;
    }
    boxes.push(box);
  }
  return boxes.toSorted((a, b) => a.name.localeCompare(b.name));
}

async function ensureImage(host: HostCtx, image: string): Promise<ImageDetails> {
  try {
    return await host.runtime.inspectImage(image);
  } catch (e) {
    if (isRuntimeError(e, "not_found")) {
      throw badRequest(msg("template_image_missing", { image }), { field: "template" });
    }
    throw e;
  }
}

/** Reuses a workspace volume left behind by an earlier box with the same name. */
async function ensureVolume(host: HostCtx, name: string, labels: Record<string, string>): Promise<void> {
  try {
    await host.runtime.inspectVolume(name);
  } catch (e) {
    if (!isRuntimeError(e, "not_found")) throw e;
    await host.runtime.createVolume(name, labels);
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

/** Bumps the revision only when the desired state actually changes, so a reconcile does not invalidate If-Match. */
async function setDesired(host: HostCtx, boxId: string, desired: DesiredState): Promise<void> {
  await host.specs.exclusive(async () => {
    const spec = host.specs.read(boxId);
    if (!spec || spec.lifecycle.desired === desired) return;
    host.specs.write({
      ...spec,
      lifecycle: { ...spec.lifecycle, desired },
      revision: spec.revision + 1,
      updatedAt: new Date().toISOString(),
    });
  });
}

export async function createBox(host: HostCtx, input: CreateBoxInput & { templateLabel?: string }): Promise<Box> {
  const { runtime, keys, prefix, security } = host;
  if (host.specs.findByName(input.name)) throw conflict(msg("box_exists", { name: input.name }));

  const image = input.image ?? host.baseTemplateTag;
  const profile = input.profile ?? security.defaultProfile;
  const details = await ensureImage(host, image);
  await ensureBoxNetwork(host);

  const volume = volumeName(prefix, input.name);
  await ensureVolume(host, volume, { [keys.box]: "true", [keys.name]: input.name });

  const containerId = await host.specs.exclusive(async () => {
    if (host.specs.findByName(input.name)) throw conflict(msg("box_exists", { name: input.name }));
    let id = newBoxId();
    for (let attempt = 0; attempt < 5 && host.specs.read(id); attempt++) id = newBoxId();
    if (host.specs.read(id)) throw conflict(msg("box_claim_failed", { detail: "could not allocate a box id" }));
    const now = new Date().toISOString();
    const memoryBytes = input.memoryMb * MB;
    const pids = security.pidsLimit;
    const createdBy = input.createdBy ?? "owner";
    const ref = input.templateLabel ?? image;
    const mounts: BoxMount[] = [{ volume, path: "/workspace", mode: "rw" }];
    const name = containerName(prefix, input.name);
    const resources = { cpus: input.cpus, memoryBytes, pids };
    const labels: Record<string, string> = {
      [keys.box]: "true",
      [keys.name]: input.name,
      [keys.id]: id,
      [keys.template]: ref,
      [keys.digest]: details.id,
      [keys.created]: now,
      [keys.profile]: profile,
      [keys.mounts]: JSON.stringify(mounts),
      [keys.cpus]: String(input.cpus),
      [keys.memory]: String(memoryBytes),
      [keys.pids]: String(pids),
      [keys.createdBy]: createdBy,
    };
    const created = await runtime
      .createContainer({
        name,
        image,
        cmd: ["sleep", "infinity"],
        workingDir: "/workspace",
        hostname: input.name.slice(0, 63),
        labels,
        mounts: [{ source: volume, target: "/workspace" }],
        restart: "no",
        cpus: input.cpus,
        memoryBytes,
        swapBytes: memoryBytes,
        init: true,
        network: security.network,
        hardening: hardeningFor(profile, security),
      })
      .catch((e: unknown) => {
        // The engine enforces unique container names, so a name it already holds is refused here, not by a racy list.
        if (isRuntimeError(e, "conflict")) throw conflict(msg("box_exists", { name: input.name }));
        throw e;
      });
    const spec: BoxSpec = {
      version: 1,
      id,
      name: input.name,
      createdName: input.name,
      hostId: host.host.id,
      createdBy,
      template: { ref, image, digest: details.id },
      resources,
      createdResources: resources,
      mounts,
      env: [],
      tools: [],
      labels: {},
      lifecycle: { desired: "running", idleTimeoutSec: null, ttlSec: null },
      profile,
      network: security.network,
      restart: "no",
      containerName: name,
      containerId: created.id,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      recovery: null,
    };
    host.specs.write(spec);
    return created.id;
  });

  await runtime.startContainer(containerId);
  log.info("box.created", { name: input.name, image, profile, cpus: input.cpus, memoryMb: input.memoryMb });
  return getBox(host, containerId);
}

export async function startBox(host: HostCtx, ref: string): Promise<Box> {
  const box = await getBox(host, ref);
  await attachToBoxNetwork(host, box);
  await host.runtime.startContainer(box.id);
  await setDesired(host, box.boxId, "running");
  return getBox(host, box.boxId);
}

export async function stopBox(host: HostCtx, ref: string): Promise<Box> {
  const box = await getBox(host, ref);
  await host.runtime.stopContainer(box.id, { timeoutSec: host.stopTimeoutSec });
  await setDesired(host, box.boxId, "stopped");
  return getBox(host, box.boxId);
}

export async function restartBox(host: HostCtx, ref: string): Promise<Box> {
  const box = await getBox(host, ref);
  await attachToBoxNetwork(host, box);
  await host.runtime.restartContainer(box.id, { timeoutSec: host.stopTimeoutSec });
  await setDesired(host, box.boxId, "running");
  return getBox(host, box.boxId);
}

export interface DeleteBoxResult {
  name: string;
  volumeDeleted: boolean;
  /** Why the requested volume removal failed. The box itself is always removed first. */
  volumeError?: string;
}

export async function deleteBox(host: HostCtx, ref: string, deleteVolume: boolean): Promise<DeleteBoxResult> {
  const box = await getBox(host, ref);
  await host.specs.exclusive(async () => {
    await host.runtime.removeContainer(box.id, { force: true });
    host.specs.remove(box.boxId);
  });
  const result: DeleteBoxResult = { name: box.name, volumeDeleted: false };
  if (deleteVolume) {
    try {
      await host.runtime.removeVolume(box.volume);
      result.volumeDeleted = true;
    } catch (e) {
      // A volume that is already gone is the state the caller asked for.
      if (isRuntimeError(e, "not_found")) {
        result.volumeDeleted = true;
      } else {
        result.volumeError = e instanceof RuntimeError ? e.detail : e instanceof Error ? e.message : String(e);
        log.warn("box.volume_remove_failed", { volume: box.volume, error: String(e) });
      }
    }
  }
  log.info("box.deleted", { name: box.name, volumeDeleted: result.volumeDeleted });
  return result;
}

function hasUpdate(patch: BoxUpdate): boolean {
  return (
    patch.name !== undefined ||
    patch.cpus !== undefined ||
    patch.memoryMb !== undefined ||
    patch.pids !== undefined ||
    patch.labels !== undefined ||
    patch.idleTimeoutSec !== undefined ||
    patch.ttlSec !== undefined
  );
}

function containerLimits(patch: BoxUpdate): ContainerUpdate {
  const limits: ContainerUpdate = {};
  if (patch.cpus !== undefined) limits.cpus = patch.cpus;
  if (patch.memoryMb !== undefined) {
    const memoryBytes = patch.memoryMb * MB;
    limits.memoryBytes = memoryBytes;
    limits.swapBytes = memoryBytes;
  }
  if (patch.pids !== undefined) limits.pidsLimit = patch.pids;
  return limits;
}

function clearNeedsReset(spec: BoxSpec, patch: BoxUpdate): BoxRecovery | null {
  if (!spec.recovery) return null;
  const drop = new Set<string>();
  if (patch.idleTimeoutSec !== undefined) drop.add("idleTimeout");
  if (patch.ttlSec !== undefined) drop.add("ttl");
  if (patch.labels !== undefined) drop.add("labels");
  const needsReset = spec.recovery.needsReset.filter((field) => !drop.has(field));
  return needsReset.length === 0 ? null : { ...spec.recovery, needsReset };
}

/**
 * Applies an in-place update. Container labels are not touched. `revision` is the caller's If-Match value;
 * a mismatch leaves the spec and the container as they were.
 */
export async function updateBox(host: HostCtx, ref: string, revision: number, patch: BoxUpdate): Promise<Box> {
  if (!hasUpdate(patch)) throw badRequest(msg("box_update_empty"));
  const current = await getBox(host, ref);
  await host.specs.exclusive(async () => {
    const spec = host.specs.read(current.boxId);
    if (!spec) throw notFound(msg("box_not_found"));
    if (spec.revision !== revision) throw revisionMismatch(spec.revision, revision);

    const nextName = patch.name !== undefined ? patch.name : spec.name;
    if (nextName !== spec.name) {
      const taken = host.specs.findByName(nextName);
      if (taken) throw conflict(msg("box_exists", { name: nextName }));
    }
    const nextContainer = nextName === spec.name ? spec.containerName : containerName(host.prefix, nextName);
    const limits = containerLimits(patch);
    let renamed = false;
    try {
      if (nextContainer !== spec.containerName) {
        await host.runtime.renameContainer(spec.containerId, nextContainer);
        renamed = true;
      }
      if (limits.cpus !== undefined || limits.memoryBytes !== undefined || limits.pidsLimit !== undefined) {
        await host.runtime.updateContainer(spec.containerId, limits);
      }
      const memoryBytes = patch.memoryMb !== undefined ? patch.memoryMb * MB : spec.resources.memoryBytes;
      host.specs.write({
        ...spec,
        name: nextName,
        containerName: nextContainer,
        resources: {
          cpus: patch.cpus !== undefined ? patch.cpus : spec.resources.cpus,
          memoryBytes,
          pids: patch.pids !== undefined ? patch.pids : spec.resources.pids,
        },
        labels: patch.labels !== undefined ? patch.labels : spec.labels,
        lifecycle: {
          ...spec.lifecycle,
          idleTimeoutSec: patch.idleTimeoutSec !== undefined ? patch.idleTimeoutSec : spec.lifecycle.idleTimeoutSec,
          ttlSec: patch.ttlSec !== undefined ? patch.ttlSec : spec.lifecycle.ttlSec,
        },
        recovery: clearNeedsReset(spec, patch),
        revision: spec.revision + 1,
        updatedAt: new Date().toISOString(),
      });
    } catch (e) {
      if (renamed) {
        try {
          await host.runtime.renameContainer(spec.containerId, spec.containerName);
        } catch (undo) {
          log.warn("box.rename_undo_failed", { id: spec.id, error: String(undo) });
        }
      }
      throw e;
    }
  });
  log.info("box.updated", { id: current.boxId, name: current.name });
  return getBox(host, current.boxId);
}

export async function updateResources(
  host: HostCtx,
  ref: string,
  res: { cpus?: number; memoryMb?: number; pids?: number },
  revision: number,
): Promise<Box> {
  return updateBox(host, ref, revision, res);
}

export async function getLogs(host: HostCtx, ref: string, tail: number): Promise<string> {
  const box = await getBox(host, ref);
  return host.runtime.containerLogs(box.id, { tail, timestamps: true });
}

export async function getStats(host: HostCtx, ref: string): Promise<ContainerStats | null> {
  const box = await getBox(host, ref);
  return box.running ? host.runtime.containerStats(box.id) : null;
}
