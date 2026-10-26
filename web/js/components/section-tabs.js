import { esc, revealInStrip } from "../lib/dom.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { tabHash } from "../lib/routes.js";
import { onTabKeydown } from "../lib/tab-nav.js";

/**
 * The tab strip of a section page. `tabs` lists `[key, labelKey, iconName]`. Each tab is a link to its own address, so
 * the active tab is in the URL. Only the active tab keeps `arg`, the box or template that tab works on.
 *
 * The strip answers the arrow keys, Home and End (see lib/tab-nav.js), which move focus within it; Enter, Space and a
 * click open the tab as they always did.
 */
export function sectionTabsHtml(section, tabs, active, arg = "") {
  return `<div class="tabs" role="tablist" aria-label="${esc(t(`nav.${section}`))}">${tabs
    .map(([key, label, iconName]) => {
      const selected = key === active;
      const href = tabHash(section, key, selected ? arg : "");
      return `<a class="tab" role="tab" id="${tabId(section, key)}" aria-selected="${selected}"${selected ? ` aria-controls="sectionBody"` : ""} href="${href}">${icon(iconName)}${esc(t(label))}</a>`;
    })
    .join("")}</div>`;
}

const tabId = (section, key) => `tab-${section}-${key}`;

/** The panel under a section's tab strip, labelled by its active tab. */
export function sectionPanelHtml(section, active) {
  return `<div id="sectionBody" role="tabpanel" aria-labelledby="${tabId(section, active)}"></div>`;
}

/** Scrolls a tab into view when it takes focus, so a strip narrower than its tabs shows where the arrow keys landed. */
function onFocus(event) {
  const tab = event.target instanceof Element ? event.target.closest("[role='tab']") : null;
  if (tab && event.currentTarget.contains(tab)) revealInStrip(event.currentTarget, tab);
}

/**
 * Makes every tab strip inside `root` answer the arrow keys, Home and End, and scroll the focused tab into view. Returns
 * the cleanup that removes the listeners. Call it after the page has drawn its strip.
 */
export function bindTabStrips(root) {
  const strips = [...root.querySelectorAll("[role='tablist']")];
  for (const strip of strips) {
    strip.addEventListener("keydown", onTabKeydown);
    strip.addEventListener("focusin", onFocus);
  }
  return () => {
    for (const strip of strips) {
      strip.removeEventListener("keydown", onTabKeydown);
      strip.removeEventListener("focusin", onFocus);
    }
  };
}
