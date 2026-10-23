import { api } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { toastError, openDialog, confirmDialog, toast } from "../lib/ui.js";
import { mountModeLabel } from "./mount-editor.js";
import { fetchStaged, onStaged, stageFields, stagedField } from "./staged-changes.js";
import { usageInlineHtml } from "./volume-usage.js";

const ROLE_LABEL = {
  workspace: "vol.roleWorkspace",
  home: "vol.roleHome",
  tools: "vol.roleTools",
  cache: "vol.roleCache",
};

const sameMount = (a, b) => a.volume === b.volume && a.path === b.path && a.mode === b.mode;

/** The box's mounts as a rebuild names them: volume, path and mode. */
export function mountSpecsOf(box) {
  return (box.mounts ?? []).map((mount) => ({ volume: mount.volume, path: mount.path, mode: mount.mode }));
}

/**
 * The rows the card lists. Without staged mounts, the box's own. With them, each mount the box has is kept or marked for
 * removal, and each staged mount the box lacks is marked to be added, after the box's own.
 */
export function mountRowsOf(box, staged) {
  const current = box.mounts ?? [];
  if (!staged) return current.map((mount) => ({ mount, pending: null }));
  const rows = current.map((mount) => ({
    mount,
    pending: staged.some((item) => sameMount(item, mount)) ? null : "remove",
  }));
  for (const item of staged) {
    if (!current.some((mount) => sameMount(item, mount))) rows.push({ mount: item, pending: "add" });
  }
  return rows;
}

function volumeOfMount(mount, volumes) {
  if (mount.volumeId) return volumes.get(mount.volumeId);
  return [...volumes.values()].find((volume) => volume.engineName === mount.volume || volume.name === mount.volume);
}

function mountAction(mount, pending) {
  const path = esc(mount.path);
  if (pending === "remove") {
    return `<button class="btn btn-sm" data-action="restore-mount" data-path="${path}">${t("stg.undo")}</button>`;
  }
  if (pending === "add" || mount.volumeId) {
    return `<button class="btn btn-sm" data-action="detach-mount" data-path="${path}">${t("vol.detach")}</button>`;
  }
  return "";
}

const PENDING_BADGE = { add: "stg.pendingAdd", remove: "stg.pendingRemove" };

export function mountsCard(box, volumes, staged = null) {
  const rows = mountRowsOf(box, staged)
    .map(({ mount, pending }) => {
      const volume = volumeOfMount(mount, volumes);
      const badge = pending ? ` <span class="badge badge-warning">${esc(t(PENDING_BADGE[pending]))}</span>` : "";
      return `<tr${pending ? ` class="mount-pending mount-pending-${pending}" data-pending="${pending}"` : ""}>
        <td class="mono">${esc(mount.path)}${badge}</td>
        <td>${esc(mount.volumeName || volume?.name || mount.volume)}</td>
        <td>${mount.role ? esc(t(ROLE_LABEL[mount.role])) : "—"}</td>
        <td>${esc(mountModeLabel(mount.mode))}</td>
        <td>${esc(mount.pool || volume?.pool || "—")}</td>
        <td>${usageInlineHtml(volume)}</td>
        <td>${mountAction(mount, pending)}</td>
      </tr>`;
    })
    .join("");
  return `<div class="card"><div class="card-head"><h3>${t("vol.mounts")}</h3>
    <button class="btn btn-sm" data-action="attach-volume">${icon("plus")}${t("vol.attach")}</button></div>
    <div class="table-wrap">${
      rows
        ? `<table class="table"><thead><tr><th>${t("vol.colPath")}</th><th>${t("vol.choose")}</th><th>${t("vol.colRole")}</th><th>${t("vol.colMode")}</th><th>${t("vol.colPool")}</th><th>${t("vol.colBytes")}</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
        : `<div class="card-body"><p class="subtle">${t("vol.noMounts")}</p></div>`
    }</div>
    <div class="card-body"><p class="help">${t("vol.rebuildNote")}</p></div></div>`;
}

/**
 * The storage section of a box: its mounts with the volumes' sizes, and the mounts staged for the next rebuild marked
 * as such. The volumes and the staged mounts are read once, after the card has shown, and the card is drawn again as
 * the box or its staged changes change. Attaching or detaching a volume stages the change; the banner applies it.
 */
export function mountMounts(root, { box, onChange }) {
  let volumes = new Map();
  let staged = null;
  let open = true;
  const draw = () => {
    if (open) root.innerHTML = mountsCard(box(), volumes, staged);
  };
  draw();
  api("/api/volumes")
    .then(({ volumes: listed }) => {
      if (!open) return;
      volumes = new Map(listed.map((volume) => [volume.id, volume]));
      draw();
    })
    .catch(() => undefined);
  const readStaged = () =>
    fetchStaged(box().id)
      .then((waiting) => {
        if (!open) return;
        staged = stagedField(waiting, "mounts");
        draw();
      })
      .catch(() => undefined);
  void readStaged();
  let revision = box().revision;
  const off = onChange(() => {
    draw();
    if (box().revision !== revision) {
      revision = box().revision;
      void readStaged();
    }
  });
  const offStaged = onStaged(
    () => box().boxId,
    (waiting) => {
      staged = stagedField(waiting, "mounts");
      draw();
    },
  );
  return () => {
    open = false;
    off();
    offStaged();
  };
}

/** The mounts the next rebuild would give the box: the staged ones, or the box's own when none are staged. */
async function plannedMounts(box) {
  return stagedField(await fetchStaged(box.id), "mounts") ?? mountSpecsOf(box);
}

/** Picks a volume, a path and a mode, and stages the box with that mount added. Resolves true once it is staged. */
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
    const planned = await plannedMounts(box);
    const mount = { volume: volume?.engineName ?? picked.id, path: picked.path, mode: picked.mode };
    await stageFields(box, { mounts: [...planned.filter((item) => item.path !== mount.path), mount] });
    toast(t("stg.staged"), { message: t("stg.stagedText") });
    return true;
  } catch (e) {
    toastError(t("vol.attachFailed"), e);
    return false;
  }
}

/** Stages the box without the mount at the path the button names. */
export async function detachMount(box, el) {
  try {
    const planned = await plannedMounts(box);
    await stageFields(box, { mounts: planned.filter((item) => item.path !== el.dataset.path) });
    toast(t("stg.staged"), { message: t("stg.stagedText") });
    return true;
  } catch (e) {
    toastError(t("vol.detachFailed"), e);
    return false;
  }
}

/** Takes a mount the box has back into the staged mounts, which undoes its staged removal. */
export async function restoreMount(box, el) {
  const kept = (box.mounts ?? []).find((mount) => mount.path === el.dataset.path);
  if (!kept) return false;
  try {
    const planned = await plannedMounts(box);
    const restored = { volume: kept.volume, path: kept.path, mode: kept.mode };
    await stageFields(box, { mounts: [...planned.filter((item) => item.path !== kept.path), restored] });
    return true;
  } catch (e) {
    toastError(t("stg.stageFailed"), e);
    return false;
  }
}
