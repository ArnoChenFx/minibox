import { api, enc } from "../lib/api.js";
import { $$, esc } from "../lib/dom.js";
import { bytes, gbOrMb } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import { getTemplates, hostNow, refreshHost } from "../lib/store.js";
import { nameError, openDialog, toast } from "../lib/ui.js";

const PRESETS = [
  { id: "small", label: "小型", cpus: 2, memoryMb: 4096 },
  { id: "medium", label: "中型", cpus: 4, memoryMb: 8192 },
  { id: "large", label: "大型", cpus: 8, memoryMb: 16384 },
  { id: "custom", label: "自定义" },
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
    template: templates.find((t) => t.ref === template)?.ref ?? templates[0]?.ref ?? "",
  };

  const templatePicker = snapshot
    ? `<div class="option" aria-checked="true"><span class="avatar">${icon("camera")}</span><span class="meta"><strong>${esc(snapshot)}</strong><span>从快照创建，包含快照时的完整环境</span></span></div>`
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
      : `<div class="callout warn">${icon("alert")}<span>当前没有可用模板。请先到 <a href="#/templates">模板</a> 页构建基础模板。</span></div>`;

  const { root, close } = openDialog({
    title: snapshot ? "从快照创建 Box" : "创建 Box",
    description: "Box 是一个独立的 Docker 容器，工作区 /workspace 保存在专属数据卷中。",
    iconName: "box",
    wide: true,
    body: `
      <div class="field"><label class="label" for="cbName">名称</label>
        <input class="input" id="cbName" placeholder="例如 agent-dev" autocomplete="off" autofocus />
        <div class="help">用于识别 Box，创建后不可修改。可使用字母、数字、点、下划线和连字符。</div>
        <div class="error-text" id="cbNameErr"></div></div>
      <div class="field"><span class="label">${snapshot ? "来源快照" : "模板"}</span>${templatePicker}</div>
      <div class="field"><span class="label">规格 <span class="subtle">宿主机 ${maxCpu} 核 · ${gbOrMb(maxMem * 1024 * 1024)}</span></span>
        <div class="segmented" id="cbPresets">${PRESETS.map(
          (
            p,
          ) => `<button type="button" class="seg" data-preset="${p.id}" aria-pressed="${p.id === state.preset}" ${p.id !== "custom" && !fits(p) ? 'disabled title="超出宿主机容量"' : ""}>
            <strong>${p.label}</strong><span>${p.id === "custom" ? "按需调整" : `${p.cpus} 核 · ${p.memoryMb / 1024} GB`}</span></button>`,
        ).join("")}</div></div>
      <div class="field"><span class="label">CPU <span class="subtle">核</span></span>
        <div class="slider-row"><input type="range" id="cbCpuR" min="0.5" max="${maxCpu}" step="0.5" /><input class="input" id="cbCpu" type="number" min="0.1" max="${maxCpu}" step="0.1" /></div></div>
      <div class="field"><span class="label">内存 <span class="subtle">MB</span></span>
        <div class="slider-row"><input type="range" id="cbMemR" min="256" max="${maxMem}" step="256" /><input class="input" id="cbMem" type="number" min="128" max="${maxMem}" step="128" /></div>
        <div class="error-text" id="cbResErr"></div></div>
      <div id="cbCapacity"></div>`,
    footer: `<button class="btn" data-close>取消</button><button class="btn btn-primary" id="cbSubmit">${icon("play")}创建并启动</button>`,
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
    if (!(state.cpus >= 0.1 && state.cpus <= maxCpu)) err = `CPU 须在 0.1 到 ${maxCpu} 核之间。`;
    else if (!(Number.isInteger(state.memoryMb) && state.memoryMb >= 128 && state.memoryMb <= maxMem))
      err = `内存须为 128 到 ${maxMem} 之间的整数（MB）。`;
    q("#cbResErr").textContent = err;
    const h = hostNow();
    if (h && !err) {
      const cpuAfter = h.boxes.allocatedCpus + state.cpus;
      const memAfter = h.boxes.allocatedMemory + state.memoryMb * 1024 * 1024;
      const over = cpuAfter > h.cpu.cores || memAfter > h.memory.total;
      q("#cbCapacity").innerHTML =
        `<div class="callout ${over ? "warn" : "info"}">${icon(over ? "alert" : "info")}<span>
        创建后运行中 Box 的配额合计：CPU ${+cpuAfter.toFixed(2)} / ${h.cpu.cores} 核，内存 ${gbOrMb(memAfter)} / ${bytes(h.memory.total)}。
        ${over ? "已超过宿主机容量，高负载时 Box 之间会互相争抢资源。" : ""}</span></div>`;
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
    const nErr = nameError(name, "Box 名称");
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
    btn.innerHTML = '<span class="spinner"></span>正在创建…';
    try {
      const body = { name, cpus: state.cpus, memoryMb: state.memoryMb };
      const res = snapshot
        ? await api(`/api/snapshots/${enc(snapshot)}/boxes`, { method: "POST", body })
        : await api("/api/boxes", { method: "POST", body: { ...body, template: state.template } });
      close();
      toast("Box 已创建", { message: `${res.box.name} 正在运行。` });
      refreshHost();
      onCreated?.(res.box);
    } catch (e) {
      btn.disabled = false;
      btn.innerHTML = `${icon("play")}创建并启动`;
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
