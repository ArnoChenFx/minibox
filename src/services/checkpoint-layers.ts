import type { SystemLayer, DataLayer } from "../checkpoints/types";
import type { HostCtx } from "../host/registry";
import { labelChange } from "../labels";
import { notFound, badRequest, conflict } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { type ImageDetails, isRuntimeError } from "../runtime";
import type { BoxMount, BoxSpec } from "../specs/types";
import type { VolumeRecord } from "../volumes/types";
import type { Box } from "./boxes";
import { envScrubChanges } from "./images";

export interface PlannedLayer {
  volume: VolumeRecord;
  mount: BoxMount;
}

/**
 * The volumes a checkpoint takes: the box's owned volumes (workspace and home, not cache), plus any volume the caller
 * names that the box mounts. Cache and tools are refused when named, because they are never part of a checkpoint.
 */
export function planLayers(host: HostCtx, spec: BoxSpec, named: string[]): PlannedLayer[] {
  const mounted = spec.mounts.flatMap((mount) => {
    const volume = host.volumes.findByEngine(host.host.id, mount.volume);
    return volume ? [{ volume, mount }] : [];
  });
  const included = new Set<string>();
  for (const ref of named) {
    const volume = host.volumes.resolve(ref, host.host.id);
    if (!volume) throw notFound(msg("volume_not_found", { volume: ref }));
    if (!volume.checkpoint || volume.role === "tools") {
      throw badRequest(msg("checkpoint_volume_excluded", { volume: volume.name }), { field: "include" });
    }
    if (!mounted.some((item) => item.volume.id === volume.id)) {
      throw conflict(msg("checkpoint_volume_not_mounted", { volume: volume.name }));
    }
    included.add(volume.id);
  }
  return mounted.filter(({ volume }) => volume.checkpoint && (volume.ownership === "owned" || included.has(volume.id)));
}

export function tagsFor(checkpointId: string, boxId: string, volume: VolumeRecord): string[] {
  return [`checkpoint:${checkpointId}`, `box:${boxId}`, `volume:${volume.id}`];
}

export async function commitSystemLayer(
  host: HostCtx,
  box: Box,
  id: string,
  signal?: AbortSignal,
): Promise<SystemLayer> {
  const repo = `${host.prefix}-checkpoint`;
  const scrub = await envScrubChanges(host, box);
  await host.runtime.commitContainer(box.id, {
    repo,
    tag: id,
    comment: `MiniBox checkpoint of ${box.name}`,
    author: "minibox",
    pause: true,
    signal,
    changes: [labelChange(host.keys.checkpoint, id), labelChange(host.keys.template, "false"), ...scrub],
  });
  const image = `${repo}:${id}`;
  const details = await host.runtime.inspectImage(image);
  return { image, imageId: details.id };
}

/** Removes a system image this checkpoint made. An image that carries another checkpoint's label is left alone. */
export async function removeSystemImage(host: HostCtx, system: SystemLayer, id: string): Promise<void> {
  let details: ImageDetails;
  try {
    details = await host.runtime.inspectImage(system.imageId);
  } catch (e) {
    if (isRuntimeError(e, "not_found")) return;
    throw e;
  }
  if (details.labels[host.keys.checkpoint] !== id) return;
  await host.runtime.removeImage(system.imageId, { force: true });
}

/** Takes back what a failed checkpoint made. A step that fails is logged, and the original error still wins. */
export async function discardTaken(
  host: HostCtx,
  id: string,
  snapshots: string[],
  system: SystemLayer | null,
): Promise<void> {
  for (const snapshotId of snapshots) {
    await host.checkpointEngine.forget(host, snapshotId).catch((e: unknown) => {
      log.warn("checkpoint.discard_failed", { id, snapshot: snapshotId, error: String(e) });
    });
  }
  if (system) {
    await removeSystemImage(host, system, id).catch((e: unknown) => {
      log.warn("checkpoint.discard_failed", { id, image: system.imageId, error: String(e) });
    });
  }
}

/** Writes one snapshot back into a volume that already exists, then sets its root to the owner the snapshot recorded. */
export async function restoreLayer(host: HostCtx, layer: DataLayer, volume: VolumeRecord): Promise<void> {
  await host.checkpointEngine.restore(host, layer.snapshotId, volume.engineName);
  await host.runtime.setVolumeRootOwner(volume.engineName, layer.owner, host.baseTemplateTag);
}

export const slug = (path: string): string => path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "volume";
