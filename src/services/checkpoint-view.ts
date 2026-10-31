import { legacyCheckpointId } from "../checkpoints/id";
import type { CheckpointRecord } from "../checkpoints/types";
import type { HostCtx } from "../host/registry";
import { notFound } from "../lib/errors";
import { msg } from "../lib/messages";
import type { CheckpointView } from "./checkpoint-model";
import type { ImageItem } from "./images";
import { listSnapshots } from "./snapshots";

export function viewOf(record: CheckpointRecord): CheckpointView {
  return {
    id: record.id,
    legacy: false,
    hostId: record.hostId,
    boxId: record.boxId,
    boxName: record.boxName,
    label: record.label,
    reason: record.reason,
    createdBy: record.createdBy,
    pinned: record.pinned,
    auto: record.auto,
    consistency: record.consistency,
    specRevision: record.specRevision,
    spec: record.spec,
    data: record.data,
    system: record.system,
    bytes: record.data.reduce((sum, layer) => sum + layer.bytes, 0),
    ...(record.remoteSync ? { remoteSync: record.remoteSync } : {}),
    ...(record.remoteFailure ? { remoteFailure: record.remoteFailure } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** A snapshot from before checkpoints: a system layer only. It can be forked and deleted, not changed. */
function legacyView(host: HostCtx, image: ImageItem): CheckpointView {
  return {
    id: legacyCheckpointId(image.id),
    legacy: true,
    hostId: host.host.id,
    boxId: image.sourceId,
    boxName: image.source,
    label: image.name,
    reason: image.description ?? "",
    createdBy: image.createdBy,
    pinned: false,
    auto: false,
    consistency: "pause",
    specRevision: null,
    spec: {
      template: { ref: `snapshot:${image.ref}`, image: image.ref, digest: image.id },
      cpus: null,
      memoryBytes: null,
      profile: null,
    },
    data: [],
    system: { image: image.ref, imageId: image.id },
    bytes: 0,
    createdAt: image.createdAt,
    updatedAt: image.createdAt,
  };
}

/** A checkpoint of this host. A recycle bin entry is not one, so it is never read as a checkpoint. */
export function ownRecord(host: HostCtx, id: string): CheckpointRecord | null {
  const record = host.checkpoints.read(id);
  return record && record.hostId === host.host.id && record.trash === null ? record : null;
}

export async function listCheckpoints(host: HostCtx): Promise<CheckpointView[]> {
  const own = host.checkpoints
    .list()
    .filter((record) => record.hostId === host.host.id && record.trash === null)
    .map(viewOf);
  const legacy = (await listSnapshots(host)).map((image) => legacyView(host, image));
  return [...own, ...legacy].toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getCheckpoint(host: HostCtx, id: string): Promise<CheckpointView> {
  const record = ownRecord(host, id);
  if (record) return viewOf(record);
  const image = (await listSnapshots(host)).find((item) => legacyCheckpointId(item.id) === id);
  if (image) return legacyView(host, image);
  throw notFound(msg("checkpoint_not_found", { id }));
}
