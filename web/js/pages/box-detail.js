import { deleteBox, editResources, lifecycle, snapshotBox } from "../components/box-actions.js";
import { openCreateBox } from "../components/create-box.js";
import { api, enc } from "../lib/api.js";
import { delegate, esc } from "../lib/dom.js";
import { bytes, cpus, dateTime, gbOrMb, mem, pct, relTime, shortId } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import { setCrumbs } from "../lib/layout.js";
import { sparkline } from "../lib/sparkline.js";
import { emptyState, stateBadge, toastError, usageBar } from "../lib/ui.js";

const TABS = [
  ["overview", "概览", "dashboard"],
  ["terminal", "终端", "terminal"],
  ["logs", "日志", "logs"],
  ["resources", "资源", "sliders"],
  ["snapshots", "快照", "camera"],
];

export function render(view, id, tab = "overview") {
  if (!TABS.some(([k]) => k === tab)) tab = "overview";
  let box = null;
  let disposed = false;
  let tabCleanup = null;
  const history = [];
  view.innerHTML = `<div class="detail-head"><div class="skeleton" style="width:44px;height:44px;border-radius:12px"></div><div style="flex:1"><div class="skeleton sk-line" style="width:200px"></div><div class="skeleton sk-line" style="width:320px"></div></div></div>`;

  const header = () => `
    <div class="detail-head">
      <span class="avatar">${icon("box", "icon-lg")}</span>
      <div><h1>${esc(box.name)} ${stateBadge(box.state)}</h1>
        <div class="meta mono">${esc(shortId(box.id))} · ${esc(box.image)} · ${cpus(box.cpus)} / ${mem(box.memory)}</div></div>
      <div class="page-actions">
        ${box.running ? `<button class="btn" data-action="stop">${icon("stop")}停止</button>` : `<button class="btn btn-primary" data-action="start">${icon("play")}启动</button>`}
        <button class="btn" data-action="restart">${icon("restart")}重启</button>
        <button class="btn" data-action="snapshot">${icon("camera")}创建快照</button>
        <button class="btn" data-action="delete" title="删除 Box">${icon("trash")}删除</button>
      </div>
    </div>
    <div class="tabs" role="tablist">${TABS.map(
      ([k, label, ic]) =>
        `<a class="tab" role="tab" aria-selected="${k === tab}" href="#/boxes/${enc(box.id)}/${k}">${icon(ic)}${label}</a>`,
    ).join("")}</div>
    <div id="tabBody"></div>`;

  const refreshBox = async () => {
    const r = await api(`/api/boxes/${enc(id)}`);
    box = r.box;
    if (box.stats) {
      history.push({
        cpu: box.cpus ? box.stats.cpuPercent / box.cpus : box.stats.cpuPercent,
        mem: box.stats.memPercent,
      });
      if (history.length > 60) history.shift();
    }
    return box;
  };

  const mount = async () => {
    try {
      await refreshBox();
    } catch (e) {
      view.innerHTML = emptyState({
        iconName: "alert",
        title: e.status === 404 ? "找不到该 Box" : "无法加载 Box",
        text: e.status === 404 ? "它可能已被删除。" : esc(e.message),
        action: `<a class="btn" href="#/boxes">${icon("arrowLeft")}返回 Box 列表</a>`,
      });
      return;
    }
    if (disposed) return;
    setCrumbs([{ label: "Box", href: "#/boxes" }, box.name]);
    document.title = `${box.name} · MiniBox`;
    view.innerHTML = header();
    tabCleanup = TAB_RENDER[tab](view.querySelector("#tabBody"), { box: () => box, refreshBox, history, rerender });
  };

  const rerender = async () => {
    tabCleanup?.();
    await mount();
  };

  delegate(view, {
    start: (b) => lifecycle(box, "start", b).then(rerender),
    stop: (b) => lifecycle(box, "stop", b).then(rerender),
    restart: (b) => lifecycle(box, "restart", b).then(rerender),
    snapshot: () => snapshotBox(box).then((s) => s && tab === "snapshots" && rerender()),
    delete: async () => {
      if (await deleteBox(box)) location.hash = "#/boxes";
    },
    resources: () => editResources(box, rerender),
    "from-snapshot": (b) =>
      openCreateBox({ snapshot: b.dataset.ref, onCreated: (nb) => (location.hash = `#/boxes/${nb.id}`) }),
  });

  mount();
  return () => {
    disposed = true;
    tabCleanup?.();
  };
}

const TAB_RENDER = {
  overview(root, { box, refreshBox }) {
    const draw = () => {
      const b = box();
      const s = b.stats;
      root.innerHTML = `
        <div class="grid grid-3">
          <div class="card metric"><div class="metric-top"><span>CPU</span>${icon("cpu")}</div>
            <div class="metric-value">${s ? pct(s.cpuPercent) : "—"}<small>配额 ${cpus(b.cpus)}</small></div>
            <div style="margin-top:auto">${s ? usageBar("相对配额", b.cpus ? s.cpuPercent / b.cpus : s.cpuPercent, b.cpus ? pct(s.cpuPercent / b.cpus, 0) : "") : '<span class="subtle">Box 未运行</span>'}</div></div>
          <div class="card metric"><div class="metric-top"><span>内存</span>${icon("memory")}</div>
            <div class="metric-value">${s ? gbOrMb(s.memUsage) : "—"}<small>配额 ${mem(b.memory)}</small></div>
            <div style="margin-top:auto">${s ? usageBar("相对配额", s.memPercent, pct(s.memPercent, 0), "mem") : '<span class="subtle">Box 未运行</span>'}</div></div>
          <div class="card metric"><div class="metric-top"><span>运行时长</span>${icon("clock")}</div>
            <div class="metric-value" style="font-size:20px">${b.running && b.startedAt ? relTime(b.startedAt).replace("前", "") : "未运行"}</div>
            <div class="metric-sub">${b.startedAt ? `最近启动于 ${dateTime(b.startedAt)}` : "尚未启动"}</div></div>
        </div>
        <div class="card" style="margin-top:16px"><div class="card-head"><h3>基本信息</h3></div><div class="card-body"><dl class="kv">
          <dt>名称</dt><dd>${esc(b.name)}</dd>
          <dt>容器 ID</dt><dd class="mono">${esc(b.id)}</dd>
          <dt>镜像</dt><dd class="mono">${esc(b.image)}</dd>
          <dt>模板</dt><dd class="mono">${esc(b.template || "—")}</dd>
          <dt>工作区</dt><dd><span class="mono">/workspace</span> <span class="subtle">→ 数据卷</span> <span class="mono">${esc(b.volume)}</span></dd>
          <dt>创建时间</dt><dd>${dateTime(b.createdAt)}</dd>
          <dt>命令行接入</dt><dd><code>docker exec -it ${esc(`minibox-${b.name}`)} bash</code></dd>
        </dl></div></div>`;
    };
    draw();
    const t = setInterval(
      () =>
        refreshBox()
          .then(draw)
          .catch(() => {}),
      3000,
    );
    return () => clearInterval(t);
  },

  terminal(root, { box }) {
    const b = box();
    if (!b.running) {
      root.innerHTML = `<div class="card">${emptyState({ iconName: "terminal", title: "Box 未运行", text: "启动 Box 后即可在浏览器中打开终端。", action: `<button class="btn btn-primary" data-action="start">${icon("play")}启动 Box</button>` })}</div>`;
      return null;
    }
    root.innerHTML = `<div class="terminal-frame">
      <div class="terminal-bar"><span class="lights"><i></i><i></i><i></i></span><span class="mono">root@${esc(b.name)}: /workspace</span>
        <span class="status" id="tStatus"><span class="dot"></span><span id="tStatusText">正在连接…</span></span>
        <button class="btn btn-ghost btn-sm" id="tReconnect" style="color:#a1a1aa">${icon("refresh")}重新连接</button></div>
      <div class="terminal" id="term"></div></div>
      <p class="help" style="margin-top:8px">会话使用 bash 登录 Shell；离开此页面即断开，后台进程请使用 nohup 或 tmux 保持。</p>`;
    if (!window.Terminal) {
      root.querySelector("#term").innerHTML =
        '<div class="callout danger">终端组件加载失败，请检查能否访问 cdn.jsdelivr.net。</div>';
      return null;
    }
    let ws;
    const xterm = new window.Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
      theme: { background: "#0b0b0e", foreground: "#e4e4e7", cursor: "#a5a2ff", selectionBackground: "#3f3f7a" },
      scrollback: 5000,
    });
    const fit = new window.FitAddon.FitAddon();
    xterm.loadAddon(fit);
    xterm.open(root.querySelector("#term"));
    fit.fit();
    const setStatus = (on, text) => {
      root.querySelector("#tStatus").classList.toggle("on", on);
      root.querySelector("#tStatusText").textContent = text;
    };
    const connect = () => {
      ws?.close();
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}/api/boxes/${enc(b.id)}/terminal`);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        setStatus(true, "已连接");
        ws.send(JSON.stringify({ type: "resize", cols: xterm.cols, rows: xterm.rows }));
        xterm.focus();
      };
      ws.onmessage = (ev) => xterm.write(typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data));
      ws.onclose = () => setStatus(false, "已断开");
    };
    const dataSub = xterm.onData((d) => ws?.readyState === 1 && ws.send(d));
    const resizeSub = xterm.onResize(
      ({ cols, rows }) => ws?.readyState === 1 && ws.send(JSON.stringify({ type: "resize", cols, rows })),
    );
    const onWin = () => fit.fit();
    window.addEventListener("resize", onWin);
    root.querySelector("#tReconnect").addEventListener("click", () => {
      xterm.reset();
      connect();
    });
    connect();
    return () => {
      window.removeEventListener("resize", onWin);
      dataSub.dispose();
      resizeSub.dispose();
      ws?.close();
      xterm.dispose();
    };
  },

  logs(root, { box }) {
    root.innerHTML = `<div class="card"><div class="card-head"><h3>容器日志</h3>
      <div class="row"><select class="select" id="lTail" style="width:auto;height:30px"><option value="200">最近 200 行</option><option value="1000">最近 1000 行</option><option value="5000">最近 5000 行</option></select>
      <label class="checkbox" style="align-items:center"><input type="checkbox" id="lAuto" style="accent-color:var(--accent);margin:0" checked />自动刷新</label>
      <button class="btn btn-sm" id="lRefresh">${icon("refresh")}刷新</button></div></div>
      <pre class="logs" id="lView">正在加载…</pre></div>
      <p class="help" style="margin-top:8px">显示容器主进程的标准输出与标准错误。终端中执行的命令输出不会出现在这里。</p>`;
    const view = root.querySelector("#lView");
    const load = async () => {
      try {
        const { logs } = await api(`/api/boxes/${enc(box().id)}/logs?tail=${root.querySelector("#lTail").value}`);
        const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
        view.textContent = logs || "暂无日志输出。";
        if (atBottom) view.scrollTop = view.scrollHeight;
      } catch (e) {
        view.textContent = `加载日志失败：${e.message}`;
      }
    };
    root.querySelector("#lRefresh").addEventListener("click", load);
    root.querySelector("#lTail").addEventListener("change", load);
    load().then(() => (view.scrollTop = view.scrollHeight));
    const t = setInterval(() => root.querySelector("#lAuto").checked && load(), 4000);
    return () => clearInterval(t);
  },

  resources(root, { box, refreshBox, history }) {
    const draw = () => {
      const b = box();
      const s = b.stats;
      root.innerHTML = `<div class="grid grid-2">
        <div class="card"><div class="card-head"><h3>资源配额</h3><button class="btn btn-sm" data-action="resources">${icon("sliders")}调整配额</button></div>
          <div class="card-body"><dl class="kv">
            <dt>CPU 上限</dt><dd>${cpus(b.cpus)}</dd>
            <dt>内存上限</dt><dd>${mem(b.memory)}</dd>
            <dt>交换空间</dt><dd>禁用（与内存上限相同）</dd>
            <dt>重启策略</dt><dd>除非手动停止，否则自动重启</dd>
          </dl><div class="callout" style="margin-top:16px">${icon("info")}<span>配额通过 <code>docker update</code> 热更新，运行中的 Box 无需重启即可生效。</span></div></div></div>
        <div class="card"><div class="card-head"><h3>实时用量</h3><span class="hint">相对配额，每 3 秒采样</span></div>
          <div class="card-body stack">${
            s
              ? `<div><div class="bar-label"><span>CPU ${pct(s.cpuPercent)}</span><span>${b.cpus ? `${pct(s.cpuPercent / b.cpus, 0)} / 配额` : ""}</span></div>${sparkline(
                  history.map((h) => h.cpu),
                  { color: "var(--chart-cpu)", id: "bcpu", height: 56 },
                )}</div>
                 <div><div class="bar-label"><span>内存 ${gbOrMb(s.memUsage)}</span><span>${pct(s.memPercent, 0)} / ${bytes(s.memLimit)}</span></div>${sparkline(
                   history.map((h) => h.mem),
                   { color: "var(--chart-mem)", id: "bmem", height: 56 },
                 )}</div>`
              : emptyState({ iconName: "activity", title: "暂无实时数据", text: "Box 未运行。" })
          }</div></div></div>`;
      root.querySelectorAll(".spark").forEach((sv) => (sv.style.height = "56px"));
    };
    draw();
    const t = setInterval(
      () =>
        refreshBox()
          .then(draw)
          .catch(() => {}),
      3000,
    );
    return () => clearInterval(t);
  },

  snapshots(root, { box }) {
    root.innerHTML =
      '<div class="card"><div class="card-body"><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div></div></div>';
    api("/api/snapshots")
      .then(({ snapshots }) => {
        const list = snapshots.filter((s) => s.source === box().name);
        root.innerHTML = `<div class="card"><div class="card-head"><h3>此 Box 的快照</h3><button class="btn btn-sm btn-primary" data-action="snapshot">${icon("camera")}创建快照</button></div>
        ${
          list.length
            ? `<div class="table-wrap"><table class="table"><thead><tr><th>快照</th><th>大小</th><th>创建时间</th><th style="text-align:right">操作</th></tr></thead><tbody>${list
                .map(
                  (
                    s,
                  ) => `<tr><td><span class="mono">${esc(s.ref)}</span></td><td class="num">${bytes(s.size)}</td><td class="subtle">${dateTime(s.createdAt)}</td>
                  <td><div class="actions"><button class="btn btn-sm" data-action="from-snapshot" data-ref="${esc(s.ref)}">${icon("plus")}从此创建 Box</button></div></td></tr>`,
                )
                .join("")}</tbody></table></div>`
            : emptyState({
                iconName: "camera",
                title: "还没有快照",
                text: "快照会保存 Box 当前的系统环境（已安装的软件和配置），可用于快速复制环境。",
              })
        }</div>`;
      })
      .catch((e) => {
        root.innerHTML = emptyState({ iconName: "alert", title: "无法加载快照", text: esc(e.message) });
        toastError("加载快照失败", e);
      });
    return null;
  },
};
