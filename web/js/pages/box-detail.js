import { mountActivity } from "../components/activity-panel.js";
import { deleteBox, editResources, lifecycle, openRebuild, rebuildPreviewHtml } from "../components/box-actions.js";
import { openMove } from "../components/box-move.js";
import { mountCheckpoints, takeCheckpoint } from "../components/checkpoints.js";
import { deleteCustomTool, openCustomToolDialog } from "../components/custom-tool-dialog.js";
import { mountEnvCard } from "../components/env-card.js";
import { openSaveTemplate } from "../components/save-template.js";
import { bindSearchBox, searchBoxHtml } from "../components/search-box.js";
import { mountStartupCard } from "../components/startup-card.js";
import { openTasks } from "../components/tasks.js";
import { mountTerminal } from "../components/terminal-panel.js";
import { api, enc } from "../lib/api.js";
import { applySamples } from "../lib/box-state.js";
import { copyText, delegate, esc } from "../lib/dom.js";
import { bytes, cpus, dateTime, duration, gbOrMb, mem, pct, shortId } from "../lib/format.js";
import { multiHost, onHosts } from "../lib/hosts.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { setCrumbs } from "../lib/layout.js";
import { pollWhileDown, subscribe } from "../lib/live.js";
import { sparkline } from "../lib/sparkline.js";
import {
  connectCommands,
  installCommands,
  setupCommands,
  windowsInstallCommands,
  windowsSetupCommands,
} from "../lib/ssh.js";
import { filterTools, groupTools, toolAction } from "../lib/tool-list.js";
import {
  boxState,
  confirmDialog,
  emptyState,
  openDialog,
  promptDialog,
  stateBadge,
  toast,
  toastError,
  usageBar,
} from "../lib/ui.js";

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
  if (box.storage?.status === "unreachable") {
    const pools = (box.storage.pools ?? [])
      .filter((pool) => pool.status === "unreachable")
      .map((pool) => pool.name)
      .join(", ");
    parts.push(
      `<div class="callout danger" style="margin-bottom:16px">${icon("alert")}<span><strong>${t("vol.unreachable")}</strong> ${t("vol.storageUnreachable", { pools: esc(pools) })}</span></div>`,
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
  ["activity", "bd.tabActivity", "activity"],
  ["resources", "bd.tabResources", "sliders"],
  ["ports", "bd.tabPorts", "externalLink"],
  ["tools", "bd.tabTools", "layers"],
  ["checkpoints", "bd.tabCheckpoints", "history"],
];

export function render(view, id, tab = "overview") {
  if (tab === "logs") tab = "activity";
  if (tab === "snapshots") tab = "checkpoints";
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
    tabCleanup = TAB_RENDER[tab](view.querySelector("#tabBody"), {
      box: () => box,
      history,
      onChange,
      refreshBox: fetchBox,
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
      if (await deleteBox(box)) location.hash = "#/boxes";
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

const ROLE_LABEL = {
  workspace: "vol.roleWorkspace",
  home: "vol.roleHome",
  tools: "vol.roleTools",
  cache: "vol.roleCache",
};

function mountsCard(box) {
  const rows = (box.mounts ?? [])
    .map((mount) => {
      const detach = mount.volumeId
        ? `<button class="btn btn-sm" data-action="detach-mount" data-volume="${esc(mount.volumeId)}" data-path="${esc(mount.path)}">${t("vol.detach")}</button>`
        : "";
      return `<tr>
        <td class="mono">${esc(mount.path)}</td>
        <td>${esc(mount.volumeName || mount.volume)}</td>
        <td>${mount.role ? esc(t(ROLE_LABEL[mount.role])) : "—"}</td>
        <td>${esc(mount.mode)}</td>
        <td>${esc(mount.pool || "—")}</td>
        <td>${detach}</td>
      </tr>`;
    })
    .join("");
  return `<div class="card" style="margin-top:16px"><div class="card-head"><h3>${t("vol.mounts")}</h3>
    <button class="btn btn-sm" data-action="attach-volume">${icon("plus")}${t("vol.attach")}</button></div>
    <div class="table-wrap">${
      rows
        ? `<table class="table"><thead><tr><th>${t("vol.colPath")}</th><th>${t("vol.choose")}</th><th>${t("vol.colRole")}</th><th>${t("vol.colMode")}</th><th>${t("vol.colPool")}</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
        : `<div class="card-body"><p class="subtle">${t("vol.noMounts")}</p></div>`
    }</div>
    <div class="card-body"><p class="help">${t("vol.rebuildNote")}</p></div></div>`;
}

/**
 * `blocks` are the commands of one step. Each has an optional label (the shell or PowerShell line) and an optional
 * note. The command scrolls sideways instead of breaking inside a word, and its copy button stays beside its label.
 */
function sshStep(number, title, help, blocks) {
  const commands = blocks
    .map(
      ({ label = "", commands: text, note = "" }) => `<div class="ssh-cmd">
      <div class="ssh-cmd-head">
        <span class="ssh-label">${esc(label)}</span>
        <button class="btn btn-sm" type="button" data-copy="${esc(text)}">${icon("copy")}${esc(t("bd.sshCopy"))}</button>
      </div>
      <pre class="token-snippet" tabindex="0">${esc(text)}</pre>
      ${note ? `<p class="help ssh-note">${esc(note)}</p>` : ""}
    </div>`,
    )
    .join("");
  return `<section class="ssh-step">
    <div class="ssh-step-head"><span class="ssh-step-num">${number}</span><strong>${esc(title)}</strong></div>
    <p class="help">${esc(help)}</p>
    ${commands}
  </section>`;
}

function openSshDialog(box) {
  const origin = location.origin;
  const { root } = openDialog({
    title: t("bd.sshTitle"),
    description: esc(t("bd.sshIntro")),
    iconName: "terminal",
    wide: true,
    body: `<div class="ssh-steps">
      ${sshStep(1, t("bd.sshInstall"), t("bd.sshInstallHelp"), [
        { label: t("bd.sshUnix"), commands: installCommands(origin) },
        { label: t("bd.sshWindows"), commands: windowsInstallCommands(origin), note: t("bd.sshInstallWindowsNote") },
      ])}
      ${sshStep(2, t("bd.sshSetup"), t("bd.sshSetupHelp", { settings: t("nav.settings"), tokens: t("st.tokens") }), [
        { label: t("bd.sshUnix"), commands: setupCommands(origin) },
        { label: t("bd.sshWindows"), commands: windowsSetupCommands(origin), note: t("bd.sshSetupWindowsNote") },
      ])}
      ${sshStep(3, t("bd.sshConnect"), t("bd.sshConnectHelp"), [{ commands: connectCommands(box.name) }])}
    </div>`,
    footer: `<button class="btn" data-close type="button">${t("common.close")}</button>`,
  });
  root.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-copy]");
    if (!button) return;
    try {
      await copyText(button.dataset.copy);
      toast(t("bd.sshCopied"));
    } catch (err) {
      toastError(t("bd.sshCopyFailed"), err);
    }
  });
}

async function attachVolume(box) {
  let volumes = [];
  try {
    volumes = (await api("/api/volumes")).volumes;
  } catch (e) {
    toastError(t("vol.attachFailed"), e);
    return null;
  }
  if (!volumes.length) {
    toastError(t("vol.attachFailed"), { message: t("vol.none") });
    return null;
  }
  const options = volumes
    .map(
      (volume) =>
        `<option value="${esc(volume.id)}" data-role="${esc(volume.role ?? "")}">${esc(volume.name)}</option>`,
    )
    .join("");
  const picked = await new Promise((resolve) => {
    let value = null;
    const { root, close } = openDialog({
      title: t("vol.attach"),
      onClose: () => resolve(value),
      body: `<label class="field"><span>${t("vol.choose")}</span><select class="select" id="m-vol">${options}</select></label>
        <label class="field"><span>${t("vol.pathLabel")}</span><input class="input" id="m-path" value="/srv/data" /></label>
        <label class="field"><span>${t("vol.colMode")}</span><select class="select" id="m-mode"><option value="rw">${esc(t("vol.modeRw"))}</option><option value="ro">${esc(t("vol.modeRo"))}</option></select></label>`,
      footer: `<button class="btn" data-close>${t("common.cancel")}</button><button class="btn btn-primary" id="m-ok">${t("vol.attach")}</button>`,
    });
    const vol = root.querySelector("#m-vol");
    const mode = root.querySelector("#m-mode");
    const applyDefault = () => {
      const role = vol.selectedOptions[0]?.dataset.role;
      if (role === "tools") mode.value = "ro";
    };
    vol.addEventListener("change", applyDefault);
    applyDefault();
    root.querySelector("#m-ok").addEventListener("click", () => {
      value = { id: vol.value, path: root.querySelector("#m-path").value.trim(), mode: mode.value };
      close();
    });
  });
  if (!picked) return null;
  const volume = volumes.find((item) => item.id === picked.id);
  const others = (volume?.mounts ?? []).filter((mount) => mount.boxId !== box.boxId && mount.mode === "rw");
  if (picked.mode === "rw" && others.length) {
    const ok = await confirmDialog({
      title: t("vol.sharedRwTitle"),
      message: esc(t("vol.sharedRwMessage", { name: volume?.name ?? picked.id })),
      confirmText: t("vol.modeRw"),
      danger: true,
    });
    if (!ok) return null;
  }
  try {
    const result = await sendRebuildingChange(
      `/api/volumes/${enc(picked.id)}/attach`,
      { box: box.id, path: picked.path, mode: picked.mode },
      { "if-match": String(box.revision) },
      { title: t("vol.attach"), message: esc(volume?.name ?? picked.id) },
    );
    if (!result) return null;
    toast(
      t("vol.attached"),
      result.warning === "shared_rw" ? { message: t("vol.sharedRwMessage", { name: volume?.name ?? "" }) } : {},
    );
    return result.box;
  } catch (e) {
    toastError(t("vol.attachFailed"), e);
    return null;
  }
}

/**
 * Attaches or detaches a volume, which rebuilds the box. The first request only returns the rebuild preview as a 409.
 * The second one, with confirm, is sent after the user has seen that preview.
 */
async function sendRebuildingChange(url, body, headers, { title, message }) {
  try {
    return await api(url, { method: "POST", body, headers });
  } catch (err) {
    if (err.code !== "confirmation_required" || !err.details?.preview) throw err;
    const ok = await confirmDialog({
      title,
      message,
      body: rebuildPreviewHtml(err.details.preview),
      confirmText: t("rb.apply"),
      danger: true,
    });
    if (!ok) return null;
    return api(url, { method: "POST", body: { ...body, confirm: true }, headers });
  }
}

async function detachMount(box, el) {
  try {
    const result = await sendRebuildingChange(
      `/api/volumes/${enc(el.dataset.volume)}/detach`,
      { box: box.id, path: el.dataset.path },
      { "if-match": String(box.revision) },
      { title: t("vol.detach"), message: esc(el.dataset.path) },
    );
    if (!result) return null;
    toast(t("vol.detached"));
    return result.box;
  } catch (e) {
    toastError(t("vol.detachFailed"), e);
    return null;
  }
}

const TOOL_COLUMNS = 5;

const categoryLabel = (id) => t(`tool.cat.${id}`);

function toolGroupRow(group, collapsed) {
  return `<tr class="group-row"><td colspan="${TOOL_COLUMNS}">
    <button type="button" class="group-toggle" data-action="toggle-group" data-group="${esc(group.id)}" aria-expanded="${!collapsed}">
      ${icon("chevron")}<strong>${esc(categoryLabel(group.category))}</strong><span class="badge">${group.rows.length}</span>
    </button>
  </td></tr>`;
}

function toolInstalledCell(tool) {
  if (!tool.installed) return `<span class="subtle tool-missing">${esc(t("bd.toolsNotInstalled"))}</span>`;
  const version = tool.installedVersion ? `<span class="mono subtle">${esc(tool.installedVersion)}</span>` : "";
  const outside = tool.managed ? "" : `<span class="help">${esc(t("tool.foundOutside"))}</span>`;
  return `<div class="tool-state"><span class="badge badge-success">${esc(t("bd.toolsInstalled"))}</span>${version}${outside}</div>`;
}

function toolActionCell(tool) {
  const id = esc(tool.id);
  switch (toolAction(tool)) {
    case "needsRoot":
      return `<span class="badge badge-warning" title="${esc(t("tool.needsRootHelp"))}">${esc(t("tool.needsRoot"))}</span>`;
    case "managed":
      return `<button class="btn btn-sm" data-action="tool-upgrade" data-tool="${id}">${t("bd.toolsUpgrade")}</button>
        <button class="btn btn-sm" data-action="tool-uninstall" data-tool="${id}">${t("bd.toolsUninstall")}</button>`;
    case "outside":
      return "";
    default:
      return `<button class="btn btn-sm btn-primary" data-action="tool-install" data-tool="${id}">${t("bd.toolsInstall")}</button>`;
  }
}

function customActionCell(tool) {
  const id = esc(tool.id);
  return `<button class="btn btn-sm btn-ghost" data-action="tool-custom-edit" data-tool="${id}">${esc(t("bd.customEdit"))}</button>
        <button class="btn btn-sm btn-ghost" data-action="tool-custom-delete" data-tool="${id}">${esc(t("bd.customDelete"))}</button>`;
}

function toolRow(tool, isCustom) {
  const badge = isCustom
    ? ` <span class="badge badge-accent" title="${esc(t("bd.customBadgeHelp"))}">${esc(t("bd.customBadge"))}</span>`
    : "";
  return `<tr>
    <td><strong>${esc(tool.name)}</strong>${badge}<div class="help">${esc(tool.description)}</div>${tool.requires ? `<div class="help">${esc(tool.requires)}</div>` : ""}</td>
    <td class="mono">${esc(tool.id)}</td>
    <td>${tool.desiredVersion ? esc(tool.desiredVersion) : "—"}</td>
    <td>${toolInstalledCell(tool)}</td>
    <td class="tool-action-cell"><div class="tool-actions">${toolActionCell(tool)}${isCustom ? customActionCell(tool) : ""}</div></td>
  </tr>`;
}

const TAB_RENDER = {
  overview(root, { box, onChange }) {
    root.innerHTML = `<div id="ovMain"></div><div id="ovEnv"></div><div id="ovStartup"></div><div id="ovMounts"></div>`;
    const env = mountEnvCard(root.querySelector("#ovEnv"), { box });
    const startup = mountStartupCard(root.querySelector("#ovStartup"), { box });
    const draw = () => {
      const b = box();
      const s = b.stats;
      root.querySelector("#ovMain").innerHTML = `
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
          <dt>${t("bd.sleeping")}</dt><dd>${b.sleeping ? t("bd.sleepingYes") : t("bd.sleepingNo")}${b.stopReason ? ` <span class="subtle">(${esc(t(`bd.stopReason.${b.stopReason}`))})</span>` : ""}</dd>
          <dt>${t("bd.lastActivity")}</dt><dd>${b.lastActivityAt ? dateTime(b.lastActivityAt) : t("bd.lastActivityUnknown")}</dd>
          <dt>${t("bd.idleTimeout")}</dt><dd>${b.idleTimeoutSec === 0 ? t("bd.idleNever") : b.idleTimeoutSec != null ? t("bd.seconds", { n: b.idleTimeoutSec }) : t("bd.idleInherit")}</dd>
          <dt>${t("bd.ttl")}</dt><dd>${b.ttlSec != null ? t("bd.seconds", { n: b.ttlSec }) : t("bd.ttlNone")}</dd>
          <dt>${t("bd.createdBy")}</dt><dd>${b.createdBy ? esc(b.createdBy) : t("bd.createdByUnknown")}</dd>
          <dt>${t("bd.containerId")}</dt><dd class="mono">${esc(b.id)}</dd>
          <dt>${t("bd.image")}</dt><dd class="mono">${esc(b.image)}</dd>
          <dt>${t("bd.template")}</dt><dd class="mono">${esc(b.template || "—")}</dd>
          <dt>${t("bd.profile")}</dt><dd>${b.profile ? t(`profile.${b.profile}`) : t("bd.profileLegacy")}</dd>
          <dt>${t("bd.network")}</dt><dd class="mono">${esc(b.network)}</dd>
          <dt>${t("bd.tools")}</dt><dd>${(b.tools ?? []).length ? esc((b.tools ?? []).map((item) => item.id).join(", ")) : t("bd.toolsNone")}</dd>
          <dt>${t("bd.workspace")}</dt><dd><span class="mono">/workspace</span> <span class="subtle">${t("bd.volume")}</span> <span class="mono">${esc(b.volume || "—")}</span></dd>
          <dt>${t("bd.created")}</dt><dd>${dateTime(b.createdAt)}</dd>
          <dt>${t("bd.cli")}</dt><dd><code>docker exec -it ${esc(b.containerName || `minibox-${b.name}`)} bash</code></dd>
        </dl></div></div>`;
      root.querySelector("#ovMounts").innerHTML = mountsCard(b);
    };
    draw();
    const off = onChange(() => {
      draw();
      env.onBoxChange();
      startup.onBoxChange();
    });
    return () => {
      off();
      env.dispose();
      startup.dispose();
    };
  },

  terminal(root, { box, onChange, rerender }) {
    return mountTerminal(root, { box, onChange, rerender });
  },

  activity(root, { box }) {
    return mountActivity(root, { box });
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

  ports(root, { box }) {
    const draw = async () => {
      const b = box();
      root.innerHTML = `<div class="card"><div class="card-body"><span class="spinner"></span> ${esc(t("bd.portsLoading"))}</div></div>`;
      let ports = [];
      try {
        ports = (await api(`/api/boxes/${enc(b.id)}/ports`)).ports;
      } catch (e) {
        root.innerHTML = emptyState({ iconName: "alert", title: t("bd.portsLoadFailed"), text: esc(e.message) });
        return;
      }
      const rows = ports
        .map((p) => {
          const source = p.source === "listening" ? t("bd.portsListening") : t("bd.portsManual");
          const remove =
            p.source === "manual"
              ? `<button class="btn btn-sm" data-action="port-remove" data-port="${p.port}">${t("bd.portsRemove")}</button>`
              : "";
          return `<tr>
            <td class="mono">${p.port}</td>
            <td>${esc(source)}</td>
            <td class="mono"><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)}</a></td>
            <td class="actions">
              <a class="btn btn-sm btn-primary" href="${esc(p.url)}" target="_blank" rel="noopener">${icon("externalLink")}${t("bd.portsOpen")}</a>
              ${remove}
            </td>
          </tr>`;
        })
        .join("");
      const body = ports.length
        ? `<div class="table-wrap"><table class="table"><thead><tr>
            <th>${t("bd.portsColPort")}</th><th>${t("bd.portsColSource")}</th><th>${t("bd.portsColUrl")}</th><th></th>
          </tr></thead><tbody>${rows}</tbody></table></div>`
        : emptyState({
            iconName: "externalLink",
            title: t("bd.portsEmpty"),
            text: b.running ? t("bd.portsEmptyText") : t("bd.portsNotRunning"),
          });
      root.innerHTML = `<div class="card"><div class="card-head"><h3>${t("bd.portsTitle")}</h3>
        <div class="actions">
          <button class="btn btn-sm" data-action="port-refresh">${icon("refresh")}${t("bd.portsRefresh")}</button>
          <button class="btn btn-sm btn-primary" data-action="port-add">${icon("plus")}${t("bd.portsAdd")}</button>
        </div></div>
        <div class="card-body"><p class="help">${t("bd.portsHelp")}</p></div>
        ${body}</div>`;
    };
    root.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-action]");
      if (!btn) return;
      const b = box();
      if (btn.dataset.action === "port-refresh") void draw();
      if (btn.dataset.action === "port-add") {
        void (async () => {
          const value = await promptDialog({
            title: t("bd.portsAddTitle"),
            description: t("bd.portsAddText"),
            iconName: "externalLink",
            label: t("bd.portsPort"),
            value: "3000",
            confirmText: t("bd.portsAdd"),
            validate: (v) => {
              const n = Number(v);
              if (!Number.isInteger(n) || n < 1 || n > 65535) return t("err.preview_port_invalid");
              return "";
            },
          });
          if (value === null) return;
          try {
            await api(`/api/boxes/${enc(b.id)}/ports`, { method: "POST", body: { port: Number(value) } });
            toast(t("bd.portsAdded"));
            await draw();
          } catch (e) {
            toastError(t("bd.portsAddFailed"), e);
          }
        })();
      }
      if (btn.dataset.action === "port-remove") {
        const port = Number(btn.dataset.port);
        void (async () => {
          const ok = await confirmDialog({
            title: t("bd.portsRemove"),
            message: String(port),
            confirmText: t("bd.portsRemove"),
            danger: true,
          });
          if (!ok) return;
          try {
            await api(`/api/boxes/${enc(b.id)}/ports/${port}`, { method: "DELETE" });
            toast(t("bd.portsRemoved"));
            await draw();
          } catch (e) {
            toastError(t("bd.portsRemoveFailed"), e);
          }
        })();
      }
    });
    void draw();
    return () => {};
  },

  tools(root, { box, refreshBox }) {
    const collapsed = new Set();
    const pending = new Set();
    let tools = null;
    /** The custom entries by id. Only an owner can list them, so for everyone else this stays empty. */
    let custom = new Map();
    let query = "";
    root.innerHTML = `<div class="card">
      <div class="card-head with-tools"><h3>${t("bd.toolsTitle")}</h3>
        <div class="list-tools">
          ${searchBoxHtml({ id: "bdToolSearch", placeholder: t("tool.searchPlaceholder"), label: t("tool.search") })}
          <button class="btn btn-sm" data-action="tool-custom-add" id="bdToolCustomAdd" hidden>${icon("plus")}${t("bd.customAdd")}</button>
          <button class="btn btn-sm" data-action="tool-reconcile">${icon("refresh")}${t("bd.toolsReconcile")}</button>
        </div></div>
      <div class="card-body"><p class="help">${t("bd.toolsHelp")}</p></div>
      <div class="table-wrap"><table class="table"><thead><tr>
        <th>${t("bd.toolsColName")}</th><th>${t("bd.toolsColId")}</th><th>${t("bd.toolsColDesired")}</th><th>${t("bd.toolsColInstalled")}</th><th></th>
      </tr></thead><tbody id="bdToolRows"><tr><td colspan="${TOOL_COLUMNS}"><span class="spinner"></span> ${esc(t("bd.toolsLoading"))}</td></tr></tbody></table></div></div>`;
    const body = root.querySelector("#bdToolRows");
    const addButton = root.querySelector("#bdToolCustomAdd");

    const drawRows = () => {
      if (!tools) return;
      const matches = filterTools(tools, query, categoryLabel);
      if (!matches.length) {
        body.innerHTML = `<tr><td colspan="${TOOL_COLUMNS}">${emptyState({
          iconName: "search",
          title: t("tool.noMatch"),
          text: t("tool.noMatchText", { q: esc(query) }),
          action: `<button class="btn btn-sm" data-action="clear-search">${t("common.clearSearch")}</button>`,
        })}</td></tr>`;
        return;
      }
      body.innerHTML = groupTools(matches)
        .map((group) => {
          const isCollapsed = collapsed.has(group.id);
          const rows = group.rows.map((tool) => toolRow(tool, custom.has(tool.id))).join("");
          return toolGroupRow(group, isCollapsed) + (isCollapsed ? "" : rows);
        })
        .join("");
    };
    const load = async () => {
      const [listed, entries] = await Promise.allSettled([
        api(`/api/tools?id=${enc(box().id)}`),
        api("/api/tools/custom"),
      ]);
      custom = new Map(entries.status === "fulfilled" ? entries.value.tools.map((entry) => [entry.id, entry]) : []);
      addButton.hidden = entries.status !== "fulfilled";
      if (listed.status === "rejected") {
        body.innerHTML = `<tr><td colspan="${TOOL_COLUMNS}">${emptyState({ iconName: "alert", title: t("bd.toolsLoadFailed"), text: esc(listed.reason.message) })}</td></tr>`;
        return;
      }
      tools = listed.value.tools;
      drawRows();
    };
    const customDialog = (entry) =>
      openCustomToolDialog({
        entry,
        catalogIds: new Set((tools ?? []).map((item) => item.id)),
        customById: custom,
        onSaved: () => void load(),
      });
    const search = bindSearchBox(root.querySelector("#bdToolSearch"), (text) => {
      query = text;
      drawRows();
    });
    const toggleGroup = (id) => {
      if (collapsed.has(id)) collapsed.delete(id);
      else collapsed.add(id);
      drawRows();
      [...root.querySelectorAll(".group-toggle")].find((button) => button.dataset.group === id)?.focus();
    };
    const start = async (path, tool) => {
      try {
        const payload = tool ? { tool, version: "latest" } : undefined;
        const res = await api(path, { method: "POST", ...(payload ? { body: payload } : {}) });
        if (res?.taskId) {
          pending.add(res.taskId);
          openTasks(res.taskId);
        }
        toast(t("bd.toolsTaskStarted"));
        await load();
        void refreshBox?.().catch(() => {});
      } catch (e) {
        toastError(t("bd.toolsTaskFailed"), e);
      }
    };
    const offTask = subscribe("task", (frame) => {
      if (frame.kind !== "status" || frame.status === "running") return;
      if (pending.delete(frame.taskId)) void load();
    });
    root.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-action]");
      if (!btn) return;
      const b = box();
      const tool = btn.dataset.tool;
      if (btn.dataset.action === "clear-search") search.clear();
      if (btn.dataset.action === "toggle-group") toggleGroup(btn.dataset.group);
      if (btn.dataset.action === "tool-install") void start(`/api/boxes/${enc(b.id)}/tools/install`, tool);
      if (btn.dataset.action === "tool-upgrade") void start(`/api/boxes/${enc(b.id)}/tools/upgrade`, tool);
      if (btn.dataset.action === "tool-uninstall") void start(`/api/boxes/${enc(b.id)}/tools/uninstall`, tool);
      if (btn.dataset.action === "tool-reconcile") void start(`/api/boxes/${enc(b.id)}/tools/reconcile`);
      if (btn.dataset.action === "tool-custom-add") customDialog(null);
      if (btn.dataset.action === "tool-custom-edit" && custom.has(tool)) customDialog(custom.get(tool));
      if (btn.dataset.action === "tool-custom-delete" && custom.has(tool)) {
        void deleteCustomTool(custom.get(tool), { onDeleted: () => void load() });
      }
    });
    void load();
    return () => offTask();
  },

  checkpoints(root, { box, refreshBox }) {
    return mountCheckpoints(root, { box, refreshBox });
  },
};
