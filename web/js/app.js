import { api } from "./lib/api.js";
import { $, $$, esc } from "./lib/dom.js";
import { pct } from "./lib/format.js";
import { icon } from "./lib/icons.js";
import { setCrumbs } from "./lib/layout.js";
import { onHost } from "./lib/store.js";
import { applyTheme, currentTheme, toggleTheme } from "./lib/theme.js";
import { confirmDialog } from "./lib/ui.js";
import * as boxDetail from "./pages/box-detail.js";
import * as boxes from "./pages/boxes.js";
import * as overview from "./pages/overview.js";
import * as settings from "./pages/settings.js";
import * as snapshots from "./pages/snapshots.js";
import * as templates from "./pages/templates.js";

const ROUTES = [
  { re: /^\/overview$/, page: overview, nav: "overview", crumbs: ["概览"] },
  { re: /^\/boxes$/, page: boxes, nav: "boxes", crumbs: ["Box"] },
  { re: /^\/boxes\/([^/]+)(?:\/(\w+))?$/, page: boxDetail, nav: "boxes", crumbs: ["Box"] },
  { re: /^\/snapshots$/, page: snapshots, nav: "snapshots", crumbs: ["快照"] },
  { re: /^\/templates$/, page: templates, nav: "templates", crumbs: ["模板"] },
  { re: /^\/settings$/, page: settings, nav: "settings", crumbs: ["设置与关于"] },
];

let cleanup = null;

function route() {
  const path = location.hash.replace(/^#/, "") || "/overview";
  const match = ROUTES.map((r) => ({ r, m: path.match(r.re) })).find((x) => x.m);
  if (!match) {
    location.hash = "#/overview";
    return;
  }
  cleanup?.();
  cleanup = null;
  $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === match.r.nav));
  $("#shell").classList.remove("nav-open");
  setCrumbs(match.r.crumbs);
  // Fresh element per route so page-level event listeners never leak across pages.
  const old = $("#view");
  const view = old.cloneNode(false);
  old.replaceWith(view);
  const params = match.m.slice(1).map((s) => (s ? decodeURIComponent(s) : s));
  cleanup = match.r.page.render(view, ...params) ?? null;
  document.title = `${match.r.crumbs[0]} · MiniBox`;
}

function hydrateIcons(root = document) {
  for (const n of root.querySelectorAll("[data-icon]")) n.outerHTML = icon(n.dataset.icon);
}

function renderThemeBtn() {
  $("#themeBtn").innerHTML = icon(currentTheme() === "dark" ? "sun" : "moon");
}

function init() {
  applyTheme();
  hydrateIcons();
  renderThemeBtn();
  $("#themeBtn").addEventListener("click", toggleTheme);
  document.addEventListener("themechange", renderThemeBtn);
  $("#menuBtn").addEventListener("click", () => $("#shell").classList.toggle("nav-open"));
  $("#logoutBtn").addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "退出登录",
      message: "退出后需要重新输入访问密钥才能继续使用。",
      confirmText: "退出登录",
    });
    if (!ok) return;
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    location.href = "/login";
  });

  onHost((h, failing) => {
    const pill = $("#hostPill");
    if (failing || !h) {
      pill.classList.add("off");
      $("#hostPillText").textContent = "无法获取宿主机状态";
      return;
    }
    pill.classList.toggle("off", !h.docker.available);
    const memP = (h.memory.used / h.memory.total) * 100;
    $("#hostPillText").innerHTML = h.docker.available
      ? `${esc(h.hostname)}<span class="sep"></span>CPU ${pct(h.cpu.usagePercent, 0)}<span class="sep"></span>内存 ${pct(memP, 0)}`
      : "Docker 不可用";
    $("#navBoxCount").textContent = h.boxes.total ? `${h.boxes.running}/${h.boxes.total}` : "";
  });

  api("/api/system")
    .then((s) => {
      $("#sidebarFoot").innerHTML = `MiniBox v${esc(s.version)} · ${esc(s.runtime)}`;
    })
    .catch(() => {});

  window.addEventListener("hashchange", route);
  route();
}

init();
