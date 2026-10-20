import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { gbOrMb } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import { hostNow, refreshHost } from "../lib/store.js";
import { confirmDialog, nameError, openDialog, promptDialog, toast, toastError, withBusy } from "../lib/ui.js";

const LIFECYCLE = {
  start: ["启动", "已启动"],
  stop: ["停止", "已停止"],
  restart: ["重启", "已重启"],
};

export async function lifecycle(box, action, btn) {
  const [verb, done] = LIFECYCLE[action];
  try {
    await withBusy(btn, () => api(`/api/boxes/${enc(box.id)}/${action}`, { method: "POST" }));
    toast(`Box ${done}`, { message: box.name });
    refreshHost();
    return true;
  } catch (e) {
    toastError(`${verb}失败`, e);
    return false;
  }
}

export async function deleteBox(box) {
  const res = await confirmDialog({
    title: `删除 Box「${box.name}」`,
    message: "容器将被强制停止并删除，此操作无法撤销。已创建的快照不受影响。",
    confirmText: "删除 Box",
    danger: true,
    checkbox: {
      label: `同时删除工作区数据卷 <code>${esc(box.volume)}</code>`,
      help: "勾选后 /workspace 中的代码和数据将被永久删除；不勾选则保留，之后同名 Box 会重新挂载它。",
    },
  });
  if (!res) return false;
  try {
    const r = await api(`/api/boxes/${enc(box.id)}?deleteVolume=${res.checked}`, { method: "DELETE" });
    toast("Box 已删除", {
      message: r.volumeDeleted ? `${box.name} 及其工作区数据卷已删除。` : `${box.name} 已删除，工作区数据卷已保留。`,
    });
    refreshHost();
    return true;
  } catch (e) {
    toastError("删除失败", e);
    return false;
  }
}

export async function snapshotBox(box) {
  const name = await promptDialog({
    title: "创建快照",
    description: `将「${esc(box.name)}」当前的系统环境保存为镜像，可用于创建新 Box 或提升为模板。`,
    iconName: "camera",
    label: "快照名称（可选）",
    placeholder: box.name,
    help: "留空时使用 Box 名称。快照不包含 /workspace 数据卷中的内容。",
    confirmText: "创建快照",
    validate: (v) => (v ? nameError(v, "快照名称") : ""),
  });
  if (name === null) return null;
  toast("正在创建快照…", { type: "info", message: "环境较大时需要一些时间。" });
  try {
    const r = await api(`/api/boxes/${enc(box.id)}/snapshots`, { method: "POST", body: name ? { name } : {} });
    toast("快照已创建", { message: r.snapshot.ref });
    return r.snapshot;
  } catch (e) {
    toastError("创建快照失败", e);
    return null;
  }
}

export function editResources(box, onSaved) {
  const host = hostNow();
  const maxCpu = host?.cpu.cores ?? 16;
  const maxMem = host ? Math.floor(host.memory.total / 1024 / 1024) : 32768;
  const curMem = box.memory ? Math.round(box.memory / 1024 / 1024) : 2048;
  const { root, close } = openDialog({
    title: "调整资源配额",
    description: `修改「${esc(box.name)}」的 CPU 与内存上限。运行中的 Box 会立即生效，无需重启。`,
    iconName: "sliders",
    body: `
      <div class="field"><span class="label">CPU <span class="subtle">当前 ${box.cpus ?? "不限"} 核 · 上限 ${maxCpu} 核</span></span>
        <div class="slider-row"><input type="range" id="erCpuR" min="0.5" max="${maxCpu}" step="0.5" value="${box.cpus ?? 1}" /><input class="input" id="erCpu" type="number" min="0.1" max="${maxCpu}" step="0.1" value="${box.cpus ?? 1}" /></div></div>
      <div class="field"><span class="label">内存 <span class="subtle">当前 ${box.memory ? gbOrMb(box.memory) : "不限"} · 上限 ${gbOrMb(maxMem * 1024 * 1024)}</span></span>
        <div class="slider-row"><input type="range" id="erMemR" min="256" max="${maxMem}" step="256" value="${curMem}" /><input class="input" id="erMem" type="number" min="128" max="${maxMem}" step="128" value="${curMem}" /></div>
        <div class="help">将内存下调到低于当前实际占用时，Docker 可能拒绝修改或触发 OOM。</div>
        <div class="error-text" id="erErr"></div></div>`,
    footer: `<button class="btn" data-close>取消</button><button class="btn btn-primary" id="erSave">保存</button>`,
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
        api(`/api/boxes/${enc(box.id)}/resources`, { method: "PATCH", body: { cpus, memoryMb } }),
      );
      close();
      toast("资源配额已更新", { message: `${box.name}：${cpus} 核 · ${gbOrMb(memoryMb * 1024 * 1024)}` });
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
    b.running ? ib("stop", "stop", "停止") : ib("start", "play", "启动"),
    ib("restart", "restart", "重启"),
    b.running ? ib("terminal", "terminal", "打开终端") : "",
    ib("snapshot", "camera", "创建快照"),
    ib("delete", "trash", "删除", "danger"),
  ].join("");
}
