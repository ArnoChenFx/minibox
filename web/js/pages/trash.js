import { openTasks, taskErrorText, waitTask } from "../components/tasks.js";
import { api, enc, errorText } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { bytes, dateTime } from "../lib/format.js";
import { hostName, multiHost, onHosts } from "../lib/hosts.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { refreshHost } from "../lib/store.js";
import { daysLeft } from "../lib/trash.js";
import {
  confirmDialog,
  emptyState,
  nameError,
  openDialog,
  promptDialog,
  skeletonRows,
  toast,
  toastError,
} from "../lib/ui.js";

const COLUMNS = 6;

const failureOf = (task) => taskErrorText(task.error) || t(`task.status.${task.status}`);

function expiryText(entry) {
  const days = daysLeft(entry.expiresAt);
  if (days === 0) return t("trash.expiringNow");
  return days === 1 ? t("trash.oneDayLeft") : t("trash.daysLeft", { n: days });
}

function entryRow(entry) {
  const where = multiHost() ? ` <span class="subtle">${esc(hostName(entry.hostId))}</span>` : "";
  return `<tr>
    <td><strong>${esc(entry.sourceName)}</strong><div class="subtle mono">${esc(entry.sourceId)}</div></td>
    <td><span class="badge">${esc(t(`trash.kind.${entry.kind}`))}</span>${where}</td>
    <td>${esc(dateTime(entry.deletedAt))}</td>
    <td class="num">${esc(bytes(entry.bytes))}</td>
    <td>${esc(expiryText(entry))}<div class="subtle">${esc(dateTime(entry.expiresAt))}</div></td>
    <td><div class="actions">
      <button class="btn btn-sm" data-action="restore" data-id="${esc(entry.id)}">${icon("refresh")}${t("trash.restore")}</button>
      <button class="btn btn-sm" data-action="purge" data-id="${esc(entry.id)}">${icon("trash")}${t("trash.purge")}</button>
    </div></td>
  </tr>`;
}

const why = (row) => (row.error ? errorText(row.error) : t(`trash.blocked.${row.blocked}`));

/** The entries an empty leaves, one line each with why, for the confirmation and for the result. */
function problemList(rows) {
  return `<ul class="trash-problems">${rows
    .map((row) => `<li><strong>${esc(row.sourceName)}</strong><span class="subtle">${esc(why(row))}</span></li>`)
    .join("")}</ul>`;
}

/** What the server says an empty would do. It changes nothing: a request without confirm only gets this answer. */
async function previewEmpty(ids) {
  try {
    await api("/api/trash/empty", { method: "POST", body: { ids } });
    return { count: 0, bytes: 0, entries: [] };
  } catch (err) {
    if (err.code !== "confirmation_required" || !err.details?.preview) throw err;
    return err.details.preview;
  }
}

/** Tells what an empty did when it did not purge everything: every entry it left or could not purge, and why. */
function resultDialog(result) {
  const problems = result.entries.filter((row) => row.status !== "removed");
  const hostNotes = result.hosts.filter((host) => host.status !== "checked" && host.error);
  openDialog({
    title: t("trash.emptyResultTitle"),
    description: esc(t("trash.emptyResultText", { removed: result.removed, left: result.refused + result.failed })),
    iconName: "alert",
    tone: "danger",
    wide: true,
    body: `${hostNotes.map((host) => `<div class="callout warn">${icon("alert")}<span>${esc(errorText(host.error))}</span></div>`).join("")}${problemList(problems)}`,
    footer: `<button class="btn btn-primary" data-close autofocus>${t("common.close")}</button>`,
  });
}

export function render(view) {
  let entries = null;

  view.innerHTML = `
    <div class="page-head">
      <div><h1>${t("trash.title")}</h1><p>${t("trash.subtitle")}</p></div>
      <div class="page-actions">
        <button class="btn" data-action="refresh">${icon("refresh")}${t("common.refresh")}</button>
        <button class="btn btn-danger" id="trashEmpty" data-action="empty" disabled>${icon("trash")}${t("trash.empty")}</button>
      </div>
    </div>
    <div class="card">
      <div class="table-wrap"><table class="table">
        <thead><tr><th>${t("trash.colName")}</th><th>${t("trash.colKind")}</th><th>${t("trash.colDeleted")}</th><th>${t("trash.colBytes")}</th><th>${t("trash.colExpires")}</th><th></th></tr></thead>
        <tbody id="trashRows">${skeletonRows(3, COLUMNS)}</tbody>
      </table></div>
    </div>`;

  const draw = () => {
    const body = view.querySelector("#trashRows");
    view.querySelector("#trashEmpty").disabled = !entries.length;
    if (!entries.length) {
      body.innerHTML = `<tr><td colspan="${COLUMNS}">${emptyState({ iconName: "trash", title: t("trash.none"), text: esc(t("trash.noneText")) })}</td></tr>`;
      return;
    }
    body.innerHTML = entries.map(entryRow).join("");
  };

  const load = async () => {
    entries = (await api("/api/trash")).trash;
    draw();
  };
  const reload = () => load().catch((e) => toastError(t("trash.loadingFailed"), e));

  const restore = async (entry) => {
    const name = await promptDialog({
      title: t("trash.restoreTitle", { name: entry.sourceName }),
      description: t(entry.kind === "box" ? "trash.restoreBoxDesc" : "trash.restoreVolumeDesc"),
      label: t("trash.restoreName"),
      value: entry.sourceName,
      confirmText: t("trash.restore"),
      iconName: "refresh",
      validate: (value) => nameError(value, "name"),
    });
    if (!name) return;
    try {
      const started = await api(`/api/trash/${enc(entry.id)}/restore`, { method: "POST", body: { name } });
      toast(t("trash.restoreStarted"), { type: "info", message: name });
      const done = await waitTask(started.taskId);
      if (done.status === "succeeded") {
        toast(t("trash.restored"), { message: name });
        refreshHost();
      } else {
        toastError(t("trash.restoreFailed"), { message: failureOf(done) });
      }
    } catch (err) {
      if (err.details?.taskId) openTasks(err.details.taskId);
      else toastError(t("trash.restoreFailed"), err);
    }
    await reload();
  };

  const purge = async (entry) => {
    const ok = await confirmDialog({
      title: t("trash.purgeTitle", { name: entry.sourceName }),
      message: t("trash.purgeMessage"),
      confirmText: t("trash.purge"),
      danger: true,
    });
    if (!ok) return;
    try {
      const started = await api(`/api/trash/${enc(entry.id)}`, { method: "DELETE" });
      toast(t("trash.purgeStarted"), { type: "info", message: entry.sourceName });
      const done = await waitTask(started.taskId);
      if (done.status === "succeeded") toast(t("trash.purged"), { message: entry.sourceName });
      else toastError(t("trash.purgeFailed"), { message: failureOf(done) });
    } catch (err) {
      if (err.details?.taskId) openTasks(err.details.taskId);
      else toastError(t("trash.purgeFailed"), err);
    }
    await reload();
  };

  const emptyBin = async () => {
    if (!entries?.length) return;
    // Only the entries the page shows: one deleted since then is kept, and one that expired since then is skipped.
    const ids = entries.map((entry) => entry.id);
    let preview;
    try {
      preview = await previewEmpty(ids);
    } catch (err) {
      return toastError(t("trash.emptyFailed"), err);
    }
    if (!preview.count) {
      if (preview.entries.length) toastError(t("trash.emptyFailed"), { message: t("trash.emptyAllLeft") });
      else toast(t("trash.emptyNothing"), { type: "info" });
      return reload();
    }
    const left = preview.entries.filter((row) => row.blocked);
    const size = bytes(preview.bytes);
    const ok = await confirmDialog({
      title: t("trash.emptyTitle"),
      message: t(preview.count === 1 ? "trash.emptyMessageOne" : "trash.emptyMessage", { n: preview.count, size }),
      body: `<div class="callout danger">${icon("alert")}<span>${esc(t("trash.emptyIrreversible"))}</span></div>${
        left.length
          ? `<div class="callout warn trash-left">${icon("alert")}<span>${esc(t("trash.emptyLeft", { n: left.length }))}</span></div>${problemList(left)}`
          : ""
      }`,
      confirmText: t("trash.emptyConfirm", { n: preview.count }),
      danger: true,
    });
    if (!ok) return;
    let result;
    try {
      const sure = preview.entries.filter((row) => !row.blocked).map((row) => row.id);
      result = await api("/api/trash/empty", { method: "POST", body: { confirm: true, ids: sure } });
    } catch (err) {
      toastError(t("trash.emptyFailed"), err);
      return reload();
    }
    if (result.refused || result.failed) resultDialog(result);
    else
      toast(t("trash.emptied"), { message: t("trash.emptiedText", { n: result.removed, size: bytes(result.bytes) }) });
    await reload();
  };

  view.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-action]");
    if (!target || !view.contains(target)) return;
    const action = target.dataset.action;
    if (action === "refresh") {
      target.disabled = true;
      await reload();
      target.disabled = false;
      return;
    }
    if (action === "empty") {
      target.disabled = true;
      await emptyBin();
      if (entries?.length) target.disabled = false;
      return;
    }
    const entry = entries?.find((item) => item.id === target.dataset.id);
    if (!entry) return;
    if (action === "restore") await restore(entry);
    if (action === "purge") await purge(entry);
  });

  const offHosts = onHosts(() => entries && draw());
  load().catch((e) => {
    view.querySelector("#trashRows").innerHTML = `<tr><td colspan="${COLUMNS}">${emptyState({
      iconName: "alert",
      title: t("trash.loadingFailed"),
      text: esc(e.message),
    })}</td></tr>`;
  });
  return () => offHosts();
}
