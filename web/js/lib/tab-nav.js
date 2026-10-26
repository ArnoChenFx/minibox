/**
 * Keyboard navigation for a tab strip, following the WAI-ARIA tabs pattern. The tabs of this console are links, so the
 * browser follows one on Enter or a click as it always did; the arrow keys only move focus within the strip, and the
 * page scrolls the focused tab into view. Home and End jump to the first and last tab, and Space opens the tab that has
 * focus, which a link does not do on its own.
 */

/** The element the event started on, when it can tell what it is nearest to. */
const closestTab = (node) => (typeof node?.closest === "function" ? node.closest("[role='tab']") : null);

/** The tabs of a strip, in the order they are laid out. Tabs that are hidden or disabled are skipped. */
function tabsOf(strip) {
  return [...strip.querySelectorAll("[role='tab']")].filter(
    (tab) => !tab.hasAttribute("disabled") && tab.getAttribute("aria-hidden") !== "true",
  );
}

/** The tab a key press moves to, or null for a key the strip does not handle. Wraps at either end. */
export function tabForKey(tabs, current, key) {
  const count = tabs.length;
  if (count === 0) return null;
  const at = tabs.indexOf(current);
  switch (key) {
    case "ArrowRight":
      return tabs[(at + 1) % count] ?? null;
    case "ArrowLeft":
      return tabs[(at - 1 + count) % count] ?? null;
    case "Home":
      return tabs[0] ?? null;
    case "End":
      return tabs[count - 1] ?? null;
    default:
      return null;
  }
}

/**
 * Moves focus between the tabs of one strip on the arrow keys, Home and End, and opens the focused tab on Space, as the
 * pattern asks of a tab that is not a native button. A press the strip handles has its default cancelled; every other
 * key is left to the browser, so Enter and a click still open the tab.
 */
export function onTabKeydown(event) {
  const strip = event.currentTarget;
  const current = closestTab(event.target);
  if (!current || !strip.contains(current)) return;
  if (event.key === " ") {
    event.preventDefault();
    current.click();
    return;
  }
  const next = tabForKey(tabsOf(strip), current, event.key);
  if (!next) return;
  event.preventDefault();
  next.focus();
}
