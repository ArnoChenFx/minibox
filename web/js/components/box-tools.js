import { api, enc } from "../lib/api.js";
import { toolJsonEntry, toolJsonText } from "../lib/custom-tool-json.js";
import { copyText, esc } from "../lib/dom.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { subscribe } from "../lib/live.js";
import { toolAction, filterTools, groupTools } from "../lib/tool-list.js";
import { emptyState, toast, toastError } from "../lib/ui.js";
import { openCustomToolDialog, deleteCustomTool } from "./custom-tool-dialog.js";
import { searchBoxHtml, bindSearchBox } from "./search-box.js";
import { openTasks } from "./tasks.js";

const TOOL_COLUMNS = 5;

const categoryLabel = (id) => t(`tool.cat.${id}`);

function toolGroupRow(group, collapsed) {
  return `<tr class="group-row"><td colspan="${TOOL_COLUMNS}">
    <button type="button" class="group-toggle" data-action="toggle-group" data-group="${esc(group.id)}" aria-expanded="${!collapsed}">
      ${icon("chevron")}<strong>${esc(categoryLabel(group.category))}</strong><span class="badge">${group.rows.length}</span>
    </button>
  </td></tr>`;
}

function toolInstalledCell(tool) {
  if (!tool.installed) return `<span class="subtle tool-missing">${esc(t("bd.toolsNotInstalled"))}</span>`;
  const version = tool.installedVersion ? `<span class="mono subtle">${esc(tool.installedVersion)}</span>` : "";
  const outside = tool.managed ? "" : `<span class="help">${esc(t("tool.foundOutside"))}</span>`;
  return `<div class="tool-state"><span class="badge badge-success">${esc(t("bd.toolsInstalled"))}</span>${version}${outside}</div>`;
}

/** A tool with a queued or running task shows that task's state in place of its buttons, so it is not started twice. */
function busyBadge(status) {
  const queued = status === "queued";
  const mark = queued ? "" : '<span class="spinner" aria-hidden="true"></span>';
  return `<span class="badge${queued ? "" : " badge-accent"} tool-busy">${mark}${esc(t(`task.status.${status}`))}</span>`;
}

function toolActionCell(tool, busy) {
  const id = esc(tool.id);
  if (busy) return busyBadge(busy);
  switch (toolAction(tool)) {
    case "needsRoot":
      return `<span class="badge badge-warning" title="${esc(t("tool.needsRootHelp"))}">${esc(t("tool.needsRoot"))}</span>`;
    case "managed":
      return `<button class="btn btn-sm" data-action="tool-upgrade" data-tool="${id}">${t("bd.toolsUpgrade")}</button>
        <button class="btn btn-sm" data-action="tool-uninstall" data-tool="${id}">${t("bd.toolsUninstall")}</button>`;
    case "outside":
      return "";
    default:
      return `<button class="btn btn-sm btn-primary" data-action="tool-install" data-tool="${id}">${t("bd.toolsInstall")}</button>`;
  }
}

function customActionCell(tool) {
  const id = esc(tool.id);
  return `<button class="btn btn-sm btn-ghost" data-action="tool-custom-edit" data-tool="${id}">${esc(t("bd.customEdit"))}</button>
        <button class="btn btn-sm btn-ghost" data-action="tool-custom-delete" data-tool="${id}">${esc(t("bd.customDelete"))}</button>`;
}

/**
 * Every row offers the catalog entry as JSON, built-in or custom, so a fork starts from a copy. The button is its icon
 * alone at every width: the words are its tooltip, which says what the copy is for, and its accessible name, so the row
 * keeps the room the actions beside it need on a phone.
 */
function copyJsonButton(tool) {
  return `<button type="button" class="btn btn-sm btn-ghost tool-copy" data-action="tool-copy-json" data-tool="${esc(tool.id)}" aria-label="${esc(t("bd.toolCopyJson"))}" title="${esc(t("bd.toolCopyJsonHelp"))}">${icon("copy")}</button>`;
}

function toolRow(tool, isCustom, busy) {
  const badge = isCustom
    ? ` <span class="badge badge-accent" title="${esc(t("bd.customBadgeHelp"))}">${esc(t("bd.customBadge"))}</span>`
    : "";
  return `<tr>
    <td><strong>${esc(tool.name)}</strong>${badge}<div class="help">${esc(tool.description)}</div>${tool.requires ? `<div class="help">${esc(tool.requires)}</div>` : ""}</td>
    <td class="mono">${esc(tool.id)}</td>
    <td>${tool.desiredVersion ? esc(tool.desiredVersion) : "—"}</td>
    <td>${toolInstalledCell(tool)}</td>
    <td class="tool-action-cell"><div class="tool-actions">${toolActionCell(tool, busy)}${isCustom ? customActionCell(tool) : ""}${copyJsonButton(tool)}</div></td>
  </tr>`;
}

/**
 * The box's tool catalog with its groups. The groups start open; each folds from its header. A search always shows its
 * matches, whichever groups are folded.
 */
export function mountTools(root, { box, refreshBox }) {
  const collapsed = new Set();
  /** Tool tasks for this box that have not ended: task id to `{ tool, status }`. */
  const pending = new Map();
  const busyOf = (toolId) => [...pending.values()].find((entry) => entry.tool === toolId)?.status;
  let tools = null;
  /** The custom entries by id. Only an owner can list them, so for everyone else this stays empty. */
  let custom = new Map();
  let query = "";
  root.innerHTML = `<div class="card">
      <div class="card-head with-tools"><h3>${t("bd.toolsTitle")}</h3>
        <div class="list-tools">
          ${searchBoxHtml({ id: "bdToolSearch", placeholder: t("tool.searchPlaceholder"), label: t("tool.search") })}
          <button class="btn btn-sm" data-action="tool-custom-add" id="bdToolCustomAdd" hidden>${icon("plus")}${t("bd.customAdd")}</button>
          <button class="btn btn-sm" data-action="tool-reconcile">${icon("refresh")}${t("bd.toolsReconcile")}</button>
        </div></div>
      <div class="card-body"><p class="help">${t("bd.toolsHelp")}</p></div>
      <div class="table-wrap"><table class="table"><thead><tr>
        <th>${t("bd.toolsColName")}</th><th>${t("bd.toolsColId")}</th><th>${t("bd.toolsColDesired")}</th><th>${t("bd.toolsColInstalled")}</th><th></th>
      </tr></thead><tbody id="bdToolRows"><tr><td colspan="${TOOL_COLUMNS}"><span class="spinner"></span> ${esc(t("bd.toolsLoading"))}</td></tr></tbody></table></div></div>`;
  const body = root.querySelector("#bdToolRows");
  const addButton = root.querySelector("#bdToolCustomAdd");

  const drawRows = () => {
    if (!tools) return;
    const matches = filterTools(tools, query, categoryLabel);
    if (!matches.length) {
      body.innerHTML = `<tr><td colspan="${TOOL_COLUMNS}">${emptyState({
        iconName: "search",
        title: t("tool.noMatch"),
        text: t("tool.noMatchText", { q: esc(query) }),
        action: `<button class="btn btn-sm" data-action="clear-search">${t("common.clearSearch")}</button>`,
      })}</td></tr>`;
      return;
    }
    const searching = query.trim() !== "";
    body.innerHTML = groupTools(matches)
      .map((group) => {
        const isCollapsed = !searching && collapsed.has(group.id);
        const rows = group.rows.map((tool) => toolRow(tool, custom.has(tool.id), busyOf(tool.id))).join("");
        return toolGroupRow(group, isCollapsed) + (isCollapsed ? "" : rows);
      })
      .join("");
  };
  const load = async () => {
    const [listed, entries, recent] = await Promise.allSettled([
      api(`/api/tools?id=${enc(box().id)}`),
      api("/api/tools/custom"),
      api("/api/tasks?limit=30"),
    ]);
    if (recent.status === "fulfilled") notePending(recent.value.tasks ?? []);
    custom = new Map(entries.status === "fulfilled" ? entries.value.tools.map((entry) => [entry.id, entry]) : []);
    addButton.hidden = entries.status !== "fulfilled";
    if (listed.status === "rejected") {
      body.innerHTML = `<tr><td colspan="${TOOL_COLUMNS}">${emptyState({ iconName: "alert", title: t("bd.toolsLoadFailed"), text: esc(listed.reason.message) })}</td></tr>`;
      return;
    }
    tools = listed.value.tools;
    drawRows();
  };
  const customDialog = (entry) =>
    openCustomToolDialog({
      entry,
      catalogIds: new Set((tools ?? []).map((item) => item.id)),
      customById: custom,
      onSaved: () => void load(),
    });
  /** Copies one row's catalog entry as JSON: the same shape a tools.d file holds, so it can be pasted back as a new tool. */
  const copyJson = async (toolId) => {
    const tool = (tools ?? []).find((item) => item.id === toolId);
    if (!tool) return;
    try {
      await copyText(toolJsonText(toolJsonEntry(tool, custom)));
      toast(t("bd.toolCopyJsonDone"));
    } catch (e) {
      toastError(t("bd.toolCopyJsonFailed"), e);
    }
  };
  const search = bindSearchBox(root.querySelector("#bdToolSearch"), (text) => {
    query = text;
    drawRows();
  });
  const toggleGroup = (id) => {
    if (collapsed.has(id)) collapsed.delete(id);
    else collapsed.add(id);
    drawRows();
    [...root.querySelectorAll(".group-toggle")].find((button) => button.dataset.group === id)?.focus();
  };
  /** Picks up this box's tool tasks that are queued or running, including ones started elsewhere (API, MCP). */
  const notePending = (list) => {
    for (const task of list) {
      if (!task.op?.startsWith("tool.") || task.target?.id !== box().id || !task.subject) continue;
      if (task.status === "queued" || task.status === "running")
        pending.set(task.id, { tool: task.subject, status: task.status });
      else pending.delete(task.id);
    }
  };
  const start = async (path, tool) => {
    try {
      const payload = tool ? { tool, version: "latest" } : undefined;
      const res = await api(path, { method: "POST", ...(payload ? { body: payload } : {}) });
      let queued = false;
      if (res?.taskId) {
        const task = await api(`/api/tasks/${enc(res.taskId)}`).catch(() => null);
        queued = task?.status === "queued";
        if (tool) pending.set(res.taskId, { tool, status: task?.status ?? "running" });
        drawRows();
        openTasks(res.taskId);
      }
      toast(t(queued ? "bd.toolsTaskQueued" : "bd.toolsTaskStarted"));
      await load();
      void refreshBox?.().catch(() => {});
    } catch (e) {
      toastError(t("bd.toolsTaskFailed"), e);
    }
  };
  const offTask = subscribe("task", (frame) => {
    if (frame.kind !== "status") return;
    const entry = pending.get(frame.taskId);
    if (frame.status === "running") {
      if (entry) {
        entry.status = "running";
        drawRows();
      }
      return;
    }
    if (pending.delete(frame.taskId)) void load();
  });
  root.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-action]");
    if (!btn) return;
    const b = box();
    const tool = btn.dataset.tool;
    if (btn.dataset.action === "clear-search") search.clear();
    if (btn.dataset.action === "toggle-group") toggleGroup(btn.dataset.group);
    if (btn.dataset.action === "tool-install") void start(`/api/boxes/${enc(b.id)}/tools/install`, tool);
    if (btn.dataset.action === "tool-upgrade") void start(`/api/boxes/${enc(b.id)}/tools/upgrade`, tool);
    if (btn.dataset.action === "tool-uninstall") void start(`/api/boxes/${enc(b.id)}/tools/uninstall`, tool);
    if (btn.dataset.action === "tool-reconcile") void start(`/api/boxes/${enc(b.id)}/tools/reconcile`);
    if (btn.dataset.action === "tool-custom-add") customDialog(null);
    if (btn.dataset.action === "tool-copy-json") void copyJson(tool);
    if (btn.dataset.action === "tool-custom-edit" && custom.has(tool)) customDialog(custom.get(tool));
    if (btn.dataset.action === "tool-custom-delete" && custom.has(tool)) {
      void deleteCustomTool(custom.get(tool), { onDeleted: () => void load() });
    }
  });
  void load();
  return () => offTask();
}
