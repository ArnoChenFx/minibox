import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { gbOrMb } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { hostNow, refreshHost } from "../lib/store.js";
import { confirmDialog, nameError, openDialog, promptDialog, toast, toastError, withBusy } from "../lib/ui.js";

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
    checkbox: {
      label: t("ba.deleteVolume", { volume: esc(box.volume) }),
      help: t("ba.deleteVolumeHelp"),
    },
  });
  if (!res) return false;
  try {
    const r = await api(`/api/boxes/${enc(box.id)}?deleteVolume=${res.checked}`, { method: "DELETE" });
    toast(t("ba.deleted"), {
      message: t(r.volumeDeleted ? "ba.deletedWithVolume" : "ba.deletedKeepVolume", { name: box.name }),
    });
    refreshHost();
    return true;
  } catch (e) {
    toastError(t("ba.deleteFailed"), e);
    return false;
  }
}

export async function snapshotBox(box) {
  const name = await promptDialog({
    title: t("ba.snapTitle"),
    description: t("ba.snapDesc", { name: esc(box.name) }),
    iconName: "camera",
    label: t("ba.snapLabel"),
    placeholder: box.name,
    help: t("ba.snapHelp"),
    confirmText: t("ba.snapTitle"),
    validate: (v) => (v ? nameError(v, "snapshotName") : ""),
  });
  if (name === null) return null;
  toast(t("ba.snapCreating"), { type: "info", message: t("ba.snapCreatingText") });
  try {
    const r = await api(`/api/boxes/${enc(box.id)}/snapshots`, { method: "POST", body: name ? { name } : {} });
    toast(t("ba.snapCreated"), { message: r.snapshot.ref });
    return r.snapshot;
  } catch (e) {
    toastError(t("ba.snapFailed"), e);
    return null;
  }
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
        message: t("ba.resUpdatedText", { name: box.name, cpus, mem: gbOrMb(memoryMb * 1024 * 1024) }),
      });
      refreshHost();
      onSaved?.();
    } catch (err) {
      q("#erErr").textContent = err.message;
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
    ib("snapshot", "camera", t("act.snapshot")),
    ib("delete", "trash", t("act.delete"), "danger"),
  ].join("");
}
