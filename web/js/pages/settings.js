import { api } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { dateTime } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import { currentTheme, toggleTheme } from "../lib/theme.js";

export function render(view) {
  view.innerHTML = `
    <div class="page-head"><div><h1>设置与关于</h1><p>运行配置为只读，修改请编辑项目根目录的 <code>.env</code> 后重启服务。</p></div></div>
    <div class="grid grid-2" id="stGrid"><div class="card"><div class="card-body"><div class="skeleton sk-line"></div></div></div></div>`;
  api("/api/system").then((s) => {
    view.querySelector("#stGrid").innerHTML = `
      <div class="stack">
        <div class="card"><div class="card-head"><h3>运行配置</h3>${icon("settings")}</div><div class="card-body"><dl class="kv">
          <dt>监听地址</dt><dd class="mono">${esc(s.config.host)}:${s.config.port}</dd>
          <dt>Docker Socket</dt><dd class="mono">${esc(s.config.dockerSocket)}</dd>
          <dt>标签前缀</dt><dd class="mono">${esc(s.config.labelPrefix)}</dd>
          <dt>基础模板</dt><dd class="mono">${esc(s.config.baseTemplate)}</dd>
          <dt>采样间隔</dt><dd>${s.config.metricsIntervalMs / 1000} 秒</dd>
          <dt>单 Box 上限</dt><dd>CPU ${s.limits.minCpus}–${s.limits.maxCpus} 核 · 内存 ${s.limits.minMemoryMb}–${s.limits.maxMemoryMb} MB</dd>
        </dl></div></div>
        <div class="card"><div class="card-head"><h3>外观</h3></div><div class="card-body row between">
          <div><strong>主题</strong><div class="help">默认跟随系统，手动切换后会记住你的选择。</div></div>
          <button class="btn" id="stTheme">${icon(currentTheme() === "dark" ? "sun" : "moon")}切换为${currentTheme() === "dark" ? "浅色" : "深色"}</button>
        </div></div>
      </div>
      <div class="stack">
        <div class="card"><div class="card-body" style="text-align:center;padding:32px 24px">
          <img data-logo src="/assets/${currentTheme() === "dark" ? "logo-dark" : "logo"}.svg" alt="MiniBox" style="height:40px" />
          <p class="muted" style="margin-top:12px">为 AI Agent 准备的个人开发环境</p>
          <p class="subtle" style="margin-top:6px;font-size:12.5px">版本 ${esc(s.version)} · ${esc(s.runtime)} · 启动于 ${dateTime(s.startedAt)}</p>
          <div class="row" style="justify-content:center;margin-top:16px"><a class="btn btn-sm" href="https://github.com/ArnoChenFx/minibox" target="_blank" rel="noopener">${icon("github")}GitHub</a></div>
        </div></div>
        <div class="card"><div class="card-head"><h3>安全须知</h3>${icon("shield")}</div><div class="card-body stack" style="gap:10px;font-size:13px">
          <div class="callout warn">${icon("alert")}<span>MiniBox 可通过 Docker Socket 控制宿主机，访问密钥等同于宿主机 root 权限，请妥善保管。</span></div>
          <p class="muted">· 服务默认只监听 127.0.0.1，对外访问请通过隧道或反向代理，并始终使用 HTTPS。</p>
          <p class="muted">· 需要更换密钥时，修改 <code>.env</code> 中的 <code>ACCESS_KEY</code> 并重启服务，所有会话会立即失效。</p>
          <p class="muted">· Box 基于容器隔离，适合个人使用，不适合运行不可信的第三方代码。</p>
        </div></div>
      </div>`;
    view.querySelector("#stTheme").addEventListener("click", () => {
      toggleTheme();
      render(view);
    });
  });
  return null;
}
