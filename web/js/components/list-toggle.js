import { esc } from "../lib/dom.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { isLong, LIST_LIMIT, shownItems } from "../lib/list-limit.js";

/**
 * Which lists and groups are toggled, per scope: a page's view or a dialog's overlay. A list is toggled when it is
 * expanded and a group when it is folded. The state lives with the scope, so a redraw keeps it, and a new route or
 * dialog starts collapsed.
 */
const toggled = new WeakMap();

export function isToggled(scope, key) {
  return toggled.get(scope)?.has(key) ?? false;
}

export function flip(scope, key) {
  const keys = toggled.get(scope) ?? new Set();
  if (keys.has(key)) keys.delete(key);
  else keys.add(key);
  toggled.set(scope, keys);
  return keys.has(key);
}

/** The button under a long list. Its label gives the full length while the list is collapsed. */
export function listToggleHtml(key, { expanded, total }) {
  const label = expanded ? t("list.collapse") : t("list.showAll", { n: total });
  return `<button type="button" class="list-toggle${expanded ? " is-expanded" : ""}" data-toggle="${esc(key)}" aria-expanded="${expanded}">${icon("chevron")}<span>${esc(label)}</span></button>`;
}

/**
 * What a list draws: the items to show and the toggle to draw under them. Searching shows every match and no toggle, so
 * clearing the search returns the list to the state the user left it in. `keep` marks items that stay visible while the
 * list is collapsed. `limit` is how many items a collapsed list shows, five by default.
 */
export function limitList(scope, key, items, { keep, searching = false, limit = LIST_LIMIT } = {}) {
  const expanded = searching || isToggled(scope, key);
  const shown = shownItems(items, { expanded, keep, limit });
  const toggle =
    !searching && isLong(items.length, limit) ? listToggleHtml(key, { expanded, total: items.length }) : "";
  return { shown, toggle };
}

/**
 * Connects the toggles drawn in `root`. A press flips the toggle and calls `redraw`, which draws `root` again. Focus then
 * returns to the same toggle, so a keyboard user keeps their place. Call it after every draw: the buttons it connects
 * are the ones drawn at that moment.
 */
export function bindToggles(scope, root, redraw) {
  for (const button of root.querySelectorAll("[data-toggle]")) {
    button.addEventListener("click", () => {
      const key = button.dataset.toggle;
      flip(scope, key);
      Promise.resolve(redraw()).then(() => focusToggle(root, key));
    });
  }
}

function focusToggle(root, key) {
  const again = [...root.querySelectorAll("[data-toggle]")].find((button) => button.dataset.toggle === key);
  again?.focus({ preventScroll: true });
}
