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
  isRuntimeError,
  RuntimeError,
  type VolumeOwner,
} from "../runtime";
import { assertSecretsSet, containerEnv } from "../secrets/env";
import { pushHistory } from "../specs/history";
import { type MovedTag, planRebuild, previewOf, type PlannedRebuild, type RebuildRequest } from "../specs/plan";
import { revisionMismatch } from "../specs/revision";
import type { BoxEnv, BoxMount, BoxRecovery, BoxSpec } from "../specs/types";
import { VolumeChanges } from "../volumes/changes";
import { assertVolumesPresent } from "../volumes/engine";
import { createIndependentVolume } from "../volumes/provision";
import { assertMountAllowed, assertRebuildAttachments, engineRefs, mountTarget } from "./attachments";
import { type Box, getBox, refuseExpired } from "./boxes";
import { assertImageAvailable, ensureImageOn } from "./images";
import { beginChange } from "./moving";
import { provisionSelfToken, selfTokenTmpfs } from "./self-token";
import { launchStartup } from "./startup";
import { alignVolumeRoot, type RecordNote, restoreVolumeRoot, writableWorkspaceVolume } from "./volume-owner";

interface SwapState {
  createdId: string | null;
  specWritten: boolean;
  oldStopped: boolean;
  oldRenamed: boolean;
  started: boolean;
  wasRunning: boolean;
  changes: VolumeChanges;
  /** The workspace root this attempt changed, with the owner it had. A rollback puts that owner back. */
  aligned: { volume: string; owner: VolumeOwner; image: string } | null;
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
  record?: RecordNote,
): Promise<Box> {
  const box = await getBox(host, ref);
  const release = beginChange(box.boxId);
  try {
    return await rebuildChanging(host, box, revision, request, confirm, record);
  } finally {
    release();
  }
}

async function rebuildChanging(
  host: HostCtx,
  box: Box,
  revision: number,
  request: RebuildRequest,
  confirm: boolean,
  record?: RecordNote,
): Promise<Box> {
  await host.specs.exclusive(async () => {
    const spec = host.specs.read(box.boxId);
    if (!spec) throw notFound(msg("box_not_found"));
    if (spec.revision !== revision) throw revisionMismatch(spec.revision, revision);
    refuseExpired(host, spec.id);

    const previous = structuredClone(spec);
    const named = request.mounts ? { ...request, mounts: engineRefs(host, request.mounts) } : request;
    // An empty request is allowed: a moved tag alone is still a rebuild. rebuild_empty only when nothing changed.
    const planned = planRebuild(
      host.prefix,
      spec,
      named,
      await movedTag(host, spec),
      await rotatedSecrets(host, spec, named.env ?? spec.env),
    );
    if (planned.changes.length === 0) throw badRequest(msg("rebuild_empty"));
    assertSecretsSet(host.secrets, planned.env);
    await assertRebuildAttachments(host, spec, planned.mounts, planned.network);

    if (planned.templateRef) await assertImageAvailable(host, planned.templateRef);
    if (!confirm) {
      const diff = await host.runtime.containerDiff(spec.containerId);
      throw new AppError(409, "confirmation_required", msg("rebuild_confirm_required"), {
        preview: previewOf(spec, planned, diff),
      });
    }
    let template = spec.template;
    if (planned.templateRef) {
      const details = await ensureImageOn(host, planned.templateRef);
      template = { ref: planned.templateRef, image: planned.templateRef, digest: details.id };
    }
    await swap(host, previous, planned, template, request, record);
  });
  await host.sampler.observe(box.id, host.specs.read(box.boxId)?.containerId ?? box.id);
  return getBox(host, box.boxId);
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
 * The image a tag-tracking box's tag names now, when the box's container runs a different one. A box tracks its
 * template when the template is the image it was created from (`ref` equals `image`). A snapshot box is labelled
 * `snapshot:<ref>`, so it stays on its snapshot. A tag that no longer exists is not a move.
 */
export async function movedTag(host: HostCtx, spec: BoxSpec): Promise<MovedTag | null> {
  if (spec.template.ref !== spec.template.image) return null;
  let tagged: ImageDetails;
  try {
    tagged = await host.runtime.inspectImage(spec.template.image);
  } catch (e) {
    if (isRuntimeError(e, "not_found")) return null;
    throw e;
  }
  const running = await inspectOld(host, spec.containerId);
  if (running.imageId === tagged.id) return null;
  return { tag: spec.template.image, from: running.imageId, to: tagged.id };
}

/**
 * The secrets a planned env names whose value is not the one the box's container was created with. A new value only
 * reaches a box on a rebuild, so a rebuild with a rotated secret is a change. The values are compared here and nowhere
 * else. A secret that is not set counts as rotated, so the rebuild is refused for it by the missing-secret check.
 */
async function rotatedSecrets(host: HostCtx, spec: BoxSpec, env: readonly BoxEnv[]): Promise<string[]> {
  const refs = env.flatMap((entry) =>
    entry.secretRef === undefined ? [] : [{ name: entry.name, ref: entry.secretRef }],
  );
  if (refs.length === 0) return [];
  const held = new Map<string, string>();
  for (const entry of await heldEnv(host, spec.containerId)) {
    const at = entry.indexOf("=");
    if (at > 0) held.set(entry.slice(0, at), entry.slice(at + 1));
  }
  return refs.flatMap(({ name, ref }) => (host.secrets.value(ref) === held.get(name) ? [] : [name]));
}

async function heldEnv(host: HostCtx, id: string): Promise<string[]> {
  try {
    return await host.runtime.inspectEnv(id);
  } catch (e) {
    if (isRuntimeError(e, "not_found")) throw notFound(msg("box_not_found"));
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

export function containerSpec(
  host: HostCtx,
  spec: BoxSpec,
  planned: PlannedRebuild,
  template: BoxSpec["template"],
  name: string,
  env: string[],
): CreateContainerSpec {
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
  if (spec.selfToken) created.tmpfs = selfTokenTmpfs();
  if (hardening) created.hardening = hardening;
  return created;
}

function canon(mounts: { volume: string; path: string; mode: string }[]): string {
  const rows = mounts.map((mount) => ({ volume: mount.volume, path: mount.path, mode: mount.mode }));
  rows.sort((a, b) => `${a.path}\0${a.volume}`.localeCompare(`${b.path}\0${b.volume}`));
  return JSON.stringify(rows);
}

/**
 * A rebuild that sets the template also checks the image id. A tag can move between the inspect and the create, and the
 * spec must not record a digest the container does not run. Returns what the engine reports for the container.
 */
export async function assertFresh(
  host: HostCtx,
  id: string,
  template: BoxSpec["template"],
  planned: PlannedRebuild,
): Promise<ContainerInfo> {
  const info = await host.runtime.inspectContainer(id);
  const problems: string[] = [];
  if (info.running) problems.push("running");
  if (info.image !== template.image) problems.push("image");
  if (planned.templateRef !== null && info.imageId !== template.digest) problems.push("image id");
  if (info.network !== planned.network) problems.push("network");
  const actual = info.mounts.map((mount) => ({ volume: mount.source, path: mount.target, mode: mount.mode }));
  if (canon(actual) !== canon(planned.mounts)) problems.push("mounts");
  if (problems.length === 0) return info;
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

async function undo(host: HostCtx, previous: BoxSpec, state: SwapState, record?: RecordNote): Promise<void> {
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
  if (state.started) host.selfTokens.revoke(previous.id);
  if (state.createdId) {
    const createdId = state.createdId;
    await fail(() => host.runtime.removeContainer(createdId, { force: true }));
  }
  if (state.oldRenamed) {
    await fail(() => host.runtime.renameContainer(previous.containerId, previous.containerName));
  }
  if (state.aligned) {
    const { volume, owner, image } = state.aligned;
    await fail(() => restoreVolumeRoot(host, { volume, owner, image }, record));
  }
  if (state.oldStopped && state.wasRunning) {
    await fail(async () => {
      await assertVolumesPresent(
        host,
        previous.mounts.map((mount) => mount.volume),
      );
      await host.runtime.startContainer(previous.containerId);
      if (previous.selfToken) {
        await provisionSelfToken(host, { boxId: previous.id, name: previous.name }, previous.containerId);
      }
      await launchStartup(host, previous.containerId, previous.startupCommand);
    });
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
  record?: RecordNote,
): Promise<void> {
  const state: SwapState = {
    createdId: null,
    specWritten: false,
    oldStopped: false,
    oldRenamed: false,
    started: false,
    wasRunning: false,
    changes: new VolumeChanges(),
    aligned: null,
  };
  const formal = planned.containerName;
  const scratch = `${formal}-new`;
  const oldAlias = `${previous.containerName}-old`;
  try {
    const env = containerEnv(host.secrets, planned.env);
    const old = await inspectOld(host, previous.containerId);
    state.wasRunning = old.running;
    if (planned.network === host.security.network) await ensureBoxNetwork(host);
    await clearLeftover(host, scratch, previous);
    await clearLeftover(host, oldAlias, previous);
    const resolved: PlannedRebuild = {
      ...planned,
      mounts: await resolveVolumes(host, previous, planned.mounts, state.changes),
    };
    await assertVolumesPresent(
      host,
      resolved.mounts.map((mount) => mount.volume),
    );
    const created = await host.runtime.createContainer(containerSpec(host, previous, resolved, template, scratch, env));
    state.createdId = created.id;
    const fresh = await assertFresh(host, created.id, template, resolved);
    writeNext(host, previous, resolved, template, created.id, request);
    state.specWritten = true;
    if (state.wasRunning) {
      await host.runtime.stopContainer(previous.containerId, { timeoutSec: host.stopTimeoutSec });
      state.oldStopped = true;
    }
    host.selfTokens.revoke(previous.id);
    const workspace = writableWorkspaceVolume(resolved.mounts);
    if (workspace) {
      const replaced = await alignVolumeRoot(
        host,
        { containerId: created.id, volume: workspace, image: fresh.imageId, labels: fresh.labels },
        record,
      );
      if (replaced) state.aligned = { volume: workspace, owner: replaced, image: old.imageId };
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
    } else if (previous.selfToken) {
      await provisionSelfToken(host, { boxId: previous.id, name: previous.name }, created.id);
    }
    await host.runtime.removeContainer(previous.containerId, { force: true });
    if (previous.lifecycle.desired === "running") await launchStartup(host, created.id, previous.startupCommand);
    log.info("box.rebuilt", {
      id: previous.id,
      name: previous.name,
      changes: planned.changes.map((change) => change.field),
      containerName: formal,
    });
  } catch (e) {
    await undo(host, previous, state, record);
    throw e;
  }
}
