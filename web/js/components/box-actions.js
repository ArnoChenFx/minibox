import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { gbOrMb } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { hostNow, refreshHost } from "../lib/store.js";
import { confirmDialog, nameError, openDialog, promptDialog, toast, toastError, withBusy } from "../lib/ui.js";
import { openTasks, taskErrorText, waitTask } from "./tasks.js";

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
    if (r.volumeError) {
      toast(t("ba.deletedVolumeFailed", { name: box.name }), {
        type: "error",
        message: t("ba.deleteVolumeFailedHint", { volume: box.volume, detail: r.volumeError }),
      });
    } else {
      toast(t("ba.deleted"), {
        message: t(r.volumeDeleted ? "ba.deletedWithVolume" : "ba.deletedKeepVolume", { name: box.name }),
      });
    }
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
    const done = await waitTask(r.taskId);
    if (done.status !== "succeeded") {
      toastError(t("ba.snapFailed"), { message: taskErrorText(done.error) || t(`task.status.${done.status}`) });
      return null;
    }
    toast(t("ba.snapCreated"), { message: done.result.snapshot.ref });
    return done.result.snapshot;
  } catch (e) {
    if (e.details?.taskId) {
      toast(t("task.alreadyRunning"), { type: "info" });
      openTasks(e.details.taskId);
      return null;
    }
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

function envKey(env) {
  return JSON.stringify(
    [...(env ?? [])]
      .map((item) => ({ name: item.name, value: item.value ?? null, secretRef: item.secretRef ?? null }))
      .toSorted((a, b) => a.name.localeCompare(b.name)),
  );
}

function canonMounts(mounts) {
  return JSON.stringify(
    [...(mounts ?? [])]
      .map((mount) => ({ volume: mount.volume, path: mount.path, mode: mount.mode }))
      .toSorted((a, b) => `${a.path}\0${a.volume}`.localeCompare(`${b.path}\0${b.volume}`)),
  );
}

function formatEnv(env) {
  return (env ?? []).map((item) => (item.value !== undefined ? `${item.name}=${item.value}` : item.name)).join("\n");
}

function readEnv(text, existing) {
  const previous = new Map((existing ?? []).map((item) => [item.name, item]));
  const env = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq === -1) {
      const prior = previous.get(line);
      if (prior?.secretRef) {
        const entry = { name: line, secretRef: prior.secretRef };
        if (prior.value !== undefined) entry.value = prior.value;
        env.push(entry);
      } else {
        env.push({ name: line, value: "" });
      }
      continue;
    }
    const name = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    const prior = previous.get(name);
    const entry = { name, value };
    if (prior?.secretRef && prior.value === value) entry.secretRef = prior.secretRef;
    env.push(entry);
  }
  return env;
}

function mountRow(mount) {
  const row = document.createElement("div");
  row.className = "rebuild-mount";
  row.dataset.mount = "true";
  row.innerHTML = `<input class="input" data-volume value="${esc(mount.volume)}" placeholder="${esc(t("rb.volume"))}" />
    <input class="input" data-path value="${esc(mount.path)}" placeholder="${esc(t("rb.path"))}" />
    <select class="select" data-mode>
      <option value="rw" ${mount.mode === "rw" ? "selected" : ""}>rw</option>
      <option value="ro" ${mount.mode === "ro" ? "selected" : ""}>ro</option>
    </select>
    <button type="button" class="btn" data-remove-mount>${esc(t("rb.removeMount"))}</button>`;
  row.querySelector("[data-remove-mount]").addEventListener("click", () => row.remove());
  return row;
}

function readMounts(root) {
  return [...root.querySelectorAll("[data-mount]")].map((row) => ({
    volume: row.querySelector("[data-volume]").value.trim(),
    path: row.querySelector("[data-path]").value.trim(),
    mode: row.querySelector("[data-mode]").value,
  }));
}

function rebuildBody(root, box) {
  const body = {};
  const template = root.querySelector("#rbTemplate").value.trim();
  if (template !== (box.template ?? "")) body.template = template;
  const network = root.querySelector("#rbNetwork").value.trim();
  if (network !== box.network) body.network = network;
  const profile = root.querySelector("#rbProfile").value;
  if (profile && profile !== (box.profile ?? "")) body.profile = profile;
  const env = readEnv(root.querySelector("#rbEnv").value, box.env);
  if (envKey(env) !== envKey(box.env)) body.env = env;
  const mounts = readMounts(root);
  if (canonMounts(mounts) !== canonMounts(box.mounts)) body.mounts = mounts;
  return body;
}

function showPreview(root, preview) {
  const changes = (preview.changes ?? [])
    .map((change) => `${t(`rebuild.field.${change.field}`)}: ${change.from} → ${change.to}`)
    .join("\n");
  const diff = preview.diff?.length
    ? preview.diff.map((change) => `${t(`rebuild.diff.${change.kind}`)} ${change.path}`).join("\n")
    : t("rb.diffEmpty");
  const keeps = (preview.keeps ?? []).map((name) => t(`rebuild.keep.${name}`)).join(", ");
  const loses = (preview.loses ?? []).map((name) => t(`rebuild.lose.${name}`)).join(", ");
  const name = preview.containerName ?? { from: "", to: "" };
  const revision = preview.revision ?? { current: "", next: "" };
  root.querySelector("#rbPreview").hidden = false;
  root.querySelector("#rbPreview").innerHTML = `<strong>${esc(t("rb.previewTitle"))}</strong>
    <div class="help" style="margin-top:8px">${esc(t("rb.changes"))}</div><pre class="mono">${esc(changes || "—")}</pre>
    <div class="help">${esc(t("rb.diff"))}</div><pre class="mono">${esc(diff)}</pre>
    <div class="help">${esc(t("rb.keeps"))}: ${esc(keeps)}</div>
    <div class="help">${esc(t("rb.loses"))}: ${esc(loses)}</div>
    <div class="help">${esc(t("rb.containerName"))}: <span class="mono">${esc(name.from)} → ${esc(name.to)}</span></div>
    <div class="help">${esc(t("rb.revision"))}: ${esc(String(revision.current))} → ${esc(String(revision.next))}</div>`;
  root.querySelector("#rbApply").hidden = false;
}

/** Preview, then confirm, a rebuild. The container id changes, so success opens the new box. */
export function openRebuild(box) {
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
      <div class="field"><label class="label" for="rbEnv">${esc(t("rb.env"))}</label>
        <textarea class="input" id="rbEnv" rows="4">${esc(formatEnv(box.env))}</textarea>
        <div class="help">${esc(t("rb.envHelp"))}</div></div>
      <div class="field"><span class="label">${esc(t("rb.mounts"))}</span>
        <div class="rebuild-mounts" id="rbMounts"></div>
        <button type="button" class="btn" id="rbAddMount">${esc(t("rb.addMount"))}</button>
        <div class="help">${esc(t("rb.mountsHelp"))}</div></div>
      <div class="error-text" id="rbErr"></div>
      <div class="rebuild-preview" id="rbPreview" hidden></div>`,
    footer: `<button class="btn" data-close>${esc(t("common.cancel"))}</button>
      <button class="btn btn-primary" id="rbPreviewBtn">${esc(t("rb.preview"))}</button>
      <button class="btn btn-danger" id="rbApply" hidden>${esc(t("rb.apply"))}</button>`,
  });
  const mounts = root.querySelector("#rbMounts");
  for (const mount of box.mounts ?? []) mounts.append(mountRow(mount));
  root.querySelector("#rbAddMount").addEventListener("click", () => {
    mounts.append(mountRow({ volume: "", path: "/data", mode: "rw" }));
  });

  const post = (body) =>
    api(`/api/boxes/${enc(box.id)}/rebuild`, {
      method: "POST",
      body,
      headers: { "if-match": String(box.revision) },
    });

  root.querySelector("#rbPreviewBtn").addEventListener("click", async (event) => {
    root.querySelector("#rbErr").textContent = "";
    root.querySelector("#rbApply").hidden = true;
    try {
      await withBusy(event.currentTarget, () => post(rebuildBody(root, box)));
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
    try {
      const result = await withBusy(event.currentTarget, () => post({ ...rebuildBody(root, box), confirm: true }));
      close();
      toast(t("rb.done"), { message: t("rb.doneText", { name: box.name }) });
      refreshHost();
      const next = result?.box?.id;
      if (next && next !== box.id) location.hash = `#/boxes/${next}`;
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
    ib("snapshot", "camera", t("act.snapshot")),
    ib("delete", "trash", t("act.delete"), "danger"),
  ].join("");
}
