import { mountActivity } from "../components/activity-panel.js";
import { lifecycle, openRebuild, deleteBox, editResources, renameBox } from "../components/box-actions.js";
import { openMove } from "../components/box-move.js";
import { mountOverview } from "../components/box-overview.js";
import { mountPorts } from "../components/box-ports.js";
import { mountBoxSettings } from "../components/box-settings.js";
import { openSshDialog } from "../components/box-ssh.js";
import { attachVolume, detachMount, restoreMount } from "../components/box-volumes.js";
import { takeCheckpoint } from "../components/checkpoints.js";
import { mountFiles } from "../components/files.js";
import { openSaveTemplate } from "../components/save-template.js";
import { bindTabStrips } from "../components/section-tabs.js";
import { mountTerminal } from "../components/terminal-panel.js";
import { api, enc } from "../lib/api.js";
import { boxSettingsOf } from "../lib/box-settings.js";
import { applySamples } from "../lib/box-state.js";
import { esc, delegate, revealInStrip } from "../lib/dom.js";
import { shortId, cpus, mem } from "../lib/format.js";
import { boxOnAgentHost } from "../lib/host-list.js";
import { hostsNow, multiHost, onHosts, refreshHosts } from "../lib/hosts.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { setCrumbs } from "../lib/layout.js";
import { subscribe, pollWhileDown } from "../lib/live.js";
import { boxHash } from "../lib/routes.js";
import { stateBadge, boxState, emptyState, toastError } from "../lib/ui.js";

/** The points a chart keeps. The server keeps its own ring; this bounds what the page holds. */
const CHART_POINTS = 240;

/** How often the box and its history are read again while the live stream is down. */
const FALLBACK_MS = 3000;

/**
 * The tabs an agent host refuses, each with the feature it loses: it holds no helper for the file browser and no relay
 * for a preview. The port list itself still reads, so the tab names the preview, not the ports.
 */
const AGENT_REFUSED_TABS = new Map([
  ["files", "bd.agentFeatureFiles"],
  ["ports", "bd.agentFeaturePorts"],
]);

/** The tooltip of a tab its host refuses, so the tab bar says why before it is opened; empty for any other tab. */
const refusedTabTitle = (key, onAgent) => {
  const feature = onAgent ? AGENT_REFUSED_TABS.get(key) : undefined;
  return feature ? ` title="${esc(t("bd.agentTab", { feature: t(feature) }))}"` : "";
};

/** The box's tabs in the order the tab bar shows them. Settings holds the sections that used to be tabs of their own. */
const TABS = [
  ["overview", "bd.tabOverview", "dashboard"],
  ["terminal", "bd.tabTerminal", "terminal"],
  ["files", "bd.tabFiles", "folder"],
  ["ports", "bd.tabPorts", "externalLink"],
  ["activity", "bd.tabActivity", "activity"],
  ["settings", "bd.tabSettings", "sliders"],
];

/**
 * The page for one box. `tab` names its tab; `sub` names the settings section on the settings tab and the terminal
 * session on the terminal tab. An unknown tab shows the overview.
 */
export function render(view, id, tab = "overview", sub = undefined) {
  if (!TABS.some(([k]) => k === tab)) tab = "overview";
  const section = tab === "settings" ? sub : undefined;
  const onCheckpoints = tab === "settings" && boxSettingsOf(section).id === "checkpoints";
  let entrySession = tab === "terminal" ? sub : undefined;
  let box = null;
  let disposed = false;
  let painted = false;
  let missing = false;
  /** Set while this page deletes its own box, so the remove frame doesn't refetch a box that is gone. */
  let leaving = false;
  let mounts = 0;
  let tabCleanup = null;
  let stripCleanup = null;
  let frames = 0;
  let headShown = "";
  let nameShown = "";
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

  /** Whether the box runs on an agent host, which holds no helper: its files, ports and checkpoints are all refused. */
  const onAgentHost = () => Boolean(box) && boxOnAgentHost(box, hostsNow());

  const headHtml = () => {
    const onAgent = onAgentHost();
    // Both of these answer 501 on an agent host: a move is refused in either direction, and a template needs an image
    // commit the agent cannot make. They are shown, disabled, with the reason, instead of failing after the click.
    const disabled = (key) => (onAgent ? ` disabled title="${esc(t(key))}"` : "");
    return `
    <div class="detail-head">
      <span class="avatar">${icon("box", "icon-lg")}</span>
      <div class="detail-title"><h1><span class="detail-name">${esc(box.name)}</span><button class="icon-btn detail-rename" data-action="rename" title="${esc(t("bd.rename"))}" aria-label="${esc(t("bd.rename"))}">${icon("pencil")}</button> ${stateBadge(boxState(box))}</h1>
        <div class="meta mono">${esc(shortId(box.id))} · ${esc(box.image)} · ${cpus(box.cpus)} / ${mem(box.memory)}</div></div>
      <div class="page-actions">
        ${box.running ? `<button class="btn" data-action="stop">${icon("stop")}${t("act.stop")}</button>` : `<button class="btn btn-primary" data-action="start">${icon("play")}${t("act.start")}</button>`}
        <button class="btn" data-action="restart">${icon("restart")}${t("act.restart")}</button>
        <button class="btn" data-action="ssh">${icon("terminal")}${t("act.ssh")}</button>
        <button class="btn" data-action="checkpoint"${disabled("bd.agentCheckpoints")}>${icon("camera")}${t("act.checkpoint")}</button>
        <button class="btn" data-action="save-template"${disabled("bd.agentTemplate")}>${icon("layers")}${t("tp.saveAction")}</button>
        ${multiHost() ? `<button class="btn" data-action="move"${disabled("bd.agentMove")}>${icon("move")}${t("bd.move")}</button>` : ""}
        <button class="btn" data-action="rebuild">${icon("refresh")}${t("bd.rebuild")}</button>
        <button class="btn" data-action="delete" title="${t("bd.deleteTitle")}">${icon("trash")}${t("act.delete")}</button>
      </div>
      ${onAgent ? `<p class="help detail-agent-note" id="bdAgentNote">${esc(t("bd.agentHeadNote"))}</p>` : ""}
    </div>`;
  };

  /** The breadcrumb and the window title name the box too, so a live rename reaches them as well as the header. */
  const paintName = () => {
    if (!box || box.name === nameShown) return;
    nameShown = box.name;
    setCrumbs([{ label: t("nav.boxes"), href: "#/boxes" }, box.name]);
    document.title = `${box.name} · MiniBox`;
  };

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
    paintName();
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
      // The page decides from the host list whether the box sits on an agent host, so both are read before the box is
      // drawn, side by side rather than one after the other.
      await Promise.all([refreshHosts(), fetchBox()]);
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
    headShown = headHtml();
    view.innerHTML = `${headShown}
    <div class="tabs" role="tablist">${TABS.map(
      ([k, label, ic]) =>
        `<a class="tab" role="tab" aria-selected="${k === tab}"${refusedTabTitle(k, onAgentHost())} href="${boxHash(box.id, k, k === tab ? section : "")}">${icon(ic)}${t(label)}</a>`,
    ).join("")}</div>
    <div id="tabBody"></div>`;
    painted = true;
    const tabs = view.querySelector(".tabs");
    revealInStrip(tabs, tabs.querySelector('[aria-selected="true"]'));
    stripCleanup?.();
    stripCleanup = bindTabStrips(view);
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
      section,
      session: entry,
      onAgentHost,
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
    checkpoint: () => takeCheckpoint(box).then((taken) => taken && onCheckpoints && rerender()),
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
    rename: () => renameBox(box, () => fetchBox().catch(() => undefined)),
    "attach-volume": () => attachVolume(box),
    "detach-mount": (el) => detachMount(box, el),
    "restore-mount": (el) => restoreMount(box, el),
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
    stripCleanup?.();
    stripCleanup = null;
  };
}

/**
 * What a tab an agent host refuses shows instead of its body: the feature, why the host cannot run it, and what to use
 * meanwhile. The tab stays in the strip, so the console never looks like it lost a feature.
 */
function refuseTab(root, which) {
  const key = which === "files" ? "bd.agentFiles" : "bd.agentPorts";
  root.innerHTML = `<div class="card"><div class="card-body">${emptyState({
    iconName: which === "files" ? "folder" : "externalLink",
    title: t(`${key}Title`),
    text: esc(t(key)),
    action: `<span class="help">${esc(t("bd.agentHostHint"))}</span>`,
  })}</div></div>`;
  return () => {};
}

const TAB_RENDER = {
  overview: mountOverview,

  terminal(root, { box, onChange, rerender, session }) {
    return mountTerminal(root, { box, onChange, rerender, session });
  },

  files(root, { box, onChange, onAgentHost }) {
    if (onAgentHost()) return refuseTab(root, "files");
    return mountFiles(root, { box, onChange });
  },

  ports(root, { box, onAgentHost }) {
    if (onAgentHost()) return refuseTab(root, "ports");
    return mountPorts(root, { box });
  },

  activity(root, { box }) {
    return mountActivity(root, { box });
  },

  settings: mountBoxSettings,
};
