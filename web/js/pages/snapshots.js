import { openCreateBox } from "../components/create-box.js";
import { api, enc } from "../lib/api.js";
import { delegate, esc } from "../lib/dom.js";
import { bytes, dateTime, shortId } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import { invalidateTemplates } from "../lib/store.js";
import { confirmDialog, emptyState, nameError, promptDialog, skeletonRows, toast, toastError } from "../lib/ui.js";

export function render(view) {
  let items = [];
  view.innerHTML = `
    <div class="page-head">
      <div><h1>快照</h1><p>快照保存 Box 某一时刻的系统环境，可用来创建新 Box，或提升为可复用的模板。</p></div>
      <div class="page-actions"><button class="btn" data-action="refresh">${icon("refresh")}刷新</button></div>
    </div>
    <div class="callout info" style="margin-bottom:16px">${icon("info")}<span>快照基于 <code>docker commit</code>，只包含容器文件系统，不包含挂载在 /workspace 的数据卷。代码请通过 git 或备份数据卷保存。</span></div>
    <div class="card"><div class="table-wrap"><table class="table">
      <thead><tr><th>快照</th><th class="hide-sm">来源 Box</th><th>大小</th><th class="hide-sm">创建时间</th><th style="text-align:right">操作</th></tr></thead>
      <tbody id="snBody">${skeletonRows(3, 5)}</tbody></table></div></div>`;
  const body = view.querySelector("#snBody");

  const load = async () => {
    try {
      items = (await api("/api/snapshots")).snapshots;
    } catch (e) {
      body.innerHTML = `<tr><td colspan="5">${emptyState({ iconName: "alert", title: "无法加载快照", text: esc(e.message) })}</td></tr>`;
      return;
    }
    if (!items.length) {
      body.innerHTML = `<tr><td colspan="5">${emptyState({
        iconName: "camera",
        title: "还没有快照",
        text: "在 Box 列表或详情页点击「创建快照」，即可保存当前环境。",
        action: `<a class="btn" href="#/boxes">${icon("box")}前往 Box 列表</a>`,
      })}</td></tr>`;
      return;
    }
    body.innerHTML = items
      .map(
        (s) => `<tr>
        <td><div class="name-cell"><span class="avatar">${icon("camera")}</span><div class="truncate"><strong class="mono" style="font-weight:500">${esc(s.ref)}</strong><span class="subtle mono">${esc(shortId(s.id))}</span></div></div></td>
        <td class="hide-sm">${s.source ? esc(s.source) : '<span class="subtle">—</span>'}</td>
        <td class="num">${bytes(s.size)}</td>
        <td class="hide-sm subtle nowrap">${dateTime(s.createdAt)}</td>
        <td><div class="actions">
          <button class="btn btn-sm" data-action="create" data-ref="${esc(s.ref)}">${icon("plus")}创建 Box</button>
          <button class="btn btn-sm" data-action="promote" data-ref="${esc(s.ref)}" data-source="${esc(s.source ?? "")}">${icon("upload")}提升为模板</button>
          <button class="icon-btn danger" data-action="delete" data-ref="${esc(s.ref)}" title="删除快照" aria-label="删除快照">${icon("trash")}</button>
        </div></td></tr>`,
      )
      .join("");
  };

  delegate(view, {
    refresh: load,
    create: (b) => openCreateBox({ snapshot: b.dataset.ref, onCreated: (nb) => (location.hash = `#/boxes/${nb.id}`) }),
    promote: async (b) => {
      const name = await promptDialog({
        title: "提升为模板",
        description: `基于快照 <code>${esc(b.dataset.ref)}</code> 创建一个模板，之后创建 Box 时可直接选择。`,
        iconName: "upload",
        label: "模板名称",
        value: b.dataset.source || "",
        placeholder: "例如 python-ml",
        help: "将生成镜像 minibox-template:&lt;名称&gt;，同名模板会被覆盖。",
        confirmText: "提升为模板",
        validate: (v) => nameError(v, "模板名称"),
      });
      if (!name) return;
      try {
        const r = await api(`/api/snapshots/${enc(b.dataset.ref)}/promote`, { method: "POST", body: { name } });
        invalidateTemplates();
        toast("已提升为模板", { message: r.template.ref });
      } catch (e) {
        toastError("提升失败", e);
      }
    },
    delete: async (b) => {
      const ok = await confirmDialog({
        title: "删除快照",
        message: `确定删除快照 <code>${esc(b.dataset.ref)}</code>？此操作无法撤销，已基于它创建的 Box 不受影响。`,
        confirmText: "删除快照",
        danger: true,
      });
      if (!ok) return;
      try {
        await api(`/api/snapshots/${enc(b.dataset.ref)}`, { method: "DELETE" });
        toast("快照已删除");
        load();
      } catch (e) {
        toastError("删除失败", e);
      }
    },
  });

  load();
  return null;
}
