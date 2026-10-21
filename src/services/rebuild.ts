import { type BoxProfile, hardeningFor } from "../box-profile";
import type { HostCtx } from "../host/registry";
import { AppError, badRequest, conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import {
  type ContainerHardening,
  type ContainerInfo,
  type CreateContainerSpec,
  type ImageDetails,
  RuntimeError,
} from "../runtime";
import { pushHistory } from "../specs/history";
import { planRebuild, previewOf, type PlannedRebuild, type RebuildRequest } from "../specs/plan";
import { revisionMismatch } from "../specs/revision";
import type { BoxMount, BoxRecovery, BoxSpec } from "../specs/types";
import { VolumeChanges } from "../volumes/changes";
import { createIndependentVolume } from "../volumes/provision";
import { assertMountAllowed, assertRebuildAttachments, engineRefs, mountTarget } from "./attachments";
import { type Box, getBox } from "./boxes";

interface SwapState {
  createdId: string | null;
  specWritten: boolean;
  oldStopped: boolean;
  oldRenamed: boolean;
  started: boolean;
  wasRunning: boolean;
  changes: VolumeChanges;
}

/**
 * Rebuilds a box onto a new container. Without `confirm`, returns a 409 whose body is the docker diff and the
 * planned change set. With `confirm`, swaps the containers and rolls both the container and the spec back on failure.
 * Claim does not rename; this is the step that may rename the container to `<prefix>-<id>` (decision D6).
 */
export async function rebuildBox(
  host: HostCtx,
  ref: string,
  revision: number,
  request: RebuildRequest,
  confirm: boolean,
): Promise<Box> {
  const box = await getBox(host, ref);
  await host.specs.exclusive(async () => {
    const spec = host.specs.read(box.boxId);
    if (!spec) throw notFound(msg("box_not_found"));
    if (spec.revision !== revision) throw revisionMismatch(spec.revision, revision);

    const previous = structuredClone(spec);
    const named = request.mounts ? { ...request, mounts: engineRefs(host, request.mounts) } : request;
    const planned = planRebuild(host.prefix, spec, named);
    if (planned.changes.length === 0) throw badRequest(msg("rebuild_empty"));
    await assertRebuildAttachments(host, spec, planned.mounts, planned.network);

    let template = spec.template;
    if (planned.templateRef) {
      const details = await ensureImage(host, planned.templateRef);
      template = { ref: planned.templateRef, image: planned.templateRef, digest: details.id };
    }
    if (!confirm) {
      const diff = await host.runtime.containerDiff(spec.containerId);
      throw new AppError(409, "confirmation_required", msg("rebuild_confirm_required"), {
        preview: previewOf(spec, planned, diff),
      });
    }
    await swap(host, previous, planned, template, request);
  });
  return getBox(host, box.boxId);
}

async function ensureImage(host: HostCtx, image: string): Promise<ImageDetails> {
  try {
    return await host.runtime.inspectImage(image);
  } catch {
    throw badRequest(msg("template_image_missing", { image }), { field: "template" });
  }
}

/** Creates the host's box network when a rebuild joins it. Mounts and networks are checked before the preview. */
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

async function inspectOld(host: HostCtx, id: string): Promise<ContainerInfo> {
  try {
    return await host.runtime.inspectContainer(id);
  } catch (e) {
    if (e instanceof RuntimeError && e.kind === "not_found") throw notFound(msg("box_not_found"));
    throw e;
  }
}

/**
 * A scratch or `-old` name left by an earlier attempt is removed when it belongs to this box and is stopped.
 * The live container is left alone. Anything else is a conflict: this step does not delete a stranger's container.
 */
async function clearLeftover(host: HostCtx, name: string, spec: BoxSpec): Promise<void> {
  let info: ContainerInfo;
  try {
    info = await host.runtime.inspectContainer(name);
  } catch (e) {
    if (e instanceof RuntimeError && e.kind === "not_found") return;
    throw e;
  }
  if (info.id === spec.containerId) return;
  if (info.labels[host.keys.id] !== spec.id || info.running) {
    throw conflict(msg("rebuild_name_conflict", { name }));
  }
  await host.runtime.removeContainer(info.id, { force: true });
}

/**
 * Names the engine volume each planned mount uses. Checks run again under the lock, so a volume that changed since the
 * preview is refused here. A name that does not exist yet becomes a standalone record. `changes` removes it again if
 * the swap fails.
 */
async function resolveVolumes(
  host: HostCtx,
  previous: BoxSpec,
  mounts: BoxMount[],
  changes: VolumeChanges,
): Promise<BoxMount[]> {
  const resolved: BoxMount[] = [];
  for (const mount of mounts) {
    const target = await mountTarget(host, mount.volume);
    assertMountAllowed(host, previous, mount.volume, target);
    if (target.info) {
      resolved.push(mount);
      continue;
    }
    const created = await createIndependentVolume(
      host,
      { name: mount.volume, role: null, createdBy: previous.createdBy },
      new Set(),
      changes,
    );
    resolved.push({ ...mount, volume: created.engineName });
  }
  return resolved;
}

function hardeningOf(host: HostCtx, spec: BoxSpec, profile: BoxProfile | null): ContainerHardening | undefined {
  if (profile) {
    return hardeningFor(profile, {
      pidsLimit: spec.resources.pids ?? host.security.pidsLimit,
      runtime: host.security.runtime,
    });
  }
  if (spec.resources.pids !== null) return { pidsLimit: spec.resources.pids };
  return undefined;
}

function containerLabels(
  host: HostCtx,
  spec: BoxSpec,
  planned: PlannedRebuild,
  template: BoxSpec["template"],
): Record<string, string> {
  const { keys } = host;
  const labels: Record<string, string> = {
    [keys.box]: "true",
    [keys.name]: spec.name,
    [keys.id]: spec.id,
    [keys.template]: template.ref,
    [keys.created]: spec.createdAt,
    [keys.mounts]: JSON.stringify(planned.mounts),
  };
  if (template.digest) labels[keys.digest] = template.digest;
  if (planned.profile) labels[keys.profile] = planned.profile;
  if (spec.resources.cpus !== null) labels[keys.cpus] = String(spec.resources.cpus);
  if (spec.resources.memoryBytes !== null) labels[keys.memory] = String(spec.resources.memoryBytes);
  if (spec.resources.pids !== null) labels[keys.pids] = String(spec.resources.pids);
  if (spec.createdBy) labels[keys.createdBy] = spec.createdBy;
  return labels;
}

function containerSpec(
  host: HostCtx,
  spec: BoxSpec,
  planned: PlannedRebuild,
  template: BoxSpec["template"],
  name: string,
): CreateContainerSpec {
  const env = planned.env.flatMap((entry) => (entry.value !== undefined ? [`${entry.name}=${entry.value}`] : []));
  const workspace = planned.mounts.some((mount) => mount.path === "/workspace");
  const hardening = hardeningOf(host, spec, planned.profile);
  const created: CreateContainerSpec = {
    name,
    image: template.image,
    cmd: ["sleep", "infinity"],
    workingDir: workspace ? "/workspace" : "/",
    hostname: spec.name.slice(0, 63),
    labels: containerLabels(host, spec, planned, template),
    mounts: planned.mounts.map((mount) => ({ source: mount.volume, target: mount.path, mode: mount.mode })),
    restart: "no",
    init: true,
    network: planned.network,
  };
  if (spec.resources.cpus !== null) created.cpus = spec.resources.cpus;
  if (spec.resources.memoryBytes !== null) {
    created.memoryBytes = spec.resources.memoryBytes;
    created.swapBytes = spec.resources.memoryBytes;
  }
  if (env.length > 0) created.env = env;
  if (hardening) created.hardening = hardening;
  return created;
}

function canon(mounts: { volume: string; path: string; mode: string }[]): string {
  const rows = mounts.map((mount) => ({ volume: mount.volume, path: mount.path, mode: mount.mode }));
  rows.sort((a, b) => `${a.path}\0${a.volume}`.localeCompare(`${b.path}\0${b.volume}`));
  return JSON.stringify(rows);
}

async function assertFresh(host: HostCtx, id: string, image: string, planned: PlannedRebuild): Promise<void> {
  const info = await host.runtime.inspectContainer(id);
  const problems: string[] = [];
  if (info.running) problems.push("running");
  if (info.image !== image) problems.push("image");
  if (info.network !== planned.network) problems.push("network");
  const actual = info.mounts.map((mount) => ({ volume: mount.source, path: mount.target, mode: mount.mode }));
  if (canon(actual) !== canon(planned.mounts)) problems.push("mounts");
  if (problems.length === 0) return;
  throw new AppError(
    502,
    "docker_error",
    msg("docker_error", { detail: `new container failed validation: ${problems.join(", ")}` }),
  );
}

function nextRecovery(spec: BoxSpec, request: RebuildRequest): BoxRecovery | null {
  if (!spec.recovery || request.env === undefined) return spec.recovery;
  const needsReset = spec.recovery.needsReset.filter((field) => field !== "env");
  return needsReset.length === 0 ? null : { ...spec.recovery, needsReset };
}

function writeNext(
  host: HostCtx,
  previous: BoxSpec,
  planned: PlannedRebuild,
  template: BoxSpec["template"],
  containerId: string,
  request: RebuildRequest,
): void {
  host.specs.write({
    ...previous,
    template,
    mounts: planned.mounts,
    env: planned.env,
    network: planned.network,
    profile: planned.profile,
    containerName: planned.containerName,
    containerId,
    resources: { ...previous.resources },
    createdResources: { ...previous.resources },
    recovery: nextRecovery(previous, request),
    revision: previous.revision + 1,
    updatedAt: new Date().toISOString(),
    history: pushHistory(previous),
  });
}

async function undo(host: HostCtx, previous: BoxSpec, state: SwapState): Promise<void> {
  const fail = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      log.warn("box.rebuild_rollback_failed", { id: previous.id, error: String(e) });
    }
  };
  if (state.started && state.createdId) {
    const createdId = state.createdId;
    await fail(() => host.runtime.stopContainer(createdId, { timeoutSec: host.stopTimeoutSec }));
  }
  if (state.createdId) {
    const createdId = state.createdId;
    await fail(() => host.runtime.removeContainer(createdId, { force: true }));
  }
  if (state.oldRenamed) {
    await fail(() => host.runtime.renameContainer(previous.containerId, previous.containerName));
  }
  if (state.oldStopped && state.wasRunning) {
    await fail(() => host.runtime.startContainer(previous.containerId));
  }
  await state.changes.rollback();
  if (!state.specWritten) return;
  try {
    host.specs.write(previous);
  } catch (e) {
    log.warn("box.rebuild_rollback_failed", { id: previous.id, error: String(e) });
  }
}

async function swap(
  host: HostCtx,
  previous: BoxSpec,
  planned: PlannedRebuild,
  template: BoxSpec["template"],
  request: RebuildRequest,
): Promise<void> {
  const state: SwapState = {
    createdId: null,
    specWritten: false,
    oldStopped: false,
    oldRenamed: false,
    started: false,
    wasRunning: false,
    changes: new VolumeChanges(),
  };
  const formal = planned.containerName;
  const scratch = `${formal}-new`;
  const oldAlias = `${previous.containerName}-old`;
  try {
    const old = await inspectOld(host, previous.containerId);
    state.wasRunning = old.running;
    if (planned.network === host.security.network) await ensureBoxNetwork(host);
    await clearLeftover(host, scratch, previous);
    await clearLeftover(host, oldAlias, previous);
    const resolved: PlannedRebuild = {
      ...planned,
      mounts: await resolveVolumes(host, previous, planned.mounts, state.changes),
    };
    const created = await host.runtime.createContainer(containerSpec(host, previous, resolved, template, scratch));
    state.createdId = created.id;
    await assertFresh(host, created.id, template.image, resolved);
    writeNext(host, previous, resolved, template, created.id, request);
    state.specWritten = true;
    if (state.wasRunning) {
      await host.runtime.stopContainer(previous.containerId, { timeoutSec: host.stopTimeoutSec });
      state.oldStopped = true;
    }
    await host.runtime.renameContainer(previous.containerId, oldAlias);
    state.oldRenamed = true;
    await host.runtime.renameContainer(created.id, formal);
    await host.runtime.startContainer(created.id);
    state.started = true;
    const started = await host.runtime.inspectContainer(created.id);
    if (!started.running) throw new AppError(502, "docker_error", msg("rebuild_start_failed"));
    if (previous.lifecycle.desired === "stopped") {
      await host.runtime.stopContainer(created.id, { timeoutSec: host.stopTimeoutSec });
    }
    await host.runtime.removeContainer(previous.containerId, { force: true });
    log.info("box.rebuilt", {
      id: previous.id,
      name: previous.name,
      changes: planned.changes.map((change) => change.field),
      containerName: formal,
    });
  } catch (e) {
    await undo(host, previous, state);
    throw e;
  }
}
