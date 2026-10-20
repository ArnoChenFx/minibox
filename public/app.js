const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      "content-type": "application/json",
      ...(opts.headers || {}),
    },
    credentials: "same-origin",
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data?.error || res.statusText || "请求失败");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function fmtBytes(n) {
  if (n == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function fmtCpus(c) { return c == null ? "不限" : `${c} CPU`; }
function fmtMem(m) { return m == null ? "不限" : fmtBytes(m); }

function showLogin() {
  $("#loginView").classList.remove("hidden");
  $("#appView").classList.add("hidden");
}
function showApp() {
  $("#loginView").classList.add("hidden");
  $("#appView").classList.remove("hidden");
}

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#loginError").textContent = "";
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify({ key: $("#loginKey").value }) });
    showApp();
    await refreshAll();
  } catch (err) {
    $("#loginError").textContent = err.message || "登录失败";
  }
});

$("#btnLogout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  showLogin();
});

$("#btnRefresh").addEventListener("click", () => refreshAll());

$$(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    ["boxes", "snapshots", "templates"].forEach((t) => {
      $(`#tab-${t}`).classList.toggle("hidden", t !== btn.dataset.tab);
    });
  });
});

async function refreshAll() {
  await Promise.all([loadBoxes(), loadSnapshots(), loadTemplates()]);
}

function stateBadge(state) {
  return `<span class="badge ${state || ""}">${state || "unknown"}</span>`;
}

async function loadBoxes() {
  const { boxes } = await api("/api/boxes");
  $("#boxCount").textContent = `共 ${boxes.length} 个`;
  const root = $("#boxList");
  if (!boxes.length) {
    root.innerHTML = `<div class="empty">还没有 Box。点「创建 Box」开始。</div>`;
    return;
  }
  root.innerHTML = boxes.map((b) => {
    const stats = b.stats
      ? `<div class="grid-stats">
           <div class="stat">CPU ${b.stats.cpuPercent}%</div>
           <div class="stat">内存 ${fmtBytes(b.stats.memUsage)} / ${fmtBytes(b.stats.memLimit)} (${b.stats.memPercent}%)</div>
         </div>`
      : `<div class="muted" style="margin-top:6px">无实时统计（未运行）</div>`;
    return `<div class="card" data-id="${b.id}">
      <div class="card-row">
        <div>
          <h3>${escapeHtml(b.name)} ${stateBadge(b.state)}</h3>
          <div class="muted mono">${escapeHtml(b.image)} · ${fmtCpus(b.cpus)} · ${fmtMem(b.memory)}</div>
          <div class="muted">模板 ${escapeHtml(b.template || "—")} · 创建于 ${escapeHtml(b.created)}</div>
          ${stats}
        </div>
        <div class="actions">
          ${b.state === "running"
            ? `<button class="btn small" data-act="stop">停止</button>
               <button class="btn small" data-act="restart">重启</button>
               <button class="btn small" data-act="term">终端</button>
               <button class="btn small" data-act="logs">日志</button>`
            : `<button class="btn small primary" data-act="start">启动</button>
               <button class="btn small" data-act="logs">日志</button>`}
          <button class="btn small" data-act="snap">快照</button>
          <button class="btn small" data-act="res">资源</button>
          <button class="btn small danger" data-act="del">删除</button>
        </div>
      </div>
    </div>`;
  }).join("");

  root.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => onBoxAction(btn.closest(".card").dataset.id, btn.dataset.act, btn.closest(".card")));
  });
}

async function onBoxAction(id, act) {
  try {
    if (act === "start") await api(`/api/boxes/${id}/start`, { method: "POST" });
    else if (act === "stop") await api(`/api/boxes/${id}/stop`, { method: "POST" });
    else if (act === "restart") await api(`/api/boxes/${id}/restart`, { method: "POST" });
    else if (act === "del") {
      const delVol = confirm("同时删除工作区卷？\n确定=删卷；取消=只删容器");
      // confirm returns true/false — ask more clearly
      const really = confirm("确认删除此 Box？");
      if (!really) return;
      const alsoVol = confirm("是否一并删除挂载的 /workspace 数据卷？");
      await api(`/api/boxes/${id}?deleteVolume=${alsoVol ? "true" : "false"}`, { method: "DELETE" });
    } else if (act === "snap") {
      const name = prompt("快照名称（可空，默认 box名-时间戳）", "");
      if (name === null) return;
      const r = await api(`/api/boxes/${id}/snapshot`, { method: "POST", body: JSON.stringify({ name: name || undefined }) });
      alert(`快照已创建: ${(r.tag || r.id)}`);
      await loadSnapshots();
    } else if (act === "res") {
      openResourceModal(id);
      return;
    } else if (act === "logs") {
      openLogsModal(id);
      return;
    } else if (act === "term") {
      openTermModal(id);
      return;
    }
    await loadBoxes();
  } catch (e) {
    alert(e.message);
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function openModal(title, bodyHtml, onMount) {
  const root = $("#modalRoot");
  root.innerHTML = `<div class="modal-backdrop"><div class="modal">
    <h2>${title}</h2>
    <div class="modal-body">${bodyHtml}</div>
  </div></div>`;
  const backdrop = root.querySelector(".modal-backdrop");
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeModal(); });
  if (onMount) onMount(root.querySelector(".modal"));
}
function closeModal() {
  const term = window.__term;
  if (term) {
    try { term.ws?.close(); term.xterm?.dispose(); } catch {}
    window.__term = null;
  }
  $("#modalRoot").innerHTML = "";
}

$("#btnCreate").addEventListener("click", async () => {
  let templates = [];
  try {
    const t = await api("/api/templates");
    templates = t.templates || [];
  } catch {}
  const opts = templates.length
    ? templates.map((t) => {
        const tag = (t.tags && t.tags[0]) || t.id;
        const name = t.labels?.["minibox.template.name"] || tag;
        return `<option value="${escapeHtml(tag)}">${escapeHtml(name)} (${escapeHtml(tag)})</option>`;
      }).join("")
    : `<option value="minibox-template:base">minibox-template:base（请先构建）</option>`;

  openModal("创建 Box", `
    <div class="form-grid">
      <label>名称<input id="fName" required placeholder="dev-1" /></label>
      <label>模板<select id="fTpl">${opts}</select></label>
      <label>CPU<input id="fCpu" type="number" min="0.1" step="0.1" value="1" /></label>
      <label>内存 MB<input id="fMem" type="number" min="128" step="128" value="1024" /></label>
    </div>
    <div class="modal-actions">
      <button class="btn" id="fCancel">取消</button>
      <button class="btn primary" id="fOk">创建并启动</button>
    </div>
  `, (modal) => {
    $("#fCancel", modal).onclick = closeModal;
    $("#fOk", modal).onclick = async () => {
      try {
        await api("/api/boxes", {
          method: "POST",
          body: JSON.stringify({
            name: $("#fName", modal).value.trim(),
            template: $("#fTpl", modal).value,
            cpus: Number($("#fCpu", modal).value),
            memoryMb: Number($("#fMem", modal).value),
          }),
        });
        closeModal();
        await loadBoxes();
      } catch (e) { alert(e.message); }
    };
  });
});

async function openResourceModal(id) {
  const { box } = await api(`/api/boxes/${id}`);
  openModal(`调整资源 · ${escapeHtml(box.name)}`, `
    <div class="form-grid">
      <label>CPU<input id="fCpu" type="number" min="0.1" step="0.1" value="${box.cpus ?? 1}" /></label>
      <label>内存 MB<input id="fMem" type="number" min="128" step="128" value="${box.memory ? Math.round(box.memory/1024/1024) : 1024}" /></label>
    </div>
    <p class="muted">运行中可热更新（docker update）。</p>
    <div class="modal-actions">
      <button class="btn" id="fCancel">取消</button>
      <button class="btn primary" id="fOk">保存</button>
    </div>
  `, (modal) => {
    $("#fCancel", modal).onclick = closeModal;
    $("#fOk", modal).onclick = async () => {
      try {
        await api(`/api/boxes/${id}/resources`, {
          method: "PATCH",
          body: JSON.stringify({
            cpus: Number($("#fCpu", modal).value),
            memoryMb: Number($("#fMem", modal).value),
          }),
        });
        closeModal();
        await loadBoxes();
      } catch (e) { alert(e.message); }
    };
  });
}

async function openLogsModal(id) {
  openModal("容器日志", `<pre class="logs" id="logView">加载中…</pre>
    <div class="modal-actions"><button class="btn" id="fClose">关闭</button></div>`, async (modal) => {
    $("#fClose", modal).onclick = closeModal;
    try {
      const { logs } = await api(`/api/boxes/${id}/logs?tail=300`);
      $("#logView", modal).textContent = logs || "(空)";
    } catch (e) {
      $("#logView", modal).textContent = e.message;
    }
  });
}

function openTermModal(id) {
  openModal("网页终端", `
    <div id="term"></div>
    <p class="muted">bash -l · 关闭窗口即断开</p>
    <div class="modal-actions"><button class="btn" id="fClose">关闭</button></div>
  `, (modal) => {
    $("#fClose", modal).onclick = closeModal;
    const termEl = $("#term", modal);
    const xterm = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      theme: { background: "#0a0e14" },
    });
    const fit = new FitAddon.FitAddon();
    xterm.loadAddon(fit);
    xterm.open(termEl);
    fit.fit();

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/api/boxes/${id}/term`);
    ws.binaryType = "arraybuffer";
    window.__term = { ws, xterm };

    ws.onopen = () => {
      xterm.focus();
      ws.send(JSON.stringify({ type: "resize", cols: xterm.cols, rows: xterm.rows }));
    };
    ws.onmessage = (ev) => {
      const data = typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data);
      xterm.write(data);
    };
    ws.onclose = () => xterm.writeln("\r\n[连接已关闭]");
    ws.onerror = () => xterm.writeln("\r\n[连接错误]");
    xterm.onData((data) => { if (ws.readyState === 1) ws.send(data); });
    xterm.onResize(({ cols, rows }) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "resize", cols, rows }));
    });
    window.addEventListener("resize", () => fit.fit(), { once: false });
  });
}

async function loadSnapshots() {
  const { snapshots } = await api("/api/snapshots");
  const root = $("#snapList");
  if (!snapshots.length) {
    root.innerHTML = `<div class="empty">暂无快照</div>`;
    return;
  }
  root.innerHTML = snapshots.map((s) => {
    const tag = (s.tags && s.tags[0]) || s.id;
    const of = s.labels?.["minibox.snapshot.of"] || "—";
    return `<div class="card">
      <div class="card-row">
        <div>
          <h3 class="mono">${escapeHtml(tag)}</h3>
          <div class="muted">来源 box: ${escapeHtml(of)} · ${fmtBytes(s.size)} · ${new Date(s.created * 1000).toLocaleString()}</div>
        </div>
        <div class="actions">
          <button class="btn small primary" data-tag="${escapeHtml(tag)}" data-act="from">从此创建 Box</button>
          <button class="btn small" data-tag="${escapeHtml(tag)}" data-act="promote">提升为模板</button>
          <button class="btn small danger" data-tag="${escapeHtml(tag)}" data-act="del">删除</button>
        </div>
      </div>
    </div>`;
  }).join("");
  root.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const tag = btn.dataset.tag;
      try {
        if (btn.dataset.act === "del") {
          if (!confirm(`删除快照 ${tag}？`)) return;
          await api(`/api/snapshots/${encodeURIComponent(tag)}`, { method: "DELETE" });
        } else if (btn.dataset.act === "promote") {
          const name = prompt("模板名称", "custom");
          if (!name) return;
          await api(`/api/snapshots/${encodeURIComponent(tag)}/promote`, {
            method: "POST", body: JSON.stringify({ name }),
          });
          await loadTemplates();
          alert("已提升为模板");
        } else if (btn.dataset.act === "from") {
          const name = prompt("新 Box 名称");
          if (!name) return;
          await api(`/api/snapshots/${encodeURIComponent(tag)}/create-box`, {
            method: "POST",
            body: JSON.stringify({ name, cpus: 1, memoryMb: 1024 }),
          });
          await loadBoxes();
          alert("已创建");
        }
        await loadSnapshots();
      } catch (e) { alert(e.message); }
    });
  });
}

async function loadTemplates() {
  const { templates, baseTag } = await api("/api/templates");
  const root = $("#tplList");
  if (!templates.length) {
    root.innerHTML = `<div class="empty">暂无模板。请构建 ${escapeHtml(baseTag)}。</div>`;
    return;
  }
  root.innerHTML = templates.map((t) => {
    const tag = (t.tags && t.tags[0]) || t.id;
    const name = t.labels?.["minibox.template.name"] || "—";
    const desc = t.labels?.["minibox.template.description"] || "";
    return `<div class="card">
      <div class="card-row">
        <div>
          <h3>${escapeHtml(name)} <span class="badge">模板</span></h3>
          <div class="muted mono">${escapeHtml(tag)}</div>
          <div class="muted">${escapeHtml(desc)} · ${fmtBytes(t.size)}</div>
        </div>
      </div>
    </div>`;
  }).join("");
}

$("#btnBuildTemplate").addEventListener("click", async () => {
  const btn = $("#btnBuildTemplate");
  btn.disabled = true;
  btn.textContent = "构建中（首次较慢）…";
  try {
    const r = await api("/api/templates/build", { method: "POST" });
    alert(`构建完成: ${r.tag}`);
    await loadTemplates();
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "构建基础模板 base";
  }
});

(async function boot() {
  try {
    await api("/api/me");
    showApp();
    await refreshAll();
    setInterval(() => {
      if (!$("#appView").classList.contains("hidden")) loadBoxes().catch(() => {});
    }, 8000);
  } catch {
    showLogin();
  }
})();
