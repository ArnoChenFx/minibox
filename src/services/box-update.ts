import type { HostCtx } from "../host/registry";
import { containerName } from "../labels";
import { badRequest, notFound, conflict } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import type { ContainerUpdate } from "../runtime";
import { pushHistory } from "../specs/history";
import { revisionMismatch } from "../specs/revision";
import type { BoxSpec, BoxRecovery } from "../specs/types";
import { type BoxUpdate, MB, type Box } from "./box-model";
import { getBox } from "./box-query";
import { beginChange } from "./moving";

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
  const release = beginChange(current.boxId);
  try {
    return await updateChanging(host, current, revision, patch);
  } finally {
    release();
  }
}

async function updateChanging(host: HostCtx, current: Box, revision: number, patch: BoxUpdate): Promise<Box> {
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
        history: pushHistory(spec),
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
    host.selfTokens.rename(current.boxId, nextName);
  });
  await host.sampler.observe(current.id);
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
