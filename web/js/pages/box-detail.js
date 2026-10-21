import { deleteBox, editResources, lifecycle, openRebuild, snapshotBox } from "../components/box-actions.js";
import { openCreateBox } from "../components/create-box.js";
import { api, enc } from "../lib/api.js";
import { applySamples } from "../lib/box-state.js";
import { delegate, esc } from "../lib/dom.js";
import { bytes, cpus, dateTime, duration, gbOrMb, mem, pct, shortId } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { setCrumbs } from "../lib/layout.js";
import { pollWhileDown, subscribe } from "../lib/live.js";
import { sparkline } from "../lib/sparkline.js";
import { emptyState, stateBadge, toastError, usageBar } from "../lib/ui.js";

/** The points a chart keeps. The server keeps its own ring; this bounds what the page holds. */
const CHART_POINTS = 240;
/** How often the box and its history are read again while the live stream is down. */
const FALLBACK_MS = 3000;

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
  let painted = false;
  let missing = false;
  let mounts = 0;
  let tabCleanup = null;
  let frames = 0;
  let headShown = "";
  let lastSampleAt = 0;
  const history = [];
  const listeners = new Set();
  view.innerHTML = `<div class="detail-head"><div class="skeleton" style="width:44px;height:44px;border-radius:12px"></div><div style="flex:1"><div class="skeleton sk-line" style="width:200px"></div><div class="skeleton sk-line" style="width:320px"></div></div></div>`;

  const ref = () => box?.boxId ?? id;

  const onChange = (fn) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  };

  const notify = () => {
    for (const fn of listeners) fn();
  };

  const headHtml = () => `
    <div class="detail-head">
      <span class="avatar">${icon("box", "icon-lg")}</span>
      <div><h1>${esc(box.name)} ${stateBadge(box.state)}</h1>
        <div class="meta mono">${esc(shortId(box.id))} · ${esc(box.image)} · ${cpus(box.cpus)} / ${mem(box.memory)}</div></div>
      <div class="page-actions">
        ${box.running ? `<button class="btn" data-action="stop">${icon("stop")}${t("act.stop")}</button>` : `<button class="btn btn-primary" data-action="start">${icon("play")}${t("act.start")}</button>`}
        <button class="btn" data-action="restart">${icon("restart")}${t("act.restart")}</button>
        <button class="btn" data-action="snapshot">${icon("camera")}${t("act.snapshot")}</button>
        <button class="btn" data-action="rebuild">${icon("refresh")}${t("bd.rebuild")}</button>
        <button class="btn" data-action="delete" title="${t("bd.deleteTitle")}">${icon("trash")}${t("act.delete")}</button>
      </div>
    </div>`;

  const paintHead = () => {
    if (!painted) return;
    const next = headHtml();
    if (next === headShown) return;
    headShown = next;
    view.querySelector(".detail-head").outerHTML = next;
  };

  const setBox = (next) => {
    if (disposed) return;
    box = next;
    paintHead();
    notify();
  };

  const pushPoint = (point) => {
    if (point.t <= lastSampleAt) return;
    lastSampleAt = point.t;
    history.push(point);
    if (history.length > CHART_POINTS) history.splice(0, history.length - CHART_POINTS);
  };

  /** Replaces the chart with the engine's ring, keeping the points that arrived while the request was in flight. */
  const loadHistory = async () => {
    const { history: samples = [] } = await api(`/api/boxes/${enc(ref())}/stats?history=true`);
    const served = samples.map((s) => ({ t: s.t, cpu: s.cpuPercent, mem: s.memPercent }));
    const newest = served.at(-1)?.t ?? 0;
    const later = history.filter((point) => point.t > newest);
    history.splice(0, history.length, ...[...served, ...later].slice(-CHART_POINTS));
    lastSampleAt = history.at(-1)?.t ?? 0;
    notify();
  };

  /** The fetched box is applied unless a box frame changed the page while the request was in flight. */
  const fetchBox = async () => {
    const seen = frames;
    const { box: fresh } = await api(`/api/boxes/${enc(ref())}`);
    if (!box || seen === frames) setBox(fresh);
  };

  const refresh = async () => {
    if (missing) return rerender();
    try {
      await fetchBox();
      await loadHistory();
    } catch (e) {
      if (e.status === 404) await rerender();
    }
  };

  const mount = async () => {
    const token = ++mounts;
    try {
      await fetchBox();
    } catch (e) {
      if (disposed || token !== mounts) return;
      painted = false;
      missing = e.status === 404;
      view.innerHTML = emptyState({
        iconName: "alert",
        title: e.status === 404 ? t("bd.notFound") : t("bd.loadFailed"),
        text: e.status === 404 ? t("bd.maybeDeleted") : esc(e.message),
        action: `<a class="btn" href="#/boxes">${icon("arrowLeft")}${t("bd.back")}</a>`,
      });
      return;
    }
    if (disposed || token !== mounts) return;
    missing = false;
    await loadHistory().catch(() => {});
    if (disposed || token !== mounts) return;
    setCrumbs([{ label: t("nav.boxes"), href: "#/boxes" }, box.name]);
    document.title = `${box.name} · MiniBox`;
    headShown = headHtml();
    view.innerHTML = `${headShown}
    <div class="tabs" role="tablist">${TABS.map(
      ([k, label, ic]) =>
        `<a class="tab" role="tab" aria-selected="${k === tab}" href="#/boxes/${enc(box.id)}/${k}">${icon(ic)}${t(label)}</a>`,
    ).join("")}</div>
    <div id="tabBody"></div>`;
    painted = true;
    tabCleanup = TAB_RENDER[tab](view.querySelector("#tabBody"), { box: () => box, history, onChange, rerender });
  };

  const rerender = async () => {
    if (disposed) return;
    tabCleanup?.();
    tabCleanup = null;
    await mount();
  };

  delegate(view, {
    start: (b) => lifecycle(box, "start", b).then(rerender),
    stop: (b) => lifecycle(box, "stop", b).then(rerender),
    restart: (b) => lifecycle(box, "restart", b).then(rerender),
    snapshot: () => snapshotBox(box).then((s) => s && tab === "snapshots" && rerender()),
    rebuild: async () => {
      try {
        const { box: fresh } = await api(`/api/boxes/${enc(ref())}`);
        openRebuild(fresh);
      } catch (err) {
        toastError(t("bd.loadFailed"), err);
      }
    },
    delete: async () => {
      if (await deleteBox(box)) location.hash = "#/boxes";
    },
    resources: () => editResources(box, rerender),
    "from-snapshot": (b) =>
      openCreateBox({ snapshot: b.dataset.ref, onCreated: (nb) => (location.hash = `#/boxes/${nb.id}`) }),
  });

  const offs = [
    subscribe("box", (frame) => {
      if (!box || frame.boxId !== box.boxId) return;
      frames += 1;
      if (frame.op === "remove" || missing) {
        void rerender();
        return;
      }
      setBox({ ...frame.box, stats: frame.box.running ? box.stats : null });
    }),
    subscribe("sample", (frame) => {
      if (!box || !applySamples([box], frame.boxes)) return;
      pushPoint({ t: frame.t, cpu: box.stats.cpuPercent, mem: box.stats.memPercent });
      notify();
    }),
    subscribe("sync", () => void refresh()),
  ];
  const stopFallback = pollWhileDown(() => void refresh(), FALLBACK_MS);
  mount();
  return () => {
    disposed = true;
    for (const off of offs) off();
    stopFallback();
    tabCleanup?.();
  };
}

const TAB_RENDER = {
  overview(root, { box, onChange }) {
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
          <dt>${t("bd.env")}</dt><dd>${(b.env ?? []).length ? esc((b.env ?? []).map((item) => item.name).join(", ")) : t("bd.envNone")}</dd>
          <dt>${t("bd.mounts")}</dt><dd>${(b.mounts ?? []).length ? (b.mounts ?? []).map((mount) => `<span class="mono">${esc(mount.path)}</span> <span class="subtle">${esc(mount.mode)}</span> <span class="mono">${esc(mount.volume)}</span>`).join("<br>") : "—"}</dd>
          <dt>${t("bd.workspace")}</dt><dd><span class="mono">/workspace</span> <span class="subtle">${t("bd.volume")}</span> <span class="mono">${esc(b.volume)}</span></dd>
          <dt>${t("bd.created")}</dt><dd>${dateTime(b.createdAt)}</dd>
          <dt>${t("bd.cli")}</dt><dd><code>docker exec -it ${esc(b.containerName || `minibox-${b.name}`)} bash</code></dd>
        </dl></div></div>`;
    };
    draw();
    return onChange(draw);
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

  resources(root, { box, history, onChange }) {
    const draw = () => {
      const b = box();
      const s = b.stats;
      const relative = (h) => (b.cpus ? h.cpu / b.cpus : h.cpu);
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
                  history.map(relative),
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
    return onChange(draw);
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
