import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { canonicalEnv, checkEnvRows, envRowsOf } from "../lib/env.js";
import { cpus as formatCpus, dateTime, gbOrMb } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { canonicalMounts } from "../lib/mounts.js";
import { movedBoxHash } from "../lib/routes.js";
import { hostNow, refreshHost } from "../lib/store.js";
import { checkboxField, confirmDialog, nameError, openDialog, toast, toastError, withBusy } from "../lib/ui.js";
import { bindEnvRows, envProblemText, envRow, readEnvRows, secretNames } from "./env-editor.js";
import { mountRow, readMountRows } from "./mount-editor.js";

const LIFECYCLE = {
  start: ["ba.startFailed", "ba.started"],
  stop: ["ba.stopFailed", "ba.stopped"],
  restart: ["ba.restartFailed", "ba.restarted"],
};

export async function lifecycle(box, action, btn) {
  const [failKey, doneKey] = LIFECYCLE[action];
  try {
    await withBusy(btn, () => api(`/api/boxes/${enc(box.id)}/${action}`, { method: "POST" }));
    toast(t(doneKey), { message: box.name });
    refreshHost();
    return true;
  } catch (e) {
    toastError(t(failKey), e);
    return false;
  }
}

export async function deleteBox(box) {
  const res = await confirmDialog({
    title: t("ba.deleteTitle", { name: box.name }),
    message: t("ba.deleteMessage"),
    confirmText: t("ba.deleteConfirm"),
    danger: true,
    checkboxes: [
      { key: "deleteVolume", label: t("ba.deleteVolume"), help: t("ba.deleteVolumeHelp") },
      { key: "skipTrash", label: t("ba.skipTrash"), help: t("ba.skipTrashHelp") },
    ],
  });
  if (!res) return false;
  try {
    const query = new URLSearchParams({ deleteVolume: String(res.deleteVolume), skipTrash: String(res.skipTrash) });
    const r = await api(`/api/boxes/${enc(box.id)}?${query}`, { method: "DELETE" });
    const kept = r.trash ? ` ${t("ba.keptInBin", { date: dateTime(r.trash.expiresAt) })}` : "";
    if (r.volumeError) {
      toast(t("ba.deletedVolumeFailed", { name: box.name }), {
        type: "error",
        message: t("ba.deleteVolumeFailedHint", { detail: r.volumeError }),
      });
    } else {
      toast(t("ba.deleted"), {
        message: t(r.volumeDeleted ? "ba.deletedWithVolume" : "ba.deletedKeepVolume", { name: box.name }) + kept,
      });
    }
    refreshHost();
    return true;
  } catch (e) {
    toastError(t("ba.deleteFailed"), e);
    return false;
  }
}

/**
 * The rename dialog: one field, prefilled with the name the box has now. A name that did not change closes the dialog with
 * no request, and an empty or malformed one is refused under the field. The save sends `box.update` with If-Match, so a
 * box changed elsewhere while the dialog was open is refused with the server's message instead of overwriting it; the
 * dialog stays open so the name can be corrected.
 */
export function renameBox(box, onSaved) {
  const { root, close } = openDialog({
    title: t("ba.renameTitle", { name: box.name }),
    description: esc(t("ba.renameDesc")),
    iconName: "pencil",
    body: `<div class="field"><label class="label" for="rnName">${esc(t("label.boxName"))}</label>
      <input class="input" id="rnName" maxlength="63" value="${esc(box.name)}" autocomplete="off" autofocus />
      <div class="error-text" id="rnErr" role="alert"></div></div>`,
    footer: `<button class="btn" data-close>${t("common.cancel")}</button><button class="btn btn-primary" id="rnSave">${t("common.save")}</button>`,
  });
  const input = root.querySelector("#rnName");
  const error = root.querySelector("#rnErr");
  const save = root.querySelector("#rnSave");

  // The current name is chosen when the dialog opens, so typing the new one replaces it. A later click only moves the caret.
  input.addEventListener("focus", () => input.select(), { once: true });
  input.addEventListener("input", () => {
    input.classList.remove("invalid");
    error.textContent = "";
  });

  const submit = async () => {
    if (save.disabled) return;
    const name = input.value.trim();
    if (name === box.name) {
      close();
      return;
    }
    const problem = nameError(name, "boxName");
    if (problem) {
      input.classList.add("invalid");
      error.textContent = problem;
      input.focus();
      return;
    }
    error.textContent = "";
    try {
      await withBusy(save, () =>
        api(`/api/boxes/${enc(box.id)}`, {
          method: "PATCH",
          body: { name },
          headers: { "if-match": String(box.revision) },
        }),
      );
    } catch (err) {
      input.classList.add("invalid");
      error.textContent = `${err.message}${err.hint ? ` ${err.hint}` : ""}`;
      input.focus();
      return;
    }
    close();
    toast(t("ba.renamed"), { message: t("ba.renamedText", { old: box.name, new: name }) });
    refreshHost();
    onSaved?.();
  };

  save.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void submit();
  });
}

export function editResources(box, onSaved) {
  const host = hostNow();
  const maxCpu = host?.cpu.cores ?? 16;
  const maxMem = host ? Math.floor(host.memory.total / 1024 / 1024) : 32768;
  const curMem = box.memory ? Math.round(box.memory / 1024 / 1024) : 2048;
  const { root, close } = openDialog({
    title: t("ba.resTitle"),
    description: t("ba.resDesc", { name: esc(box.name) }),
    iconName: "sliders",
    body: `
      <div class="field"><span class="label">CPU <span class="subtle">${t("ba.resCpuHint", { cur: box.cpus ?? t("common.unlimited"), max: maxCpu })}</span></span>
        <div class="slider-row"><input type="range" id="erCpuR" min="0.5" max="${maxCpu}" step="0.5" value="${box.cpus ?? 1}" /><input class="input" id="erCpu" type="number" min="0.1" max="${maxCpu}" step="0.1" value="${box.cpus ?? 1}" /></div></div>
      <div class="field"><span class="label">${t("cb.memory")} <span class="subtle">${t("ba.resMemHint", { cur: box.memory ? gbOrMb(box.memory) : t("common.unlimited"), max: gbOrMb(maxMem * 1024 * 1024) })}</span></span>
        <div class="slider-row"><input type="range" id="erMemR" min="256" max="${maxMem}" step="256" value="${curMem}" /><input class="input" id="erMem" type="number" min="128" max="${maxMem}" step="128" value="${curMem}" /></div>
        <div class="help">${t("ba.resMemHelp")}</div>
        <div class="error-text" id="erErr"></div></div>`,
    footer: `<button class="btn" data-close>${t("common.cancel")}</button><button class="btn btn-primary" id="erSave">${t("common.save")}</button>`,
  });
  const q = (s) => root.querySelector(s);
  const link = (a, b) => {
    q(a).addEventListener("input", () => (q(b).value = q(a).value));
    q(b).addEventListener("input", () => (q(a).value = q(b).value));
  };
  link("#erCpuR", "#erCpu");
  link("#erMemR", "#erMem");
  q("#erSave").addEventListener("click", async (e) => {
    const cpus = Number(q("#erCpu").value);
    const memoryMb = Number(q("#erMem").value);
    try {
      await withBusy(e.currentTarget, () =>
        api(`/api/boxes/${enc(box.id)}/resources`, {
          method: "PATCH",
          body: { cpus, memoryMb },
          headers: { "if-match": String(box.revision) },
        }),
      );
      close();
      toast(t("ba.resUpdated"), {
        message: t("ba.resUpdatedText", {
          name: box.name,
          cpus: formatCpus(cpus),
          mem: gbOrMb(memoryMb * 1024 * 1024),
        }),
      });
      refreshHost();
      onSaved?.();
    } catch (err) {
      q("#erErr").textContent = err.message;
    }
  });
}

/** The rebuild body the dialog's fields describe, or the first env row the server would refuse. */
function rebuildBody(root, box) {
  const body = {};
  const template = root.querySelector("#rbTemplate").value.trim();
  // Always send a non-empty template so a moved tag with the same name still previews.
  if (template) body.template = template;
  const network = root.querySelector("#rbNetwork").value.trim();
  if (network !== box.network) body.network = network;
  const profile = root.querySelector("#rbProfile").value;
  if (profile && profile !== (box.profile ?? "")) body.profile = profile;
  const checked = checkEnvRows(readEnvRows(root.querySelector("#rbEnvRows")));
  if ("problem" in checked) return { problem: checked.problem };
  if (canonicalEnv(checked.env) !== canonicalEnv(box.env)) body.env = checked.env;
  const mounts = readMountRows(root.querySelector("#rbMounts"));
  if (canonicalMounts(mounts) !== canonicalMounts(box.mounts)) body.mounts = mounts;
  return { body };
}

/**
 * An environment change as the preview holds it: a JSON list of entries, or a note about a rotated secret, which is not
 * JSON. A secret shows its name only.
 */
function envChangeText(text) {
  let entries;
  try {
    entries = JSON.parse(text);
  } catch {
    return text;
  }
  if (!Array.isArray(entries)) return text;
  if (!entries.length) return "—";
  return entries
    .map((entry) =>
      entry.secretRef
        ? `${entry.name}=${t("env.secretLabel", { name: entry.secretRef })}`
        : `${entry.name}=${entry.value ?? ""}`,
    )
    .join(", ");
}

/** A planned change's text as a person reads it: an environment as NAME=value pairs, anything else as it is. */
export function changeText(change, text) {
  if (change.field === "env") return envChangeText(text);
  if (change.field === "mounts") return mountsChangeText(text);
  return text;
}

/** Mounts as path=volume:mode, from the JSON a rebuild plan names them in. Text that is not that JSON stays as it is. */
function mountsChangeText(text) {
  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    return text;
  }
  if (!Array.isArray(rows)) return text;
  if (!rows.length) return "—";
  return rows.map((row) => `${row.path}=${row.volume}:${row.mode}`).join(", ");
}

/** The HTML for a rebuild preview: the planned changes, the writable layer, what is kept and what is lost. */
export function rebuildPreviewHtml(preview) {
  const changes = (preview.changes ?? [])
    .map(
      (change) =>
        `${t(`rebuild.field.${change.field}`)}: ${changeText(change, change.from)} → ${changeText(change, change.to)}`,
    )
    .join("\n");
  const diff = preview.diff?.length
    ? preview.diff.map((change) => `${t(`rebuild.diff.${change.kind}`)} ${change.path}`).join("\n")
    : t("rb.diffEmpty");
  const keeps = (preview.keeps ?? []).map((name) => t(`rebuild.keep.${name}`)).join(", ");
  const loses = (preview.loses ?? []).map((name) => t(`rebuild.lose.${name}`)).join(", ");
  const name = preview.containerName ?? { from: "", to: "" };
  const revision = preview.revision ?? { current: "", next: "" };
  return `<div class="rebuild-preview"><strong>${esc(t("rb.previewTitle"))}</strong>
    <div class="help" style="margin-top:8px">${esc(t("rb.changes"))}</div><pre class="mono">${esc(changes || "—")}</pre>
    <div class="help">${esc(t("rb.diff"))}</div><pre class="mono">${esc(diff)}</pre>
    <div class="help">${esc(t("rb.keeps"))}: ${esc(keeps)}</div>
    <div class="help">${esc(t("rb.loses"))}: ${esc(loses)}</div>
    <div class="help">${esc(t("rb.containerName"))}: <span class="mono">${esc(name.from)} → ${esc(name.to)}</span></div>
    <div class="help">${esc(t("rb.revision"))}: ${esc(String(revision.current))} → ${esc(String(revision.next))}</div></div>`;
}

function showPreview(root, preview) {
  const panel = root.querySelector("#rbPreview");
  panel.hidden = false;
  panel.innerHTML = `${rebuildPreviewHtml(preview)}${checkboxField({
    id: "rbSafety",
    label: esc(t("rb.safety")),
    help: esc(t("rb.safetyHelp")),
    checked: true,
  })}`;
  root.querySelector("#rbApply").hidden = false;
}

/**
 * Preview, then confirm, a rebuild. The container id changes, so success opens the new box. `box` must come from a REST
 * read: a live frame names the environment variables without their values, and this dialog writes back what it shows.
 */
export async function openRebuild(box) {
  const secrets = await secretNames();
  const profiles = ["standard", "strict", "relaxed"];
  const profileOptions = [
    box.profile ? "" : `<option value="">${esc(t("bd.profileLegacy"))}</option>`,
    ...profiles.map(
      (profile) =>
        `<option value="${profile}" ${box.profile === profile ? "selected" : ""}>${esc(t(`profile.${profile}`))}</option>`,
    ),
  ].join("");
  const { root, close } = openDialog({
    title: t("bd.rebuild"),
    description: t("rb.desc"),
    iconName: "refresh",
    wide: true,
    body: `<p class="help">${t("rb.help", { id: esc(box.boxId || "") })}</p>
      <div class="field"><label class="label" for="rbTemplate">${esc(t("rb.template"))}</label>
        <input class="input" id="rbTemplate" value="${esc(box.template || "")}" /></div>
      <div class="field"><label class="label" for="rbProfile">${esc(t("rb.profile"))}</label>
        <select class="select" id="rbProfile">${profileOptions}</select></div>
      <div class="field"><label class="label" for="rbNetwork">${esc(t("rb.network"))}</label>
        <input class="input" id="rbNetwork" value="${esc(box.network || "")}" /></div>
      <div class="field"><span class="label">${esc(t("rb.env"))}</span>
        <div class="row-editor">
          <div class="env-rows" id="rbEnvRows"></div>
          <button type="button" class="btn" id="rbAddEnv">${icon("plus")}${esc(t("env.add"))}</button>
        </div>
        <div class="help">${esc(t("rb.envHelp"))}</div></div>
      <div class="field"><span class="label">${esc(t("rb.mounts"))}</span>
        <div class="row-editor">
          <div class="rebuild-mounts" id="rbMounts"></div>
          <button type="button" class="btn" id="rbAddMount">${esc(t("mount.add"))}</button>
        </div>
        <div class="help">${esc(t("rb.mountsHelp"))}</div></div>
      <div class="error-text" id="rbErr"></div>
      <div id="rbPreview" hidden></div>`,
    footer: `<button class="btn" data-close>${esc(t("common.cancel"))}</button>
      <button class="btn btn-primary" id="rbPreviewBtn">${esc(t("rb.preview"))}</button>
      <button class="btn btn-danger" id="rbApply" hidden>${esc(t("rb.apply"))}</button>`,
  });
  const mounts = root.querySelector("#rbMounts");
  for (const mount of box.mounts ?? []) mounts.append(mountRow(mount));
  root.querySelector("#rbAddMount").addEventListener("click", () => {
    mounts.append(mountRow({ volume: "", path: "/data", mode: "rw" }));
  });

  const envRows = root.querySelector("#rbEnvRows");
  for (const row of envRowsOf(box.env)) envRows.append(envRow(row, secrets));
  const resetPreview = () => {
    root.querySelector("#rbPreview").hidden = true;
    root.querySelector("#rbApply").hidden = true;
  };
  bindEnvRows(envRows, resetPreview);
  root.querySelector("#rbAddEnv").addEventListener("click", () => {
    envRows.append(envRow({ name: "", kind: "value", value: "", secretRef: "" }, secrets));
    resetPreview();
  });
  const dialogBody = root.querySelector(".dialog-body");
  const editedBody = (event) => {
    if (event.target.id !== "rbSafety") resetPreview();
  };
  dialogBody.addEventListener("input", editedBody);
  dialogBody.addEventListener("change", editedBody);

  const post = (body) =>
    api(`/api/boxes/${enc(box.id)}/rebuild`, {
      method: "POST",
      body,
      headers: { "if-match": String(box.revision) },
    });

  root.querySelector("#rbPreviewBtn").addEventListener("click", async (event) => {
    root.querySelector("#rbErr").textContent = "";
    root.querySelector("#rbApply").hidden = true;
    const built = rebuildBody(root, box);
    if (built.problem) {
      root.querySelector("#rbErr").textContent = envProblemText(built.problem);
      return;
    }
    try {
      await withBusy(event.currentTarget, () => post(built.body));
      root.querySelector("#rbErr").textContent = t("err.rebuild_empty");
    } catch (err) {
      if (err?.code === "confirmation_required" && err.details?.preview) {
        showPreview(root, err.details.preview);
        return;
      }
      root.querySelector("#rbErr").textContent = err?.message ?? String(err);
    }
  });

  root.querySelector("#rbApply").addEventListener("click", async (event) => {
    root.querySelector("#rbErr").textContent = "";
    const built = rebuildBody(root, box);
    if (built.problem) {
      root.querySelector("#rbErr").textContent = envProblemText(built.problem);
      return;
    }
    try {
      const safetyCheckpoint = root.querySelector("#rbSafety")?.checked ?? true;
      const result = await withBusy(event.currentTarget, () =>
        post({ ...built.body, confirm: true, safetyCheckpoint }),
      );
      close();
      const safety = result?.safety ? ` ${t("rb.safetyTaken")}` : "";
      toast(t("rb.done"), { message: t("rb.doneText", { name: box.name }) + safety });
      refreshHost();
      const next = result?.box?.id;
      const address = next && next !== box.id ? movedBoxHash(location.hash, box.id, next) : null;
      if (address) location.hash = address;
    } catch (err) {
      root.querySelector("#rbErr").textContent = err?.message ?? String(err);
      toastError(t("rb.failed"), err);
    }
  });
}

export function actionButtons(b, { compact = true } = {}) {
  const ib = (action, ic, title, extra = "") =>
    compact
      ? `<button class="icon-btn ${extra}" data-action="${action}" data-id="${esc(b.id)}" title="${title}" aria-label="${title}">${icon(ic)}</button>`
      : `<button class="btn ${extra === "danger" ? "" : ""}" data-action="${action}" data-id="${esc(b.id)}">${icon(ic)}${title}</button>`;
  return [
    b.running ? ib("stop", "stop", t("act.stop")) : ib("start", "play", t("act.start")),
    ib("restart", "restart", t("act.restart")),
    b.running ? ib("terminal", "terminal", t("act.terminal")) : "",
    ib("checkpoint", "camera", t("act.checkpoint")),
    ib("delete", "trash", t("act.delete"), "danger"),
  ].join("");
}
