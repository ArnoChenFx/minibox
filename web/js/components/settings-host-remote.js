import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { dateTime, relTime } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { confirmDialog, emptyState, openDialog, skeletonRows, toast, toastError, withBusy } from "../lib/ui.js";
import { taskErrorText, waitTask } from "./tasks.js";

const COLUMNS = 5;

/**
 * The base folder a remote was saved with. The server appends the host id to it, so the form shows the folder without
 * that last segment; an empty folder at the target's root reads back as the host id alone.
 */
function basePathOf(path, hostId, kind) {
  if (path === hostId) return "";
  const suffix = `/${hostId}`;
  if (path === suffix) return kind === "sftp" ? "/" : "";
  return path.endsWith(suffix) ? path.slice(0, -suffix.length) : path;
}

/** The checkpoints of one host the remote does not hold yet, counted as the sync service counts them. */
function pendingCount(checkpoints, hostId, targetId) {
  return checkpoints.filter(
    (checkpoint) =>
      checkpoint.hostId === hostId && checkpoint.data.length > 0 && checkpoint.remoteSync?.[targetId] === undefined,
  ).length;
}

/**
 * The checkpoint records a host holds, as the page already read them. The list leaves out recycle bin entries, which
 * the server counts too; the dialog says what it can see, and a save the server refuses says why.
 */
function recordCount(checkpoints, hostId) {
  return checkpoints.filter((checkpoint) => checkpoint.hostId === hostId).length;
}

/** A target the form offers: only S3 and SFTP can hold a checkpoint repository. */
const usableTarget = (target) => target.kind === "s3" || target.kind === "sftp";

/**
 * Reads the hosts' remote repositories, the targets the form offers and the checkpoints the pending count needs. A host
 * whose read fails is shown as having none, so one unreachable answer does not hide the others.
 */
async function readRemotes(hosts) {
  const [{ targets }, { checkpoints }, ...replies] = await Promise.all([
    api("/api/targets"),
    api("/api/checkpoints"),
    ...hosts.map((host) =>
      api(`/api/hosts/${enc(host.id)}/checkpoint-remote`).then(
        (reply) => reply.remote,
        () => null,
      ),
    ),
  ]);
  return {
    targets,
    checkpoints,
    remotes: new Map(hosts.map((host, index) => [host.id, replies[index] ?? null])),
  };
}

/** One host's row: where its snapshots go, when they last went, what waits, and the controls that change it. */
function rowHtml(host, remote, targets, checkpoints) {
  const target = remote ? targets.find((item) => item.id === remote.targetId) : undefined;
  const only = remote?.mode === "only";
  const locked = only && recordCount(checkpoints, host.id) > 0;
  const mode = only ? ` <span class="badge badge-accent">${esc(t("st.hostRemoteOnlyBadge"))}</span>` : "";
  const repo = remote
    ? `<strong>${esc(remote.targetName)}</strong> <span class="badge">${esc(t(`st.targetKind.${remote.kind}`))}</span>${mode}
       <div class="help mono truncate" title="${esc(remote.path)}">${esc(remote.path)}</div>`
    : `<span class="subtle">${esc(t("st.hostRemoteNone"))}</span>`;
  const failures =
    remote && remote.failures > 0
      ? `<div class="error-text">${esc(t("st.hostRemoteFailures", { count: remote.failures }))}</div>`
      : "";
  // A remote-only host never copies, so it has neither a last sync nor a pending count; the mode badge says why.
  const last = only
    ? `<span class="subtle">—</span>`
    : remote
      ? `${remote.lastSyncAt ? `<span title="${esc(dateTime(remote.lastSyncAt))}">${esc(relTime(remote.lastSyncAt))}</span>` : `<span class="subtle">${esc(t("st.hostRemoteNever"))}</span>`}
       ${remote.lastError ? `<div class="error-text" title="${esc(remote.lastError)}">${esc(remote.lastError)}</div>` : ""}${failures}`
      : `<span class="subtle">—</span>`;
  const pending = remote && !only ? String(pendingCount(checkpoints, host.id, remote.targetId)) : "—";
  const missing = remote && !target ? `<div class="help">${esc(t("st.hostRemoteTargetMissing"))}</div>` : "";
  const agent = host.transport === "agent" ? `<div class="help">${esc(t("st.hostRemoteAgent"))}</div>` : "";
  const syncButton = only
    ? ""
    : `<button class="btn btn-sm" data-remote-sync="${esc(host.id)}"${host.transport === "agent" ? " disabled" : ""}>${icon("refresh")}${esc(t("st.hostRemoteSync"))}</button>`;
  const clearTitle = locked ? ` title="${esc(t("st.hostRemoteClearLocked"))}"` : "";
  const actions = remote
    ? `<button class="btn btn-sm" data-remote-edit="${esc(host.id)}">${icon("settings")}${esc(t("st.hostRemoteEdit"))}</button>
       ${syncButton}
       <button class="btn btn-sm btn-danger" data-remote-clear="${esc(host.id)}"${locked ? " disabled" : ""}${clearTitle}>${icon("x")}${esc(t("st.hostRemoteClear"))}</button>`
    : `<button class="btn btn-sm btn-primary" data-remote-set="${esc(host.id)}"${host.transport === "agent" ? " disabled" : ""}>${icon("plus")}${esc(t("st.hostRemoteSet"))}</button>`;
  return `<tr data-host-remote="${esc(host.id)}">
    <td class="host-remote-host"><strong>${esc(host.name)}</strong> <span class="subtle mono">${esc(host.id)}</span>${agent}</td>
    <td class="host-remote-repo">${repo}${missing}</td>
    <td class="host-remote-last" data-remote-last data-label="${esc(t("st.hostRemoteColLast"))}">${last}</td>
    <td class="host-remote-pending num" data-remote-pending data-label="${esc(t("st.hostRemoteColPending"))}">${pending}</td>
    <td class="host-remote-actions"><div class="actions">${actions}</div></td>
  </tr>`;
}

function bodyHtml(hosts, data) {
  if (hosts.length === 0) {
    return `<tr><td colspan="${COLUMNS}">${emptyState({ iconName: "server", title: t("st.hostRemoteNoHosts") })}</td></tr>`;
  }
  return hosts.map((host) => rowHtml(host, data.remotes.get(host.id) ?? null, data.targets, data.checkpoints)).join("");
}

/**
 * The hosts page's remote checkpoint repository card. It draws one row per host with the configured target, the last
 * success and the pending count, and opens the dialog that sets, changes or clears one. Returns after the first draw;
 * the card shows skeleton rows until the reads answer.
 */
export async function loadHostRemote(view, hosts) {
  const card = view.querySelector("#stHostRemote");
  if (!card) return;
  card.innerHTML = `
    <div class="card-head"><div><h3>${t("st.hostRemote")}</h3><p class="help">${t("st.hostRemoteHelp")}</p></div></div>
    <div class="table-wrap"><table class="table host-remote-table">
      <thead><tr>
        <th>${t("st.hostRemoteColHost")}</th>
        <th>${t("st.hostRemoteColRepo")}</th>
        <th>${t("st.hostRemoteColLast")}</th>
        <th>${t("st.hostRemoteColPending")}</th>
        <th><span class="sr-only">${t("st.hostRemoteColActions")}</span></th>
      </tr></thead>
      <tbody id="stHostRemoteRows" aria-busy="true">${skeletonRows(Math.max(1, Math.min(hosts.length, 3)), COLUMNS)}</tbody>
    </table></div>`;

  let data;
  try {
    data = await readRemotes(hosts);
  } catch (e) {
    const body = card.querySelector("#stHostRemoteRows");
    body.removeAttribute("aria-busy");
    body.innerHTML = `<tr><td colspan="${COLUMNS}"><div class="callout danger">${icon("alert")}<span>${esc(e.message)}</span></div></td></tr>`;
    return;
  }
  const body = card.querySelector("#stHostRemoteRows");
  body.removeAttribute("aria-busy");
  body.innerHTML = bodyHtml(hosts, data);
  bind(card, view, hosts, data);
}

function hostOf(hosts, id) {
  return hosts.find((host) => host.id === id);
}

function bind(card, view, hosts, data) {
  for (const button of card.querySelectorAll("[data-remote-set], [data-remote-edit]")) {
    button.addEventListener("click", () => {
      const id = button.dataset.remoteSet ?? button.dataset.remoteEdit;
      const host = hostOf(hosts, id);
      if (!host) return;
      openRemoteDialog(view, host, data.remotes.get(id) ?? null, data.targets, hosts, data.checkpoints);
    });
  }
  for (const button of card.querySelectorAll("[data-remote-sync]")) {
    button.addEventListener("click", (event) => syncNow(event.currentTarget, view, hosts));
  }
  for (const button of card.querySelectorAll("[data-remote-clear]")) {
    button.addEventListener("click", (event) => clearRemote(event.currentTarget, view, hosts));
  }
}

async function syncNow(button, view, hosts) {
  const id = button.dataset.remoteSync;
  await withBusy(button, async () => {
    let started;
    try {
      started = await api(`/api/hosts/${enc(id)}/checkpoint-remote/sync`, { method: "POST" });
    } catch (e) {
      toastError(t("st.hostRemoteSyncFailed"), e);
      return;
    }
    // The task drawer shows the copy's progress, and waiting keeps the row's figures current when it ends.
    const task = await waitTask(started.taskId);
    if (task.status === "succeeded") toast(t("st.hostRemoteSynced"), { message: hostOf(hosts, id)?.name ?? id });
    else
      toastError(t("st.hostRemoteSyncFailed"), {
        message: taskErrorText(task.error) || t(`task.status.${task.status}`),
      });
    await loadHostRemote(view, hosts);
  });
}

async function clearRemote(button, view, hosts) {
  const id = button.dataset.remoteClear;
  const host = hostOf(hosts, id);
  const name = host?.name ?? id;
  const ok = await confirmDialog({
    title: t("st.hostRemoteClearTitle", { host: name }),
    message: esc(t("st.hostRemoteClearMessage")),
    confirmText: t("st.hostRemoteClear"),
    danger: true,
  });
  if (!ok) return;
  await withBusy(button, async () => {
    try {
      await api(`/api/hosts/${enc(id)}/checkpoint-remote`, { method: "DELETE" });
    } catch (e) {
      toastError(t("st.hostRemoteClearFailed"), e);
      return;
    }
    toast(t("st.hostRemoteCleared"), { message: name });
    await loadHostRemote(view, hosts);
  });
}

/**
 * Sets or changes one host's remote repository. The target list is the S3 and SFTP targets only: a WebDAV target cannot
 * hold a restic repository. The folder is the base the server appends the host id to. A host with checkpoint records
 * cannot move to or from the only-remote mode, and one already there cannot change its position or be cleared.
 */
function openRemoteDialog(view, host, remote, targets, hosts, checkpoints) {
  const eligible = targets.filter(usableTarget);
  const selected = remote?.targetId ?? eligible[0]?.id ?? "";
  const folder = remote ? basePathOf(remote.path, host.id, remote.kind) : "";
  const mode = remote?.mode ?? "sync";
  const only = mode === "only";
  const records = recordCount(checkpoints ?? [], host.id);
  const locked = records > 0;
  // The mode can only change when the host has no records, and a host already in only mode is frozen while it has any.
  const positionLocked = only && locked;
  const passwordFile = `checkpoint-remote-${host.id}.key`;
  const options = eligible
    .map(
      (target) =>
        `<option value="${esc(target.id)}"${target.id === selected ? " selected" : ""}>${esc(target.name)} · ${esc(t(`st.targetKind.${target.kind}`))}</option>`,
    )
    .join("");
  const { root, close } = openDialog({
    title: remote ? t("st.hostRemoteEditTitle", { host: host.name }) : t("st.hostRemoteSetTitle", { host: host.name }),
    description: t("st.hostRemoteDialogHelp"),
    iconName: "upload",
    body: `
      <div class="stack form-stack">
        <label class="field">${t("st.hostRemoteMode")}
          <select class="select" name="mode"${positionLocked ? " disabled" : ""}>
            <option value="sync"${only ? "" : " selected"}>${esc(t("st.hostRemoteModeSync"))}</option>
            <option value="only"${only ? " selected" : ""}${locked && !only ? " disabled" : ""}>${esc(t("st.hostRemoteModeOnly"))}</option>
          </select>
          <span class="help">${esc(t("st.hostRemoteModeHelp"))}</span>
        </label>
        ${locked ? `<div class="callout warn" id="stHostRemoteRecords">${icon("alert")}<span>${esc(t("st.hostRemoteModeLocked", { count: records }))}</span></div>` : ""}
        <label class="field">${t("st.hostRemoteTarget")}
          <select class="select" name="targetId"${eligible.length === 0 || positionLocked ? " disabled" : ""}>${options || `<option value="">${esc(t("st.hostRemoteNoTargets"))}</option>`}</select>
          <span class="help">${t("st.hostRemoteTargetHelp")}</span>
        </label>
        <label class="field">${t("st.hostRemoteFolder")}
          <input class="input mono" name="path" maxlength="512" value="${esc(folder)}" spellcheck="false" autocomplete="off"${positionLocked ? " disabled" : ""} />
          <span class="help">${t("st.hostRemoteFolderHelp")}</span>
        </label>
        <div class="callout warn${only ? "" : " hidden"}" id="stHostRemoteOnlyNotice">${icon("alert")}<div class="stack">
          <span>${esc(t("st.hostRemoteOnlyNetwork"))}</span>
          <span>${esc(t("st.hostRemoteOnlyNoLocal"))}</span>
          <span>${esc(t("st.hostRemoteOnlyKey", { file: passwordFile }))}</span>
        </div></div>
        ${eligible.length === 0 ? `<div class="callout warn">${icon("alert")}<span>${esc(t("st.hostRemoteNoTargets"))}</span></div>` : ""}
      </div>`,
    footer: `<button class="btn" data-close>${t("common.cancel")}</button>
      ${remote ? `<button class="btn btn-danger" id="stHostRemoteClear"${positionLocked ? " disabled" : ""}${positionLocked ? ` title="${esc(t("st.hostRemoteClearLocked"))}"` : ""}>${icon("trash")}${t("st.hostRemoteClear")}</button>` : ""}
      <button class="btn btn-primary" id="stHostRemoteSave"${eligible.length === 0 ? " disabled" : ""}>${icon("check")}${t("st.hostRemoteSave")}</button>`,
  });
  const modeSelect = root.querySelector('[name="mode"]');
  const notice = root.querySelector("#stHostRemoteOnlyNotice");
  const target = root.querySelector('[name="targetId"]');
  const path = root.querySelector('[name="path"]');
  modeSelect?.addEventListener("change", () => {
    notice?.classList.toggle("hidden", modeSelect.value !== "only");
  });
  root.querySelector("#stHostRemoteSave")?.addEventListener("click", (event) =>
    withBusy(event.currentTarget, async () => {
      try {
        await api(`/api/hosts/${enc(host.id)}/checkpoint-remote`, {
          method: "PUT",
          body: { targetId: target.value, path: path.value.trim(), mode: modeSelect.value },
        });
      } catch (e) {
        toastError(t("st.hostRemoteSaveFailed"), e);
        return;
      }
      close();
      toast(t("st.hostRemoteSaved"), { message: host.name });
      await loadHostRemote(view, hosts);
    }),
  );
  root.querySelector("#stHostRemoteClear")?.addEventListener("click", (event) =>
    withBusy(event.currentTarget, async () => {
      const ok = await confirmDialog({
        title: t("st.hostRemoteClearTitle", { host: host.name }),
        message: esc(t("st.hostRemoteClearMessage")),
        confirmText: t("st.hostRemoteClear"),
        danger: true,
      });
      if (!ok) return;
      try {
        await api(`/api/hosts/${enc(host.id)}/checkpoint-remote`, { method: "DELETE" });
      } catch (e) {
        toastError(t("st.hostRemoteClearFailed"), e);
        return;
      }
      close();
      toast(t("st.hostRemoteCleared"), { message: host.name });
      await loadHostRemote(view, hosts);
    }),
  );
}
