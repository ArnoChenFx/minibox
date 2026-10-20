import { actionButtons, deleteBox, lifecycle, snapshotBox } from "../components/box-actions.js";
import { openCreateBox } from "../components/create-box.js";
import { api } from "../lib/api.js";
import { delegate, esc } from "../lib/dom.js";
import { cpus, gbOrMb, mem, pct, relTime } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import { emptyState, skeletonRows, stateBadge, toastError, usageBar } from "../lib/ui.js";

export function render(view) {
  let boxes = [];
  let filter = "";
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Box</h1><p>每个 Box 是一个独立的开发环境，可供 Agent 通过终端或 API 使用。</p></div>
      <div class="page-actions">
        <div class="input-group hide-sm" style="width:220px">${icon("search")}<input class="input" id="bxSearch" placeholder="搜索名称或模板" /></div>
        <button class="btn" data-action="refresh" title="刷新">${icon("refresh")}刷新</button>
        <button class="btn btn-primary" data-action="create">${icon("plus")}创建 Box</button>
      </div>
    </div>
    <div class="card"><div class="table-wrap"><table class="table">
      <thead><tr><th>名称</th><th>状态</th><th class="hide-sm">模板</th><th class="hide-sm">配额</th><th>CPU</th><th>内存</th><th class="hide-sm">创建时间</th><th style="text-align:right">操作</th></tr></thead>
      <tbody id="bxBody">${skeletonRows(3, 8)}</tbody>
    </table></div></div>`;

  const body = view.querySelector("#bxBody");
  const find = (id) => boxes.find((b) => b.id === id);

  const draw = () => {
    const list = boxes.filter(
      (b) => !filter || b.name.toLowerCase().includes(filter) || b.template.toLowerCase().includes(filter),
    );
    if (!boxes.length) {
      body.innerHTML = `<tr><td colspan="8">${emptyState({
        iconName: "box",
        title: "还没有 Box",
        text: "Box 是一个带独立工作区的容器。选择模板和规格即可在几秒内创建。",
        action: `<button class="btn btn-primary" data-action="create">${icon("plus")}创建第一个 Box</button>`,
      })}</td></tr>`;
      return;
    }
    if (!list.length) {
      body.innerHTML = `<tr><td colspan="8">${emptyState({ iconName: "search", title: "没有匹配的 Box", text: `没有名称或模板包含「${esc(filter)}」的 Box。` })}</td></tr>`;
      return;
    }
    body.innerHTML = list
      .map((b) => {
        const s = b.stats;
        const cpuP = s && b.cpus ? s.cpuPercent / b.cpus : s?.cpuPercent;
        return `<tr class="clickable" data-action="open" data-id="${esc(b.id)}">
          <td><div class="name-cell"><span class="avatar">${icon("box")}</span><div class="truncate"><strong>${esc(b.name)}</strong><span class="subtle mono">${esc(b.id.slice(0, 12))}</span></div></div></td>
          <td>${stateBadge(b.state)}</td>
          <td class="hide-sm"><span class="tag truncate" title="${esc(b.template)}">${esc(b.template.replace(/^minibox-template:/, "") || "—")}</span></td>
          <td class="hide-sm num nowrap">${cpus(b.cpus)} · ${mem(b.memory)}</td>
          <td>${s ? usageBar("", cpuP, pct(s.cpuPercent)) : '<span class="subtle">—</span>'}</td>
          <td>${s ? usageBar("", s.memPercent, gbOrMb(s.memUsage), "mem") : '<span class="subtle">—</span>'}</td>
          <td class="hide-sm subtle nowrap" title="${esc(b.createdAt)}">${relTime(b.createdAt)}</td>
          <td><div class="actions">${actionButtons(b)}</div></td>
        </tr>`;
      })
      .join("");
  };

  const load = async () => {
    try {
      boxes = (await api("/api/boxes")).boxes;
      draw();
    } catch (e) {
      body.innerHTML = `<tr><td colspan="8">${emptyState({ iconName: "alert", title: "无法加载 Box 列表", text: esc(e.message) })}</td></tr>`;
    }
  };

  view.querySelector("#bxSearch").addEventListener("input", (e) => {
    filter = e.target.value.trim().toLowerCase();
    draw();
  });

  delegate(view, {
    refresh: (btn) => {
      btn.disabled = true;
      load().finally(() => (btn.disabled = false));
    },
    create: () => openCreateBox({ onCreated: load }),
    open: (el) => (location.hash = `#/boxes/${el.dataset.id}`),
    start: (el) => lifecycle(find(el.dataset.id), "start", el).then(load),
    stop: (el) => lifecycle(find(el.dataset.id), "stop", el).then(load),
    restart: (el) => lifecycle(find(el.dataset.id), "restart", el).then(load),
    terminal: (el) => (location.hash = `#/boxes/${el.dataset.id}/terminal`),
    snapshot: (el) => snapshotBox(find(el.dataset.id)),
    delete: (el) => deleteBox(find(el.dataset.id)).then((ok) => ok && load()),
  });

  load().catch((e) => toastError("加载失败", e));
  const t = setInterval(load, 5000);
  return () => clearInterval(t);
}
