import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { hostName, hostsNow, refreshHosts } from "../lib/hosts.js";
import { t } from "../lib/i18n.js";
import { movedBoxHash } from "../lib/routes.js";
import { refreshHost } from "../lib/store.js";
import { openDialog, toast, toastError, withBusy } from "../lib/ui.js";
import { openTasks, taskErrorText, waitTask } from "./tasks.js";

const KEEPS = ["id", "name", "volumes", "env", "history"];
const LOSES = ["writableLayer", "processes", "ip"];

const ACTION_KEY = {
  copy: "mv.action.copy",
  remount: "mv.action.remount",
  tools: "mv.action.tools",
};

function volumeLine(volume, to) {
  return `<li><span class="mono">${esc(volume.path)}</span><span class="mono help">${esc(volume.name)}</span>
    <span class="help">${esc(t(ACTION_KEY[volume.action] ?? "mv.action.copy", { to: hostName(to) }))}</span></li>`;
}

/** The HTML of a move preview: what is copied or attached, the image, whether the box starts, and what is kept and lost. */
export function movePreviewHtml(preview) {
  const to = hostName(preview.to);
  const from = hostName(preview.from);
  const volumes = (preview.volumes ?? []).map((volume) => volumeLine(volume, preview.to)).join("");
  const image = preview.image?.transfer ? t("mv.imageSend", { to }) : t("mv.imageHave", { to });
  const starts = preview.starts ? t("mv.starts", { to }) : t("mv.staysStopped");
  const keeps = KEEPS.map((name) => t(`mv.keep.${name}`)).join(", ");
  const loses = LOSES.map((name) => t(`rebuild.lose.${name}`)).join(", ");
  const checkpointKey = preview.checkpoints === 1 ? "mv.checkpoint" : "mv.checkpoints";
  const checkpoints =
    preview.checkpoints > 0
      ? `<p class="help">${esc(t(checkpointKey, { count: String(preview.checkpoints), from, to }))}</p>`
      : "";
  return `<div class="rebuild-preview"><strong>${esc(t("mv.previewTitle"))}</strong>
    <div class="help" style="margin-top:8px">${esc(t("mv.volumes"))}</div>
    <ul class="move-volumes">${volumes || `<li class="help">${esc(t("mv.noVolumes"))}</li>`}</ul>
    <div class="help">${esc(t("mv.image", { image: preview.image?.ref ?? "" }))}: ${esc(image)}</div>
    <div class="help">${esc(starts)}</div>
    ${checkpoints}
    <div class="help">${esc(t("mv.keeps"))}: ${esc(keeps)}</div>
    <div class="help">${esc(t("mv.loses"))}: ${esc(loses)}</div>
    <div class="help">${esc(t("mv.revision", { from: String(preview.revision?.current ?? ""), to: String(preview.revision?.next ?? "") }))}</div></div>`;
}

function hostOptions(box) {
  return hostsNow()
    .filter((host) => host.id !== box.hostId && host.status === "online")
    .map((host) => `<option value="${esc(host.id)}">${esc(host.name ?? host.id)}</option>`)
    .join("");
}

/**
 * Moves a box to another host: a preview first, then the move as a task. The dialog closes once the task starts, and the
 * task drawer follows it. When the move succeeds the page opens the box under its new container id.
 */
export async function openMove(box) {
  await refreshHosts();
  const options = hostOptions(box);
  const { root, close } = openDialog({
    title: t("mv.title"),
    description: t("mv.desc"),
    iconName: "move",
    wide: true,
    body: options
      ? `<p class="help">${esc(t("mv.help"))}</p>
        <div class="field"><label class="label" for="mvHost">${esc(t("mv.host"))}</label>
          <select class="select" id="mvHost">${options}</select></div>
        <div class="error-text" id="mvErr"></div>
        <div class="move-preview" id="mvPreview" hidden></div>`
      : `<p class="help">${esc(t("mv.noHosts"))}</p>`,
    footer: `<button class="btn" data-close>${esc(t("common.cancel"))}</button>
      ${options ? `<button class="btn btn-primary" id="mvPreviewBtn">${esc(t("mv.preview"))}</button>` : ""}
      <button class="btn btn-danger" id="mvApply" hidden>${esc(t("mv.apply"))}</button>`,
  });
  if (!options) return;

  const ref = box.boxId ?? box.id;
  const send = (body) =>
    api(`/api/boxes/${enc(ref)}/move`, {
      method: "POST",
      body,
      headers: { "if-match": String(box.revision) },
    });

  root.querySelector("#mvPreviewBtn").addEventListener("click", async (event) => {
    const to = root.querySelector("#mvHost").value;
    root.querySelector("#mvErr").textContent = "";
    root.querySelector("#mvApply").hidden = true;
    try {
      await withBusy(event.currentTarget, () => send({ host: to }));
      root.querySelector("#mvErr").textContent = t("mv.noPreview");
    } catch (err) {
      if (err?.code === "confirmation_required" && err.details?.preview) {
        root.querySelector("#mvPreview").hidden = false;
        root.querySelector("#mvPreview").innerHTML = movePreviewHtml(err.details.preview);
        root.querySelector("#mvApply").hidden = false;
        return;
      }
      root.querySelector("#mvErr").textContent = err?.message ?? String(err);
    }
  });

  root.querySelector("#mvApply").addEventListener("click", async (event) => {
    const to = root.querySelector("#mvHost").value;
    root.querySelector("#mvErr").textContent = "";
    try {
      const started = await withBusy(event.currentTarget, () => send({ host: to, confirm: true }));
      close();
      toast(t("mv.started"), { message: t("mv.startedText", { name: box.name, to: hostName(to) }) });
      openTasks(started.taskId);
      void followMove(box, started.taskId, to);
    } catch (err) {
      root.querySelector("#mvErr").textContent = err?.message ?? String(err);
      toastError(t("mv.failed"), err);
    }
  });
}

async function followMove(box, taskId, to) {
  const task = await waitTask(taskId);
  if (task.status === "succeeded") {
    toast(t("mv.done"), { message: t("mv.doneText", { name: box.name, to: hostName(to) }) });
    refreshHost();
    const next = task.result?.box?.id;
    const address = next && next !== box.id ? movedBoxHash(location.hash, box.id, next) : null;
    if (address) location.hash = address;
    return;
  }
  toast(t("mv.failed"), {
    type: "error",
    message: taskErrorText(task.error) || t("mv.failedText", { name: box.name }),
  });
}
