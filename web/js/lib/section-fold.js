/**
 * Sections of the create dialog that fold under their heading. The folded ones are saved in this browser, so the dialog
 * opens the way the user left it. Pure apart from the storage, which may be unavailable.
 */

const STORAGE_KEY = "minibox.createBox.folded";

/** The ids of the sections saved as folded. Empty when nothing valid is saved or storage is unavailable. */
export function loadFolded() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

/** Saves whether section `id` is folded, keeping the others as they are. */
export function saveFolded(id, folded) {
  const ids = loadFolded();
  if (folded) ids.add(id);
  else ids.delete(id);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage can be disabled. The dialog still keeps the choice while it is open.
  }
}

/** What a heading says about the chosen items: how many, and the first `max` names with an ellipsis for the rest. */
export function chosenSummary(names, max = 3) {
  const shown = names.slice(0, max).join(", ");
  return { count: names.length, names: names.length > max ? `${shown}, …` : shown };
}
