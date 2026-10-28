/**
 * What the buttons of a volume's row do, and what the page's Create button does: edit the usage limits, take a snapshot,
 * stage a mount on a box, browse the files, delete one volume, measure it again, and create a volume. Each action opens
 * its own dialog, sends its own request and reports the result, so the page only routes a click here. The actions read
 * the page's boxes and volume list but never change them: a change that matters to the table ends in `reload()`, so the
 * page decides when its own state is read again.
 *
 * The form dialog is passed in rather than drawn here, because the page's pool forms use the same one and it is the
 * page that knows when a submit keeps the dialog open.
 */

import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { bytes, dateTime } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { validMountPath } from "../lib/mounts.js";
import { confirmDialog, nameError, openDialog, toast, toastError } from "../lib/ui.js";
import { snapshotPlan } from "../lib/volume-row.js";
import { limitDraft, limitsBody } from "../lib/volume-usage.js";
import { stageMount } from "./box-volumes.js";
import { mountFiles } from "./files.js";
import { field } from "./form-field.js";
import { mountModeLabel } from "./mount-editor.js";
import { waitTask, taskErrorText } from "./tasks.js";
import { ROLES } from "./volume-cells.js";

/** Browses the volume's files in a dialog, through the same file browser a box's Files tab has. */
function browse(volume) {
  const box = {
    mounts: [{ path: "/", volumeId: volume.id, volumeName: volume.name, role: null, mode: "rw" }],
  };
  let dispose = null;
  const { root } = openDialog({
    title: t("vol.browseTitle", { name: volume.name }),
    iconName: "folder",
    wide: true,
    body: `<div class="vol-browse"></div>`,
    onClose: () => dispose?.(),
  });
  dispose = mountFiles(root.querySelector(".vol-browse"), { box: () => box, onChange: () => () => {} });
}

const limitInput = (id, value) =>
  `<input class="input" id="${id}" type="number" min="0" step="any" inputmode="decimal" value="${esc(value)}" placeholder="${esc(t("vol.noLimit"))}" />`;

/**
 * The volume actions. `volumes()` is the page's current list, `boxes()` its current boxes, `boxNames()` the map from a
 * box's id to its name, `formDialog` the page's form dialog, and `reload()` reads the page again after a change.
 */
export function mountVolumeActions({ volumes, boxes, boxNames, formDialog, reload }) {
  const limits = async (volume) => {
    const draft = limitDraft(volume.limits);
    const root = await formDialog(
      t("vol.limitsTitle", { name: volume.name }),
      `<p class="help">${esc(t("vol.limitsHelp"))}</p>
        ${field(t("vol.softLimit"), limitInput("lim-soft", draft.soft))}
        ${field(t("vol.hardLimit"), limitInput("lim-hard", draft.hard))}
        ${field(
          t("vol.limitAction"),
          `<select class="select" id="lim-action">
            <option value="warn" ${draft.action === "warn" ? "selected" : ""}>${esc(t("vol.actionWarn"))}</option>
            <option value="stop" ${draft.action === "stop" ? "selected" : ""}>${esc(t("vol.actionStop"))}</option>
          </select>`,
          esc(t("vol.actionHelp")),
        )}`,
    );
    if (!root) return;
    const parsed = limitsBody({
      soft: root.querySelector("#lim-soft").value,
      hard: root.querySelector("#lim-hard").value,
      action: root.querySelector("#lim-action").value,
    });
    if (parsed.error) return toastError(t("vol.limitsFailed"), { message: t(parsed.error) });
    try {
      await api(`/api/volumes/${enc(volume.id)}/limits`, { method: "PUT", body: parsed.body });
    } catch (e) {
      return toastError(t("vol.limitsFailed"), e);
    }
    toast(t("vol.limitsSaved"));
    await reload();
  };

  /**
   * Snapshots the volume. An owned volume is a checkpoint of its owner box, which always includes it. An independent one
   * is snapshotted on its own, without a box, whether or not a box mounts it.
   */
  const snapshot = async (volume) => {
    const plan = snapshotPlan(volume);
    if (plan.block) return toast(t("vol.snapshot"), { type: "info", message: t(plan.block) });
    const boxName = plan.own ? null : (plan.boxName ?? boxNames().get(plan.boxId) ?? plan.boxId);
    const ok = await confirmDialog({
      title: t("vol.snapshotTitle", { name: volume.name }),
      message: esc(
        t(
          plan.own
            ? volume.mounts.length
              ? "vol.snapshotSelfMountedText"
              : "vol.snapshotSelfText"
            : "vol.snapshotOwnedText",
          { box: boxName ?? "" },
        ),
      ),
      confirmText: t("vol.snapshot"),
    });
    if (!ok) return;
    const label = `${volume.name} ${dateTime(new Date().toISOString())}`.slice(0, 80);
    let started;
    try {
      started = plan.own
        ? await api(`/api/volumes/${enc(volume.id)}/checkpoints`, { method: "POST", body: { label } })
        : await api(`/api/boxes/${enc(plan.boxId)}/checkpoints`, { method: "POST", body: { label } });
    } catch (e) {
      return toastError(t("ck.takeFailed"), e);
    }
    toast(t("ck.takeStarted"), { type: "info", message: boxName ?? volume.name });
    const done = await waitTask(started.taskId);
    if (done.status !== "succeeded") return toastError(t("ck.takeFailed"), { message: taskErrorText(done.error) });
    toast(t("ck.takeDone"), { message: done.result?.checkpoint?.label ?? label });
    await reload();
  };

  /** Stages a mount of the volume on a box. It applies with the box's other staged changes, like one added there. */
  const mountTo = async (volume) => {
    if (!boxes().length) return toast(t("vol.mountTo"), { type: "info", message: t("vol.mountToNoBoxes") });
    const owner = volume.ownership === "owned" && !volume.ownerMissing ? volume.ownerBoxId : null;
    const mountedOn = new Set(volume.mounts.map((mount) => mount.boxId));
    const options = boxes()
      .map((box) => {
        const blocked = owner && box.boxId !== owner;
        const note = mountedOn.has(box.boxId) ? ` (${t("vol.mountToMounted")})` : "";
        return `<option value="${esc(box.boxId)}"${blocked ? " disabled" : ""}${box.boxId === owner ? " selected" : ""}>${esc(box.name + note)}</option>`;
      })
      .join("");
    const ro = volume.role === "tools";
    const root = await formDialog(
      t("vol.mountToTitle", { name: volume.name }),
      `${owner ? `<p class="help">${esc(t("vol.mountToOwned"))}</p>` : ""}
       ${field(t("vol.mountToBox"), `<select class="select" id="mt-box">${options}</select>`)}
       ${field(t("vol.pathLabel"), `<input class="input mono" id="mt-path" value="${esc(`/mnt/${volume.name}`)}" />`)}
       ${field(t("vol.colMode"), `<select class="select" id="mt-mode"><option value="rw"${ro ? "" : " selected"}>${esc(mountModeLabel("rw"))}</option><option value="ro"${ro ? " selected" : ""}>${esc(mountModeLabel("ro"))}</option></select>`)}`,
    );
    if (!root) return;
    const box = boxes().find((item) => item.boxId === root.querySelector("#mt-box").value);
    const path = root.querySelector("#mt-path").value.trim();
    if (!box) return;
    if (!validMountPath(path)) return toastError(t("vol.attachFailed"), { message: t("vol.mountToBadPath") });
    const staged = await stageMount(
      box,
      volume,
      { id: volume.id, path, mode: root.querySelector("#mt-mode").value },
      t("vol.mountStagedText", { box: box.name }),
    );
    if (staged) await reload();
  };

  /** Deletes one volume, after the confirmation that says whether a copy is kept in the recycle bin. */
  const remove = async (volume) => {
    const res = await confirmDialog({
      title: t("vol.deleteTitle"),
      message: esc(t("vol.deleteMessage", { name: volume.name })),
      confirmText: t("vol.delete"),
      danger: true,
      checkboxes: [{ key: "skipTrash", label: t("vol.skipTrash"), help: t("vol.skipTrashHelp") }],
    });
    if (!res) return;
    const query = new URLSearchParams({ confirm: "true", skipTrash: String(res.skipTrash) });
    const deleted = await api(`/api/volumes/${enc(volume.id)}?${query}`, { method: "DELETE" });
    toast(
      t("vol.deleted"),
      deleted.trash ? { message: t("vol.keptInBin", { date: dateTime(deleted.trash.expiresAt) }) } : {},
    );
    await reload();
  };

  /** Measures the volume again, so its size cell shows the reading the engine just took. */
  const measure = async (volume) => {
    const result = await api(`/api/volumes/${enc(volume.id)}/usage`, { method: "POST" });
    toast(t("vol.measure"), { message: t("vol.measured", { bytes: bytes(result.volume.bytes) }) });
    await reload();
  };

  /** Creates a volume on one of the pools the page holds, at the role the dialog picks. */
  const create = async (pools) => {
    const options = pools.map((pool) => `<option value="${esc(pool.name)}">${esc(pool.name)}</option>`).join("");
    const roleOptions = [`<option value="">—</option>`]
      .concat(ROLES.map(([role, label]) => `<option value="${role}">${esc(t(label))}</option>`))
      .join("");
    const root = await formDialog(
      t("vol.createTitle"),
      `${field(t("vol.colName"), `<input class="input" id="v-name" />`)}
       ${field(t("vol.colPool"), `<select class="select" id="v-pool">${options}</select>`)}
       ${field(t("vol.colRole"), `<select class="select" id="v-role">${roleOptions}</select>`)}`,
    );
    if (!root) return;
    const name = root.querySelector("#v-name").value.trim();
    const invalid = nameError(name, "name");
    if (invalid) return toastError(t("vol.createFailed"), { message: invalid });
    await api("/api/volumes", {
      method: "POST",
      body: {
        name,
        pool: root.querySelector("#v-pool").value,
        role: root.querySelector("#v-role").value || null,
        confirm: true,
      },
    });
    toast(t("vol.created"));
    await reload();
  };

  /** Runs the action a volume row's button names, on the volume `id` selects from the page's list. */
  const run = async (action, id) => {
    const volume = volumes()?.find((item) => item.id === id);
    if (!volume) return;
    if (action === "limits") await limits(volume);
    else if (action === "browse") browse(volume);
    else if (action === "snapshot") await snapshot(volume);
    else if (action === "mount-to") await mountTo(volume);
  };

  return { run, create, remove, measure };
}
