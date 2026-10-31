import { api, enc } from "../lib/api.js";
import {
  browserTimezone,
  contentsOf,
  HOLD_MODES,
  isVolumeSnapshot,
  kindsOf,
  newestFirst,
  passphraseOk,
  remoteMarksOf,
  rowActions,
  SKIP_REASON_KEYS,
  usedPercent,
} from "../lib/checkpoint-state.js";
import { esc } from "../lib/dom.js";
import { bytes, dateTime, relTime } from "../lib/format.js";
import { boxOnAgentHost, hostLabel, hostOfBox } from "../lib/host-list.js";
import { hostFilter, hostName, hostsNow, multiHost } from "../lib/hosts.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { subscribe } from "../lib/live.js";
import { bindScheduleForm, lastRunText, scheduleCardHtml, scheduleFieldsHtml, zonedTime } from "../lib/schedule-ui.js";
import { confirmDialog, emptyState, nameError, openDialog, toast, toastError, withBusy } from "../lib/ui.js";
import { flip, limitList } from "./list-toggle.js";
import { openTasks, taskErrorText, waitTask } from "./tasks.js";

/** How many checkpoints the box's tab lists before its show-all toggle. */
const LIST_ROWS = 8;

export const KIND_CLASS = {
  legacy: "badge-warning",
  pinned: "badge-success",
  automatic: "",
  manual: "badge-accent",
  volume: "badge-accent",
};

const callout = (tone, text) => `<div class="callout ${tone}">${icon("alert")}<span>${esc(text)}</span></div>`;

function failureOf(task) {
  return taskErrorText(task.error) || t(`task.status.${task.status}`);
}

/** Runs one action and reports a failure. A conflict that names a running task opens that task instead. */
async function guarded(failed, run) {
  try {
    return await run();
  } catch (err) {
    if (err.details?.taskId) {
      toast(t("task.alreadyRunning"), { type: "info" });
      openTasks(err.details.taskId);
    } else {
      toastError(t(failed), err);
    }
    return null;
  }
}

export function takeFormHtml(box) {
  const holds = HOLD_MODES.map(
    (mode) =>
      `<button type="button" class="seg" data-hold="${mode}" aria-pressed="${mode === "live"}"><strong>${esc(t(`ck.hold.${mode}`))}</strong><span>${esc(t(`ck.holdHint.${mode}`))}</span></button>`,
  ).join("");
  return `<div class="field"><label class="label" for="ckLabel">${esc(t("ck.takeLabel"))}</label>
      <input class="input" id="ckLabel" maxlength="200" placeholder="${esc(box.name)}" autocomplete="off" />
      <div class="help">${esc(t("ck.takeLabelHelp"))}</div></div>
    <div class="field"><span class="label">${esc(t("ck.takeHold"))}</span>
      <div class="segmented segmented-3" role="group" aria-label="${esc(t("ck.takeHold"))}">${holds}</div>
      <div class="help">${esc(t("ck.takeHoldHelp"))}</div></div>
    <label class="checkbox"><input type="checkbox" id="ckSystem" /> <span>${esc(t("ck.takeSystem"))}<div class="help">${esc(t("ck.takeSystemHelp"))}</div></span></label>`;
}

function askTake(box) {
  return new Promise((resolve) => {
    let result = null;
    let hold = "live";
    const { root, close } = openDialog({
      title: t("ck.takeTitle"),
      description: esc(t("ck.takeDesc", { name: box.name })),
      iconName: "camera",
      body: takeFormHtml(box),
      footer: `<button class="btn" data-close>${esc(t("common.cancel"))}</button><button class="btn btn-primary" id="ckTakeOk">${esc(t("ck.takeConfirm"))}</button>`,
      onClose: () => resolve(result),
    });
    const holdButtons = root.querySelectorAll("[data-hold]");
    for (const button of holdButtons) {
      button.addEventListener("click", () => {
        hold = button.dataset.hold;
        for (const other of holdButtons) other.setAttribute("aria-pressed", String(other === button));
      });
    }
    root.querySelector("#ckTakeOk").addEventListener("click", () => {
      const label = root.querySelector("#ckLabel").value.trim();
      result = {
        consistency: hold,
        include: { system: root.querySelector("#ckSystem").checked },
        ...(label ? { label } : {}),
      };
      close();
    });
  });
}

/** Asks for a new checkpoint of a box, then takes it and waits for the task. Resolves to the checkpoint, or null. */
export async function takeCheckpoint(box) {
  const input = await askTake(box);
  if (!input) return null;
  return guarded("ck.takeFailed", async () => {
    const started = await api(`/api/boxes/${enc(box.boxId)}/checkpoints`, { method: "POST", body: input });
    toast(t("ck.takeStarted"), { type: "info", message: box.name });
    const done = await waitTask(started.taskId);
    if (done.status !== "succeeded") {
      toastError(t("ck.takeFailed"), { message: failureOf(done) });
      return null;
    }
    toast(t("ck.takeDone"), { message: done.result.checkpoint.label });
    return done.result.checkpoint;
  });
}

function askFork(checkpoint, box) {
  return new Promise((resolve) => {
    let result = null;
    const { root, close } = openDialog({
      title: t("ck.forkTitle", { label: checkpoint.label }),
      description: esc(t("ck.forkDesc")),
      iconName: "copy",
      body: `<div class="field"><label class="label" for="ckForkName">${esc(t("ck.forkName"))}</label>
          <input class="input" id="ckForkName" maxlength="63" placeholder="${esc(`${box.name}-fork`)}" autocomplete="off" />
          <div class="error-text" id="ckForkErr"></div></div>
        <label class="checkbox"><input type="checkbox" id="ckForkHome" /> <span>${esc(t("ck.forkHome"))}<div class="help">${esc(t("ck.forkHomeHelp"))}</div></span></label>`,
      footer: `<button class="btn" data-close>${esc(t("common.cancel"))}</button><button class="btn btn-primary" id="ckForkOk">${esc(t("ck.forkConfirm"))}</button>`,
      onClose: () => resolve(result),
    });
    const input = root.querySelector("#ckForkName");
    const submit = () => {
      const name = input.value.trim();
      const error = nameError(name, "name");
      if (error) {
        input.classList.add("invalid");
        root.querySelector("#ckForkErr").textContent = error;
        return;
      }
      result = { name, copyHome: root.querySelector("#ckForkHome").checked };
      close();
    };
    root.querySelector("#ckForkOk").addEventListener("click", submit);
    input.addEventListener("keydown", (event) => event.key === "Enter" && submit());
  });
}

/** Asks for a name and a home copy, then creates a box from the checkpoint and opens it. */
export async function forkCheckpoint(checkpoint, box) {
  const input = await askFork(checkpoint, box);
  if (!input) return null;
  return guarded("ck.forkFailed", async () => {
    const started = await api(`/api/checkpoints/${enc(checkpoint.id)}/fork`, { method: "POST", body: input });
    toast(t("ck.forkStarted"), { type: "info", message: input.name });
    const done = await waitTask(started.taskId);
    if (done.status !== "succeeded") {
      toastError(t("ck.forkFailed"), { message: failureOf(done) });
      return null;
    }
    toast(t("ck.forked"), { message: input.name });
    location.hash = `#/boxes/${enc(done.result.box.id)}`;
    return done.result.box;
  });
}

/**
 * A host to put a checkpoint on, labelled among `hosts` so two hosts of one name read apart. An agent host is listed but
 * cannot be picked, with the reason in its label: it runs boxes only, so an import or a copy onto it would answer 501.
 */
function checkpointHostOption(host, selected, hosts) {
  const agent = host.transport === "agent";
  const name = hostLabel(host, hosts);
  const label = agent ? t("ck.agentHostOption", { name }) : name;
  return `<option value="${esc(host.id)}"${selected ? " selected" : ""}${agent ? " disabled" : ""}>${esc(label)}</option>`;
}

/** The host a checkpoint form starts on: `wanted` if it can hold checkpoints, else the first host that can. */
const checkpointHostChoice = (hosts, wanted) =>
  hosts.find((host) => host.id === wanted && host.transport !== "agent")?.id ??
  hosts.find((host) => host.transport !== "agent")?.id ??
  "";

/** The host a copy goes to: each host but the one the checkpoint is kept on. */
export function copyFormHtml({ hosts, from }) {
  const targets = hosts.filter((host) => host.id !== from);
  const chosen = checkpointHostChoice(targets, "");
  const options = targets.map((host) => checkpointHostOption(host, host.id === chosen, hosts)).join("");
  return `<div class="field"><label class="label" for="ckCopyHost">${esc(t("cb.host"))}</label>
      <select class="select" id="ckCopyHost">${options}</select>
      <div class="help">${esc(t("ck.copyHostHelp"))}</div></div>
    ${callout("info", t("ck.copyHow"))}`;
}

function askCopy(checkpoint, hosts) {
  return new Promise((resolve) => {
    let result = null;
    const { root, close } = openDialog({
      title: t("ck.copyTitle", { label: checkpoint.label }),
      description: esc(t("ck.copyDesc")),
      iconName: "server",
      body: copyFormHtml({ hosts, from: checkpoint.hostId }),
      footer: `<button class="btn" data-close>${esc(t("common.cancel"))}</button><button class="btn btn-primary" id="ckCopyOk">${esc(t("ck.copyConfirm"))}</button>`,
      onClose: () => resolve(result),
    });
    root.querySelector("#ckCopyOk").addEventListener("click", () => {
      const picked = root.querySelector("#ckCopyHost").selectedOptions[0];
      // An agent host is listed but disabled; with nothing else to pick, there is nothing to copy to.
      if (!picked || picked.disabled) return;
      const host = picked.value;
      result = { host };
      close();
    });
  });
}

/** Asks for the host to copy a checkpoint to, copies it there and waits for the task. Resolves to the copy, or null. */
export async function copyCheckpoint(checkpoint) {
  const input = await askCopy(checkpoint, hostsNow());
  if (!input) return null;
  return guarded("ck.copyFailed", async () => {
    const started = await api(`/api/checkpoints/${enc(checkpoint.id)}/copy`, { method: "POST", body: input });
    toast(t("ck.copyStarted"), { type: "info", message: hostName(input.host) });
    const done = await waitTask(started.taskId);
    if (done.status !== "succeeded") {
      toastError(t("ck.copyFailed"), { message: failureOf(done) });
      return null;
    }
    toast(t("ck.copied"), { message: hostName(input.host) });
    return done.result.checkpoint;
  });
}

/** Starts the browser's download of a package. The server names the file and keeps the package for a day. */
function download(url) {
  const link = document.createElement("a");
  link.href = url;
  document.body.append(link);
  link.click();
  link.remove();
}

export function exportFormHtml() {
  return `<div class="field"><label class="label" for="ckPass">${esc(t("ck.passphrase"))}</label>
      <input class="input mono" id="ckPass" type="password" autocomplete="new-password" autocapitalize="off" spellcheck="false" />
      <div class="help">${esc(t("ck.passphraseHelp"))}</div></div>
    <div class="field"><label class="label" for="ckPassAgain">${esc(t("ck.passphraseAgain"))}</label>
      <input class="input mono" id="ckPassAgain" type="password" autocomplete="new-password" autocapitalize="off" spellcheck="false" />
      <div class="error-text" id="ckPassErr"></div></div>
    ${callout("info", t("ck.exportHow"))}`;
}

function askExport(checkpoint) {
  return new Promise((resolve) => {
    let result = null;
    const { root, close } = openDialog({
      title: t("ck.exportTitle", { label: checkpoint.label }),
      description: esc(t("ck.exportDesc")),
      iconName: "download",
      body: exportFormHtml(),
      footer: `<button class="btn" data-close>${esc(t("common.cancel"))}</button><button class="btn btn-primary" id="ckExportOk">${esc(t("ck.exportConfirm"))}</button>`,
      onClose: () => resolve(result),
    });
    const pass = root.querySelector("#ckPass");
    const again = root.querySelector("#ckPassAgain");
    const err = root.querySelector("#ckPassErr");
    root.querySelector("#ckExportOk").addEventListener("click", () => {
      const invalid = !passphraseOk(pass.value);
      const mismatch = !invalid && pass.value !== again.value;
      pass.classList.toggle("invalid", invalid);
      again.classList.toggle("invalid", mismatch);
      err.textContent = invalid ? t("err.package_passphrase_invalid") : mismatch ? t("ck.passphraseMismatch") : "";
      if (invalid || mismatch) return;
      result = { passphrase: pass.value };
      close();
    });
  });
}

/** Asks for a passphrase, seals the checkpoint in a package, and downloads the package once the export finishes. */
export async function exportCheckpoint(checkpoint) {
  const input = await askExport(checkpoint);
  if (!input) return null;
  return guarded("ck.exportFailed", async () => {
    const started = await api(`/api/checkpoints/${enc(checkpoint.id)}/export`, { method: "POST", body: input });
    toast(t("ck.exportStarted"), { type: "info", message: checkpoint.label });
    const done = await waitTask(started.taskId);
    if (done.status !== "succeeded") {
      toastError(t("ck.exportFailed"), { message: failureOf(done) });
      return null;
    }
    download(done.result.package.url);
    toast(t("ck.exported"), { message: checkpoint.label });
    return done.result.package;
  });
}

export function importFormHtml({ hosts, host }) {
  const hostField =
    hosts.length > 1
      ? `<div class="field"><label class="label" for="ckImportHost">${esc(t("cb.host"))}</label>
          <select class="select" id="ckImportHost">${hosts
            .map((h) => checkpointHostOption(h, h.id === checkpointHostChoice(hosts, host), hosts))
            .join("")}</select>
          <div class="help">${esc(t("ck.importHostHelp"))}</div></div>`
      : "";
  return `<div class="field"><span class="label">${esc(t("ck.importFile"))}</span>
      <div class="file-pick">
        <input class="sr-only" id="ckImportFile" type="file" accept=".mbckpt" tabindex="-1" />
        <button type="button" class="btn btn-sm" id="ckImportPick">${icon("upload")}${esc(t("ck.importChoose"))}</button>
        <span class="file-pick-name" id="ckImportFileName">${esc(t("ck.importNoneChosen"))}</span>
      </div>
      <div class="help">${esc(t("ck.importFileHelp"))}</div></div>
    <div class="field"><label class="label" for="ckImportPass">${esc(t("ck.passphrase"))}</label>
      <input class="input mono" id="ckImportPass" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" /></div>
    ${hostField}
    <div class="error-text" id="ckImportErr"></div>`;
}

/**
 * Asks for a package file and the passphrase it was sealed with, uploads the file and imports it as a checkpoint. The
 * dialog stays open until the import succeeds: a wrong passphrase is retyped in place, and the uploaded package is
 * imported again rather than uploaded again.
 */
export function importCheckpoint() {
  return new Promise((resolve) => {
    let imported = null;
    let uploaded = null;
    const { root, close } = openDialog({
      title: t("ck.importTitle"),
      description: esc(t("ck.importDesc")),
      iconName: "upload",
      body: importFormHtml({ hosts: multiHost() ? hostsNow() : [], host: hostFilter() || "local" }),
      footer: `<button class="btn" data-close>${esc(t("common.cancel"))}</button><button class="btn btn-primary" id="ckImportOk">${esc(t("ck.importConfirm"))}</button>`,
      onClose: () => resolve(imported),
    });
    const file = root.querySelector("#ckImportFile");
    const pass = root.querySelector("#ckImportPass");
    const hostInput = root.querySelector("#ckImportHost");
    const ok = root.querySelector("#ckImportOk");
    const err = root.querySelector("#ckImportErr");
    const pick = root.querySelector("#ckImportPick");
    const fileName = root.querySelector("#ckImportFileName");
    pick.addEventListener("click", () => file.click());
    file.addEventListener("change", () => {
      const chosen = file.files?.[0];
      fileName.textContent = chosen ? `${chosen.name} · ${bytes(chosen.size)}` : t("ck.importNoneChosen");
      fileName.classList.toggle("chosen", Boolean(chosen));
    });
    const run = async () => {
      err.textContent = "";
      if (!uploaded && !file.files?.[0]) {
        err.textContent = t("ck.importNoFile");
        return;
      }
      if (hostInput?.selectedOptions[0]?.disabled) {
        // The option's label already says why the host cannot be picked.
        err.textContent = hostInput.selectedOptions[0].textContent;
        return;
      }
      if (!passphraseOk(pass.value)) {
        err.textContent = t("err.package_passphrase_invalid");
        return;
      }
      try {
        if (!uploaded) {
          const { package: stored } = await api("/api/packages", { method: "POST", body: file.files[0] });
          uploaded = stored;
          file.disabled = true;
          pick.disabled = true;
        }
        const body = { passphrase: pass.value, ...(hostInput ? { host: hostInput.value } : {}) };
        const started = await api(`/api/packages/${enc(uploaded.id)}/import`, { method: "POST", body });
        const done = await waitTask(started.taskId);
        if (done.status !== "succeeded") {
          err.textContent = failureOf(done);
          return;
        }
        imported = done.result.checkpoint;
        toast(t("ck.imported"), { message: imported.label });
        close();
      } catch (error) {
        err.textContent = error.message;
      }
    };
    ok.addEventListener("click", () => withBusy(ok, run));
  });
}

/** The words of a checkpoint schedule, for the shared card markup. */
export const SCHEDULE_LABELS = {
  title: "ck.schedule",
  offHelp: "ck.scheduleOffHelp",
  note: "ck.scheduleNote",
  ok: "ck.runOk",
  failed: "ck.runFailed",
  none: "ck.lastRunNone",
};

const SCHEDULE_IDS = { hours: "ckHours", at: "ckAt", error: "ckScheduleErr" };

function skipText(reason) {
  const key = SKIP_REASON_KEYS[reason];
  return key ? t(key) : (reason ?? "");
}

/** A skipped checkpoint run says why, which the shared last-run line leaves to its caller. */
function checkpointLastRunText(run, zone, labels) {
  if (run?.status === "skipped") {
    return t("ck.runSkipped", { time: zonedTime(run.at, zone), reason: skipText(run.reason) });
  }
  return lastRunText(run, zone, labels);
}

/** The schedule line of the card: off, or the rule with its next and last run, and the buttons that change it. */
export function scheduleHtml(schedule, zone = browserTimezone()) {
  return scheduleCardHtml(schedule, {
    zone,
    labels: SCHEDULE_LABELS,
    action: "ck-schedule",
    lastRun: checkpointLastRunText,
  });
}

export function scheduleFormHtml(schedule, zone = browserTimezone()) {
  return scheduleFieldsHtml(schedule, { zone, ids: SCHEDULE_IDS, help: "ck.scheduleHelp" });
}

function askSchedule(schedule) {
  return new Promise((resolve) => {
    let result = null;
    const { root, close } = openDialog({
      title: t("ck.scheduleTitle"),
      description: esc(t("ck.scheduleDesc")),
      iconName: "clock",
      body: scheduleFormHtml(schedule),
      footer: `<button class="btn" data-close>${esc(t("common.cancel"))}</button><button class="btn btn-primary" id="ckScheduleOk">${esc(t("ck.scheduleSave"))}</button>`,
      onClose: () => resolve(result),
    });
    const submit = bindScheduleForm(root, {
      ids: SCHEDULE_IDS,
      invalid: "ck.scheduleInvalid",
      onRule: (body) => {
        result = body;
      },
    });
    root.querySelector("#ckScheduleOk").addEventListener("click", () => {
      if (submit() !== null) close();
    });
  });
}

async function editSchedule(box, schedule) {
  const body = await askSchedule(schedule);
  if (!body) return null;
  return guarded("ck.scheduleFailed", async () => {
    const saved = await api(`/api/boxes/${enc(box.boxId)}/checkpoint-schedule`, { method: "PUT", body });
    toast(t("ck.scheduleSaved"), { message: ruleText(saved.schedule) });
    return saved.schedule;
  });
}

function turnOffSchedule(box) {
  return guarded("ck.scheduleFailed", async () => {
    await api(`/api/boxes/${enc(box.boxId)}/checkpoint-schedule`, { method: "DELETE" });
    toast(t("ck.scheduleOffDone"));
    return null;
  });
}

function keepLabel(name) {
  switch (name) {
    case "id":
      return t("rebuild.keep.id");
    case "name":
      return t("rebuild.keep.name");
    case "history":
      return t("rebuild.keep.history");
    case "shared volumes":
      return t("ck.keepShared");
    default:
      return name;
  }
}

function loseLabel(name) {
  switch (name) {
    case "writableLayer":
      return t("rebuild.lose.writableLayer");
    case "processes":
      return t("rebuild.lose.processes");
    case "ip":
      return t("rebuild.lose.ip");
    default:
      return name;
  }
}

function volumesList(volumes) {
  const items = volumes
    .map(
      (volume) =>
        `<li><span class="mono">${esc(volume.name)}</span> <span class="subtle">${esc(volume.path)} · ${esc(bytes(volume.bytes))}</span></li>`,
    )
    .join("");
  return `<ul class="ck-list">${items || `<li>${esc(t("ck.none"))}</li>`}</ul>`;
}

function revisionLine(revision) {
  return `<div class="help">${esc(t("ck.revision"))}: ${esc(String(revision.current))} → ${esc(String(revision.next))}</div>`;
}

/** The honest text of a rollback before it runs: what is replaced, kept and lost, and where the data goes. */
export function rollbackPreviewHtml(preview) {
  const replaced = preview.restores.length
    ? preview.restores
        .map(
          (volume) =>
            `<li><span class="mono">${esc(volume.volume)}</span> <span class="subtle">${esc(volume.path)}</span></li>`,
        )
        .join("")
    : `<li>${esc(t("ck.none"))}</li>`;
  const lost = [
    ...preview.loses.map(loseLabel),
    ...(preview.diff.length ? [t("ck.lostChanges", { n: preview.diff.length })] : []),
  ];
  return `<p class="help">${esc(t("ck.rollbackHow"))}</p>
    <div class="help">${esc(t("ck.rollbackReplaced"))}</div>
    <ul class="ck-list">${replaced}</ul>
    <div class="help">${esc(t("ck.rollbackKept"))}: ${esc(preview.keeps.map(keepLabel).join(", "))}</div>
    <div class="callout warn">${icon("alert")}<div><strong>${esc(t("ck.rollbackLost"))}</strong>
      <ul class="ck-list">${lost.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></div></div>
    ${callout("info", t("ck.rollbackSafety"))}
    ${revisionLine(preview.revision)}`;
}

export function confirmRollbackHtml(preview) {
  return `<p class="help">${esc(t("ck.confirmHow"))}</p>
    <div class="help">${esc(t("ck.willDelete"))}</div>
    ${volumesList(preview.delete)}
    <div class="help">${esc(t("ck.safetyPoint"))}: <span class="mono">${esc(preview.safetyCheckpointId)}</span></div>`;
}

export function undoRollbackHtml(preview) {
  const remount = preview.remount.length
    ? preview.remount
        .map(
          (mount) =>
            `<li><span class="mono">${esc(mount.volume)}</span> → <span class="subtle">${esc(mount.path)}</span></li>`,
        )
        .join("")
    : `<li>${esc(t("ck.none"))}</li>`;
  return `<p class="help">${esc(t("ck.undoHow"))}</p>
    <div class="help">${esc(t("ck.willRemount"))}</div>
    <ul class="ck-list">${remount}</ul>
    <div class="help">${esc(t("ck.willDelete"))}</div>
    ${volumesList(preview.delete)}
    ${callout("warn", t("ck.undoLoses"))}
    ${revisionLine(preview.revision)}`;
}

async function currentRevision(box) {
  const { box: fresh } = await api(`/api/boxes/${enc(box.boxId)}`);
  return fresh.revision;
}

/** The server's preview of a step that needs confirmation: the request without `confirm` answers 409 with it. */
async function previewOf(path, body, headers) {
  try {
    await api(path, { method: "POST", body: { ...body, confirm: false }, headers });
    return null;
  } catch (err) {
    if (err.code === "confirmation_required" && err.details?.preview) return err.details.preview;
    throw err;
  }
}

/**
 * Shows the preview of a confirmed step, and sends it with `confirm` once the person agrees. Resolves to the finished
 * task, or null when nothing ran.
 */
async function previewedTask({ path, body = {}, headers, title, confirmText, render, done, failed }) {
  return guarded(failed, async () => {
    const preview = await previewOf(path, body, headers);
    if (!preview) return null;
    const agreed = await confirmDialog({
      title,
      body: `<div class="ck-preview">${render(preview)}</div>`,
      confirmText,
      danger: true,
    });
    if (!agreed) return null;
    const started = await api(path, { method: "POST", body: { ...body, confirm: true }, headers });
    const task = await waitTask(started.taskId);
    if (task.status === "succeeded") toast(t(done));
    else toastError(t(failed), { message: failureOf(task) });
    return task;
  });
}

export function rollBack(box, checkpoint) {
  return guarded("ck.rollbackFailed", async () => {
    const revision = await currentRevision(box);
    return previewedTask({
      path: `/api/boxes/${enc(box.boxId)}/rollback`,
      body: { checkpoint: checkpoint.id },
      headers: { "if-match": String(revision) },
      title: t("ck.rollbackTitle", { label: checkpoint.label }),
      confirmText: t("ck.rollbackConfirm"),
      render: rollbackPreviewHtml,
      done: "ck.rolledBack",
      failed: "ck.rollbackFailed",
    });
  });
}

export function confirmPending(box) {
  return previewedTask({
    path: `/api/boxes/${enc(box.boxId)}/rollback/confirm`,
    title: t("ck.confirmTitle"),
    confirmText: t("ck.confirmAction"),
    render: confirmRollbackHtml,
    done: "ck.confirmed",
    failed: "ck.confirmFailed",
  });
}

export function undoPending(box) {
  return guarded("ck.undoFailed", async () => {
    const revision = await currentRevision(box);
    return previewedTask({
      path: `/api/boxes/${enc(box.boxId)}/rollback/undo`,
      headers: { "if-match": String(revision) },
      title: t("ck.undoTitle"),
      confirmText: t("ck.undoAction"),
      render: undoRollbackHtml,
      done: "ck.undone",
      failed: "ck.undoFailed",
    });
  });
}

export function setPinned(checkpoint, pinned) {
  return guarded("ck.pinFailed", async () => {
    const started = await api(`/api/checkpoints/${enc(checkpoint.id)}`, { method: "PATCH", body: { pinned } });
    const done = await waitTask(started.taskId);
    if (done.status !== "succeeded") toastError(t("ck.pinFailed"), { message: failureOf(done) });
    else toast(t(pinned ? "ck.pinned" : "ck.unpinned"), { message: checkpoint.label });
    return done;
  });
}

export async function removeCheckpoint(checkpoint) {
  const agreed = await confirmDialog({
    title: t("ck.deleteTitle", { label: checkpoint.label }),
    message: esc(t("ck.deleteText")),
    confirmText: t("ck.deleteConfirm"),
    danger: true,
  });
  if (!agreed) return null;
  return guarded("ck.deleteFailed", async () => {
    const started = await api(`/api/checkpoints/${enc(checkpoint.id)}`, { method: "DELETE" });
    const done = await waitTask(started.taskId);
    if (done.status !== "succeeded") toastError(t("ck.deleteFailed"), { message: failureOf(done) });
    else toast(t("ck.deleted"), { message: checkpoint.label });
    return done;
  });
}

export function usageHtml(usage) {
  const limit = usage.limitBytes === null ? t("ck.noLimit") : bytes(usage.limitBytes);
  const percent = usedPercent(usage);
  const share = percent === null ? "" : ` (${percent}%)`;
  const policy = [t("ck.policy", { keep: usage.policy.keepLast })];
  if (usage.policy.keepDays > 0) policy.push(t("ck.policyAge", { days: usage.policy.keepDays }));
  const line = `<div class="ck-usage"><span>${esc(t("ck.repository"))}: <strong>${esc(bytes(usage.bytes))}</strong> / ${esc(limit)}${esc(share)}</span>
    <span class="help">${esc(policy.join(" "))}</span></div>`;
  if (usage.state === "exceeded") return `${line}${callout("danger", t("ck.usageExceeded"))}`;
  if (usage.state === "warning") return `${line}${callout("warn", t("ck.usageWarning", { percent }))}`;
  return line;
}

export function pendingHtml(pending) {
  const replaced = pending.replaced.map((volume) => volume.name).join(", ");
  return `<div class="callout warn">${icon("alert")}<div>
      <strong>${esc(t("ck.pendingTitle"))}</strong>
      <div>${esc(t("ck.pendingText", { label: pending.checkpoint.label, time: dateTime(pending.createdAt) }))}</div>
      <div class="help">${esc(t("ck.pendingReplaced"))}: <span class="mono">${esc(replaced || "—")}</span></div>
      <div class="ck-pending-actions">
        <button class="btn btn-sm btn-danger" data-action="ck-confirm">${icon("check")}${esc(t("ck.pendingConfirm"))}</button>
        <button class="btn btn-sm" data-action="ck-undo">${icon("refresh")}${esc(t("ck.pendingUndo"))}</button>
      </div></div></div>`;
}

export function contentsText(checkpoint) {
  // A snapshot of one volume holds that volume alone, and its record names it: there is no box to name the contents by.
  if (isVolumeSnapshot(checkpoint)) return t("ck.contentsVolume", { name: checkpoint.boxName ?? "—" });
  const { roles, others, system } = contentsOf(checkpoint);
  const parts = roles.map((role) => t(role === "workspace" ? "vol.roleWorkspace" : "vol.roleHome"));
  if (others) parts.push(t("ck.contentsOther", { n: others }));
  if (system) parts.push(t("ck.contentsSystem"));
  return parts.join(" · ") || "—";
}

/** The copy rule, refused when every other host is an agent host: none of them can hold the copy. */
function copyRule(rule, checkpoint, hosts) {
  if (!rule.allowed) return rule;
  const target = hosts.some((host) => host.id !== checkpoint.hostId && host.transport !== "agent");
  return target ? rule : { allowed: false, reason: "ck.reasonCopyAgentOnly" };
}

/** An icon button for one checkpoint, as on the storage page's timeline. A disabled one gives its reason as the title. */
function rowButton(action, checkpoint, iconName, label, rule, { danger = false } = {}) {
  const state = rule.allowed ? `title="${esc(label)}"` : `title="${esc(t(rule.reason))}" disabled`;
  return `<button type="button" class="icon-btn${danger ? " danger" : ""}" data-action="${action}" data-id="${esc(checkpoint.id)}" aria-label="${esc(label)}" ${state}>${icon(iconName)}</button>`;
}

function hostLine(hosts, hostId) {
  const name = hosts.find((host) => host.id === hostId)?.name ?? hostId;
  return t("ck.storedOn", { host: name });
}

/** The remote copy marks a checkpoint row carries, as badges beside its kinds. */
export function remoteBadgesHtml(checkpoint, targetNames = new Map()) {
  return remoteMarksOf(checkpoint, targetNames)
    .map((mark) =>
      mark.kind === "synced"
        ? `<span class="badge badge-success" title="${esc(t("ck.remoteSyncedTitle", { targets: mark.targets.join(", ") }))}">${esc(t("ck.remoteSynced"))}</span>`
        : `<span class="badge badge-warning" title="${esc(t("ck.remoteFailedTitle", { detail: mark.detail }))}">${esc(t("ck.remoteFailed"))}</span>`,
    )
    .join("");
}

/**
 * One row. `state` carries the rollback's safety point (`held`, `pending`), the hosts when there are several (`hosts`),
 * and the host the box runs on (`boxHostId`). A checkpoint kept on another host cannot be rolled back to from here.
 * The label line carries the kind badges and the line under it what the checkpoint holds, so no column has to wrap.
 */
export function checkpointRowHtml(checkpoint, state) {
  const elsewhere = state.boxHostId !== undefined && checkpoint.hostId !== state.boxHostId;
  const rules = rowActions(checkpoint, { held: state.held, pending: state.pending, elsewhere });
  const kinds = kindsOf(checkpoint)
    .map((kind) => `<span class="badge ${KIND_CLASS[kind]}">${esc(t(`ck.kind.${kind}`))}</span>`)
    .join("");
  const remote = remoteBadgesHtml(checkpoint, state.targetNames);
  const detail = [contentsText(checkpoint)];
  if (state.hosts?.length > 1) detail.push(hostLine(state.hosts, checkpoint.hostId));
  const detailText = detail.join(" · ");
  const reason = checkpoint.reason
    ? `<div class="subtle truncate" title="${esc(checkpoint.reason)}">${esc(checkpoint.reason)}</div>`
    : "";
  return `<tr>
    <td class="ck-time nowrap" title="${esc(dateTime(checkpoint.createdAt))}">${esc(dateTime(checkpoint.createdAt))}<div class="subtle">${esc(relTime(checkpoint.createdAt))}</div></td>
    <td class="ck-label"><div class="ck-label-line"><span class="truncate" title="${esc(checkpoint.label)}">${esc(checkpoint.label)}</span><span class="ck-badges">${kinds}${remote}</span></div>
      <div class="subtle truncate" title="${esc(detailText)}">${esc(detailText)}</div>${reason}</td>
    <td class="ck-size num nowrap">${esc(bytes(checkpoint.bytes))}</td>
    <td class="ck-actions"><div class="actions ck-row-actions">
      ${rowButton("ck-fork", checkpoint, "copy", t("ck.fork"), rules.fork)}
      ${rowButton("ck-export", checkpoint, "download", t("ck.export"), rules.export)}
      ${state.hosts?.length > 1 ? rowButton("ck-copy", checkpoint, "server", t("ck.copy"), copyRule(rules.copy, checkpoint, state.hosts)) : ""}
      ${rowButton("ck-rollback", checkpoint, "history", t("ck.rollback"), rules.rollback)}
      ${rowButton("ck-pin", checkpoint, "layers", checkpoint.pinned ? t("ck.unpin") : t("ck.pin"), rules.pin)}
      ${rowButton("ck-delete", checkpoint, "trash", t("ck.delete"), rules.delete, { danger: true })}
    </div></td></tr>`;
}

/**
 * `schedule` is null when the box has none, and undefined when it could not be read, which hides the line. `hosts` lists
 * the hosts when there are several, and `boxHostId` is the host the box runs on. `toggle` is the show-all button drawn
 * under a long list, and `total` how many checkpoints the box has when `rows` is only the first of them.
 */
export function checkpointCardHtml({
  rows,
  pending,
  usage,
  schedule,
  hosts = [],
  targetNames = new Map(),
  boxHostId,
  toggle = "",
  total,
  onAgent = false,
}) {
  const count = total ?? rows.length;
  const body = rows.length
    ? `<div class="table-wrap"><table class="table ck-table">
        <colgroup><col class="ck-c-time" /><col /><col class="ck-c-size" /><col class="${hosts.length > 1 ? "ck-c-actions-6" : "ck-c-actions"}" /></colgroup>
        <thead><tr>
        <th>${esc(t("ck.colTaken"))}</th><th>${esc(t("ck.colLabel"))}</th>
        <th class="num">${esc(t("bd.colSize"))}</th><th class="actions-head">${esc(t("bx.colActions"))}</th>
      </tr></thead><tbody>${rows
        .map((row) =>
          checkpointRowHtml(row, {
            held: pending?.safetyCheckpointId === row.id,
            pending: Boolean(pending),
            hosts,
            targetNames,
            boxHostId,
          }),
        )
        .join("")}</tbody></table></div>${toggle ? `<div class="ck-more">${toggle}</div>` : ""}`
    : emptyState({ iconName: "history", title: t("ck.empty"), text: esc(t("ck.emptyText")) });
  const counted = count ? `<span class="badge">${count}</span>` : "";
  return `<div class="card ck-card">
    <div class="card-head"><h3>${esc(t("ck.title"))}${counted}</h3>
      <div class="actions"><button class="btn btn-sm" data-action="ck-import">${icon("upload")}${esc(t("ck.import"))}</button>${onAgent ? `<button class="btn btn-sm btn-primary" data-action="ck-take" disabled title="${esc(t("bd.agentCheckpoints"))}">${icon("camera")}${esc(t("act.checkpoint"))}</button>` : `<button class="btn btn-sm btn-primary" data-action="ck-take">${icon("camera")}${esc(t("act.checkpoint"))}</button>`}</div></div>
    <div class="card-body stack">
      <p class="help">${esc(t("ck.help"))}</p>
      ${onAgent ? callout("warn", t("bd.agentCheckpoints")) : ""}
      ${usage ? usageHtml(usage) : ""}
      ${pending ? pendingHtml(pending) : ""}
      ${schedule === undefined ? "" : scheduleHtml(schedule)}
    </div>
    ${body}
  </div>`;
}

/**
 * Mounts the checkpoints of one box: the list, the repository's size, a rollback that waits for its confirm or undo, and
 * the actions on each checkpoint. Returns the cleanup that the page calls when the tab closes.
 */
export function mountCheckpoints(root, { box, refreshBox }) {
  let disposed = false;
  let seq = 0;
  let rows = [];
  let pending = null;
  let schedule = undefined;
  let lastUsage = null;
  /** The target names the remote copy badges use, read with the checkpoints. */
  let targetNames = new Map();

  /** Draws the card from the last load. A long list shows its newest rows and any pinned one, with a show-all toggle. */
  const draw = () => {
    const current = box();
    const { shown, toggle } = limitList(root, `ck:${current.boxId}`, rows, {
      limit: LIST_ROWS,
      keep: (row) => row.pinned,
    });
    root.innerHTML = checkpointCardHtml({
      rows: shown,
      total: rows.length,
      toggle,
      pending,
      usage: lastUsage,
      schedule,
      hosts: multiHost() ? hostsNow() : [],
      targetNames,
      boxHostId: hostOfBox(current),
      onAgent: boxOnAgentHost(current, hostsNow()),
    });
  };

  const load = async () => {
    const token = ++seq;
    try {
      const current = box();
      const [{ checkpoints }, { rollback }, usage, plan, targets] = await Promise.all([
        api("/api/checkpoints"),
        api(`/api/boxes/${enc(current.boxId)}/rollback`),
        api("/api/checkpoints/usage").catch(() => null),
        api(`/api/boxes/${enc(current.boxId)}/checkpoint-schedule`).then(
          (reply) => reply.schedule,
          () => undefined,
        ),
        api("/api/targets").catch(() => ({ targets: [] })),
      ]);
      if (disposed || token !== seq) return;
      rows = newestFirst(checkpoints.filter((checkpoint) => checkpoint.boxId === current.boxId));
      pending = rollback;
      schedule = plan;
      lastUsage = usage;
      targetNames = new Map(targets.targets.map((target) => [target.id, target.name]));
      draw();
    } catch (err) {
      if (disposed || token !== seq) return;
      root.innerHTML = emptyState({ iconName: "alert", title: t("ck.loadFailed"), text: esc(err.message) });
    }
  };

  const settled = (task) => {
    if (task?.status === "succeeded") void refreshBox().catch(() => {});
  };
  const actions = new Map([
    ["ck-take", (current) => takeCheckpoint(current)],
    ["ck-import", () => importCheckpoint()],
    ["ck-export", (_current, checkpoint) => exportCheckpoint(checkpoint)],
    ["ck-copy", (_current, checkpoint) => copyCheckpoint(checkpoint)],
    ["ck-fork", (current, checkpoint) => forkCheckpoint(checkpoint, current)],
    ["ck-rollback", (current, checkpoint) => rollBack(current, checkpoint).then(settled)],
    ["ck-pin", (_current, checkpoint) => setPinned(checkpoint, !checkpoint.pinned)],
    ["ck-delete", (_current, checkpoint) => removeCheckpoint(checkpoint)],
    ["ck-confirm", (current) => confirmPending(current).then(settled)],
    ["ck-undo", (current) => undoPending(current).then(settled)],
    ["ck-schedule", (current) => editSchedule(current, schedule)],
    ["ck-schedule-off", (current) => turnOffSchedule(current)],
  ]);

  const onClick = (event) => {
    const key = event.target.closest("[data-toggle]")?.dataset.toggle;
    if (key) {
      flip(root, key);
      draw();
      [...root.querySelectorAll("[data-toggle]")].find((b) => b.dataset.toggle === key)?.focus({ preventScroll: true });
      return;
    }
    const button = event.target.closest("[data-action]");
    const run = button && actions.get(button.dataset.action);
    if (!run || button.disabled) return;
    const checkpoint = rows.find((row) => row.id === button.dataset.id);
    void run(box(), checkpoint).finally(() => {
      if (!disposed) void load();
    });
  };
  root.addEventListener("click", onClick);

  const off = subscribe("task", (frame) => {
    if (frame.kind === "status" && frame.status !== "running" && !disposed) void load();
  });

  root.innerHTML = `<div class="card"><div class="card-body"><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div></div></div>`;
  void load();
  return () => {
    disposed = true;
    off();
    root.removeEventListener("click", onClick);
  };
}
