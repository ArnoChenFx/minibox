import { dirname } from "node:path";

import { hardeningFor } from "../box-profile";
import type { HostCtx } from "../host/registry";
import { containerName } from "../labels";
import { badRequest, notFound, conflict } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { isRuntimeError } from "../runtime";
import { assertSecretsSet, containerEnv } from "../secrets/env";
import { newBoxId, isBoxId } from "../specs/revision";
import type { BoxMount, MountMode, BoxSpec } from "../specs/types";
import { loadCatalog } from "../tools/catalog";
import { VolumeChanges } from "../volumes/changes";
import { trackPoolRoots, poolsUsed, assertVolumesPresent } from "../volumes/engine";
import { assertPoolsReachable } from "../volumes/health";
import { assertMountsWithinLimits } from "../volumes/limits";
import { validMountPath } from "../volumes/mounts";
import { provisionDefaultMounts } from "../volumes/provision";
import { assertMountAllowed, mountTarget } from "./attachments";
import { type CreateBoxInput, type Box, MB } from "./box-model";
import { ensureBoxNetwork } from "./box-network";
import { getBox } from "./box-query";
import { ensureImageOn } from "./images";
import { launchStartup } from "./startup";
import { desiredToolsOf } from "./tools";
import { type RecordNote, writableWorkspaceVolume, alignVolumeRoot } from "./volume-owner";

function assertMountList(mounts: BoxMount[]): void {
  const paths = new Set<string>();
  for (const mount of mounts) {
    if (!validMountPath(mount.path)) throw badRequest(msg("mount_path_invalid", { path: mount.path }));
    if (mount.mode !== "rw" && mount.mode !== "ro") throw badRequest(msg("mount_path_invalid", { path: mount.path }));
    if (paths.has(mount.path)) throw badRequest(msg("mount_duplicate", { path: mount.path }));
    paths.add(mount.path);
  }
}

function resolveMounts(host: HostCtx, mounts: BoxMount[]): BoxMount[] {
  assertMountList(mounts);
  return mounts.map((mount) => {
    const volume = host.volumes.resolve(mount.volume, host.host.id);
    if (!volume || volume.hostId !== host.host.id) throw notFound(msg("volume_not_found", { volume: mount.volume }));
    return { volume: volume.engineName, path: mount.path, mode: mount.mode };
  });
}

/** Explicit mounts name recorded volumes, and each one must pass the attachment rules a new box is held to. */
async function resolveCreateMounts(host: HostCtx, mounts: BoxMount[]): Promise<BoxMount[]> {
  const resolved = resolveMounts(host, mounts);
  for (const mount of resolved) {
    assertMountAllowed(host, null, mount.volume, await mountTarget(host, mount.volume));
  }
  return resolved;
}

function engineMounts(mounts: BoxMount[]): { source: string; target: string; mode: MountMode }[] {
  return mounts.map((mount) => ({ source: mount.volume, target: mount.path, mode: mount.mode }));
}

/** What one create attempt has made so far, so a failed attempt can take it back. */
interface CreateAttempt {
  boxId: string | null;
  containerId: string | null;
  changes: VolumeChanges;
}

export async function createBox(
  host: HostCtx,
  input: CreateBoxInput & { templateLabel?: string },
  record?: RecordNote,
): Promise<Box> {
  const attempt: CreateAttempt = { boxId: null, containerId: null, changes: new VolumeChanges() };
  let containerId: string;
  try {
    containerId = await buildBox(host, input, attempt, record);
  } catch (e) {
    await undoCreate(host, attempt);
    throw e;
  }
  return getBox(host, containerId);
}

/**
 * Takes back a failed create in dependency order: the container, then the spec, then the volumes it made. If the engine
 * keeps the container, its spec and volumes stay too, so nothing still in use is left without a record.
 */
async function undoCreate(host: HostCtx, attempt: CreateAttempt): Promise<void> {
  const containerId = attempt.containerId;
  if (containerId) {
    try {
      await host.runtime.removeContainer(containerId, { force: true });
    } catch (e) {
      if (!isRuntimeError(e, "not_found")) {
        log.warn("box.create_rollback_failed", { container: containerId, error: String(e) });
        return;
      }
    }
    host.specs.retire(containerId);
  }
  if (attempt.boxId) {
    try {
      host.specs.remove(attempt.boxId);
    } catch (e) {
      log.warn("box.create_rollback_failed", { id: attempt.boxId, error: String(e) });
    }
  }
  await attempt.changes.rollback();
}

/** The id a new box takes: the reserved one when it is still free, else a generated id that no spec holds. */
function boxIdFor(host: HostCtx, reserved: string | undefined): string {
  if (reserved === undefined) {
    for (let tries = 0; tries < 5; tries++) {
      const id = newBoxId();
      if (!host.specs.read(id)) return id;
    }
    throw conflict(msg("box_claim_failed", { detail: "could not allocate a box id" }));
  }
  if (!isBoxId(reserved)) throw new Error(`refusing a box id ${reserved}`);
  if (host.specs.read(reserved)) throw conflict(msg("box_id_taken", { id: reserved }));
  return reserved;
}

async function buildBox(
  host: HostCtx,
  input: CreateBoxInput & { templateLabel?: string },
  attempt: CreateAttempt,
  record?: RecordNote,
): Promise<string> {
  const { runtime, keys, prefix, security } = host;
  if (host.specs.findByName(input.name)) throw conflict(msg("box_exists", { name: input.name }));
  const env = input.env ?? [];
  assertSecretsSet(host.secrets, env);

  const image = input.image ?? host.baseTemplateTag;
  const profile = input.profile ?? security.defaultProfile;
  const details = await ensureImageOn(host, image);
  await ensureBoxNetwork(host);

  const id = boxIdFor(host, input.id);
  attempt.boxId = id;
  const createdBy = input.createdBy ?? "owner";
  const known = new Set<string>([image]);
  const mounts = input.mounts
    ? await resolveCreateMounts(host, input.mounts)
    : await provisionDefaultMounts(host, { id, name: input.name, createdBy }, known, attempt.changes);
  assertMountsWithinLimits(host, mounts);
  await trackPoolRoots(host, poolsUsed(host, mounts), attempt.changes);
  await assertPoolsReachable(host, poolsUsed(host, mounts));

  const containerId = await host.specs.exclusive(async () => {
    if (host.specs.findByName(input.name)) throw conflict(msg("box_exists", { name: input.name }));
    const now = new Date().toISOString();
    const memoryBytes = input.memoryMb * MB;
    const pids = security.pidsLimit;
    const ref = input.templateLabel ?? image;
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
    await assertVolumesPresent(
      host,
      mounts.map((mount) => mount.volume),
    );
    const containerVars = containerEnv(host.secrets, env);
    const created = await runtime
      .createContainer({
        name,
        image,
        cmd: ["sleep", "infinity"],
        workingDir: mounts.some((mount) => mount.path === "/workspace") ? "/workspace" : "/",
        hostname: input.name.slice(0, 63),
        labels,
        mounts: engineMounts(mounts),
        restart: "no",
        cpus: input.cpus,
        memoryBytes,
        swapBytes: memoryBytes,
        init: true,
        network: security.network,
        hardening: hardeningFor(profile, security),
        ...(containerVars.length > 0 ? { env: containerVars } : {}),
      })
      .catch((e: unknown) => {
        // The engine enforces unique container names, so a name it already holds is refused here, not by a racy list.
        if (isRuntimeError(e, "conflict")) throw conflict(msg("box_exists", { name: input.name }));
        throw e;
      });
    attempt.containerId = created.id;
    const workspace = writableWorkspaceVolume(mounts);
    if (workspace) {
      await alignVolumeRoot(
        host,
        { containerId: created.id, volume: workspace, image: details.id, labels: details.labels },
        record,
      );
    }
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
      env,
      tools: desiredToolsOf(input.tools, loadCatalog(dirname(host.specs.dir()))),
      ...(input.startupCommand !== undefined ? { startupCommand: input.startupCommand } : {}),
      labels: {},
      lifecycle: {
        desired: "running",
        idleTimeoutSec: input.idleTimeoutSec === undefined ? null : input.idleTimeoutSec,
        ttlSec: input.ttlSec === undefined ? null : input.ttlSec,
        stopReason: null,
      },
      profile,
      network: security.network,
      restart: "no",
      containerName: name,
      containerId: created.id,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      recovery: null,
      history: [],
    };
    host.specs.write(spec);
    return created.id;
  });

  await runtime.startContainer(containerId);
  await host.sampler.observe(containerId);
  host.pulse.touch(id, "create");
  await launchStartup(host, containerId, input.startupCommand);
  log.info("box.created", { name: input.name, image, profile, cpus: input.cpus, memoryMb: input.memoryMb });
  return containerId;
}
