import { openCreateBox } from "../components/create-box.js";
import { api, enc } from "../lib/api.js";
import { delegate, esc } from "../lib/dom.js";
import { bytes, dateTime } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import { invalidateTemplates } from "../lib/store.js";
import { confirmDialog, emptyState, toast, toastError, withBusy } from "../lib/ui.js";

export function render(view) {
  let base = "";
  view.innerHTML = `
    <div class="page-head">
      <div><h1>模板</h1><p>模板是创建 Box 时使用的基础镜像。可以构建内置的基础模板，或将快照提升为自定义模板。</p></div>
      <div class="page-actions"><button class="btn" data-action="build">${icon("hammer")}构建基础模板</button></div>
    </div>
    <div class="grid grid-3" id="tpGrid">${'<div class="card"><div class="skeleton sk-block"></div></div>'.repeat(3)}</div>`;
  const grid = view.querySelector("#tpGrid");

  const load = async () => {
    let templates;
    try {
      const r = await api("/api/templates");
      templates = r.templates;
      base = r.baseTemplate;
    } catch (e) {
      grid.innerHTML = `<div class="card" style="grid-column:1/-1">${emptyState({ iconName: "alert", title: "无法加载模板", text: esc(e.message) })}</div>`;
      return;
    }
    if (!templates.length) {
      grid.innerHTML = `<div class="card" style="grid-column:1/-1">${emptyState({
        iconName: "layers",
        title: "还没有模板",
        text: "构建内置的基础模板（Debian 12 · Node.js 24 · Python 3 · git），首次构建约需 1–3 分钟。",
        action: `<button class="btn btn-primary" data-action="build">${icon("hammer")}构建基础模板</button>`,
      })}</div>`;
      return;
    }
    grid.innerHTML = templates
      .map(
        (t) => `<div class="card" style="display:flex;flex-direction:column">
        <div class="card-body" style="flex:1">
          <div class="row between" style="margin-bottom:12px"><span class="avatar" style="width:36px;height:36px;border-radius:10px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent-text)">${icon("layers")}</span>
          ${t.ref === base ? '<span class="badge badge-accent">内置</span>' : '<span class="badge">自定义</span>'}</div>
          <h3 style="font-size:15px">${esc(t.name)}</h3>
          <p class="muted" style="font-size:13px;margin-top:4px;min-height:40px">${esc(t.description ?? "无描述")}</p>
          <dl class="kv" style="margin-top:14px;font-size:12.5px"><dt>镜像</dt><dd class="mono">${esc(t.ref)}</dd><dt>大小</dt><dd>${bytes(t.size)}</dd><dt>创建时间</dt><dd>${dateTime(t.createdAt)}</dd></dl>
        </div>
        <div class="dialog-foot" style="justify-content:space-between;background:transparent">
          <button class="icon-btn danger" data-action="delete" data-ref="${esc(t.ref)}" title="删除模板" aria-label="删除模板">${icon("trash")}</button>
          <button class="btn btn-sm btn-primary" data-action="use" data-ref="${esc(t.ref)}">${icon("plus")}用此模板创建</button>
        </div></div>`,
      )
      .join("");
  };

  delegate(view, {
    use: (b) => openCreateBox({ template: b.dataset.ref, onCreated: (b) => (location.hash = `#/boxes/${b.id}`) }),
    build: async (btn) => {
      toast("开始构建基础模板", { type: "info", message: "首次构建需要下载镜像，约 1–3 分钟。" });
      try {
        const r = await withBusy(btn, () => api("/api/templates/base/build", { method: "POST" }));
        invalidateTemplates();
        toast("基础模板构建完成", { message: r.ref });
        load();
      } catch (e) {
        toastError("构建失败", e);
      }
    },
    delete: async (b) => {
      const isBase = b.dataset.ref === base;
      const ok = await confirmDialog({
        title: "删除模板",
        message: `确定删除模板 <code>${esc(b.dataset.ref)}</code>？${isBase ? "删除后可在本页重新构建。" : "此操作无法撤销。"}已基于它创建的 Box 不受影响。`,
        confirmText: "删除模板",
        danger: true,
      });
      if (!ok) return;
      try {
        await api(`/api/templates/${enc(b.dataset.ref)}`, { method: "DELETE" });
        invalidateTemplates();
        toast("模板已删除");
        load();
      } catch (e) {
        toastError("删除失败", e);
      }
    },
  });

  load();
  return null;
}
