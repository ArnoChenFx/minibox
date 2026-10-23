import { esc } from "../lib/dom.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { tabHash } from "../lib/routes.js";

/**
 * The tab strip of a section page. `tabs` lists `[key, labelKey, iconName]`. Each tab is a link to its own address, so
 * the active tab is in the URL. Only the active tab keeps `arg`, the box or template that tab works on.
 */
export function sectionTabsHtml(section, tabs, active, arg = "") {
  return `<div class="tabs" role="tablist">${tabs
    .map(([key, label, iconName]) => {
      const selected = key === active;
      const href = tabHash(section, key, selected ? arg : "");
      return `<a class="tab" role="tab" aria-selected="${selected}" href="${href}">${icon(iconName)}${esc(t(label))}</a>`;
    })
    .join("")}</div>`;
}
