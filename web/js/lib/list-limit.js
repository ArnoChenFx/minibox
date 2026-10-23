/**
 * Long lists show their first few items and a toggle for the rest. Pure, so the pages and the tests share one rule. The
 * toggle itself is drawn by components/list-toggle.js.
 */

/** How many items a long list shows before its toggle expands it. */
export const LIST_LIMIT = 5;

/** The items with the pinned ones first. Each group keeps the order it had. */
export function pinFirst(items, isPinned) {
  return [...items.filter((item) => isPinned(item)), ...items.filter((item) => !isPinned(item))];
}

/**
 * The items a list shows. All of them when the list is expanded or no longer than `limit`. Otherwise the first `limit`
 * items and every item `keep` marks, such as a selected one, in the order the list has them.
 */
export function shownItems(items, { expanded = false, limit = LIST_LIMIT, keep = () => false } = {}) {
  if (expanded || items.length <= limit) return items;
  return items.filter((item, index) => index < limit || keep(item));
}

/** Whether a list of `count` items needs a toggle: it is longer than the limit. */
export const isLong = (count, limit = LIST_LIMIT) => count > limit;
