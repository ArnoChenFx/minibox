import { mountBoxTab } from "../components/box-tab.js";
import { mountCheckpoints } from "../components/checkpoints.js";
import { sectionPanelHtml, sectionTabsHtml } from "../components/section-tabs.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import * as volumes from "./volumes.js";

const TABS = [
  ["volumes", "storage.tabVolumes", "folder"],
  ["checkpoints", "storage.tabCheckpoints", "history"],
];

/** Storage: the volumes, and the checkpoints of each box. The recycle bin opens from here. */
export function render(view, tab = "volumes", arg = "") {
  view.innerHTML = `
    <div class="page-head">
      <div><h1>${t("nav.storage")}</h1></div>
      <div class="page-actions"><a class="btn" href="#/trash">${icon("trash")}${t("nav.trash")}</a></div>
    </div>
    ${sectionTabsHtml("storage", TABS, tab, arg)}
    ${sectionPanelHtml("storage", tab)}`;
  const body = view.querySelector("#sectionBody");
  if (tab === "checkpoints") return mountBoxTab(body, { section: "storage", tab, arg, mount: mountCheckpoints });
  return volumes.render(body);
}
