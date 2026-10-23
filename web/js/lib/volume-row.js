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
  // A staged mount names the volume by its engine name, which is its id for a volume MiniBox created and its old name
  // for one it adopted.
  const byRef = new Map();
  for (const volume of volumes) {
    for (const ref of [volume.name, volume.engineName, volume.id]) if (ref) byRef.set(ref, volume);
  }
  const out = new Map();
  for (const { box, staged } of entries) {
    for (const mount of staged?.fields?.mounts ?? []) {
      const volume = byRef.get(mount.volume);
      if (!volume || volume.mounts.some((item) => item.boxId === box.boxId)) continue;
      const list = out.get(volume.id) ?? [];
      list.push(box.name);
      out.set(volume.id, list);
    }
  }
  return out;
}
