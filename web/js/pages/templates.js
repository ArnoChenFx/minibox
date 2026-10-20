import { openCreateBox } from "../components/create-box.js";
import { api, enc } from "../lib/api.js";
import { delegate, esc } from "../lib/dom.js";
import { bytes, dateTime } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { invalidateTemplates } from "../lib/store.js";
import { confirmDialog, emptyState, toast, toastError, withBusy } from "../lib/ui.js";

export function render(view) {
  let base = "";
  view.innerHTML = `
    <div class="page-head">
      <div><h1>${t("nav.templates")}</h1><p>${t("tp.subtitle")}</p></div>
      <div class="page-actions"><button class="btn" data-action="build">${icon("hammer")}${t("tp.build")}</button></div>
    </div>
    <div class="grid grid-3" id="tpGrid">${'<div class="card"><div class="skeleton sk-block"></div></div>'.repeat(3)}</div>`;
  const grid = view.querySelector("#tpGrid");

  const load = async () => {
    let templates;
    try {
      const r = await api("/api/templates");
      templates = r.templates;
      base = r.baseTemplate;
    } catch (e) {
      grid.innerHTML = `<div class="card" style="grid-column:1/-1">${emptyState({ iconName: "alert", title: t("tp.loadFailed"), text: esc(e.message) })}</div>`;
      return;
    }
    if (!templates.length) {
      grid.innerHTML = `<div class="card" style="grid-column:1/-1">${emptyState({
        iconName: "layers",
        title: t("tp.empty"),
        text: t("tp.emptyText"),
        action: `<button class="btn btn-primary" data-action="build">${icon("hammer")}${t("tp.build")}</button>`,
      })}</div>`;
      return;
    }
    grid.innerHTML = templates
      .map(
        (tp) => `<div class="card" style="display:flex;flex-direction:column">
        <div class="card-body" style="flex:1">
          <div class="row between" style="margin-bottom:12px"><span class="avatar" style="width:36px;height:36px;border-radius:10px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent-text)">${icon("layers")}</span>
          ${tp.ref === base ? `<span class="badge badge-accent">${t("tp.builtin")}</span>` : `<span class="badge">${t("tp.custom")}</span>`}</div>
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

  delegate(view, {
    use: (b) => openCreateBox({ template: b.dataset.ref, onCreated: (b) => (location.hash = `#/boxes/${b.id}`) }),
    build: async (btn) => {
      toast(t("tp.buildStarted"), { type: "info", message: t("tp.buildStartedText") });
      try {
        const r = await withBusy(btn, () => api("/api/templates/base/build", { method: "POST" }));
        invalidateTemplates();
        toast(t("tp.buildDone"), { message: r.ref });
        load();
      } catch (e) {
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

  load();
  return null;
}
