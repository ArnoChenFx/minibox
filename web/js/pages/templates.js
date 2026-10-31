import { openCreateBox } from "../components/create-box.js";
import { openEditTemplate } from "../components/edit-template.js";
import { openForkTemplate } from "../components/fork-template.js";
import { bindToggles, limitList } from "../components/list-toggle.js";
import { bindSearchBox, searchBoxHtml } from "../components/search-box.js";
import { openTasks, trackTask } from "../components/tasks.js";
import { openNewTemplate } from "../components/template-dialog.js";
import { api, enc } from "../lib/api.js";
import { delegate, esc } from "../lib/dom.js";
import { bytes, dateTime, shortId } from "../lib/format.js";
import { hostLabel } from "../lib/host-list.js";
import { hostName, hostsNow, multiHost, refreshHosts } from "../lib/hosts.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { filterBySearch, searchTerms } from "../lib/search.js";
import { invalidateTemplates } from "../lib/store.js";
import {
  forkAction,
  isUnbuilt,
  templateBadge,
  templateCards,
  templateDetailRows,
  templateSearchFields,
  withDraftCards,
  withOfficialCards,
} from "../lib/template-list.js";
import { imageRefOk, KIND_LABEL_KEYS } from "../lib/template-source.js";
import { confirmDialog, emptyState, nameError, promptDialog, toast, toastError, withBusy } from "../lib/ui.js";

/** Operations whose success changes the template list. */
const TEMPLATE_TASK_OPS = new Set([
  "template.build",
  "template.save",
  "template.create",
  "template.rebuild",
  "template.sync",
  "template.official.build",
]);

function legacyRow(s) {
  const where = multiHost() ? `<div class="help">${esc(hostName(s.hostId))}</div>` : "";
  return `<tr>
        <td><div class="name-cell"><span class="avatar">${icon("camera")}</span><div class="truncate"><strong class="mono" style="font-weight:500">${esc(s.ref)}</strong><span class="subtle mono">${esc(shortId(s.id))}</span></div></div></td>
        <td class="hide-sm">${s.source ? esc(s.source) : '<span class="subtle">—</span>'}${where}</td>
        <td class="num">${bytes(s.size)}</td>
        <td class="hide-sm subtle nowrap">${dateTime(s.createdAt)}</td>
        <td><div class="actions">
          <button class="btn btn-sm" data-action="snap-create" data-ref="${esc(s.ref)}">${icon("plus")}${t("box.create")}</button>
          <button class="btn btn-sm" data-action="snap-promote" data-ref="${esc(s.ref)}" data-host="${esc(s.hostId)}" data-source="${esc(s.source ?? "")}">${icon("upload")}${t("sn.promote")}</button>
          <button class="icon-btn danger" data-action="snap-delete" data-ref="${esc(s.ref)}" data-host="${esc(s.hostId)}" title="${t("sn.delete")}" aria-label="${t("sn.delete")}">${icon("trash")}</button>
        </div></td></tr>`;
}

/**
 * One row per host: whether the host holds the template, and for a host that lacks it, a button that copies it from a
 * host that holds it, or builds an official template no host holds yet. An agent host can take neither.
 */
function presenceHtml(card) {
  const unbuilt = isUnbuilt(card);
  return hostsNow()
    .map((host) => {
      const name = esc(hostLabel(host, hostsNow()));
      if (card.holders.includes(host.id)) {
        return `<div class="row between"><span>${name}</span><span class="badge badge-success">${esc(t("tp.present"))}</span></div>`;
      }
      const blocked =
        host.transport === "agent"
          ? t("err.agent_host_unsupported", { feature: t("feature.templates") })
          : host.status === "online"
            ? ""
            : t("tp.hostOffline");
      const action = unbuilt
        ? `data-action="build-official" data-name="${esc(card.name)}" data-host="${esc(host.id)}"`
        : `data-action="sync" data-ref="${esc(card.ref)}" data-host="${esc(host.id)}"`;
      return `<div class="row between"><span>${name}</span><span class="row" style="gap:8px"><span class="badge">${esc(t("tp.absent"))}</span>
        <button class="btn btn-sm" ${action}${blocked ? ` disabled title="${esc(blocked)}"` : ""}>${icon(unbuilt ? "hammer" : "copy")}${esc(t(unbuilt ? "tp.buildHere" : "tp.copyHere"))}</button></span></div>`;
    })
    .join("");
}

/**
 * The setup lines of a card: one per detail the template's devcontainer.json asks for. The command cell truncates, so a
 * long one cannot stretch the card.
 */
function detailsHtml(tp) {
  return templateDetailRows(tp)
    .map((row) => `<dt>${t(row.key)}</dt><dd class="mono truncate" title="${esc(row.text)}">${esc(row.text)}</dd>`)
    .join("");
}

/**
 * The duplicate button of a card. Every card takes one, including an official template no host has built yet: that copy
 * is a draft from the Dockerfile MiniBox ships. A draft card draws no duplicate button, because there is no image behind
 * it.
 */
function forkHtml(tp) {
  const fork = forkAction(tp);
  const label = `${icon("copy")}${t("tp.fork")}`;
  return fork.enabled
    ? `<button class="btn btn-sm" data-action="fork" data-ref="${esc(tp.ref)}" title="${esc(t("tp.fork"))}">${label}</button>`
    : `<button class="btn btn-sm" disabled>${label}</button>`;
}

export function render(view, focusName = "") {
  let base = "";
  let templates = null;
  let officials = [];
  let drafts = [];
  let cards = [];
  let loadError = null;
  let legacy = null;
  let legacyError = null;
  let query = "";
  let pendingFocus = focusName;

  view.innerHTML = `
    <div class="page-head">
      <div><p>${t("tp.subtitle")}</p></div>
      <div class="page-actions">
        ${searchBoxHtml({ id: "tpSearch", placeholder: t("tp.searchPlaceholder"), label: t("tp.search") })}
        <button class="btn" data-action="pull">${icon("download")}${t("tp.pull")}</button>
        <button class="btn" data-action="build">${icon("hammer")}${t("tp.build")}</button>
        <button class="btn btn-primary" data-action="new-template">${icon("plus")}${t("tp.new")}</button>
      </div>
    </div>
    <div class="grid grid-fit" id="tpGrid">${'<div class="card"><div class="skeleton sk-block"></div></div>'.repeat(3)}</div>
    <div class="list-more" id="tpMore"></div>
    <details class="advanced" id="tpLegacy" hidden>
      <summary>${t("sn.legacyTitle")} <span class="subtle" id="tpLegacyCount"></span></summary>
      <p class="help">${t("sn.legacyText")}</p>
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>${t("sn.colSnapshot")}</th><th class="hide-sm">${t("sn.colSource")}</th><th>${t("tp.size")}</th><th class="hide-sm">${t("bx.colCreated")}</th><th style="text-align:right">${t("bx.colActions")}</th></tr></thead>
        <tbody id="tpLegacyBody"></tbody>
      </table></div></div>
    </details>`;
  const grid = view.querySelector("#tpGrid");
  const more = view.querySelector("#tpMore");
  const legacyBox = view.querySelector("#tpLegacy");
  const legacyBody = view.querySelector("#tpLegacyBody");

  const badge = (tp) => t(templateBadge(tp, base));

  const draw = () => {
    if (loadError) {
      more.innerHTML = "";
      grid.innerHTML = `<div class="card" style="grid-column:1/-1">${emptyState({ iconName: "alert", title: t("tp.loadFailed"), text: esc(loadError.message) })}</div>`;
      return;
    }
    if (!templates) return;
    // Drafts come before the official catalog: a just-saved template must not hide behind "Show all".
    cards = withOfficialCards(withDraftCards(templateCards(templates), drafts), officials);
    if (!cards.length) {
      more.innerHTML = "";
      grid.innerHTML = `<div class="card" style="grid-column:1/-1">${emptyState({
        iconName: "layers",
        title: t("tp.empty"),
        text: t("tp.emptyText"),
        action: `<button class="btn btn-primary" data-action="build">${icon("hammer")}${t("tp.build")}</button>`,
      })}</div>`;
      return;
    }
    const matches = filterBySearch(cards, query, (tp) => templateSearchFields(tp, badge(tp)));
    if (!matches.length) {
      more.innerHTML = "";
      grid.innerHTML = `<div class="card" style="grid-column:1/-1">${emptyState({
        iconName: "search",
        title: t("tp.noMatch"),
        text: t("tp.noMatchText", { q: esc(query) }),
        action: `<button class="btn btn-sm" data-action="clear-search">${t("common.clearSearch")}</button>`,
      })}</div>`;
      return;
    }
    const { shown, toggle } = limitList(view, "templates", matches, {
      keep: (tp) => tp.name === pendingFocus,
      searching: searchTerms(query).length > 0,
      defaultExpanded: true,
    });
    grid.innerHTML = shown
      .map((tp) => {
        const draft = tp.draft === true;
        const unbuilt = isUnbuilt(tp);
        // The bundled base template is MiniBox's own: helpers, volumes and the egress proxy run on it, so it cannot be
        // deleted and its card offers no button for it.
        const deleteButton =
          tp.ref === base
            ? "<span></span>"
            : `<button class="icon-btn danger" data-action="delete" data-ref="${esc(tp.ref)}"${draft ? ` data-draft="true" data-host="${esc(tp.hostId)}"` : ""} title="${t("tp.delete")}" aria-label="${t("tp.delete")}">${icon("trash")}</button>`;
        return `<div class="card" style="display:flex;flex-direction:column" data-name="${esc(tp.name)}">
        <div class="card-body" style="flex:1">
          <div class="row between" style="margin-bottom:12px"><span class="avatar" style="width:36px;height:36px;border-radius:10px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent-text)">${icon("layers")}</span>
          <span class="badge${tp.ref === base ? " badge-accent" : ""}">${esc(badge(tp))}</span></div>
          <h3 style="font-size:15px">${esc(tp.name)}</h3>
          <p class="muted" style="font-size:13px;margin-top:4px;min-height:40px">${esc(tp.description ?? t("tp.noDesc"))}</p>
          ${tp.source ? `<div class="help" style="margin-top:-4px;margin-bottom:8px">${esc(t("tp.fromBox", { name: tp.source }))}</div>` : ""}
          ${tp.buildKind && !unbuilt ? `<div class="help" style="margin-top:-4px;margin-bottom:8px">${esc(t("tp.builtFrom", { kind: t(KIND_LABEL_KEYS[tp.buildKind]) }))}</div>` : ""}
          ${draft ? `<div class="help" style="margin-top:-4px;margin-bottom:8px">${esc(t("tp.draftHelp"))}</div>` : unbuilt ? `<div class="help" style="margin-top:-4px;margin-bottom:8px">${esc(t("tp.notBuiltHelp"))}</div>` : ""}
          <dl class="kv" style="margin-top:14px;font-size:12.5px"><dt>${t("tp.image")}</dt><dd class="mono">${esc(tp.ref)}</dd><dt>${t("tp.size")}</dt><dd>${bytes(tp.size)}</dd><dt>${t("tp.created")}</dt><dd>${dateTime(tp.createdAt)}</dd>${detailsHtml(tp)}</dl>
          ${multiHost() && !draft ? `<div class="stack" style="margin-top:14px;gap:6px"><div class="help">${esc(t("tp.hosts"))}</div>${presenceHtml(tp)}</div>` : ""}
        </div>
        <div class="dialog-foot" style="justify-content:space-between;background:transparent">
          ${draft || !unbuilt ? deleteButton : "<span></span>"}
          <div class="actions">
            ${
              draft
                ? `<button class="btn btn-sm" data-action="rebuild" data-draft="true" data-ref="${esc(tp.ref)}" data-host="${esc(tp.hostId)}">${icon("hammer")}${t("tp.buildDraft")}</button>
                 <button class="btn btn-sm" data-action="edit" data-draft="true" data-ref="${esc(tp.ref)}" data-host="${esc(tp.hostId)}" title="${esc(t("tp.edit"))}">${icon("pencil")}${t("tp.edit")}</button>`
                : `${unbuilt && !multiHost() ? `<button class="btn btn-sm" data-action="build-official" data-name="${esc(tp.name)}">${icon("hammer")}${t("tp.buildOfficial")}</button>` : ""}
                 ${forkHtml(tp)}
                 ${tp.buildKind && !unbuilt ? `<button class="btn btn-sm" data-action="edit" data-ref="${esc(tp.ref)}" title="${esc(t("tp.edit"))}">${icon("pencil")}${t("tp.edit")}</button>` : ""}
                 ${tp.buildKind && !unbuilt ? `<button class="btn btn-sm" data-action="rebuild" data-ref="${esc(tp.ref)}" data-host="${esc(tp.holders[0])}">${icon("refresh")}${t("tp.rebuild")}</button>` : ""}
                 <button class="btn btn-sm btn-primary" data-action="use" data-ref="${esc(tp.ref)}">${icon("plus")}${t("tp.use")}</button>`
            }
          </div>
        </div></div>`;
      })
      .join("");
    more.innerHTML = toggle;
    bindToggles(view, more, draw);
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
    await refreshHosts();
    try {
      // The official catalog is extra: when it cannot be read, the page still lists the templates the hosts hold, as the
      // create dialog does.
      const [r, official, saved] = await Promise.all([
        api("/api/templates"),
        api("/api/templates/official").then(
          (body) => body.templates,
          () => [],
        ),
        api("/api/templates/drafts").then(
          (body) => body.templates,
          () => [],
        ),
      ]);
      templates = r.templates;
      officials = official;
      drafts = saved;
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

  /** Reloads the page, optionally bringing the named template's card into focus once it is drawn. */
  const load = (focus = "") => {
    if (focus) pendingFocus = focus;
    return Promise.all([loadTemplates(), loadLegacy()]);
  };

  delegate(view, {
    use: (b) => openCreateBox({ template: b.dataset.ref, onCreated: (b) => (location.hash = `#/boxes/${b.id}`) }),
    "clear-search": () => search.clear(),
    "new-template": () => openNewTemplate({ onCreated: () => load() }),
    pull: async () => {
      const ref = await promptDialog({
        title: t("tp.pullTitle"),
        description: t("tp.pullDesc"),
        iconName: "download",
        label: t("tp.pullLabel"),
        placeholder: "node:24-bookworm-slim",
        help: t("tp.pullHelp"),
        confirmText: t("tp.pull"),
        validate: (v) => (imageRefOk(v) ? "" : t("tp.errImageRef")),
      });
      if (!ref) return;
      try {
        const r = await api("/api/images/pull", { method: "POST", body: { ref } });
        toast(t("tp.pullStarted"), { type: "info", message: ref });
        trackTask(r.taskId);
      } catch (e) {
        if (e.details?.taskId) {
          toast(t("task.alreadyRunning"), { type: "info" });
          openTasks(e.details.taskId);
          return;
        }
        toastError(t("tp.pullFailed"), e);
      }
    },
    fork: (b) => {
      const card = cards.find((tp) => tp.ref === b.dataset.ref);
      if (!card) return;
      openForkTemplate({ card, cards, base, onForked: (template) => load(template?.name) });
    },
    edit: (b) => {
      // A draft has a host of its own, so the card it belongs to is picked by host when two cards share one reference.
      const card = cards.find((tp) =>
        b.dataset.draft === "true"
          ? tp.draft === true && tp.ref === b.dataset.ref && tp.hostId === b.dataset.host
          : tp.ref === b.dataset.ref,
      );
      if (!card) return;
      void openEditTemplate({ card, onEdited: (name) => load(name) });
    },
    rebuild: async (b) => {
      const draft = b.dataset.draft === "true";
      try {
        const path = `/api/templates/${enc(b.dataset.ref)}/rebuild?host=${enc(b.dataset.host)}`;
        const r = await withBusy(b, () => api(path, { method: "POST" }));
        toast(t(draft ? "tp.draftBuildStarted" : "tp.rebuildStarted"), {
          type: "info",
          message: t(draft ? "tp.createStartedText" : "tp.rebuildStartedText"),
        });
        trackTask(r.taskId);
      } catch (e) {
        if (e.details?.taskId) {
          toast(t("task.alreadyRunning"), { type: "info" });
          openTasks(e.details.taskId);
          return;
        }
        toastError(t("tp.rebuildFailed"), e);
      }
    },
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
    "build-official": async (b) => {
      try {
        const query = b.dataset.host ? `?host=${enc(b.dataset.host)}` : "";
        const path = `/api/templates/official/${enc(b.dataset.name)}/build${query}`;
        const r = await withBusy(b, () => api(path, { method: "POST" }));
        toast(t("tp.officialBuildStarted"), { type: "info", message: t("tp.buildStartedText") });
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
      const ref = b.dataset.ref;
      // The draft card names the host that saved it, so a built template of the same name on another host is not the one
      // this button deletes.
      const card = cards.find((tp) =>
        b.dataset.draft === "true"
          ? tp.draft === true && tp.ref === ref && tp.hostId === b.dataset.host
          : tp.ref === ref,
      );
      if (!card) return;
      const draft = card.draft === true;
      // A draft lives on the host that saved it, and has no image to remove there; a built template may be on several.
      const hosts = draft ? [card.hostId] : card.holders;
      const hostsNote =
        multiHost() && !draft
          ? t("tp.deleteHostsExtra", { hosts: card.holders.map((id) => esc(hostName(id))).join(", ") })
          : "";
      const ok = await confirmDialog({
        title: t("tp.delete"),
        message: t(draft ? "tp.deleteDraftMessage" : "tp.deleteMessage", {
          ref: esc(ref),
          extra: `${hostsNote}${t("tp.deleteExtra")}`,
        }),
        confirmText: t("tp.delete"),
        danger: true,
      });
      if (!ok) return;
      try {
        for (const host of hosts) await api(`/api/templates/${enc(ref)}?host=${enc(host)}`, { method: "DELETE" });
        invalidateTemplates();
        toast(t("tp.deleted"));
        load();
      } catch (e) {
        invalidateTemplates();
        load();
        toastError(t("ba.deleteFailed"), e);
      }
    },
    sync: async (b) => {
      try {
        const r = await withBusy(b, () =>
          api(`/api/templates/${enc(b.dataset.ref)}/sync`, { method: "POST", body: { host: b.dataset.host } }),
        );
        toast(t("tp.syncStarted"), { type: "info", message: t("tp.syncStartedText") });
        trackTask(r.taskId);
      } catch (e) {
        if (e.details?.taskId) {
          toast(t("task.alreadyRunning"), { type: "info" });
          openTasks(e.details.taskId);
          return;
        }
        toastError(t("tp.syncFailed"), e);
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
        const r = await api(`/api/snapshots/${enc(b.dataset.ref)}/promote`, {
          method: "POST",
          body: { name, host: b.dataset.host },
        });
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
        await api(`/api/snapshots/${enc(b.dataset.ref)}?host=${enc(b.dataset.host)}`, { method: "DELETE" });
        toast(t("sn.deleted"));
        load();
      } catch (e) {
        toastError(t("ba.deleteFailed"), e);
      }
    },
  });

  const onTask = (event) => {
    if (TEMPLATE_TASK_OPS.has(event.detail?.op)) load();
  };
  window.addEventListener("minibox-task-done", onTask);
  load();
  return () => window.removeEventListener("minibox-task-done", onTask);
}
