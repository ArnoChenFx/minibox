import { mountActivity } from "../components/activity-panel.js";
import { lifecycle, openRebuild, deleteBox, editResources } from "../components/box-actions.js";
import { openMove } from "../components/box-move.js";
import { mountOverview } from "../components/box-overview.js";
import { mountPorts } from "../components/box-ports.js";
import { mountResources } from "../components/box-resources.js";
import { openSshDialog } from "../components/box-ssh.js";
import { mountTools } from "../components/box-tools.js";
import { attachVolume, detachMount } from "../components/box-volumes.js";
import { takeCheckpoint, mountCheckpoints } from "../components/checkpoints.js";
import { mountFiles } from "../components/files.js";
import { openSaveTemplate } from "../components/save-template.js";
import { mountTerminal } from "../components/terminal-panel.js";
import { api, enc } from "../lib/api.js";
import { applySamples } from "../lib/box-state.js";
import { esc, delegate } from "../lib/dom.js";
import { shortId, cpus, mem } from "../lib/format.js";
import { multiHost, onHosts } from "../lib/hosts.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { setCrumbs } from "../lib/layout.js";
import { subscribe, pollWhileDown } from "../lib/live.js";
import { stateBadge, boxState, emptyState, toastError } from "../lib/ui.js";

/** The points a chart keeps. The server keeps its own ring; this bounds what the page holds. */
const CHART_POINTS = 240;

/** How often the box and its history are read again while the live stream is down. */
const FALLBACK_MS = 3000;

const TABS = [
  ["overview", "bd.tabOverview", "dashboard"],
  ["terminal", "bd.tabTerminal", "terminal"],
  ["activity", "bd.tabActivity", "activity"],
  ["resources", "bd.tabResources", "sliders"],
  ["ports", "bd.tabPorts", "externalLink"],
  ["tools", "bd.tabTools", "layers"],
  ["checkpoints", "bd.tabCheckpoints", "history"],
  ["files", "bd.tabFiles", "folder"],
];

export function render(view, id, tab = "overview", session = undefined) {
  if (tab === "logs") tab = "activity";
  if (tab === "snapshots") tab = "checkpoints";
  if (!TABS.some(([k]) => k === tab)) tab = "overview";
  let entrySession = session;
  let box = null;
  let disposed = false;
  let painted = false;
  let missing = false;
  /** Set while this page deletes its own box, so the remove frame doesn't refetch a box that is gone. */
  let leaving = false;
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
      <div><h1>${esc(box.name)} ${stateBadge(boxState(box))}</h1>
        <div class="meta mono">${esc(shortId(box.id))} · ${esc(box.image)} · ${cpus(box.cpus)} / ${mem(box.memory)}</div></div>
      <div class="page-actions">
        ${box.running ? `<button class="btn" data-action="stop">${icon("stop")}${t("act.stop")}</button>` : `<button class="btn btn-primary" data-action="start">${icon("play")}${t("act.start")}</button>`}
        <button class="btn" data-action="restart">${icon("restart")}${t("act.restart")}</button>
        <button class="btn" data-action="ssh">${icon("terminal")}${t("act.ssh")}</button>
        <button class="btn" data-action="checkpoint">${icon("camera")}${t("act.checkpoint")}</button>
        <button class="btn" data-action="save-template">${icon("layers")}${t("tp.saveAction")}</button>
        ${multiHost() ? `<button class="btn" data-action="move">${icon("move")}${t("bd.move")}</button>` : ""}
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
    if (leaving) return;
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
    // The session the address names opens once. A later mount of this page keeps the session on screen, which the
    // terminal remembers as the box's last one.
    const entry = entrySession;
    entrySession = undefined;
    tabCleanup = TAB_RENDER[tab](view.querySelector("#tabBody"), {
      box: () => box,
      history,
      onChange,
      refreshBox: fetchBox,
      rerender,
      session: entry,
    });
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
    ssh: () => openSshDialog(box),
    checkpoint: () => takeCheckpoint(box).then((taken) => taken && tab === "checkpoints" && rerender()),
    "save-template": () => openSaveTemplate(box),
    rebuild: async () => {
      try {
        const { box: fresh } = await api(`/api/boxes/${enc(ref())}`);
        await openRebuild(fresh);
      } catch (err) {
        toastError(t("bd.loadFailed"), err);
      }
    },
    move: () => openMove(box),
    delete: async () => {
      const framesAtDelete = frames;
      leaving = true;
      if (await deleteBox(box)) {
        location.hash = "#/boxes";
        return;
      }
      leaving = false;
      if (frames !== framesAtDelete) void rerender();
    },
    resources: () => editResources(box, rerender),
    "attach-volume": () =>
      attachVolume(box).then((next) => {
        if (!next) return;
        if (next.id !== id) location.hash = `#/boxes/${enc(next.id)}`;
        else rerender();
      }),
    "detach-mount": (el) =>
      detachMount(box, el).then((next) => {
        if (!next) return;
        if (next.id !== id) location.hash = `#/boxes/${enc(next.id)}`;
        else rerender();
      }),
  });

  const offs = [
    subscribe("box", (frame) => {
      if (!box || frame.boxId !== box.boxId) return;
      frames += 1;
      if (leaving) return;
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
    onHosts(() => paintHead()),
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
  overview: mountOverview,

  terminal(root, { box, onChange, rerender, session }) {
    return mountTerminal(root, { box, onChange, rerender, session });
  },

  activity(root, { box }) {
    return mountActivity(root, { box });
  },

  resources: mountResources,

  ports: mountPorts,

  tools: mountTools,

  checkpoints(root, { box, refreshBox }) {
    return mountCheckpoints(root, { box, refreshBox });
  },

  files(root, { box, onChange }) {
    return mountFiles(root, { box, onChange });
  },
};
