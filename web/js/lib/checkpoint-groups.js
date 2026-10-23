/** The storage page's checkpoint timeline: every checkpoint, grouped by the box it was taken of. No DOM, so tests load it. */

const time = (checkpoint) => Date.parse(checkpoint.createdAt) || 0;

/**
 * One group per box, each with its checkpoints newest first and their total size. A box that still exists keeps its
 * current name, and one with no checkpoints gets an empty group, so a checkpoint can be taken from it. Checkpoints of a
 * deleted box form a group of their own under the name they were taken with. Groups with a rollback waiting for its
 * confirm or undo come first, then the rest by their newest checkpoint, then the empty ones, then the deleted boxes.
 */
export function groupCheckpoints(checkpoints, boxes, pending = new Map()) {
  const groups = new Map();
  for (const box of boxes) {
    groups.set(box.boxId, { id: box.boxId, name: box.name, box, deleted: false, rows: [], bytes: 0, newest: 0 });
  }
  for (const checkpoint of checkpoints) {
    const id = checkpoint.boxId ?? `deleted:${checkpoint.boxName ?? ""}`;
    let group = groups.get(id);
    if (!group) {
      group = { id, name: checkpoint.boxName ?? "—", box: null, deleted: true, rows: [], bytes: 0, newest: 0 };
      groups.set(id, group);
    }
    group.rows.push(checkpoint);
    group.bytes += checkpoint.bytes ?? 0;
    group.newest = Math.max(group.newest, time(checkpoint));
  }
  const rank = (group) => {
    if (pending.get(group.id)) return 0;
    if (group.deleted) return 3;
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
