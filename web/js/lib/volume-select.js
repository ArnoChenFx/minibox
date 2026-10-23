/**
 * Which volumes a batch delete can select, and the state of the checkboxes that select them. Pure, so the page and the
 * tests share one rule. A volume a box mounts, and the shared tools volume, cannot be selected: the server refuses both.
 */

/** Why a volume cannot be selected, as a key the page translates, or null when it can be selected. */
export function unselectableReason(volume) {
  if (volume.role === "tools") return "tools";
  if (volume.mounts.length > 0) return "mounted";
  return null;
}

export function isSelectable(volume) {
  return unselectableReason(volume) === null;
}

/**
 * The selection after the header checkbox is pressed. Every selectable match is selected, unless they all were already,
 * in which case they are cleared. Selected volumes outside the matches stay selected.
 */
export function toggleAll(selected, matches) {
  const ids = matches.filter(isSelectable).map((volume) => volume.id);
  const next = new Set(selected);
  const allSelected = ids.length > 0 && ids.every((id) => next.has(id));
  for (const id of ids) {
    if (allSelected) next.delete(id);
    else next.add(id);
  }
  return next;
}

/** The selection after one row's checkbox is pressed. A volume that cannot be selected is never added. */
export function toggleOne(selected, volume, checked) {
  const next = new Set(selected);
  if (checked && isSelectable(volume)) next.add(volume.id);
  else next.delete(volume.id);
  return next;
}

/** The header checkbox for the matches: checked when all their selectable volumes are selected, mixed when some are, and disabled when none can be. */
export function headerState(selected, matches) {
  const ids = matches.filter(isSelectable).map((volume) => volume.id);
  const picked = ids.filter((id) => selected.has(id)).length;
  return {
    disabled: ids.length === 0,
    checked: ids.length > 0 && picked === ids.length,
    indeterminate: picked > 0 && picked < ids.length,
  };
}

/** The selection without the ids of volumes that are gone, or can no longer be selected, once the list is loaded again. */
export function keepSelectable(selected, volumes) {
  const selectable = new Set(volumes.filter(isSelectable).map((volume) => volume.id));
  return new Set([...selected].filter((id) => selectable.has(id)));
}

/** How many rows of a batch delete or a prune ended each way. A row that is only a preview is not counted. */
export function tallyRows(rows) {
  const tally = { removed: 0, refused: 0, failed: 0 };
  for (const row of rows) {
    if (row.status in tally) tally[row.status] += 1;
  }
  return tally;
}

/**
 * What a batch delete does with one row of its preview: whether it removes the volume, and whether a copy of its data is
 * kept in the recycle bin first. The preview is made without skipTrash, so the user's choice is applied here.
 */
export function previewOutcome(row, skipTrash) {
  if (row.blocked) return { removes: false, keepsCopy: false, blocked: row.blocked };
  return { removes: true, keepsCopy: row.trash && !skipTrash, blocked: null };
}
