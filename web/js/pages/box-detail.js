import { deleteBox, editResources, lifecycle, snapshotBox } from "../components/box-actions.js";
import { openCreateBox } from "../components/create-box.js";
import { api, enc } from "../lib/api.js";
import { delegate, esc } from "../lib/dom.js";
import { bytes, cpus, dateTime, duration, gbOrMb, mem, pct, shortId } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { setCrumbs } from "../lib/layout.js";
import { sparkline } from "../lib/sparkline.js";
import { emptyState, stateBadge, toastError, usageBar } from "../lib/ui.js";

function joined(names, translate) {
  return esc((names ?? []).map((name) => (translate ? t(`reset.${name}`) : name)).join(t("reset.sep")));
}

function specBanners(box) {
  const parts = [];
  const recovery = box.recovery;
  if (recovery?.needsReset?.length) {
    const fields = joined(recovery.needsReset, true);
    const degraded = recovery.source === "degraded";
    const title = degraded ? t("bd.degradedTitle") : t("bd.claimTitle");
    const text = degraded ? t("bd.degradedText", { fields }) : t("bd.claimText", { fields });
    parts.push(
      `<div class="callout warn" style="margin-bottom:16px">${icon("alert")}<span><strong>${title}</strong> ${text}</span></div>`,
    );
  }
  if (box.drift?.length) {
    const fields = joined(
      box.drift.map((item) => item.field),
      false,
    );
    parts.push(
      `<div class="callout warn" style="margin-bottom:16px">${icon("alert")}<span><strong>${t("bd.driftTitle")}</strong> ${t("bd.driftText", { fields })}</span></div>`,
    );
  }
  return parts.join("");
}

const TABS = [
  ["overview", "bd.tabOverview", "dashboard"],
  ["terminal", "bd.tabTerminal", "terminal"],
  ["logs", "bd.tabLogs", "logs"],
  ["resources", "bd.tabResources", "sliders"],
  ["snapshots", "bd.tabSnapshots", "camera"],
];

export function render(view, id, tab = "overview") {
  if (!TABS.some(([k]) => k === tab)) tab = "overview";
  let box = null;
  let disposed = false;
  let tabCleanup = null;
  const history = [];
  view.innerHTML = `<div class="detail-head"><div class="skeleton" style="width:44px;height:44px;border-radius:12px"></div><div style="flex:1"><div class="skeleton sk-line" style="width:200px"></div><div class="skeleton sk-line" style="width:320px"></div></div></div>`;

  const header = () => `
    <div class="detail-head">
      <span class="avatar">${icon("box", "icon-lg")}</span>
      <div><h1>${esc(box.name)} ${stateBadge(box.state)}</h1>
        <div class="meta mono">${esc(shortId(box.id))} · ${esc(box.image)} · ${cpus(box.cpus)} / ${mem(box.memory)}</div></div>
      <div class="page-actions">
        ${box.running ? `<button class="btn" data-action="stop">${icon("stop")}${t("act.stop")}</button>` : `<button class="btn btn-primary" data-action="start">${icon("play")}${t("act.start")}</button>`}
        <button class="btn" data-action="restart">${icon("restart")}${t("act.restart")}</button>
        <button class="btn" data-action="snapshot">${icon("camera")}${t("act.snapshot")}</button>
        <button class="btn" data-action="delete" title="${t("bd.deleteTitle")}">${icon("trash")}${t("act.delete")}</button>
      </div>
    </div>
    <div class="tabs" role="tablist">${TABS.map(
      ([k, label, ic]) =>
        `<a class="tab" role="tab" aria-selected="${k === tab}" href="#/boxes/${enc(box.id)}/${k}">${icon(ic)}${t(label)}</a>`,
    ).join("")}</div>
    <div id="tabBody"></div>`;

  const refreshBox = async () => {
    const r = await api(`/api/boxes/${enc(id)}`);
    box = r.box;
    if (box.stats) {
      history.push({
        cpu: box.cpus ? box.stats.cpuPercent / box.cpus : box.stats.cpuPercent,
        mem: box.stats.memPercent,
      });
      if (history.length > 60) history.shift();
    }
    return box;
  };

  const mount = async () => {
    try {
      await refreshBox();
    } catch (e) {
      view.innerHTML = emptyState({
        iconName: "alert",
        title: e.status === 404 ? t("bd.notFound") : t("bd.loadFailed"),
        text: e.status === 404 ? t("bd.maybeDeleted") : esc(e.message),
        action: `<a class="btn" href="#/boxes">${icon("arrowLeft")}${t("bd.back")}</a>`,
      });
      return;
    }
    if (disposed) return;
    setCrumbs([{ label: t("nav.boxes"), href: "#/boxes" }, box.name]);
    document.title = `${box.name} · MiniBox`;
    view.innerHTML = header();
    tabCleanup = TAB_RENDER[tab](view.querySelector("#tabBody"), { box: () => box, refreshBox, history, rerender });
  };

  const rerender = async () => {
    tabCleanup?.();
    await mount();
  };

  delegate(view, {
    start: (b) => lifecycle(box, "start", b).then(rerender),
    stop: (b) => lifecycle(box, "stop", b).then(rerender),
    restart: (b) => lifecycle(box, "restart", b).then(rerender),
    snapshot: () => snapshotBox(box).then((s) => s && tab === "snapshots" && rerender()),
    delete: async () => {
      if (await deleteBox(box)) location.hash = "#/boxes";
    },
    resources: () => editResources(box, rerender),
    "from-snapshot": (b) =>
      openCreateBox({ snapshot: b.dataset.ref, onCreated: (nb) => (location.hash = `#/boxes/${nb.id}`) }),
  });

  mount();
  return () => {
    disposed = true;
    tabCleanup?.();
  };
}

const TAB_RENDER = {
  overview(root, { box, refreshBox }) {
    const draw = () => {
      const b = box();
      const s = b.stats;
      root.innerHTML = `
        ${specBanners(b)}
        <div class="grid grid-3">
          <div class="card metric"><div class="metric-top"><span>CPU</span>${icon("cpu")}</div>
            <div class="metric-value">${s ? pct(s.cpuPercent) : "—"}<small>${t("bd.quota", { v: cpus(b.cpus) })}</small></div>
            <div style="margin-top:auto">${s ? usageBar(t("bd.relQuota"), b.cpus ? s.cpuPercent / b.cpus : s.cpuPercent, b.cpus ? pct(s.cpuPercent / b.cpus, 0) : "") : `<span class="subtle">${t("bd.notRunning")}</span>`}</div></div>
          <div class="card metric"><div class="metric-top"><span>${t("ov.memory")}</span>${icon("memory")}</div>
            <div class="metric-value">${s ? gbOrMb(s.memUsage) : "—"}<small>${t("bd.quota", { v: mem(b.memory) })}</small></div>
            <div style="margin-top:auto">${s ? usageBar(t("bd.relQuota"), s.memPercent, pct(s.memPercent, 0), "mem") : `<span class="subtle">${t("bd.notRunning")}</span>`}</div></div>
          <div class="card metric"><div class="metric-top"><span>${t("bd.uptime")}</span>${icon("clock")}</div>
            <div class="metric-value" style="font-size:20px">${b.running && b.startedAt ? duration((Date.now() - new Date(b.startedAt).getTime()) / 1000) : t("bd.stopped")}</div>
            <div class="metric-sub">${b.startedAt ? t("bd.lastStarted", { t: dateTime(b.startedAt) }) : t("bd.neverStarted")}</div></div>
        </div>
        <div class="card" style="margin-top:16px"><div class="card-head"><h3>${t("bd.info")}</h3></div><div class="card-body"><dl class="kv">
          <dt>${t("bd.name")}</dt><dd>${esc(b.name)}</dd>
          <dt>${t("bd.boxId")}</dt><dd class="mono">${esc(b.boxId || "—")}</dd>
          <dt>${t("bd.revision")}</dt><dd>${esc(String(b.revision ?? "—"))}</dd>
          <dt>${t("bd.desired")}</dt><dd>${b.desired === "stopped" ? t("bd.desiredStopped") : t("bd.desiredRunning")}</dd>
          <dt>${t("bd.createdBy")}</dt><dd>${b.createdBy ? esc(b.createdBy) : t("bd.createdByUnknown")}</dd>
          <dt>${t("bd.containerId")}</dt><dd class="mono">${esc(b.id)}</dd>
          <dt>${t("bd.image")}</dt><dd class="mono">${esc(b.image)}</dd>
          <dt>${t("bd.template")}</dt><dd class="mono">${esc(b.template || "—")}</dd>
          <dt>${t("bd.profile")}</dt><dd>${b.profile ? t(`profile.${b.profile}`) : t("bd.profileLegacy")}</dd>
          <dt>${t("bd.network")}</dt><dd class="mono">${esc(b.network)}</dd>
          <dt>${t("bd.workspace")}</dt><dd><span class="mono">/workspace</span> <span class="subtle">${t("bd.volume")}</span> <span class="mono">${esc(b.volume)}</span></dd>
          <dt>${t("bd.created")}</dt><dd>${dateTime(b.createdAt)}</dd>
          <dt>${t("bd.cli")}</dt><dd><code>docker exec -it ${esc(b.containerName || `minibox-${b.name}`)} bash</code></dd>
        </dl></div></div>`;
    };
    draw();
    const timer = setInterval(
      () =>
        refreshBox()
          .then(draw)
          .catch(() => {}),
      3000,
    );
    return () => clearInterval(timer);
  },

  terminal(root, { box }) {
    const b = box();
    if (!b.running) {
      root.innerHTML = `<div class="card">${emptyState({ iconName: "terminal", title: t("bd.notRunning"), text: t("bd.termNotRunningText"), action: `<button class="btn btn-primary" data-action="start">${icon("play")}${t("bd.startBox")}</button>` })}</div>`;
      return null;
    }
    root.innerHTML = `<div class="terminal-frame">
      <div class="terminal-bar"><span class="lights"><i></i><i></i><i></i></span><span class="mono">${esc(b.name)}: /workspace</span>
        <span class="status" id="tStatus"><span class="dot"></span><span id="tStatusText">${t("common.connecting")}</span></span>
        <button class="btn btn-ghost btn-sm" id="tReconnect" style="color:#a1a1aa">${icon("refresh")}${t("bd.reconnect")}</button></div>
      <div class="terminal" id="term"></div></div>
      <p class="help" style="margin-top:8px">${t("bd.termHelp")}</p>`;
    if (!window.Terminal) {
      root.querySelector("#term").innerHTML = `<div class="callout danger">${t("bd.termLoadFailed")}</div>`;
      return null;
    }
    let ws;
    const xterm = new window.Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
      theme: { background: "#0b0b0e", foreground: "#e4e4e7", cursor: "#a5a2ff", selectionBackground: "#3f3f7a" },
      scrollback: 5000,
    });
    const fit = new window.FitAddon.FitAddon();
    xterm.loadAddon(fit);
    xterm.open(root.querySelector("#term"));
    fit.fit();
    const setStatus = (on, text) => {
      root.querySelector("#tStatus").classList.toggle("on", on);
      root.querySelector("#tStatusText").textContent = text;
    };
    const connect = () => {
      ws?.close();
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}/api/boxes/${enc(b.id)}/terminal`);
      ws.binaryType = "arraybuffer";
      const sock = ws;
      sock.addEventListener("open", () => {
        setStatus(true, t("bd.connected"));
        sock.send(JSON.stringify({ type: "resize", cols: xterm.cols, rows: xterm.rows }));
        xterm.focus();
      });
      sock.addEventListener("message", (ev) =>
        xterm.write(typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data)),
      );
      sock.addEventListener("close", (ev) => {
        if (sock !== ws) return;
        if (ev.code === 1008) {
          location.href = "/login";
          return;
        }
        setStatus(false, t("bd.disconnected"));
      });
    };
    const dataSub = xterm.onData((d) => ws?.readyState === 1 && ws.send(d));
    const resizeSub = xterm.onResize(
      ({ cols, rows }) => ws?.readyState === 1 && ws.send(JSON.stringify({ type: "resize", cols, rows })),
    );
    const onWin = () => fit.fit();
    window.addEventListener("resize", onWin);
    root.querySelector("#tReconnect").addEventListener("click", () => {
      xterm.reset();
      connect();
    });
    connect();
    return () => {
      window.removeEventListener("resize", onWin);
      dataSub.dispose();
      resizeSub.dispose();
      ws?.close();
      xterm.dispose();
    };
  },

  logs(root, { box }) {
    root.innerHTML = `<div class="card"><div class="card-head"><h3>${t("bd.logs")}</h3>
      <div class="row"><select class="select" id="lTail" style="width:auto;height:30px">${[200, 1000, 5000].map((n) => `<option value="${n}">${t("bd.lastLines", { n })}</option>`).join("")}</select>
      <label class="checkbox" style="align-items:center"><input type="checkbox" id="lAuto" style="accent-color:var(--accent);margin:0" checked />${t("bd.autoRefresh")}</label>
      <button class="btn btn-sm" id="lRefresh">${icon("refresh")}${t("common.refresh")}</button></div></div>
      <pre class="logs" id="lView">${t("common.loading")}</pre></div>
      <p class="help" style="margin-top:8px">${t("bd.logsHelp")}</p>`;
    const view = root.querySelector("#lView");
    const load = async () => {
      try {
        const { logs } = await api(`/api/boxes/${enc(box().id)}/logs?tail=${root.querySelector("#lTail").value}`);
        const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
        view.textContent = logs || t("bd.noLogs");
        if (atBottom) view.scrollTop = view.scrollHeight;
      } catch (e) {
        view.textContent = t("bd.logsFailed", { msg: e.message });
      }
    };
    root.querySelector("#lRefresh").addEventListener("click", load);
    root.querySelector("#lTail").addEventListener("change", load);
    load().then(() => (view.scrollTop = view.scrollHeight));
    const timer = setInterval(() => root.querySelector("#lAuto").checked && load(), 4000);
    return () => clearInterval(timer);
  },

  resources(root, { box, refreshBox, history }) {
    const draw = () => {
      const b = box();
      const s = b.stats;
      root.innerHTML = `<div class="grid grid-2">
        <div class="card"><div class="card-head"><h3>${t("bd.quotaTitle")}</h3><button class="btn btn-sm" data-action="resources">${icon("sliders")}${t("bd.adjust")}</button></div>
          <div class="card-body"><dl class="kv">
            <dt>${t("bd.cpuLimit")}</dt><dd>${cpus(b.cpus)}</dd>
            <dt>${t("bd.memLimit")}</dt><dd>${mem(b.memory)}</dd>
            <dt>${t("bd.pids")}</dt><dd>${b.pids ?? t("common.unlimited")}</dd>
            <dt>${t("bd.swap")}</dt><dd>${t("bd.swapValue")}</dd>
            <dt>${t("bd.restartPolicy")}</dt><dd>${t("bd.restartValue")}</dd>
          </dl><div class="callout" style="margin-top:16px">${icon("info")}<span>${t("bd.hotUpdate")}</span></div></div></div>
        <div class="card"><div class="card-head"><h3>${t("bd.liveUsage")}</h3><span class="hint">${t("bd.liveHint")}</span></div>
          <div class="card-body stack">${
            s
              ? `<div><div class="bar-label"><span>CPU ${pct(s.cpuPercent)}</span><span>${b.cpus ? t("bd.ofQuota", { p: pct(s.cpuPercent / b.cpus, 0) }) : ""}</span></div>${sparkline(
                  history.map((h) => h.cpu),
                  { color: "var(--chart-cpu)", id: "bcpu", height: 56 },
                )}</div>
                 <div><div class="bar-label"><span>${t("ov.memory")} ${gbOrMb(s.memUsage)}</span><span>${pct(s.memPercent, 0)} / ${bytes(s.memLimit)}</span></div>${sparkline(
                   history.map((h) => h.mem),
                   { color: "var(--chart-mem)", id: "bmem", height: 56 },
                 )}</div>`
              : emptyState({ iconName: "activity", title: t("bd.noLive"), text: t("bd.notRunningShort") })
          }</div></div></div>`;
      root.querySelectorAll(".spark").forEach((sv) => (sv.style.height = "56px"));
    };
    draw();
    const timer = setInterval(
      () =>
        refreshBox()
          .then(draw)
          .catch(() => {}),
      3000,
    );
    return () => clearInterval(timer);
  },

  snapshots(root, { box }) {
    root.innerHTML =
      '<div class="card"><div class="card-body"><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div></div></div>';
    api("/api/snapshots")
      .then(({ snapshots }) => {
        const list = snapshots.filter((s) => s.source === box().name);
        root.innerHTML = `<div class="card"><div class="card-head"><h3>${t("bd.boxSnapshots")}</h3><button class="btn btn-sm btn-primary" data-action="snapshot">${icon("camera")}${t("act.snapshot")}</button></div>
        ${
          list.length
            ? `<div class="table-wrap"><table class="table"><thead><tr><th>${t("bd.colSnapshot")}</th><th>${t("bd.colSize")}</th><th>${t("bd.created")}</th><th style="text-align:right">${t("bx.colActions")}</th></tr></thead><tbody>${list
                .map(
                  (
                    s,
                  ) => `<tr><td><span class="mono">${esc(s.ref)}</span></td><td class="num">${bytes(s.size)}</td><td class="subtle">${dateTime(s.createdAt)}</td>
                  <td><div class="actions"><button class="btn btn-sm" data-action="from-snapshot" data-ref="${esc(s.ref)}">${icon("plus")}${t("bd.createFrom")}</button></div></td></tr>`,
                )
                .join("")}</tbody></table></div>`
            : emptyState({
                iconName: "camera",
                title: t("bd.noSnapshots"),
                text: t("bd.noSnapshotsText"),
              })
        }</div>`;
      })
      .catch((e) => {
        root.innerHTML = emptyState({ iconName: "alert", title: t("bd.snapLoadFailed"), text: esc(e.message) });
        toastError(t("bd.snapLoadFailedToast"), e);
      });
    return null;
  },
};
