/** What the storage page's volume rows need beyond the volume: its latest checkpoint, and how to snapshot it. */

/** The newest checkpoint that holds each volume, by volume id. */
export function latestByVolume(checkpoints) {
  const latest = new Map();
  for (const checkpoint of checkpoints) {
    for (const layer of checkpoint.data) {
      const seen = latest.get(layer.volumeId);
      if (!seen || Date.parse(checkpoint.createdAt) > Date.parse(seen.createdAt))
        latest.set(layer.volumeId, checkpoint);
    }
  }
  return latest;
}

/**
 * How a snapshot of the volume is taken: a checkpoint of a box that mounts it. An owned volume goes with its owner box,
 * which always includes it. An independent one is named in the checkpoint of the first box that mounts it. `block` is
 * the i18n key of why it cannot be taken, and is empty when it can.
 */
export function snapshotPlan(volume) {
  if (!volume.checkpoint || volume.role === "tools") return { block: "vol.snapshotExcluded" };
  if (volume.ownership === "owned") {
    if (volume.ownerMissing || !volume.ownerBoxId) return { block: "vol.snapshotNoBox" };
    const name = volume.mounts.find((mount) => mount.boxId === volume.ownerBoxId)?.boxName ?? null;
    return { block: "", boxId: volume.ownerBoxId, boxName: name, include: [] };
  }
  const mount = volume.mounts[0];
  if (!mount) return { block: "vol.snapshotUnmounted" };
  return { block: "", boxId: mount.boxId, boxName: mount.boxName, include: [volume.id] };
}

/**
 * The boxes that will mount each volume once their staged changes apply, by volume id. A box that already mounts the
 * volume is left out: its staged mount is only a change of path or mode.
 */
export function stagedMountsByVolume(entries, volumes) {
  const mountedOn = new Map(volumes.map((volume) => [volume.id, new Set(volume.mounts.map((mount) => mount.boxId))]));
  const out = new Map();
  for (const { box, staged } of entries) {
    for (const mount of staged?.fields?.mounts ?? []) {
      if (mountedOn.get(mount.volume)?.has(box.boxId)) continue;
      const list = out.get(mount.volume) ?? [];
      list.push(box.name);
      out.set(mount.volume, list);
    }
  }
  return out;
}
