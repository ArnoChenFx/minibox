import { openCreateBox } from "../components/create-box.js";
import { bindToggles, limitList } from "../components/list-toggle.js";
import { followOverview } from "../components/overview-feed.js";
import { drawWatch } from "../components/overview-watch.js";
import { ACTION_ICON, readableAction } from "../lib/activity.js";
import { api } from "../lib/api.js";
import { applyBoxFrame, boxesOfSync } from "../lib/box-state.js";
import { delegate, esc } from "../lib/dom.js";
import { bytes, cpus, duration, gbOrMb, mem, pct, relTime } from "../lib/format.js";
import { boxesOnHost, HOST_BADGE, isUnreachable } from "../lib/host-list.js";
import { hostFilter, hostName, hostsNow, onHosts } from "../lib/hosts.js";
import { has, t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { pollWhileDown, subscribe } from "../lib/live.js";
import { sparkline } from "../lib/sparkline.js";
import { onHost } from "../lib/store.js";
import { boxState, emptyState, stateBadge } from "../lib/ui.js";

function metricSkeleton() {
  return '<div class="card"><div class="skeleton sk-block"></div></div>';
}

/** Highlights the recent-activity card and brings it to the middle of the view, which the Activity entry asks for. */
function revealRecent(view) {
  const card = view.querySelector("#ovRecentCard");
  card.classList.add("is-focus");
  card.scrollIntoView({ block: "center" });
}

/** How often the host cards re-read what each host runs and uses. The sampler keeps its figures current between reads. */
const HOST_USAGE_MS = 10_000;

/** `focus` is "activity" when the Activity entry opened the page: the recent-activity card is then brought into view. */
export function render(view, focus = "") {
  view.innerHTML = `
    <div class="page-head">
      <div><h1>${t("nav.overview")}</h1><p id="ovSub">${t("ov.subtitle")}</p></div>
      <div class="page-actions"><button class="btn btn-primary" data-action="create">${icon("plus")}${t("box.create")}</button></div>
    </div>
    <div class="grid grid-4" id="ovHosts" style="margin-bottom:16px" hidden></div>
    <div class="grid grid-4" id="ovMetrics">${metricSkeleton().repeat(4)}</div>
    <div class="grid watch-grid" style="margin-top:16px">
      <section class="card watch-card" id="ovProgressCard" aria-labelledby="ovProgressTitle">
        <div class="card-head"><h3 id="ovProgressTitle">${t("ov.progress")}</h3><span class="hint">${t("ov.progressHint")}</span></div>
        <div id="ovProgress"><div class="card-body"><div class="skeleton sk-line"></div></div></div>
      </section>
      <section class="card watch-card" id="ovAttentionCard" aria-labelledby="ovAttentionTitle">
        <div class="card-head"><h3 id="ovAttentionTitle">${t("ov.attention")}</h3><span class="hint">${t("ov.attentionHint")}</span></div>
        <div id="ovAttention"><div class="card-body"><div class="skeleton sk-line"></div></div></div>
      </section>
    </div>
    <div class="grid grid-3" style="margin-top:16px">
      <div class="card" style="grid-column: span 2" id="ovAlloc"><div class="card-body"><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div></div></div>
      <div class="card" id="ovHost"><div class="card-body"><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div></div></div>
    </div>
    <div class="grid grid-2" style="margin-top:16px">
      <div class="card"><div class="card-head"><h3>${t("nav.boxes")}</h3><a class="hint" href="#/boxes">${t("ov.viewAll")}</a></div><div id="ovBoxes"><div class="card-body"><div class="skeleton sk-line"></div></div></div></div>
      <div class="card" id="ovRecentCard"><div class="card-head"><h3>${t("ov.recent")}</h3><span class="hint">${t("ov.thisRun")}</span></div><div id="ovActivity"><div class="card-body"><div class="skeleton sk-line"></div></div></div></div>
    </div>`;

  delegate(view, { create: () => openCreateBox({ onCreated: (b) => (location.hash = `#/boxes/${b.id}`) }) });

  const off = onHost((h, failing) => {
    if (!h) return;
    renderMetrics(view, h, failing);
  });

  let boxes = [];
  let loaded = false;
  const loadBoxes = async () => {
    try {
      boxes = (await api("/api/boxes?stats=false")).boxes;
      loaded = true;
      renderBoxes(view, boxes);
    } catch {
      /* the host pill already signals connectivity issues */
    }
  };
  let revealPending = focus === "activity";
  const loadActivity = async () => {
    try {
      renderActivity(view, (await api("/api/activity")).activity);
    } catch {
      /* the host pill already signals connectivity issues */
    }
    if (revealPending) {
      revealPending = false;
      revealRecent(view);
    }
  };
  const loadAll = () => {
    void loadBoxes();
    void loadActivity();
  };

  let activityTimer = null;
  const refreshActivity = () => {
    clearTimeout(activityTimer);
    activityTimer = setTimeout(loadActivity, 300);
  };

  let latest = null;
  const stopFeed = followOverview((overview) => {
    latest = overview;
    drawWatch(view, overview);
  });

  let hostList = hostsNow();
  let usageById = new Map();
  const drawHosts = () => renderHostCards(view, hostList, usageById);
  const loadUsage = async () => {
    if (hostList.length < 2) return;
    try {
      usageById = new Map((await api("/api/hosts/usage")).hosts.map((host) => [host.id, host]));
      drawHosts();
    } catch {
      /* the cards keep the figures they have */
    }
  };
  const usageTimer = setInterval(loadUsage, HOST_USAGE_MS);

  const offs = [
    onHosts((list) => {
      hostList = list;
      drawHosts();
      void loadUsage();
      if (loaded) renderBoxes(view, boxes);
      if (latest) drawWatch(view, latest);
    }),
    subscribe("sync", (frame) => {
      const next = boxesOfSync(frame);
      if (!next) return;
      boxes = next;
      renderBoxes(view, boxes);
    }),
    subscribe("box", (frame) => {
      boxes = applyBoxFrame(boxes, frame);
      renderBoxes(view, boxes);
    }),
    subscribe("event", refreshActivity),
    subscribe("reset", refreshActivity),
  ];
  loadAll();
  const stopPolling = pollWhileDown(loadAll, 10000);
  return () => {
    off();
    for (const unsubscribe of offs) unsubscribe();
    stopPolling();
    stopFeed();
    clearTimeout(activityTimer);
    clearInterval(usageTimer);
  };
}

function renderMetrics(view, h, failing) {
  const memP = (h.memory.used / h.memory.total) * 100;
  const disk = h.disks[0];
  const diskP = disk ? (disk.used / disk.total) * 100 : 0;
  const cpuHist = h.history.map((s) => s.cpu);
  const memHist = h.history.map((s) => s.mem);
  const span = h.history.length > 1 ? Math.round((h.history.at(-1).t - h.history[0].t) / 60000) : 0;
  view.querySelector("#ovSub").textContent = failing
    ? t("ov.stale")
    : t("ov.uptimeLine", { host: h.hostname, platform: h.platform, uptime: duration(h.uptimeSec) });

  view.querySelector("#ovMetrics").innerHTML = `
    <div class="card metric">
      <div class="metric-top"><span>${t("ov.cpuUsage")}</span>${icon("cpu")}</div>
      <div class="metric-value">${pct(h.cpu.usagePercent)}<small>${cpus(h.cpu.cores)}</small></div>
      <div class="metric-sub">${t("ov.load", { load: h.cpu.load.map((n) => n.toFixed(2)).join(" / "), n: Math.max(span, 1) })}</div>
      ${sparkline(cpuHist, { color: "var(--chart-cpu)", id: "cpu" })}
    </div>
    <div class="card metric">
      <div class="metric-top"><span>${t("ov.memory")}</span>${icon("memory")}</div>
      <div class="metric-value">${pct(memP)}<small>${bytes(h.memory.used)} / ${bytes(h.memory.total)}</small></div>
      <div class="metric-sub">${t("ov.available", { n: bytes(h.memory.available) })}${h.memory.swapTotal ? ` · ${t("ov.swap", { n: bytes(h.memory.swapUsed) })}` : ""}</div>
      ${sparkline(memHist, { color: "var(--chart-mem)", id: "mem" })}
    </div>
    <div class="card metric">
      <div class="metric-top"><span>${t("ov.disk")}</span>${icon("disk")}</div>
      <div class="metric-value">${pct(diskP)}<small>${disk ? `${bytes(disk.used)} / ${bytes(disk.total)}` : ""}</small></div>
      <div class="stack" style="gap:10px;margin-top:auto">
        ${h.disks
          .map((d) => {
            const p = (d.used / d.total) * 100;
            return `<div><div class="bar-label"><span>${esc(t(`disk.${d.label}`))}</span><span>${t("ov.free", { n: bytes(d.free) })}</span></div><div class="bar ${p > 90 ? "crit" : p > 75 ? "warn" : ""}"><span style="width:${p}%"></span></div></div>`;
          })
          .join("")}
      </div>
    </div>
    <div class="card metric">
      <div class="metric-top"><span>${t("nav.boxes")}</span>${icon("box")}</div>
      <div class="metric-value">${h.boxes.running}<small>${t("ov.boxesRunning", { n: h.boxes.total })}</small></div>
      <div class="metric-sub">${t("ov.dockerLine", { version: h.docker.available ? esc(h.docker.version) : t("ov.unavailable"), running: h.docker.containers.running, total: h.docker.containers.total, images: h.docker.images })}</div>
      <div style="margin-top:auto">${h.docker.available ? `<span class="badge badge-success"><span class="dot"></span>${t("ov.dockerOk")}</span>` : `<span class="badge badge-danger"><span class="dot"></span>${t("shell.dockerUnavailable")}</span>`}</div>
    </div>`;

  const cpuAllocP = (h.boxes.allocatedCpus / h.cpu.cores) * 100;
  const memAllocP = (h.boxes.allocatedMemory / h.memory.total) * 100;
  const over = cpuAllocP > 100 || memAllocP > 100;
  view.querySelector("#ovAlloc").innerHTML = `
    <div class="card-head"><h3>${t("ov.allocation")}</h3><span class="hint">${t("ov.allocationHint")}</span></div>
    <div class="card-body stack">
      <div><div class="bar-label"><span>${t("ov.cpuQuota")}</span><span>${t("ov.cpuAlloc", { used: +h.boxes.allocatedCpus.toFixed(2), cores: h.cpu.cores, pct: pct(cpuAllocP, 0) })}</span></div>
        <div class="bar ${cpuAllocP > 100 ? "crit" : cpuAllocP > 75 ? "warn" : ""}"><span style="width:${Math.min(cpuAllocP, 100)}%"></span></div></div>
      <div><div class="bar-label"><span>${t("ov.memQuota")}</span><span>${t("ov.memAlloc", { used: gbOrMb(h.boxes.allocatedMemory), total: bytes(h.memory.total), pct: pct(memAllocP, 0) })}</span></div>
        <div class="bar mem ${memAllocP > 100 ? "crit" : memAllocP > 75 ? "warn" : ""}"><span style="width:${Math.min(memAllocP, 100)}%"></span></div></div>
      ${over ? `<div class="callout warn">${icon("alert")}<span>${t("ov.overAlloc")}</span></div>` : `<div class="callout">${icon("info")}<span>${t("ov.quotaNote")}</span></div>`}
    </div>`;

  view.querySelector("#ovHost").innerHTML = `
    <div class="card-head"><h3>${t("ov.host")}</h3>${icon("server")}</div>
    <div class="card-body"><dl class="kv">
      <dt>${t("ov.hostname")}</dt><dd>${esc(h.hostname)}</dd>
      <dt>${t("ov.os")}</dt><dd>${esc(h.platform)}</dd>
      <dt>${t("ov.kernel")}</dt><dd class="mono">${esc(h.kernel)} · ${esc(h.arch)}</dd>
      <dt>${t("ov.cpu")}</dt><dd class="truncate" title="${esc(h.cpu.model)}">${esc(h.cpu.model)}</dd>
      <dt>${t("ov.uptime")}</dt><dd>${duration(h.uptimeSec)}</dd>
      <dt>Docker</dt><dd>${h.docker.available ? `${esc(h.docker.version)} <span class="subtle mono">${esc(h.docker.rootDir)}</span>` : t("ov.unavailable")}</dd>
    </dl></div>`;
}

function renderBoxes(view, boxes) {
  const root = view.querySelector("#ovBoxes");
  if (!boxes.length) {
    root.innerHTML = emptyState({
      iconName: "box",
      title: t("ov.noBoxes"),
      text: t("ov.noBoxesText"),
    });
    return;
  }
  const scoped = boxesOnHost(boxes, hostFilter());
  if (!scoped.length) {
    root.innerHTML = emptyState({
      iconName: "box",
      title: t("bx.noHostBoxes"),
      text: t("bx.noHostBoxesText", { host: esc(hostName(hostFilter())) }),
    });
    return;
  }
  const { shown, toggle } = limitList(view, "boxes", scoped);
  root.innerHTML = `<ul class="activity">${shown
    .map(
      (
        b,
      ) => `<li class="${isUnreachable(b) ? "is-unreachable" : ""}"><span class="ico">${icon("box")}</span><a href="#/boxes/${b.id}"><strong>${esc(b.name)}</strong></a>
      <span class="subtle">${cpus(b.cpus)} · ${mem(b.memory)}</span><span class="time">${stateBadge(boxState(b))}</span></li>`,
    )
    .join("")}</ul><div class="list-more">${toggle}</div>`;
  bindToggles(view, root, () => renderBoxes(view, boxes));
}

function renderHostCards(view, hosts, usageById) {
  const root = view.querySelector("#ovHosts");
  root.hidden = hosts.length < 2;
  root.innerHTML = root.hidden ? "" : hosts.map((host) => hostCard(host, usageById.get(host.id))).join("");
}

function hostCard(host, usage) {
  const capacity = host.capacity
    ? `${cpus(host.capacity.cpus)} · ${mem(host.capacity.memoryBytes)}`
    : t("common.unknown");
  const latency = host.latencyMs == null ? "" : ` · ${host.latencyMs} ms`;
  const containers = usage?.containers
    ? `<div class="metric-sub">${t("ov.hostContainers", usage.containers)}</div>`
    : "";
  return `<div class="card metric" data-host="${esc(host.id)}">
    <div class="metric-top"><span>${esc(host.name)}</span>${icon("server")}</div>
    <div class="metric-value">${host.boxes}<small>${t("ov.hostBoxes", { n: host.boxes })}</small></div>
    <div class="metric-sub">${esc(t(`st.transport.${host.transport}`))} · ${capacity}${latency}</div>
    ${containers}
    ${hostAllocation(host, usage)}
    <div style="margin-top:auto"><span class="badge ${HOST_BADGE[host.status] ?? ""}"><span class="dot"></span>${esc(t(`st.hostStatus.${host.status}`))}</span></div>
  </div>`;
}

const barLevel = (p) => (p > 100 ? "crit" : p > 75 ? "warn" : "");

/** The CPU and memory the running boxes book on a host, as bars against its capacity, and what they use now. */
function hostAllocation(host, usage) {
  const allocated = usage?.allocated;
  if (!allocated || !host.capacity?.cpus || !host.capacity.memoryBytes) return "";
  const cpuP = (allocated.cpus / host.capacity.cpus) * 100;
  const memP = (allocated.memoryBytes / host.capacity.memoryBytes) * 100;
  const using = usage.usage
    ? t("ov.hostUsing", { cpu: +usage.usage.cpus.toFixed(2), mem: gbOrMb(usage.usage.memoryBytes) })
    : t("common.unknown");
  return `<div class="stack" style="gap:8px;margin-top:8px">
    <div><div class="bar-label"><span>${t("ov.cpuQuota")}</span><span>${t("ov.cpuAlloc", { used: +allocated.cpus.toFixed(2), cores: host.capacity.cpus, pct: pct(cpuP, 0) })}</span></div>
      <div class="bar ${barLevel(cpuP)}"><span style="width:${Math.min(cpuP, 100)}%"></span></div></div>
    <div><div class="bar-label"><span>${t("ov.memQuota")}</span><span>${t("ov.memAlloc", { used: gbOrMb(allocated.memoryBytes), total: bytes(host.capacity.memoryBytes), pct: pct(memP, 0) })}</span></div>
      <div class="bar mem ${barLevel(memP)}"><span style="width:${Math.min(memP, 100)}%"></span></div></div>
    <div class="metric-sub">${using}</div>
  </div>`;
}

function renderActivity(view, items) {
  const root = view.querySelector("#ovActivity");
  if (!items.length) {
    root.innerHTML = emptyState({
      iconName: "activity",
      title: t("ov.noActivity"),
      text: t("ov.noActivityText"),
    });
    return;
  }
  const { shown, toggle } = limitList(view, "activity", items);
  root.innerHTML = `<ul class="activity">${shown
    .map((a) => {
      const ic = ACTION_ICON[a.action] ?? "activity";
      const label = has(`act.${a.action}`) ? t(`act.${a.action}`) : readableAction(a.action);
      return `<li title="${esc(a.message ?? "")}"><span class="ico ${a.ok ? "" : "fail"}">${icon(a.ok ? ic : "alert")}</span>
        <span>${esc(label)} <strong>${esc(a.target)}</strong>${a.ok ? "" : ` <span class="badge badge-danger">${t("common.failed")}</span>`}</span>
        <span class="time">${relTime(a.t)}</span></li>`;
    })
    .join("")}</ul><div class="list-more">${toggle}</div>`;
  bindToggles(view, root, () => renderActivity(view, items));
}
