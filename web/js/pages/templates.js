import { openCreateBox } from "../components/create-box.js";
import { bindSearchBox, searchBoxHtml } from "../components/search-box.js";
import { openTasks, trackTask } from "../components/tasks.js";
import { api, enc } from "../lib/api.js";
import { delegate, esc } from "../lib/dom.js";
import { bytes, dateTime, shortId } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { filterBySearch } from "../lib/search.js";
import { invalidateTemplates } from "../lib/store.js";
import { templateSearchFields } from "../lib/template-list.js";
import { confirmDialog, emptyState, nameError, promptDialog, toast, toastError, withBusy } from "../lib/ui.js";

function legacyRow(s) {
  return `<tr>
        <td><div class="name-cell"><span class="avatar">${icon("camera")}</span><div class="truncate"><strong class="mono" style="font-weight:500">${esc(s.ref)}</strong><span class="subtle mono">${esc(shortId(s.id))}</span></div></div></td>
        <td class="hide-sm">${s.source ? esc(s.source) : '<span class="subtle">—</span>'}</td>
        <td class="num">${bytes(s.size)}</td>
        <td class="hide-sm subtle nowrap">${dateTime(s.createdAt)}</td>
        <td><div class="actions">
          <button class="btn btn-sm" data-action="snap-create" data-ref="${esc(s.ref)}">${icon("plus")}${t("box.create")}</button>
          <button class="btn btn-sm" data-action="snap-promote" data-ref="${esc(s.ref)}" data-source="${esc(s.source ?? "")}">${icon("upload")}${t("sn.promote")}</button>
          <button class="icon-btn danger" data-action="snap-delete" data-ref="${esc(s.ref)}" title="${t("sn.delete")}" aria-label="${t("sn.delete")}">${icon("trash")}</button>
        </div></td></tr>`;
}

export function render(view, focusName = "") {
  let base = "";
  let templates = null;
  let loadError = null;
  let legacy = null;
  let legacyError = null;
  let query = "";
  let pendingFocus = focusName;

  view.innerHTML = `
    <div class="page-head">
      <div><h1>${t("nav.templates")}</h1><p>${t("tp.subtitle")}</p></div>
      <div class="page-actions">
        ${searchBoxHtml({ id: "tpSearch", placeholder: t("tp.searchPlaceholder"), label: t("tp.search") })}
        <button class="btn" data-action="build">${icon("hammer")}${t("tp.build")}</button>
      </div>
    </div>
    <div class="grid grid-fit" id="tpGrid">${'<div class="card"><div class="skeleton sk-block"></div></div>'.repeat(3)}</div>
    <details class="advanced" id="tpLegacy" hidden>
      <summary>${t("sn.legacyTitle")} <span class="subtle" id="tpLegacyCount"></span></summary>
      <p class="help">${t("sn.legacyText")}</p>
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>${t("sn.colSnapshot")}</th><th class="hide-sm">${t("sn.colSource")}</th><th>${t("tp.size")}</th><th class="hide-sm">${t("bx.colCreated")}</th><th style="text-align:right">${t("bx.colActions")}</th></tr></thead>
        <tbody id="tpLegacyBody"></tbody>
      </table></div></div>
    </details>`;
  const grid = view.querySelector("#tpGrid");
  const legacyBox = view.querySelector("#tpLegacy");
  const legacyBody = view.querySelector("#tpLegacyBody");

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
        (tp) => `<div class="card" style="display:flex;flex-direction:column" data-name="${esc(tp.name)}">
        <div class="card-body" style="flex:1">
          <div class="row between" style="margin-bottom:12px"><span class="avatar" style="width:36px;height:36px;border-radius:10px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent-text)">${icon("layers")}</span>
          <span class="badge${tp.ref === base ? " badge-accent" : ""}">${esc(badge(tp))}</span></div>
          <h3 style="font-size:15px">${esc(tp.name)}</h3>
          <p class="muted" style="font-size:13px;margin-top:4px;min-height:40px">${esc(tp.description ?? t("tp.noDesc"))}</p>
          ${tp.source ? `<div class="help" style="margin-top:-4px;margin-bottom:8px">${esc(t("tp.fromBox", { name: tp.source }))}</div>` : ""}
          <dl class="kv" style="margin-top:14px;font-size:12.5px"><dt>${t("tp.image")}</dt><dd class="mono">${esc(tp.ref)}</dd><dt>${t("tp.size")}</dt><dd>${bytes(tp.size)}</dd><dt>${t("tp.created")}</dt><dd>${dateTime(tp.createdAt)}</dd></dl>
        </div>
        <div class="dialog-foot" style="justify-content:space-between;background:transparent">
          <button class="icon-btn danger" data-action="delete" data-ref="${esc(tp.ref)}" title="${t("tp.delete")}" aria-label="${t("tp.delete")}">${icon("trash")}</button>
          <button class="btn btn-sm btn-primary" data-action="use" data-ref="${esc(tp.ref)}">${icon("plus")}${t("tp.use")}</button>
        </div></div>`,
      )
      .join("");
    const focused = [...grid.querySelectorAll("[data-name]")].find((card) => card.dataset.name === pendingFocus);
    pendingFocus = "";
    if (focused) {
      focused.classList.add("is-focus");
      focused.scrollIntoView({ block: "center" });
    }
  };

  const drawLegacy = () => {
    legacyBox.hidden = !legacyError && !legacy?.length;
    if (legacyBox.hidden) return;
    legacyBox.querySelector("#tpLegacyCount").textContent = legacy ? `(${legacy.length})` : "";
    legacyBody.innerHTML = legacyError
      ? `<tr><td colspan="5">${emptyState({ iconName: "alert", title: t("sn.loadFailed"), text: esc(legacyError.message) })}</td></tr>`
      : legacy.map(legacyRow).join("");
  };

  const search = bindSearchBox(view.querySelector("#tpSearch"), (text) => {
    query = text;
    draw();
  });

  const loadTemplates = async () => {
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

  const loadLegacy = async () => {
    try {
      legacy = (await api("/api/snapshots")).snapshots;
      legacyError = null;
    } catch (e) {
      legacyError = e;
    }
    drawLegacy();
  };

  const load = () => Promise.all([loadTemplates(), loadLegacy()]);

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
    "snap-create": (b) =>
      openCreateBox({ snapshot: b.dataset.ref, onCreated: (nb) => (location.hash = `#/boxes/${nb.id}`) }),
    "snap-promote": async (b) => {
      const name = await promptDialog({
        title: t("sn.promote"),
        description: t("sn.promoteDesc", { ref: esc(b.dataset.ref) }),
        iconName: "upload",
        label: t("sn.templateName"),
        value: b.dataset.source || "",
        placeholder: t("sn.templatePlaceholder"),
        help: t("sn.promoteHelp"),
        confirmText: t("sn.promote"),
        validate: (v) => nameError(v, "templateName"),
      });
      if (!name) return;
      try {
        const r = await api(`/api/snapshots/${enc(b.dataset.ref)}/promote`, { method: "POST", body: { name } });
        invalidateTemplates();
        toast(t("sn.promoted"), { message: r.template.ref });
        load();
      } catch (e) {
        toastError(t("sn.promoteFailed"), e);
      }
    },
    "snap-delete": async (b) => {
      const ok = await confirmDialog({
        title: t("sn.delete"),
        message: t("sn.deleteMessage", { ref: esc(b.dataset.ref) }),
        confirmText: t("sn.delete"),
        danger: true,
      });
      if (!ok) return;
      try {
        await api(`/api/snapshots/${enc(b.dataset.ref)}`, { method: "DELETE" });
        toast(t("sn.deleted"));
        load();
      } catch (e) {
        toastError(t("ba.deleteFailed"), e);
      }
    },
  });

  const onTask = (event) => {
    if (event.detail?.op === "template.build" || event.detail?.op === "template.save") load();
  };
  window.addEventListener("minibox-task-done", onTask);
  load();
  return () => window.removeEventListener("minibox-task-done", onTask);
}
