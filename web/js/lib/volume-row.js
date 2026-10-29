/** What the storage page's volume rows need beyond the volume: its latest checkpoint, and how to snapshot it. */

import { hostOnAgentTransport } from "./host-list.js";

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
 * How a snapshot of the volume is taken. An owned volume goes with its owner box, which always includes it, so it is a
 * checkpoint of that box. An independent volume is snapshotted on its own, without any box: `own` says so, and the plan
 * names no box, so a volume no box mounts can be snapshotted too. `block` is the i18n key of why it cannot be taken, and
 * is empty when it can.
 */
export function snapshotPlan(volume) {
  if (!volume.checkpoint || volume.role === "tools") return { block: "vol.snapshotExcluded" };
  if (volume.ownership === "owned") {
    if (volume.ownerMissing || !volume.ownerBoxId) return { block: "vol.snapshotNoBox" };
    const name = volume.mounts.find((mount) => mount.boxId === volume.ownerBoxId)?.boxName ?? null;
    return { block: "", own: false, boxId: volume.ownerBoxId, boxName: name, include: [] };
  }
  return { block: "", own: true, boxId: null, boxName: null, include: [volume.id] };
}

/**
 * Why a volume on an agent host cannot be browsed, measured or snapshotted, as the i18n key of the reason, or "" when it
 * can. An agent runs boxes only: the file browser and the usage reading both need a helper container, and a checkpoint
 * commits a system image and copies the volume through one, so all three are refused there. A host the list does not
 * name yet is not called an agent, so a page that opens before the host list loads keeps every button.
 */
export const agentVolumeBlock = (volume, hosts) => (hostOnAgentTransport(volume.hostId, hosts) ? "vol.agentHost" : "");

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
