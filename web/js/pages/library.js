import { mountBoxTab } from "../components/box-tab.js";
import { mountTools } from "../components/box-tools.js";
import { sectionPanelHtml, sectionTabsHtml } from "../components/section-tabs.js";
import { t } from "../lib/i18n.js";
import * as templates from "./templates.js";

const TABS = [
  ["templates", "library.tabTemplates", "layers"],
  ["tools", "library.tabTools", "terminal"],
];

/** Library: the templates new boxes start from, and the tool catalog with what each box has installed. */
export function render(view, tab = "templates", arg = "") {
  view.innerHTML = `
    <div class="page-head"><div><h1>${t("nav.library")}</h1></div></div>
    ${sectionTabsHtml("library", TABS, tab, arg)}
    ${sectionPanelHtml("library", tab)}`;
  const body = view.querySelector("#sectionBody");
  if (tab === "tools") return mountBoxTab(body, { section: "library", tab, arg, mount: mountTools });
  return templates.render(body, arg);
}
