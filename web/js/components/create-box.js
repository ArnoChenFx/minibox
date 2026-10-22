import { api, enc } from "../lib/api.js";
import { $$, esc } from "../lib/dom.js";
import { checkEnvRows, isEnvErrorKey } from "../lib/env.js";
import { bytes, gbOrMb } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { checkMountRows, DEFAULT_MOUNTS, isVolumeErrorKey, MOUNT_MAX, volumeChoices } from "../lib/mounts.js";
import { getTemplates, hostNow, refreshHost } from "../lib/store.js";
import { filterTools, groupTools } from "../lib/tool-list.js";
import { emptyState, nameError, openDialog, toast } from "../lib/ui.js";
import { bindEnvRows, envProblemText, envRow, readEnvRows, secretNames } from "./env-editor.js";
import { mountRow, readMountRows } from "./mount-editor.js";
import { bindSearchBox, searchBoxHtml } from "./search-box.js";
import { openTasks } from "./tasks.js";

const PRESETS = [
  { id: "small", label: "cb.small", cpus: 2, memoryMb: 4096 },
  { id: "medium", label: "cb.medium", cpus: 4, memoryMb: 8192 },
  { id: "large", label: "cb.large", cpus: 8, memoryMb: 16384 },
  { id: "custom", label: "cb.custom" },
];

const PROFILES = ["standard", "strict", "relaxed"];

/** The text for a custom row the dialog refuses before sending. Paths use the server's own messages. */
function problemText(problem) {
  return problem.code === "volume" ? t("cb.mountVolumeRequired") : t(`err.${problem.code}`, { path: problem.path });
}

const categoryLabel = (id) => t(`tool.cat.${id}`);

/** The native checkbox stays for keyboard and screen-reader use; the row draws its own box and check mark. */
function toolCheckHtml(tool, selected) {
  const blocked = tool.needsRoot;
  return `<label class="check-row${blocked ? " is-disabled" : ""}">
    <input class="sr-only" type="checkbox" value="${esc(tool.id)}"${selected ? " checked" : ""}${blocked ? " disabled" : ""} />
    <span class="check-mark" aria-hidden="true">${icon("check")}</span>
    <span class="check-body">
      <span class="check-title"><strong>${esc(tool.name)}</strong>${blocked ? `<span class="badge badge-warning" title="${esc(t("tool.needsRootHelp"))}">${esc(t("tool.needsRoot"))}</span>` : ""}</span>
      <span class="subtle">${esc(tool.source)}${tool.requires ? ` · ${esc(tool.requires)}` : ""} · ~${esc(String(tool.estimatedMb))} MB</span>
      <span class="help">${esc(tool.description)}</span>
    </span></label>`;
}

function toolGroupHtml(group, selected) {
  const label = esc(categoryLabel(group.category));
  return `<section class="tool-group" aria-label="${label}">
    <div class="tool-group-head"><strong>${label}</strong><span class="badge">${group.rows.length}</span></div>
    <div class="tool-checks">${group.rows.map((tool) => toolCheckHtml(tool, selected.has(tool.id))).join("")}</div>
  </section>`;
}

/** The volumes a custom row can pick, with the ones another live box owns marked unavailable. */
async function loadChoices() {
  const [volumeBody, boxBody] = await Promise.all([api("/api/volumes"), api("/api/boxes?stats=false")]);
  return volumeChoices(volumeBody.volumes, new Set(boxBody.boxes.map((box) => box.boxId)));
}

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
  const system = await api("/api/system").catch(() => null);
  const defaultProfile = PROFILES.includes(system?.config?.boxProfile) ? system.config.boxProfile : "standard";
  const fits = (p) => p.cpus <= maxCpu && p.memoryMb <= maxMem;
  const initial = PRESETS.find((p) => p.id !== "custom" && fits(p)) ?? PRESETS[3];
  const state = {
    cpus: initial.cpus ?? Math.min(2, maxCpu),
    memoryMb: initial.memoryMb ?? 2048,
    preset: initial.id,
    template: templates.find((tp) => tp.ref === template)?.ref ?? templates[0]?.ref ?? "",
    profile: defaultProfile,
    volumesMode: "default",
  };
  let choices = null;
  let seeded = false;

  let catalog = [];
  try {
    catalog = (await api("/api/tools/catalog")).tools;
  } catch {
    catalog = [];
  }
  const secrets = snapshot ? [] : await secretNames();
  const picker = !snapshot && catalog.length > 0;
  const toolsSection = picker
    ? `<div class="field" id="cbToolsField">
          <div class="tool-picker-head"><span class="label">${t("cb.tools")}</span>${searchBoxHtml({ id: "cbToolSearch", placeholder: t("tool.searchPlaceholder"), label: t("tool.search") })}</div>
          <div class="help">${t("cb.toolsHelp")}</div>
          <div class="tool-groups" id="cbTools"></div></div>`
    : "";

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

  const volumesSection = snapshot
    ? ""
    : `<details class="advanced" id="cbVolumes">
        <summary id="cbVolSummary">${t("cb.volumesSummary", { mode: t("cb.volumesModeDefault") })}</summary>
        <div class="field"><span class="label">${t("vol.mounts")}</span>
          <div class="segmented segmented-2" id="cbVolMode">
            <button type="button" class="seg" data-vol-mode="default" aria-pressed="true"><strong>${t("cb.volumesDefault")}</strong><span>${t("cb.volumesDefaultHint")}</span></button>
            <button type="button" class="seg" data-vol-mode="custom" aria-pressed="false"><strong>${t("cb.volumesCustom")}</strong><span>${t("cb.volumesCustomHint")}</span></button>
          </div>
          <div class="help" id="cbVolHelp">${t("cb.volumesDefaultHelp")}</div></div>
        <div id="cbVolCustom" hidden>
          <div class="callout warn">${icon("alert")}<span>${t("cb.volumesReplace")}</span></div>
          <div class="rebuild-mounts" id="cbMountRows"></div>
          <button type="button" class="btn" id="cbAddMount">${t("mount.add")}</button>
          <div class="help" id="cbMountsNote" hidden></div>
          <div class="help" id="cbMountsOwned" hidden>${t("cb.mountsOwned")}</div>
          <div id="cbSharedNote" hidden></div>
        </div>
        <div class="error-text" id="cbVolErr"></div>
      </details>`;

  const envSection = snapshot
    ? ""
    : `<details class="advanced" id="cbEnv">
        <summary id="cbEnvSummary">${t("env.section")}</summary>
        <div class="stack">
          <div class="help">${t("env.createHelp")}</div>
          <div class="env-rows" id="cbEnvRows"></div>
          <div><button type="button" class="btn" id="cbAddEnv">${icon("plus")}${t("env.add")}</button></div>
          <div class="error-text" id="cbEnvErr"></div>
        </div>
      </details>`;

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
      <div id="cbCapacity"></div>
      <details class="advanced" id="cbAdvanced">
        <summary>${t("cb.advancedSummary", { profile: t(`profile.${state.profile}`) })}</summary>
        <div class="field"><span class="label">${t("cb.profile")}</span>
          <div class="segmented segmented-3" id="cbProfiles">${PROFILES.map(
            (p) =>
              `<button type="button" class="seg" data-profile="${p}" aria-pressed="${p === state.profile}"><strong>${t(`profile.${p}`)}</strong><span>${t(`profile.${p}Hint`)}</span></button>`,
          ).join("")}</div>
          <div class="help">${t("cb.profileHelp")}</div></div>
      </details>${toolsSection}${volumesSection}${envSection}`,
    footer: `<button class="btn" data-close>${t("common.cancel")}</button><button class="btn btn-primary" id="cbSubmit">${icon("play")}${t("cb.submit")}</button>`,
  });

  const q = (s) => root.querySelector(s);
  const sync = () => {
    q("#cbCpuR").value = state.cpus;
    q("#cbCpu").value = state.cpus;
    q("#cbMemR").value = state.memoryMb;
    q("#cbMem").value = state.memoryMb;
    $$("#cbPresets .seg", root).forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.preset === state.preset)),
    );
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
  q("#cbProfiles").addEventListener("click", (e) => {
    const b = e.target.closest(".seg");
    if (!b) return;
    state.profile = b.dataset.profile;
    $$("#cbProfiles .seg", root).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    q("#cbAdvanced summary").textContent = t("cb.advancedSummary", { profile: t(`profile.${state.profile}`) });
  });
  q("#cbName").addEventListener("input", () => {
    q("#cbName").classList.remove("invalid");
    q("#cbNameErr").textContent = "";
  });

  const showVolumeError = (message) => {
    if (snapshot) {
      q("#cbResErr").textContent = message;
      return;
    }
    q("#cbVolumes").open = true;
    q("#cbVolErr").textContent = message;
  };

  const showEnvError = (message) => {
    q("#cbEnv").open = true;
    q("#cbEnvErr").textContent = message;
  };

  const refreshMounts = () => {
    if (!choices) return;
    const rows = readMountRows(q("#cbMountRows"));
    const note = q("#cbMountsNote");
    let text = "";
    if (choices.length === 0) text = t("cb.mountsNoVolumes");
    else if (rows.length === 0) text = t("cb.mountsNone");
    else if (rows.length >= MOUNT_MAX) text = t("cb.mountsLimit", { max: MOUNT_MAX });
    note.textContent = text;
    note.hidden = text === "";
    q("#cbAddMount").disabled = rows.length >= MOUNT_MAX;
    const shared = rows
      .filter((row) => row.mode === "rw")
      .map((row) => choices.find((choice) => choice.id === row.volume))
      .filter((choice) => choice && choice.rwMounts > 0)
      .map((choice) => `<div>${esc(t("vol.sharedRwMessage", { name: choice.name }))}</div>`);
    q("#cbSharedNote").hidden = shared.length === 0;
    q("#cbSharedNote").innerHTML = shared.length
      ? `<div class="callout warn">${icon("alert")}<div>${shared.join("")}</div></div>`
      : "";
  };

  const chooseVolumesMode = async (mode) => {
    const custom = mode === "custom";
    q("#cbVolErr").textContent = "";
    if (custom && choices === null) {
      const seg = q('#cbVolMode [data-vol-mode="custom"]');
      seg.disabled = true;
      try {
        choices = await loadChoices();
      } catch (e) {
        q("#cbVolErr").textContent = e.message;
        return;
      } finally {
        seg.disabled = false;
      }
    }
    if (custom && !seeded) {
      seeded = true;
      for (const m of DEFAULT_MOUNTS) {
        q("#cbMountRows").append(mountRow({ volume: "", path: m.path, mode: m.mode }, { volumes: choices }));
      }
    }
    state.volumesMode = mode;
    $$("#cbVolMode .seg", root).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.volMode === mode)));
    q("#cbVolCustom").hidden = !custom;
    q("#cbVolHelp").textContent = t(custom ? "cb.volumesCustomHelp" : "cb.volumesDefaultHelp");
    q("#cbVolSummary").textContent = t("cb.volumesSummary", {
      mode: t(custom ? "cb.volumesModeCustom" : "cb.volumesModeDefault"),
    });
    q("#cbMountsOwned").hidden = !custom || !choices?.some((choice) => choice.disabled);
    refreshMounts();
  };

  if (!snapshot) {
    q("#cbVolMode").addEventListener("click", (e) => {
      const b = e.target.closest(".seg");
      if (b && b.dataset.volMode !== state.volumesMode) chooseVolumesMode(b.dataset.volMode);
    });
    q("#cbAddMount").addEventListener("click", () => {
      q("#cbMountRows").append(mountRow({ volume: "", path: "/data", mode: "rw" }, { volumes: choices }));
      refreshMounts();
    });
    q("#cbMountRows").addEventListener("change", refreshMounts);
    q("#cbMountRows").addEventListener("click", refreshMounts);
  }
  const selectedTools = new Set();
  if (picker) {
    let toolQuery = "";
    const drawTools = () => {
      const matches = filterTools(catalog, toolQuery, categoryLabel);
      q("#cbTools").innerHTML = matches.length
        ? groupTools(matches)
            .map((group) => toolGroupHtml(group, selectedTools))
            .join("")
        : emptyState({
            iconName: "search",
            title: t("tool.noMatch"),
            text: t("tool.noMatchText", { q: esc(toolQuery) }),
            action: `<button class="btn btn-sm" data-action="clear-search">${t("common.clearSearch")}</button>`,
          });
    };
    const search = bindSearchBox(q("#cbToolSearch"), (text) => {
      toolQuery = text;
      drawTools();
    });
    q("#cbTools").addEventListener("change", (event) => {
      const input = event.target.closest("input[type=checkbox]");
      if (!input) return;
      if (input.checked) selectedTools.add(input.value);
      else selectedTools.delete(input.value);
    });
    q("#cbTools").addEventListener("click", (event) => {
      if (event.target.closest('[data-action="clear-search"]')) search.clear();
    });
    drawTools();
  }
  sync();
  if (!snapshot) {
    const rows = q("#cbEnvRows");
    const refreshEnv = () => {
      q("#cbEnvErr").textContent = "";
      const n = rows.children.length;
      q("#cbEnvSummary").textContent = n ? t("env.sectionCount", { n }) : t("env.section");
    };
    bindEnvRows(rows, refreshEnv);
    q("#cbAddEnv").addEventListener("click", () => {
      rows.append(envRow({ name: "", kind: "value", value: "", secretRef: "" }, secrets));
      refreshEnv();
      rows.lastElementChild.querySelector("[data-env-name]").focus();
    });
  }

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
    if (!snapshot) q("#cbVolErr").textContent = "";
    let mounts;
    if (!snapshot && state.volumesMode === "custom") {
      const checked = checkMountRows(readMountRows(q("#cbMountRows")));
      if ("problem" in checked) {
        showVolumeError(problemText(checked.problem));
        return;
      }
      mounts = checked.mounts;
    }
    let env;
    if (!snapshot) {
      const checked = checkEnvRows(readEnvRows(q("#cbEnvRows")));
      if ("problem" in checked) {
        showEnvError(envProblemText(checked.problem));
        return;
      }
      env = checked.env;
    }
    const btn = q("#cbSubmit");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>${t("cb.creating")}`;
    try {
      const body = { name, cpus: state.cpus, memoryMb: state.memoryMb, profile: state.profile };
      if (mounts) body.mounts = mounts;
      if (env?.length) body.env = env;
      const selectedToolIds = [...selectedTools];
      if (selectedToolIds.length) body.tools = selectedToolIds;
      const res = snapshot
        ? await api(`/api/snapshots/${enc(snapshot)}/boxes`, { method: "POST", body })
        : await api("/api/boxes", { method: "POST", body: { ...body, template: state.template } });
      close();
      toast(t("cb.created"), { message: t("cb.createdText", { name: res.box.name }) });
      refreshHost();
      if (selectedToolIds.length) {
        try {
          const task = await api(`/api/boxes/${enc(res.box.id)}/tools/reconcile`, { method: "POST" });
          if (task?.taskId) openTasks(task.taskId);
          toast(t("cb.toolsInstalling"), { message: t("cb.toolsInstallingText") });
        } catch (installErr) {
          toast(t("cb.toolsInstallLater"), { message: installErr.message });
        }
      }
      onCreated?.(res.box);
    } catch (e) {
      btn.disabled = false;
      btn.innerHTML = `${icon("play")}${t("cb.submit")}`;
      if (isVolumeErrorKey(e.key)) {
        showVolumeError(e.message);
      } else if (!snapshot && (e.details?.field === "env" || isEnvErrorKey(e.key))) {
        showEnvError(`${e.message}${e.hint ? ` ${e.hint}` : ""}`);
      } else if (e.details?.field === "name") {
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
