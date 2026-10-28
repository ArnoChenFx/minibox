/**
 * The storage page's two destructive batch flows: cleaning up orphaned volumes, and deleting the volumes the user picked.
 * Both ask the server for a preview first, list what would happen to each row in a dialog, and only then send the request
 * that does it, reporting the tally. This module owns those dialogs and requests; the page owns the volumes and the
 * selection, and hands them over through `ids()` and `clearSelection()`, so a redraw of the table and a flow that ends
 * cannot disagree about what is selected. It draws no part of the page and loads nothing.
 */

import { api, errorText } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { bytes, dateTime } from "../lib/format.js";
import { hostName, multiHost } from "../lib/hosts.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { checkboxField, openDialog, toast, toastError } from "../lib/ui.js";
import { previewOutcome, tallyRows } from "../lib/volume-select.js";
import { bindToggles, limitList } from "./list-toggle.js";
import { blockedText } from "./volume-cells.js";

/**
 * A dialog that shows what a change to volumes would do. It resolves to the dialog's root when its confirm button is
 * pressed, and to null when it is closed another way. Cancel has the focus, so Enter does not confirm a removal.
 */
function previewDialog({ title, description, body, confirmText, confirmDisabled = false }, draw) {
  return new Promise((resolve) => {
    let confirmed = false;
    const { root, close } = openDialog({
      title,
      description,
      iconName: "alert",
      tone: "danger",
      wide: true,
      body,
      footer: `<button class="btn" data-close autofocus>${t("common.cancel")}</button><button class="btn btn-danger" id="vol-ok"${confirmDisabled ? " disabled" : ""}>${esc(confirmText)}</button>`,
      onClose: () => resolve(confirmed ? root : null),
    });
    draw(root);
    root.querySelector("#vol-ok").addEventListener("click", () => {
      confirmed = true;
      close();
    });
  });
}

/**
 * Draws a preview table into `box`. A long table shows its first rows and a toggle for the rest. The scope remembers
 * whether the toggle is open, so a redraw keeps it.
 */
function drawTable(box, scope, { head, items, row }) {
  const { shown, toggle } = limitList(scope, "rows", items);
  box.innerHTML = `<div class="table-wrap"><table class="table">
      <thead><tr>${head}</tr></thead>
      <tbody>${shown.map(row).join("")}</tbody>
    </table></div>
    <div class="list-more">${toggle}</div>`;
  bindToggles(scope, box, () => drawTable(box, scope, { head, items, row }));
}

/** One line for each host a prune did not check. The volumes on such a host were left alone. */
const skippedHostNotes = (hosts) =>
  hosts.filter((host) => host.status !== "checked").map((host) => errorText(host.error));

function pruneRowHtml(volume, showHost) {
  return `<tr>
    <td><strong>${esc(volume.name)}</strong></td>
    ${showHost ? `<td>${esc(hostName(volume.hostId))}</td>` : ""}
    <td class="num">${esc(bytes(volume.bytes))}</td>
    <td>${esc(dateTime(volume.lastUsedAt))}</td>
    <td>${volume.formerBox ? esc(volume.formerBox) : "—"}</td>
    <td class="nowrap">${esc(volume.keepsCopy ? t("vol.willKeepBin") : t("vol.willDeleteForever"))}</td>
  </tr>`;
}

function deleteRowHtml(row, skipTrash, showHost) {
  const outcome = previewOutcome(row, skipTrash);
  const action = outcome.blocked
    ? `<span class="subtle">${esc(blockedText(outcome.blocked))}</span>`
    : esc(outcome.keepsCopy ? t("vol.willKeepBin") : t("vol.willDeleteForever"));
  return `<tr>
    <td><strong>${esc(row.name)}</strong></td>
    ${showHost ? `<td>${esc(hostName(row.hostId))}</td>` : ""}
    <td class="num">${esc(bytes(row.bytes))}</td>
    <td>${action}</td>
  </tr>`;
}

/**
 * The preview of a batch delete. The server answers a request without confirm with its preview and removes nothing, so
 * this only reads that answer.
 */
async function previewDelete(ids) {
  try {
    await api("/api/volumes/delete", { method: "POST", body: { ids } });
    return [];
  } catch (err) {
    if (err.code !== "confirmation_required" || !err.details?.preview) throw err;
    return err.details.preview.volumes;
  }
}

/**
 * The page's batch flows. `ids()` is the selection as volume ids in table order, `clearSelection()` empties it, and
 * `reload()` reads the page again after a flow changed something. The flows keep no state of their own.
 */
export function mountVolumeBatch({ ids, clearSelection, reload }) {
  const pruneOrphans = async () => {
    let preview;
    try {
      preview = await api("/api/volumes/prune", { method: "POST", body: { dryRun: true } });
    } catch (err) {
      return toastError(t("vol.pruneFailed"), err);
    }
    const notes = skippedHostNotes(preview.hosts);
    if (!preview.volumes.length) return toast(t("vol.pruneNone"), { type: "info", message: notes.join(" ") });
    const showHost = multiHost();
    const scope = {};
    const confirmed = await previewDialog(
      {
        title: t("vol.pruneTitle"),
        description: esc(t("vol.pruneDesc")),
        body: `<div class="preview-notes">${notes.map((note) => `<div class="callout warn">${icon("alert")}<span>${esc(note)}</span></div>`).join("")}</div><div class="prune-list"></div>`,
        confirmText: t("vol.pruneConfirm"),
      },
      (root) => {
        const head = `<th>${t("vol.colName")}</th>${showHost ? `<th>${t("vol.colHost")}</th>` : ""}<th class="num">${t("vol.colBytes")}</th><th>${t("vol.lastUsed")}</th><th>${t("vol.formerBox")}</th><th>${t("vol.colAction")}</th>`;
        drawTable(root.querySelector(".prune-list"), scope, {
          head,
          items: preview.volumes,
          row: (volume) => pruneRowHtml(volume, showHost),
        });
      },
    );
    if (!confirmed) return;
    let result;
    try {
      // Only the volumes the preview showed: the server refuses any that stopped being orphans and removes nothing else.
      const orphans = preview.volumes.map((volume) => volume.id);
      result = await api("/api/volumes/prune", { method: "POST", body: { dryRun: false, ids: orphans } });
    } catch (err) {
      return toastError(t("vol.pruneFailed"), err);
    }
    const tally = tallyRows(result.volumes);
    toast(t("vol.pruned"), {
      type: tally.failed ? "error" : "success",
      message: [t("vol.resultTally", tally), ...skippedHostNotes(result.hosts)].join(" "),
    });
    await reload();
  };

  const deleteSelected = async () => {
    const picked = ids();
    if (!picked.length) return;
    let rows;
    try {
      rows = await previewDelete(picked);
    } catch (err) {
      return toastError(t("vol.deleteFailed"), err);
    }
    const removable = rows.filter((row) => previewOutcome(row, false).removes).length;
    const showHost = multiHost();
    const scope = {};
    const confirmed = await previewDialog(
      {
        title: t("vol.deleteSelectedTitle"),
        description: `${esc(t("vol.deleteSummary", { removed: removable, skipped: rows.length - removable }))} ${esc(t("vol.deleteSelectedDesc"))}`,
        body: `${checkboxField({ id: "bd-skip", label: esc(t("vol.skipTrash")), help: esc(t("vol.skipTrashHelp")) })}<div class="prune-list"></div>`,
        confirmText: t("vol.delete"),
        confirmDisabled: removable === 0,
      },
      (root) => {
        const skip = root.querySelector("#bd-skip");
        const head = `<th>${t("vol.colName")}</th>${showHost ? `<th>${t("vol.colHost")}</th>` : ""}<th class="num">${t("vol.colBytes")}</th><th>${t("vol.colAction")}</th>`;
        const box = root.querySelector(".prune-list");
        const draw = () =>
          drawTable(box, scope, { head, items: rows, row: (row) => deleteRowHtml(row, skip.checked, showHost) });
        skip.addEventListener("change", draw);
        draw();
      },
    );
    if (!confirmed) return;
    const skipTrash = confirmed.querySelector("#bd-skip").checked;
    let done;
    try {
      done = await api("/api/volumes/delete", { method: "POST", body: { ids: picked, confirm: true, skipTrash } });
    } catch (err) {
      return toastError(t("vol.deleteFailed"), err);
    }
    const tally = tallyRows(done.volumes);
    toast(t("vol.bulkDone"), { type: tally.failed ? "error" : "success", message: t("vol.resultTally", tally) });
    clearSelection();
    await reload();
  };

  return { prune: pruneOrphans, deleteSelected };
}
