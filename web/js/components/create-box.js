import { api, enc } from "../lib/api.js";
import { $$, esc } from "../lib/dom.js";
import { bytes, gbOrMb } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { getTemplates, hostNow, refreshHost } from "../lib/store.js";
import { nameError, openDialog, toast } from "../lib/ui.js";

const PRESETS = [
  { id: "small", label: "cb.small", cpus: 2, memoryMb: 4096 },
  { id: "medium", label: "cb.medium", cpus: 4, memoryMb: 8192 },
  { id: "large", label: "cb.large", cpus: 8, memoryMb: 16384 },
  { id: "custom", label: "cb.custom" },
];

/**
 * Create-box dialog. When `snapshot` is given the image is fixed and the box is created from it.
 * `onCreated(box)` runs after success.
 */
export async function openCreateBox({ snapshot, template, onCreated } = {}) {
  if (!hostNow()) await refreshHost();
  const host = hostNow();
  const maxCpu = host?.cpu.cores ?? 16;
  const maxMem = host ? Math.floor(host.memory.total / 1024 / 1024) : 32768;
  let templates = [];
  if (!snapshot) {
    try {
      templates = await getTemplates(true);
    } catch {
      templates = [];
    }
  }
  const fits = (p) => p.cpus <= maxCpu && p.memoryMb <= maxMem;
  const initial = PRESETS.find((p) => p.id !== "custom" && fits(p)) ?? PRESETS[3];
  const state = {
    cpus: initial.cpus ?? Math.min(2, maxCpu),
    memoryMb: initial.memoryMb ?? 2048,
    preset: initial.id,
    template: templates.find((tp) => tp.ref === template)?.ref ?? templates[0]?.ref ?? "",
  };

  const templatePicker = snapshot
    ? `<div class="option" aria-checked="true"><span class="avatar">${icon("camera")}</span><span class="meta"><strong>${esc(snapshot)}</strong><span>${t("cb.fromSnapshotHint")}</span></span></div>`
    : templates.length
      ? `<div class="option-list" role="radiogroup" id="cbTemplates">${templates
          .map(
            (
              t,
            ) => `<div class="option" role="radio" tabindex="0" aria-checked="${t.ref === state.template}" data-ref="${esc(t.ref)}">
              <span class="avatar">${icon("layers")}</span>
              <span class="meta"><strong>${esc(t.name)}</strong><span>${esc(t.description ?? t.ref)}</span></span>
              <span class="subtle num">${bytes(t.size)}</span></div>`,
          )
          .join("")}</div>`
      : `<div class="callout warn">${icon("alert")}<span>${t("cb.noTemplates")}</span></div>`;

  const { root, close } = openDialog({
    title: snapshot ? t("cb.titleSnapshot") : t("cb.title"),
    description: t("cb.desc"),
    iconName: "box",
    wide: true,
    body: `
      <div class="field"><label class="label" for="cbName">${t("cb.name")}</label>
        <input class="input" id="cbName" placeholder="${t("cb.namePlaceholder")}" autocomplete="off" autofocus />
        <div class="help">${t("cb.nameHelp")}</div>
        <div class="error-text" id="cbNameErr"></div></div>
      <div class="field"><span class="label">${snapshot ? t("cb.sourceSnapshot") : t("cb.template")}</span>${templatePicker}</div>
      <div class="field"><span class="label">${t("cb.size")} <span class="subtle">${t("cb.hostCap", { cores: maxCpu, mem: gbOrMb(maxMem * 1024 * 1024) })}</span></span>
        <div class="segmented" id="cbPresets">${PRESETS.map(
          (
            p,
          ) => `<button type="button" class="seg" data-preset="${p.id}" aria-pressed="${p.id === state.preset}" ${p.id !== "custom" && !fits(p) ? `disabled title="${t("cb.overHost")}"` : ""}>
            <strong>${t(p.label)}</strong><span>${p.id === "custom" ? t("cb.customHint") : t("cb.presetSpec", { cpus: p.cpus, gb: p.memoryMb / 1024 })}</span></button>`,
        ).join("")}</div></div>
      <div class="field"><span class="label">CPU <span class="subtle">${t("unit.coresShort")}</span></span>
        <div class="slider-row"><input type="range" id="cbCpuR" min="0.5" max="${maxCpu}" step="0.5" /><input class="input" id="cbCpu" type="number" min="0.1" max="${maxCpu}" step="0.1" /></div></div>
      <div class="field"><span class="label">${t("cb.memory")} <span class="subtle">MB</span></span>
        <div class="slider-row"><input type="range" id="cbMemR" min="256" max="${maxMem}" step="256" /><input class="input" id="cbMem" type="number" min="128" max="${maxMem}" step="128" /></div>
        <div class="error-text" id="cbResErr"></div></div>
      <div id="cbCapacity"></div>`,
    footer: `<button class="btn" data-close>${t("common.cancel")}</button><button class="btn btn-primary" id="cbSubmit">${icon("play")}${t("cb.submit")}</button>`,
  });

  const q = (s) => root.querySelector(s);
  const sync = () => {
    q("#cbCpuR").value = state.cpus;
    q("#cbCpu").value = state.cpus;
    q("#cbMemR").value = state.memoryMb;
    q("#cbMem").value = state.memoryMb;
    $$(".seg", root).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.preset === state.preset)));
    validateRes();
  };
  const validateRes = () => {
    let err = "";
    if (!(state.cpus >= 0.1 && state.cpus <= maxCpu)) err = t("cb.cpuRange", { max: maxCpu });
    else if (!(Number.isInteger(state.memoryMb) && state.memoryMb >= 128 && state.memoryMb <= maxMem))
      err = t("cb.memRange", { max: maxMem });
    q("#cbResErr").textContent = err;
    const h = hostNow();
    if (h && !err) {
      const cpuAfter = h.boxes.allocatedCpus + state.cpus;
      const memAfter = h.boxes.allocatedMemory + state.memoryMb * 1024 * 1024;
      const over = cpuAfter > h.cpu.cores || memAfter > h.memory.total;
      q("#cbCapacity").innerHTML =
        `<div class="callout ${over ? "warn" : "info"}">${icon(over ? "alert" : "info")}<span>
        ${t("cb.capacity", { cpu: +cpuAfter.toFixed(2), cores: h.cpu.cores, mem: gbOrMb(memAfter), total: bytes(h.memory.total) })}
        ${over ? t("cb.capacityOver") : ""}</span></div>`;
    }
    return !err;
  };
  const setCustom = () => {
    state.preset = "custom";
  };

  q("#cbPresets").addEventListener("click", (e) => {
    const b = e.target.closest(".seg");
    if (!b || b.disabled) return;
    const p = PRESETS.find((x) => x.id === b.dataset.preset);
    state.preset = p.id;
    if (p.cpus) {
      state.cpus = p.cpus;
      state.memoryMb = p.memoryMb;
    }
    sync();
  });
  const bind = (sel, evt, key) =>
    q(sel).addEventListener(evt, (e) => {
      setCustom();
      state[key] = Number(e.target.value);
      sync();
    });
  bind("#cbCpuR", "input", "cpus");
  bind("#cbMemR", "input", "memoryMb");
  bind("#cbCpu", "change", "cpus");
  bind("#cbMem", "change", "memoryMb");
  q("#cbTemplates")?.addEventListener("click", (e) => {
    const o = e.target.closest(".option");
    if (!o) return;
    state.template = o.dataset.ref;
    $$(".option", root).forEach((x) => x.setAttribute("aria-checked", String(x === o)));
  });
  q("#cbName").addEventListener("input", () => {
    q("#cbName").classList.remove("invalid");
    q("#cbNameErr").textContent = "";
  });
  sync();

  const submit = async () => {
    const name = q("#cbName").value.trim();
    const nErr = nameError(name, "boxName");
    if (nErr) {
      q("#cbName").classList.add("invalid");
      q("#cbNameErr").textContent = nErr;
      q("#cbName").focus();
      return;
    }
    if (!validateRes()) return;
    if (!snapshot && !state.template) return;
    const btn = q("#cbSubmit");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>${t("cb.creating")}`;
    try {
      const body = { name, cpus: state.cpus, memoryMb: state.memoryMb };
      const res = snapshot
        ? await api(`/api/snapshots/${enc(snapshot)}/boxes`, { method: "POST", body })
        : await api("/api/boxes", { method: "POST", body: { ...body, template: state.template } });
      close();
      toast(t("cb.created"), { message: t("cb.createdText", { name: res.box.name }) });
      refreshHost();
      onCreated?.(res.box);
    } catch (e) {
      btn.disabled = false;
      btn.innerHTML = `${icon("play")}${t("cb.submit")}`;
      if (e.details?.field === "name") {
        q("#cbName").classList.add("invalid");
        q("#cbNameErr").textContent = e.message;
      } else if (e.code === "conflict") {
        q("#cbName").classList.add("invalid");
        q("#cbNameErr").textContent = e.message;
      } else {
        q("#cbResErr").textContent = e.message;
      }
    }
  };
  q("#cbSubmit").addEventListener("click", submit);
  q("#cbName").addEventListener("keydown", (e) => e.key === "Enter" && submit());
}
