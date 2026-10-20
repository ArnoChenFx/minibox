import { openCreateBox } from "../components/create-box.js";
import { api } from "../lib/api.js";
import { delegate, esc } from "../lib/dom.js";
import { bytes, cpus, duration, gbOrMb, mem, pct, relTime } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import { sparkline } from "../lib/sparkline.js";
import { onHost } from "../lib/store.js";
import { emptyState, stateBadge } from "../lib/ui.js";

const ACTION_LABEL = {
  "box.create": ["创建 Box", "plus"],
  "box.delete": ["删除 Box", "trash"],
  "box.start": ["启动 Box", "play"],
  "box.stop": ["停止 Box", "stop"],
  "box.restart": ["重启 Box", "restart"],
  "box.resources": ["调整资源", "sliders"],
  "snapshot.create": ["创建快照", "camera"],
  "snapshot.delete": ["删除快照", "trash"],
  "template.promote": ["提升为模板", "upload"],
  "template.build": ["构建基础模板", "hammer"],
  "template.delete": ["删除模板", "trash"],
};

function metricSkeleton() {
  return '<div class="card"><div class="skeleton sk-block"></div></div>';
}

export function render(view) {
  view.innerHTML = `
    <div class="page-head">
      <div><h1>概览</h1><p id="ovSub">宿主机资源与 Box 运行情况，每 3 秒自动刷新。</p></div>
      <div class="page-actions"><button class="btn btn-primary" data-action="create">${icon("plus")}创建 Box</button></div>
    </div>
    <div class="grid grid-4" id="ovMetrics">${metricSkeleton().repeat(4)}</div>
    <div class="grid grid-3" style="margin-top:16px">
      <div class="card" style="grid-column: span 2" id="ovAlloc"><div class="card-body"><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div></div></div>
      <div class="card" id="ovHost"><div class="card-body"><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div></div></div>
    </div>
    <div class="grid grid-2" style="margin-top:16px">
      <div class="card"><div class="card-head"><h3>Box</h3><a class="hint" href="#/boxes">查看全部</a></div><div id="ovBoxes"><div class="card-body"><div class="skeleton sk-line"></div></div></div></div>
      <div class="card"><div class="card-head"><h3>最近操作</h3><span class="hint">本次运行期间</span></div><div id="ovActivity"><div class="card-body"><div class="skeleton sk-line"></div></div></div></div>
    </div>`;

  delegate(view, { create: () => openCreateBox({ onCreated: (b) => (location.hash = `#/boxes/${b.id}`) }) });

  const off = onHost((h, failing) => {
    if (!h) return;
    renderMetrics(view, h, failing);
  });

  const loadLists = async () => {
    try {
      const [{ boxes }, { activity }] = await Promise.all([api("/api/boxes?stats=false"), api("/api/activity")]);
      renderBoxes(view, boxes);
      renderActivity(view, activity);
    } catch {
      /* the host pill already signals connectivity issues */
    }
  };
  loadLists();
  const t = setInterval(loadLists, 10000);
  return () => {
    off();
    clearInterval(t);
  };
}

function renderMetrics(view, h, failing) {
  const memP = (h.memory.used / h.memory.total) * 100;
  const disk = h.disks[0];
  const diskP = disk ? (disk.used / disk.total) * 100 : 0;
  const cpuHist = h.history.map((s) => s.cpu);
  const memHist = h.history.map((s) => s.mem);
  const span = h.history.length > 1 ? Math.round((h.history.at(-1).t - h.history[0].t) / 60000) : 0;
  view.querySelector("#ovSub").textContent = failing
    ? "暂时无法获取最新数据，显示的是上一次结果。"
    : `${h.hostname} · ${h.platform} · 已运行 ${duration(h.uptimeSec)}`;

  view.querySelector("#ovMetrics").innerHTML = `
    <div class="card metric">
      <div class="metric-top"><span>CPU 使用率</span>${icon("cpu")}</div>
      <div class="metric-value">${pct(h.cpu.usagePercent)}<small>${h.cpu.cores} 核</small></div>
      <div class="metric-sub">负载 ${h.cpu.load.map((n) => n.toFixed(2)).join(" / ")} · 近 ${Math.max(span, 1)} 分钟</div>
      ${sparkline(cpuHist, { color: "var(--chart-cpu)", id: "cpu" })}
    </div>
    <div class="card metric">
      <div class="metric-top"><span>内存</span>${icon("memory")}</div>
      <div class="metric-value">${pct(memP)}<small>${bytes(h.memory.used)} / ${bytes(h.memory.total)}</small></div>
      <div class="metric-sub">可用 ${bytes(h.memory.available)}${h.memory.swapTotal ? ` · 交换 ${bytes(h.memory.swapUsed)}` : ""}</div>
      ${sparkline(memHist, { color: "var(--chart-mem)", id: "mem" })}
    </div>
    <div class="card metric">
      <div class="metric-top"><span>磁盘</span>${icon("disk")}</div>
      <div class="metric-value">${pct(diskP)}<small>${disk ? `${bytes(disk.used)} / ${bytes(disk.total)}` : ""}</small></div>
      <div class="stack" style="gap:10px;margin-top:auto">
        ${h.disks
          .map((d) => {
            const p = (d.used / d.total) * 100;
            return `<div><div class="bar-label"><span>${esc(d.label)}</span><span>剩余 ${bytes(d.free)}</span></div><div class="bar ${p > 90 ? "crit" : p > 75 ? "warn" : ""}"><span style="width:${p}%"></span></div></div>`;
          })
          .join("")}
      </div>
    </div>
    <div class="card metric">
      <div class="metric-top"><span>Box</span>${icon("box")}</div>
      <div class="metric-value">${h.boxes.running}<small>运行中 / 共 ${h.boxes.total} 个</small></div>
      <div class="metric-sub">Docker ${h.docker.available ? esc(h.docker.version) : "不可用"} · 容器 ${h.docker.containers.running}/${h.docker.containers.total} · 镜像 ${h.docker.images}</div>
      <div style="margin-top:auto">${h.docker.available ? `<span class="badge badge-success"><span class="dot"></span>Docker 运行正常</span>` : `<span class="badge badge-danger"><span class="dot"></span>Docker 不可用</span>`}</div>
    </div>`;

  const cpuAllocP = (h.boxes.allocatedCpus / h.cpu.cores) * 100;
  const memAllocP = (h.boxes.allocatedMemory / h.memory.total) * 100;
  const over = cpuAllocP > 100 || memAllocP > 100;
  view.querySelector("#ovAlloc").innerHTML = `
    <div class="card-head"><h3>资源分配</h3><span class="hint">运行中 Box 的配额总和与宿主机容量对比</span></div>
    <div class="card-body stack">
      <div><div class="bar-label"><span>CPU 配额</span><span>${+h.boxes.allocatedCpus.toFixed(2)} / ${h.cpu.cores} 核（${pct(cpuAllocP, 0)}）</span></div>
        <div class="bar ${cpuAllocP > 100 ? "crit" : cpuAllocP > 75 ? "warn" : ""}"><span style="width:${Math.min(cpuAllocP, 100)}%"></span></div></div>
      <div><div class="bar-label"><span>内存配额</span><span>${gbOrMb(h.boxes.allocatedMemory)} / ${bytes(h.memory.total)}（${pct(memAllocP, 0)}）</span></div>
        <div class="bar mem ${memAllocP > 100 ? "crit" : memAllocP > 75 ? "warn" : ""}"><span style="width:${Math.min(memAllocP, 100)}%"></span></div></div>
      ${over ? `<div class="callout warn">${icon("alert")}<span>配额总和已超过宿主机容量。Box 之间会争抢资源，必要时请停止部分 Box 或下调配额。</span></div>` : `<div class="callout">${icon("info")}<span>配额是上限而非预留：Box 实际只占用正在使用的资源，超配不会立即出错，但高负载时会互相影响。</span></div>`}
    </div>`;

  view.querySelector("#ovHost").innerHTML = `
    <div class="card-head"><h3>宿主机</h3>${icon("server")}</div>
    <div class="card-body"><dl class="kv">
      <dt>主机名</dt><dd>${esc(h.hostname)}</dd>
      <dt>系统</dt><dd>${esc(h.platform)}</dd>
      <dt>内核</dt><dd class="mono">${esc(h.kernel)} · ${esc(h.arch)}</dd>
      <dt>处理器</dt><dd class="truncate" title="${esc(h.cpu.model)}">${esc(h.cpu.model)}</dd>
      <dt>运行时长</dt><dd>${duration(h.uptimeSec)}</dd>
      <dt>Docker</dt><dd>${h.docker.available ? `${esc(h.docker.version)} <span class="subtle mono">${esc(h.docker.rootDir)}</span>` : "不可用"}</dd>
    </dl></div>`;
}

function renderBoxes(view, boxes) {
  const root = view.querySelector("#ovBoxes");
  if (!boxes.length) {
    root.innerHTML = emptyState({
      iconName: "box",
      title: "还没有 Box",
      text: "创建第一个 Box，为 Agent 准备一个独立的开发环境。",
    });
    return;
  }
  root.innerHTML = `<ul class="activity">${boxes
    .slice(0, 6)
    .map(
      (b) => `<li><span class="ico">${icon("box")}</span><a href="#/boxes/${b.id}"><strong>${esc(b.name)}</strong></a>
      <span class="subtle">${cpus(b.cpus)} · ${mem(b.memory)}</span><span class="time">${stateBadge(b.state)}</span></li>`,
    )
    .join("")}</ul>`;
}

function renderActivity(view, items) {
  const root = view.querySelector("#ovActivity");
  if (!items.length) {
    root.innerHTML = emptyState({
      iconName: "activity",
      title: "暂无操作记录",
      text: "创建、启停、快照等操作会显示在这里。",
    });
    return;
  }
  root.innerHTML = `<ul class="activity">${items
    .slice(0, 6)
    .map((a) => {
      const [label, ic] = ACTION_LABEL[a.action] ?? [a.action, "activity"];
      return `<li title="${esc(a.message ?? "")}"><span class="ico ${a.ok ? "" : "fail"}">${icon(a.ok ? ic : "alert")}</span>
        <span>${esc(label)} <strong>${esc(a.target)}</strong>${a.ok ? "" : ' <span class="badge badge-danger">失败</span>'}</span>
        <span class="time">${relTime(a.t)}</span></li>`;
    })
    .join("")}</ul>`;
}
