import { initDropdowns } from "./components/dropdown.js";
import { mountOwnerKeyBanner } from "./components/owner-key-banner.js";
import { mountTasks } from "./components/tasks.js";
import { api } from "./lib/api.js";
import { $, $$, esc } from "./lib/dom.js";
import { pct } from "./lib/format.js";
import { onHosts, refreshHosts, setHostFilter } from "./lib/hosts.js";
import { applyI18n, bindLangButton, t } from "./lib/i18n.js";
import { icon } from "./lib/icons.js";
import { setCrumbs } from "./lib/layout.js";
import { retiredRedirect } from "./lib/retired-routes.js";
import { onHost } from "./lib/store.js";
import { applyTheme, currentTheme, toggleTheme } from "./lib/theme.js";
import { confirmDialog } from "./lib/ui.js";
import * as about from "./pages/about.js";
import * as boxDetail from "./pages/box-detail.js";
import * as boxes from "./pages/boxes.js";
import * as overview from "./pages/overview.js";
import * as settings from "./pages/settings.js";
import * as templates from "./pages/templates.js";
import * as trash from "./pages/trash.js";
import * as volumes from "./pages/volumes.js";

const ROUTES = [
  { re: /^\/overview$/, page: overview, nav: "overview", crumbs: ["nav.overview"] },
  { re: /^\/boxes$/, page: boxes, nav: "boxes", crumbs: ["nav.boxes"] },
  { re: /^\/volumes$/, page: volumes, nav: "volumes", crumbs: ["nav.volumes"] },
  { re: /^\/trash$/, page: trash, nav: "trash", crumbs: ["nav.trash"] },
  { re: /^\/boxes\/([^/]+)(?:\/(\w+))?$/, page: boxDetail, nav: "boxes", crumbs: ["nav.boxes"] },
  { re: /^\/templates(?:\/([^/]+))?$/, page: templates, nav: "templates", crumbs: ["nav.templates"] },
  { re: /^\/settings(?:\/([^/]*))?$/, page: settings, nav: "settings", crumbs: ["nav.settings"] },
  { re: /^\/about$/, page: about, nav: "about", crumbs: ["nav.about"] },
];

let cleanup = null;

function route() {
  const path = location.hash.replace(/^#/, "") || "/overview";
  const retired = retiredRedirect(path);
  if (retired) {
    history.replaceState(null, "", retired);
    route();
    return;
  }
  const match = ROUTES.map((r) => ({ r, m: path.match(r.re) })).find((x) => x.m);
  if (!match) {
    location.hash = "#/overview";
    return;
  }
  cleanup?.();
  cleanup = null;
  $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === match.r.nav));
  $("#shell").classList.remove("nav-open");
  const crumbs = match.r.crumbs.map((k) => t(k));
  setCrumbs(crumbs);
  // Fresh element per route so page-level event listeners never leak across pages.
  const old = $("#view");
  const view = old.cloneNode(false);
  old.replaceWith(view);
  const params = match.m.slice(1).map((s) => (s ? decodeURIComponent(s) : s));
  cleanup = match.r.page.render(view, ...params) ?? null;
  document.title = `${crumbs[0]} · MiniBox`;
}

function hydrateIcons(root = document) {
  for (const n of root.querySelectorAll("[data-icon]")) n.outerHTML = icon(n.dataset.icon);
}

function renderThemeBtn() {
  $("#themeBtn").innerHTML = icon(currentTheme() === "dark" ? "sun" : "moon");
}

function initHostFilter() {
  const select = $("#hostFilter");
  select.addEventListener("change", () => setHostFilter(select.value));
  onHosts((list, current) => {
    select.hidden = list.length < 2;
    select.innerHTML = [`<option value="">${esc(t("shell.allHosts"))}</option>`]
      .concat(list.map((host) => `<option value="${esc(host.id)}">${esc(host.name)}</option>`))
      .join("");
    select.value = current;
  });
  void refreshHosts();
  setInterval(refreshHosts, 15000);
}

function init() {
  applyI18n();
  applyTheme();
  hydrateIcons();
  renderThemeBtn();
  $("#themeBtn").addEventListener("click", toggleTheme);
  document.addEventListener("themechange", renderThemeBtn);
  $("#menuBtn").addEventListener("click", () => $("#shell").classList.toggle("nav-open"));
  $("#logoutBtn").addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: t("shell.logout"),
      message: t("shell.logoutMessage"),
      confirmText: t("shell.logout"),
    });
    if (!ok) return;
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    location.href = "/login";
  });

  onHost((h, failing) => {
    const pill = $("#hostPill");
    if (failing || !h) {
      pill.classList.add("off");
      $("#hostPillText").textContent = t("shell.hostUnavailable");
      return;
    }
    pill.classList.toggle("off", !h.docker.available);
    const memP = (h.memory.used / h.memory.total) * 100;
    $("#hostPillText").innerHTML = h.docker.available
      ? `${esc(h.hostname)}<span class="sep"></span>CPU ${pct(h.cpu.usagePercent, 0)}<span class="sep"></span>${t("shell.memShort")} ${pct(memP, 0)}`
      : t("shell.dockerUnavailable");
    $("#navBoxCount").textContent = h.boxes.total ? `${h.boxes.running}/${h.boxes.total}` : "";
  });

  bindLangButton($("#langBtn"), icon);
  initDropdowns();
  mountTasks();
  mountOwnerKeyBanner($("#ownerKeyBanner"));
  initHostFilter();
  api("/api/system")
    .then((s) => {
      $("#sidebarVersion").textContent = `MiniBox v${s.version}`;
    })
    .catch(() => {});

  window.addEventListener("hashchange", route);
  route();
}

init();
