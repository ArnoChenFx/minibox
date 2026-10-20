import { openCreateBox } from "../components/create-box.js";
import { api, enc } from "../lib/api.js";
import { delegate, esc } from "../lib/dom.js";
import { bytes, dateTime, shortId } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { invalidateTemplates } from "../lib/store.js";
import { confirmDialog, emptyState, nameError, promptDialog, skeletonRows, toast, toastError } from "../lib/ui.js";

export function render(view) {
  let items = [];
  view.innerHTML = `
    <div class="page-head">
      <div><h1>${t("nav.snapshots")}</h1><p>${t("sn.subtitle")}</p></div>
      <div class="page-actions"><button class="btn" data-action="refresh">${icon("refresh")}${t("common.refresh")}</button></div>
    </div>
    <div class="callout info" style="margin-bottom:16px">${icon("info")}<span>${t("sn.note")}</span></div>
    <div class="card"><div class="table-wrap"><table class="table">
      <thead><tr><th>${t("sn.colSnapshot")}</th><th class="hide-sm">${t("sn.colSource")}</th><th>${t("tp.size")}</th><th class="hide-sm">${t("bx.colCreated")}</th><th style="text-align:right">${t("bx.colActions")}</th></tr></thead>
      <tbody id="snBody">${skeletonRows(3, 5)}</tbody></table></div></div>`;
  const body = view.querySelector("#snBody");

  const load = async () => {
    try {
      items = (await api("/api/snapshots")).snapshots;
    } catch (e) {
      body.innerHTML = `<tr><td colspan="5">${emptyState({ iconName: "alert", title: t("sn.loadFailed"), text: esc(e.message) })}</td></tr>`;
      return;
    }
    if (!items.length) {
      body.innerHTML = `<tr><td colspan="5">${emptyState({
        iconName: "camera",
        title: t("sn.empty"),
        text: t("sn.emptyText"),
        action: `<a class="btn" href="#/boxes">${icon("box")}${t("sn.goBoxes")}</a>`,
      })}</td></tr>`;
      return;
    }
    body.innerHTML = items
      .map(
        (s) => `<tr>
        <td><div class="name-cell"><span class="avatar">${icon("camera")}</span><div class="truncate"><strong class="mono" style="font-weight:500">${esc(s.ref)}</strong><span class="subtle mono">${esc(shortId(s.id))}</span></div></div></td>
        <td class="hide-sm">${s.source ? esc(s.source) : '<span class="subtle">—</span>'}</td>
        <td class="num">${bytes(s.size)}</td>
        <td class="hide-sm subtle nowrap">${dateTime(s.createdAt)}</td>
        <td><div class="actions">
          <button class="btn btn-sm" data-action="create" data-ref="${esc(s.ref)}">${icon("plus")}${t("box.create")}</button>
          <button class="btn btn-sm" data-action="promote" data-ref="${esc(s.ref)}" data-source="${esc(s.source ?? "")}">${icon("upload")}${t("sn.promote")}</button>
          <button class="icon-btn danger" data-action="delete" data-ref="${esc(s.ref)}" title="${t("sn.delete")}" aria-label="${t("sn.delete")}">${icon("trash")}</button>
        </div></td></tr>`,
      )
      .join("");
  };

  delegate(view, {
    refresh: load,
    create: (b) => openCreateBox({ snapshot: b.dataset.ref, onCreated: (nb) => (location.hash = `#/boxes/${nb.id}`) }),
    promote: async (b) => {
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
      } catch (e) {
        toastError(t("sn.promoteFailed"), e);
      }
    },
    delete: async (b) => {
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

  load();
  return null;
}
