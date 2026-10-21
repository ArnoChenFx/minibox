import { openCreateBox } from "../components/create-box.js";
import { bindSearchBox, searchBoxHtml } from "../components/search-box.js";
import { openTasks, trackTask } from "../components/tasks.js";
import { api, enc } from "../lib/api.js";
import { delegate, esc } from "../lib/dom.js";
import { bytes, dateTime } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { filterBySearch } from "../lib/search.js";
import { invalidateTemplates } from "../lib/store.js";
import { templateSearchFields } from "../lib/template-list.js";
import { confirmDialog, emptyState, toast, toastError, withBusy } from "../lib/ui.js";

export function render(view) {
  let base = "";
  let templates = null;
  let loadError = null;
  let query = "";
  view.innerHTML = `
    <div class="page-head">
      <div><h1>${t("nav.templates")}</h1><p>${t("tp.subtitle")}</p></div>
      <div class="page-actions">
        ${searchBoxHtml({ id: "tpSearch", placeholder: t("tp.searchPlaceholder"), label: t("tp.search") })}
        <button class="btn" data-action="build">${icon("hammer")}${t("tp.build")}</button>
      </div>
    </div>
    <div class="grid grid-fit" id="tpGrid">${'<div class="card"><div class="skeleton sk-block"></div></div>'.repeat(3)}</div>`;
  const grid = view.querySelector("#tpGrid");

  const badge = (tp) => (tp.ref === base ? t("tp.builtin") : t("tp.custom"));

  const draw = () => {
    if (loadError) {
      grid.innerHTML = `<div class="card" style="grid-column:1/-1">${emptyState({ iconName: "alert", title: t("tp.loadFailed"), text: esc(loadError.message) })}</div>`;
      return;
    }
    if (!templates) return;
    if (!templates.length) {
      grid.innerHTML = `<div class="card" style="grid-column:1/-1">${emptyState({
        iconName: "layers",
        title: t("tp.empty"),
        text: t("tp.emptyText"),
        action: `<button class="btn btn-primary" data-action="build">${icon("hammer")}${t("tp.build")}</button>`,
      })}</div>`;
      return;
    }
    const matches = filterBySearch(templates, query, (tp) => templateSearchFields(tp, badge(tp)));
    if (!matches.length) {
      grid.innerHTML = `<div class="card" style="grid-column:1/-1">${emptyState({
        iconName: "search",
        title: t("tp.noMatch"),
        text: t("tp.noMatchText", { q: esc(query) }),
        action: `<button class="btn btn-sm" data-action="clear-search">${t("common.clearSearch")}</button>`,
      })}</div>`;
      return;
    }
    grid.innerHTML = matches
      .map(
        (tp) => `<div class="card" style="display:flex;flex-direction:column">
        <div class="card-body" style="flex:1">
          <div class="row between" style="margin-bottom:12px"><span class="avatar" style="width:36px;height:36px;border-radius:10px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent-text)">${icon("layers")}</span>
          <span class="badge${tp.ref === base ? " badge-accent" : ""}">${esc(badge(tp))}</span></div>
          <h3 style="font-size:15px">${esc(tp.name)}</h3>
          <p class="muted" style="font-size:13px;margin-top:4px;min-height:40px">${esc(tp.description ?? t("tp.noDesc"))}</p>
          <dl class="kv" style="margin-top:14px;font-size:12.5px"><dt>${t("tp.image")}</dt><dd class="mono">${esc(tp.ref)}</dd><dt>${t("tp.size")}</dt><dd>${bytes(tp.size)}</dd><dt>${t("tp.created")}</dt><dd>${dateTime(tp.createdAt)}</dd></dl>
        </div>
        <div class="dialog-foot" style="justify-content:space-between;background:transparent">
          <button class="icon-btn danger" data-action="delete" data-ref="${esc(tp.ref)}" title="${t("tp.delete")}" aria-label="${t("tp.delete")}">${icon("trash")}</button>
          <button class="btn btn-sm btn-primary" data-action="use" data-ref="${esc(tp.ref)}">${icon("plus")}${t("tp.use")}</button>
        </div></div>`,
      )
      .join("");
  };

  const search = bindSearchBox(view.querySelector("#tpSearch"), (text) => {
    query = text;
    draw();
  });

  const load = async () => {
    try {
      const r = await api("/api/templates");
      templates = r.templates;
      base = r.baseTemplate;
      loadError = null;
    } catch (e) {
      loadError = e;
    }
    draw();
  };

  delegate(view, {
    use: (b) => openCreateBox({ template: b.dataset.ref, onCreated: (b) => (location.hash = `#/boxes/${b.id}`) }),
    "clear-search": () => search.clear(),
    build: async (btn) => {
      try {
        const r = await withBusy(btn, () => api("/api/templates/base/build", { method: "POST" }));
        toast(t("tp.buildStarted"), { type: "info", message: t("tp.buildStartedText") });
        trackTask(r.taskId);
      } catch (e) {
        if (e.details?.taskId) {
          toast(t("task.alreadyRunning"), { type: "info" });
          openTasks(e.details.taskId);
          return;
        }
        toastError(t("tp.buildFailed"), e);
      }
    },
    delete: async (b) => {
      const isBase = b.dataset.ref === base;
      const ok = await confirmDialog({
        title: t("tp.delete"),
        message: t("tp.deleteMessage", {
          ref: esc(b.dataset.ref),
          extra: isBase ? t("tp.deleteBaseExtra") : t("tp.deleteExtra"),
        }),
        confirmText: t("tp.delete"),
        danger: true,
      });
      if (!ok) return;
      try {
        await api(`/api/templates/${enc(b.dataset.ref)}`, { method: "DELETE" });
        invalidateTemplates();
        toast(t("tp.deleted"));
        load();
      } catch (e) {
        toastError(t("ba.deleteFailed"), e);
      }
    },
  });

  const onTask = (event) => {
    if (event.detail?.op === "template.build") load();
  };
  window.addEventListener("minibox-task-done", onTask);
  load();
  return () => window.removeEventListener("minibox-task-done", onTask);
}
