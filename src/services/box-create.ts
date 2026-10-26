import { dirname } from "node:path";

import { hardeningFor } from "../box-profile";
import { OPEN_EGRESS } from "../egress/policy";
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
import { type CreateMount, isRoleMount, mountPointOf, rolesToCreate } from "../volumes/create-mounts";
import { assertVolumesPresent, healSharedToolsMounts, poolsUsed, trackPoolRoots } from "../volumes/engine";
import { assertPoolsReachable } from "../volumes/health";
import { assertMountsWithinLimits } from "../volumes/limits";
import { validMountPath } from "../volumes/mounts";
import { provisionDefaultMounts, provisionRoleMounts } from "../volumes/provision";
import { assertMountAllowed, mountTarget } from "./attachments";
import { type CreateBoxInput, type Box, MB } from "./box-model";
import { ensureBoxNetwork } from "./box-network";
import { getBox } from "./box-query";
import {
  egressEnvOf,
  ensureEgressNetwork,
  ensureEgressProxy,
  planEgress,
  removeEgress,
  syncHostFirewall,
  withoutRawSockets,
} from "./egress";
import { ensureImageOn } from "./images";
import { assertSelfTokenHost, provisionSelfToken, selfTokenTmpfs } from "./self-token";
import { scheduleStartup } from "./startup";
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
async function resolveCreateMounts(host: HostCtx, mounts: BoxMount[], known: Set<string>): Promise<BoxMount[]> {
  const resolved = resolveMounts(host, mounts);
  await healSharedToolsMounts(
    host,
    resolved.map((mount) => mount.volume),
    known,
  );
  for (const mount of resolved) {
    assertMountAllowed(host, null, mount.volume, await mountTarget(host, mount.volume));
  }
  return resolved;
}

/**
 * The mounts a create asked for. A mount that names a volume is attached, with the checks a new box is held to. A mount
 * that names a role has MiniBox create that role's volume for the box, so only the roles the list names exist, and the
 * tools role mounts the host's shared tools volume instead of making a second one. A list with no role mount keeps the
 * mounts exactly as the request gave them.
 */
async function mountsForCreate(
  host: HostCtx,
  requested: readonly CreateMount[],
  box: { id: string; name: string; createdBy: string | null },
  known: Set<string>,
  changes: VolumeChanges,
): Promise<BoxMount[]> {
  const roles = rolesToCreate(requested);
  const created = roles.length === 0 ? [] : await provisionRoleMounts(host, box, roles, known, changes);
  const made = new Map(created.map((mount) => [mount.path, mount]));
  const attached: BoxMount[] = [];
  for (const mount of requested) {
    if (isRoleMount(mount)) {
      const built = made.get(mountPointOf(mount).path);
      if (!built) throw badRequest(msg("mount_create_invalid"));
      made.delete(mountPointOf(mount).path);
      attached.push(built);
      continue;
    }
    attached.push({ volume: mount.volume, ...mountPointOf(mount) });
  }
  if (made.size > 0) throw badRequest(msg("mount_create_invalid"));
  if (roles.length === 0) return resolveCreateMounts(host, attached, known);
  await assertVolumesPresent(
    host,
    attached.map((mount) => mount.volume),
  );
  return attached;
}

function engineMounts(mounts: BoxMount[]): { source: string; target: string; mode: MountMode }[] {
  return mounts.map((mount) => ({ source: mount.volume, target: mount.path, mode: mount.mode }));
}

/** What one create attempt has made so far, so a failed attempt can take it back. */
interface CreateAttempt {
  boxId: string | null;
  containerId: string | null;
  /** True once the box's private network or proxy may exist. */
  egress: boolean;
  changes: VolumeChanges;
}

export async function createBox(
  host: HostCtx,
  input: CreateBoxInput & { templateLabel?: string },
  record?: RecordNote,
): Promise<Box> {
  const attempt: CreateAttempt = { boxId: null, containerId: null, egress: false, changes: new VolumeChanges() };
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
  if (attempt.egress && attempt.boxId) {
    try {
      await removeEgress(host, attempt.boxId);
    } catch (e) {
      log.warn("box.create_rollback_failed", { id: attempt.boxId, error: String(e) });
    }
  }
  if (attempt.boxId) {
    host.startup.endSetup(attempt.boxId);
    host.selfTokens.revoke(attempt.boxId);
    try {
      host.specs.remove(attempt.boxId);
    } catch (e) {
      log.warn("box.create_rollback_failed", { id: attempt.boxId, error: String(e) });
    }
  }
  if (attempt.egress) {
    await syncHostFirewall(host).catch((e: unknown) => {
      log.warn("box.create_rollback_failed", { id: attempt.boxId, error: String(e) });
    });
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
  if (input.selfToken) assertSelfTokenHost(host);
  const awaitsSetup = input.awaitsSetup === true && input.startupCommand !== undefined;
  const env = input.env ?? [];
  assertSecretsSet(host.secrets, env);

  const image = input.image ?? host.baseTemplateTag;
  const profile = input.profile ?? security.defaultProfile;
  const details = await ensureImageOn(host, image);
  const policy = input.egress ?? OPEN_EGRESS;
  if (policy.mode === "open") await ensureBoxNetwork(host);

  const id = boxIdFor(host, input.id);
  attempt.boxId = id;
  const reserved = await host.specs.exclusive(async () => {
    const planned = await planEgress(host, policy);
    if (!planned) return null;
    attempt.egress = true;
    return { egress: planned, network: await ensureEgressNetwork(host, id, planned) };
  });
  const egress = reserved?.egress ?? null;
  const network = reserved?.network ?? security.network;
  const createdBy = input.createdBy ?? "owner";
  const known = new Set<string>([image]);
  const mounts = input.mounts
    ? await mountsForCreate(host, input.mounts, { id, name: input.name, createdBy }, known, attempt.changes)
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
      ...(egress ? { [keys.egress]: JSON.stringify(egress) } : {}),
    };
    await assertVolumesPresent(
      host,
      mounts.map((mount) => mount.volume),
    );
    const containerVars = [...egressEnvOf(egress), ...containerEnv(host.secrets, env)];
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
        network,
        hardening: egress ? withoutRawSockets(hardeningFor(profile, security)) : hardeningFor(profile, security),
        ...(containerVars.length > 0 ? { env: containerVars } : {}),
        ...(input.selfToken ? { tmpfs: selfTokenTmpfs() } : {}),
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
      ...(awaitsSetup ? { startupAwaitsSetup: true } : {}),
      ...(input.selfToken ? { selfToken: true } : {}),
      labels: {},
      lifecycle: {
        desired: "running",
        idleTimeoutSec: input.idleTimeoutSec === undefined ? null : input.idleTimeoutSec,
        ttlSec: input.ttlSec === undefined ? null : input.ttlSec,
        stopReason: null,
      },
      profile,
      network,
      ...(egress ? { egress } : {}),
      restart: "no",
      containerName: name,
      containerId: created.id,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      recovery: null,
      history: [],
    };
    if (awaitsSetup) host.startup.beginSetup(id);
    host.specs.write(spec);
    return created.id;
  });

  if (egress) await ensureEgressProxy(host, { boxId: id, id: containerId, name: input.name }, egress);
  if (egress || security.blockHostGateway) await syncHostFirewall(host);
  await runtime.startContainer(containerId);
  if (input.selfToken) await provisionSelfToken(host, { boxId: id, name: input.name }, containerId);
  await host.sampler.observe(containerId);
  host.pulse.touch(id, "create");
  if (input.startupCommand !== undefined) scheduleStartup(host, id);
  log.info("box.created", { name: input.name, image, profile, cpus: input.cpus, memoryMb: input.memoryMb });
  return containerId;
}
