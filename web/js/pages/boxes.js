import { actionButtons, deleteBox, lifecycle } from "../components/box-actions.js";
import { takeCheckpoint } from "../components/checkpoints.js";
import { openCreateBox } from "../components/create-box.js";
import { followOverview } from "../components/overview-feed.js";
import { api } from "../lib/api.js";
import { applyBoxFrame, applySamples, boxesOfSync } from "../lib/box-state.js";
import { delegate, esc } from "../lib/dom.js";
import { cpus, gbOrMb, mem, pct, relTime } from "../lib/format.js";
import { boxesOnHost, hostOfBox, isUnreachable } from "../lib/host-list.js";
import { hostFilter, hostName, multiHost, onHosts } from "../lib/hosts.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { pollWhileDown, subscribe } from "../lib/live.js";
import { activityByBox } from "../lib/overview.js";
import { boxState, emptyState, skeletonRows, stateBadge, toastError, usageBar } from "../lib/ui.js";

export function render(view) {
  let boxes = [];
  let filter = "";
  view.innerHTML = `
    <div class="page-head">
      <div><h1>${t("nav.boxes")}</h1><p>${t("bx.subtitle")}</p></div>
      <div class="page-actions">
        <div class="input-group hide-sm" style="width:220px">${icon("search")}<input class="input" id="bxSearch" placeholder="${t("bx.search")}" /></div>
        <button class="btn" data-action="refresh" title="${t("common.refresh")}">${icon("refresh")}${t("common.refresh")}</button>
        <button class="btn btn-primary" data-action="create">${icon("plus")}${t("box.create")}</button>
      </div>
    </div>
    <div class="card"><div class="table-wrap"><table class="table">
      <thead><tr><th>${t("bx.colName")}</th><th>${t("bx.colState")}</th><th class="hide-sm">${t("bx.colTemplate")}</th><th class="hide-sm">${t("bx.colQuota")}</th><th>CPU</th><th>${t("bx.colMem")}</th><th class="hide-sm">${t("bx.colCreated")}</th><th style="text-align:right">${t("bx.colActions")}</th></tr></thead>
      <tbody id="bxBody">${skeletonRows(3, 8)}</tbody>
    </table></div></div>`;

  const body = view.querySelector("#bxBody");
  const find = (id) => boxes.find((b) => b.id === id);

  let activity = new Map();
  const paintActivity = () => {
    for (const badge of body.querySelectorAll("[data-activity]")) {
      const row = activity.get(badge.dataset.activity);
      badge.hidden = !row;
      if (row) badge.innerHTML = `<span class="dot"></span>${esc(t("ov.agentActive", { ago: relTime(row.lastAt) }))}`;
    }
  };

  let loaded = false;
  const draw = () => {
    const scoped = boxesOnHost(boxes, hostFilter());
    const list = scoped.filter(
      (b) => !filter || b.name.toLowerCase().includes(filter) || b.template.toLowerCase().includes(filter),
    );
    if (!boxes.length) {
      body.innerHTML = `<tr><td colspan="8">${emptyState({
        iconName: "box",
        title: t("bx.empty"),
        text: t("bx.emptyText"),
        action: `<button class="btn btn-primary" data-action="create">${icon("plus")}${t("bx.createFirst")}</button>`,
      })}</td></tr>`;
      return;
    }
    if (!scoped.length) {
      body.innerHTML = `<tr><td colspan="8">${emptyState({ iconName: "box", title: t("bx.noHostBoxes"), text: t("bx.noHostBoxesText", { host: esc(hostName(hostFilter())) }) })}</td></tr>`;
      return;
    }
    if (!list.length) {
      body.innerHTML = `<tr><td colspan="8">${emptyState({ iconName: "search", title: t("bx.noMatch"), text: t("bx.noMatchText", { q: esc(filter) }) })}</td></tr>`;
      return;
    }
    body.innerHTML = list
      .map((b) => {
        const s = b.stats;
        const cpuP = s && b.cpus ? s.cpuPercent / b.cpus : s?.cpuPercent;
        const unreachable = isUnreachable(b);
        const where = multiHost() ? ` · ${esc(hostName(hostOfBox(b)))}` : "";
        return `<tr class="clickable${unreachable ? " is-unreachable" : ""}" data-action="open" data-id="${esc(b.id)}">
          <td><div class="name-cell"><span class="avatar">${icon("box")}</span><div class="truncate"><strong>${esc(b.name)}</strong><span class="subtle mono">${esc(b.id.slice(0, 12))}${where}</span></div></div></td>
          <td>${stateBadge(boxState(b))}${b.storage?.status === "unreachable" ? ` <span class="badge badge-danger">${esc(t("vol.unreachable"))}</span>` : ""} <span class="agent-live badge badge-accent" data-activity="${esc(b.id)}" hidden></span></td>
          <td class="hide-sm"><span class="tag truncate" title="${esc(b.template)}">${esc(b.template.replace(/^minibox-template:/, "") || "—")}</span></td>
          <td class="hide-sm num nowrap">${cpus(b.cpus)} · ${mem(b.memory)}</td>
          <td>${s ? usageBar("", cpuP, pct(s.cpuPercent)) : '<span class="subtle">—</span>'}</td>
          <td>${s ? usageBar("", s.memPercent, gbOrMb(s.memUsage), "mem") : '<span class="subtle">—</span>'}</td>
          <td class="hide-sm subtle nowrap" title="${esc(b.createdAt)}">${relTime(b.createdAt)}</td>
          <td><div class="actions">${unreachable ? `<span class="subtle">${t("bx.unreachableHint")}</span>` : actionButtons(b)}</div></td>
        </tr>`;
      })
      .join("");
    paintActivity();
  };

  const load = async () => {
    try {
      boxes = (await api("/api/boxes")).boxes;
      loaded = true;
      draw();
    } catch (e) {
      body.innerHTML = `<tr><td colspan="8">${emptyState({ iconName: "alert", title: t("bx.loadFailed"), text: esc(e.message) })}</td></tr>`;
    }
  };

  view.querySelector("#bxSearch").addEventListener("input", (e) => {
    filter = e.target.value.trim().toLowerCase();
    draw();
  });

  delegate(view, {
    refresh: (btn) => {
      btn.disabled = true;
      load().finally(() => (btn.disabled = false));
    },
    create: () => openCreateBox({ onCreated: load }),
    open: (el) => (location.hash = `#/boxes/${el.dataset.id}`),
    start: (el) => lifecycle(find(el.dataset.id), "start", el).then(load),
    stop: (el) => lifecycle(find(el.dataset.id), "stop", el).then(load),
    restart: (el) => lifecycle(find(el.dataset.id), "restart", el).then(load),
    terminal: (el) => (location.hash = `#/boxes/${el.dataset.id}/terminal`),
    checkpoint: (el) => takeCheckpoint(find(el.dataset.id)),
    delete: (el) => deleteBox(find(el.dataset.id)).then((ok) => ok && load()),
  });

  const offs = [
    subscribe("sync", (frame) => {
      const next = boxesOfSync(frame);
      if (!next) return;
      boxes = next;
      draw();
    }),
    subscribe("box", (frame) => {
      boxes = applyBoxFrame(boxes, frame);
      draw();
    }),
    subscribe("sample", (frame) => {
      if (applySamples(boxes, frame.boxes)) draw();
    }),
    onHosts(() => loaded && draw()),
  ];
  const stopFeed = followOverview((overview) => {
    activity = activityByBox(overview.inProgress);
    paintActivity();
  });
  load().catch((e) => toastError(t("bx.loadFailedToast"), e));
  const stopPolling = pollWhileDown(load, 5000);
  return () => {
    for (const off of offs) off();
    stopPolling();
    stopFeed();
  };
}
