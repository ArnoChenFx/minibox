import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { toastError, openDialog, confirmDialog, toast } from "../lib/ui.js";
import { rebuildPreviewHtml } from "./box-actions.js";
import { mountModeLabel } from "./mount-editor.js";
import { usageInlineHtml } from "./volume-usage.js";

const ROLE_LABEL = {
  workspace: "vol.roleWorkspace",
  home: "vol.roleHome",
  tools: "vol.roleTools",
  cache: "vol.roleCache",
};

export function mountsCard(box, volumes) {
  const rows = (box.mounts ?? [])
    .map((mount) => {
      const detach = mount.volumeId
        ? `<button class="btn btn-sm" data-action="detach-mount" data-volume="${esc(mount.volumeId)}" data-path="${esc(mount.path)}">${t("vol.detach")}</button>`
        : "";
      return `<tr>
        <td class="mono">${esc(mount.path)}</td>
        <td>${esc(mount.volumeName || mount.volume)}</td>
        <td>${mount.role ? esc(t(ROLE_LABEL[mount.role])) : "—"}</td>
        <td>${esc(mountModeLabel(mount.mode))}</td>
        <td>${esc(mount.pool || "—")}</td>
        <td>${usageInlineHtml(volumes.get(mount.volumeId))}</td>
        <td>${detach}</td>
      </tr>`;
    })
    .join("");
  return `<div class="card" style="margin-top:16px"><div class="card-head"><h3>${t("vol.mounts")}</h3>
    <button class="btn btn-sm" data-action="attach-volume">${icon("plus")}${t("vol.attach")}</button></div>
    <div class="table-wrap">${
      rows
        ? `<table class="table"><thead><tr><th>${t("vol.colPath")}</th><th>${t("vol.choose")}</th><th>${t("vol.colRole")}</th><th>${t("vol.colMode")}</th><th>${t("vol.colPool")}</th><th>${t("vol.colBytes")}</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
        : `<div class="card-body"><p class="subtle">${t("vol.noMounts")}</p></div>`
    }</div>
    <div class="card-body"><p class="help">${t("vol.rebuildNote")}</p></div></div>`;
}

export async function attachVolume(box) {
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
        <label class="field"><span>${t("vol.colMode")}</span><select class="select" id="m-mode"><option value="rw">${esc(mountModeLabel("rw"))}</option><option value="ro">${esc(mountModeLabel("ro"))}</option></select></label>`,
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
      checkboxes: [{ key: "safetyCheckpoint", label: t("rb.safety"), help: t("rb.safetyHelp"), checked: true }],
    });
    if (!ok) return null;
    return api(url, {
      method: "POST",
      body: { ...body, confirm: true, safetyCheckpoint: ok.safetyCheckpoint },
      headers,
    });
  }
}

export async function detachMount(box, el) {
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
