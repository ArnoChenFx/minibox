/** The storage page's checkpoint timeline: every checkpoint, grouped by the box it was taken of. No DOM, so tests load it. */

const time = (checkpoint) => Date.parse(checkpoint.createdAt) || 0;

/** A volume's identity survives renames and distinguishes equal names on different hosts or after recreation. */
export function checkpointGroupId(checkpoint) {
  if (!checkpoint.legacy && checkpoint.boxId === null) {
    return `volume:${checkpoint.data?.[0]?.volumeId ?? checkpoint.id}`;
  }
  return checkpoint.boxId ?? `deleted:${checkpoint.boxName ?? ""}`;
}

/**
 * One group per box, each with its checkpoints newest first and their total size. A box that still exists keeps its
 * current name, and one with no checkpoints gets an empty group, so a checkpoint can be taken from it. Checkpoints of a
 * deleted box form a group of their own under the name they were taken with.
 *
 * A checkpoint whose record names no box is a snapshot of one volume, taken on its own. Its record carries the volume's
 * name as its box name, so those checkpoints form a group named after the volume, and `volume` marks it: the group is not
 * a deleted box, and its rows say so instead of offering a rollback.
 *
 * Groups with a rollback waiting for its confirm or undo come first, then the rest by their newest checkpoint, then the
 * empty ones, then the deleted boxes and the volume snapshots.
 */
export function groupCheckpoints(checkpoints, boxes, pending = new Map()) {
  const groups = new Map();
  for (const box of boxes) {
    groups.set(box.boxId, { id: box.boxId, name: box.name, box, deleted: false, rows: [], bytes: 0, newest: 0 });
  }
  for (const checkpoint of checkpoints) {
    // Only a record that names no box and is not a legacy snapshot is a snapshot of one volume: a legacy snapshot has
    // no volume data, so it stays a deleted box's group even when its image carried no box id.
    const volume = !checkpoint.legacy && checkpoint.boxId === null;
    // A legacy snapshot can name no box at all, so it keeps the fallback key a deleted box's group always had.
    const id = checkpointGroupId(checkpoint);
    let group = groups.get(id);
    if (!group) {
      group = {
        id,
        name: checkpoint.boxName ?? "—",
        box: null,
        deleted: !volume,
        volume,
        rows: [],
        bytes: 0,
        newest: 0,
      };
      groups.set(id, group);
    }
    group.rows.push(checkpoint);
    group.bytes += checkpoint.bytes ?? 0;
    group.newest = Math.max(group.newest, time(checkpoint));
  }
  const rank = (group) => {
    if (pending.get(group.id)) return 0;
    // A group that is not a box, such as a deleted box's or a volume's snapshots, comes after the boxes.
    if (!group.box) return 3;
    return group.rows.length ? 1 : 2;
  };
  return [...groups.values()]
    .map((group) => ({
      ...group,
      pending: pending.get(group.id) ?? null,
      rows: group.rows.toSorted((a, b) => time(b) - time(a)),
    }))
    .toSorted((a, b) => rank(a) - rank(b) || b.newest - a.newest || a.name.localeCompare(b.name));
}
