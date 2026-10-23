import { sectionPanelHtml, sectionTabsHtml } from "../components/section-tabs.js";
import { mountStorageCheckpoints } from "../components/storage-checkpoints.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import * as volumes from "./volumes.js";

const TABS = [
  ["volumes", "storage.tabVolumes", "folder"],
  ["checkpoints", "storage.tabCheckpoints", "history"],
];

/** Storage: the volumes, and every checkpoint grouped by box. The recycle bin opens from here. */
export function render(view, tab = "volumes", arg = "") {
  view.innerHTML = `
    <div class="page-head">
      <div><h1>${t("nav.storage")}</h1></div>
      <div class="page-actions"><a class="btn" href="#/trash">${icon("trash")}${t("nav.trash")}</a></div>
    </div>
    ${sectionTabsHtml("storage", TABS, tab, arg)}
    ${sectionPanelHtml("storage", tab)}`;
  const body = view.querySelector("#sectionBody");
  if (tab === "checkpoints") return mountStorageCheckpoints(body, { focus: arg });
  return volumes.render(body);
}
