import { initDropdowns } from "./components/dropdown.js";
import { mountOwnerKeyBanner } from "./components/owner-key-banner.js";
import { mountTasks } from "./components/tasks.js";
import { api } from "./lib/api.js";
import { $, $$, esc } from "./lib/dom.js";
import { pct } from "./lib/format.js";
import { hostFilterShown } from "./lib/host-list.js";
import { onHosts, refreshHosts, setHostFilter } from "./lib/hosts.js";
import { applyI18n, bindLangButton, t } from "./lib/i18n.js";
import { icon } from "./lib/icons.js";
import { setCrumbs } from "./lib/layout.js";
import { resolveRoute } from "./lib/routes.js";
import { onHost } from "./lib/store.js";
import { applyTheme, currentTheme, toggleTheme } from "./lib/theme.js";
import { confirmDialog } from "./lib/ui.js";
import * as about from "./pages/about.js";
import * as activity from "./pages/activity.js";
import * as boxDetail from "./pages/box-detail.js";
import * as boxes from "./pages/boxes.js";
import * as library from "./pages/library.js";
import * as overview from "./pages/overview.js";
import * as settings from "./pages/settings.js";
import * as storage from "./pages/storage.js";
import * as trash from "./pages/trash.js";

const PAGES = { about, activity, boxDetail, boxes, library, overview, settings, storage, trash };

/** The tab bar's own entries: the first three open their page, and More opens the sidebar for everything else. */
const TABS = ["overview", "boxes", "activity"];

let cleanup = null;

/** The drawer under 900px is a fixed sidebar that `#shell.nav-open` shows; the scrim and More reflect whether it is open. */
function setNavOpen(open) {
  $("#shell").classList.toggle("nav-open", open);
  $("#moreBtn").setAttribute("aria-expanded", String(open));
}

const navOpen = () => $("#shell").classList.contains("nav-open");

/** While a field on the page has the keyboard, the bar hides and the menu button shows in its place. */
const setTyping = (typing) => $("#shell").classList.toggle("typing", typing);

/** Whether a node is a field that brings up a phone's keyboard: a text field, a text area or an editable region. */
const isField = (node) =>
  node instanceof HTMLElement &&
  node.matches("input:not([type='checkbox']):not([type='radio']), textarea, [contenteditable='true']");

/**
 * Marks the current entry in the sidebar and in the tab bar. The tab bar has no entry of its own for Storage, Library,
 * Settings, About or a box's detail page, so those mark More, which opens the sidebar that lists them.
 */
function markNav(nav) {
  for (const link of $$(".sidebar [data-nav]")) {
    const current = link.dataset.nav === nav;
    link.classList.toggle("active", current);
    if (current) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  const tab = TABS.includes(nav) ? nav : "more";
  for (const item of $$("#tabbar [data-tab]")) {
    const current = item.dataset.tab === tab;
    item.classList.toggle("active", current);
    if (current) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
}

function route() {
  const hit = resolveRoute(location.hash.replace(/^#/, ""));
  if (!hit) {
    location.hash = "#/overview";
    return;
  }
  if (hit.redirect) {
    history.replaceState(null, "", `#${hit.redirect}`);
    route();
    return;
  }
  cleanup?.();
  cleanup = null;
  markNav(hit.nav);
  setNavOpen(false);
  setTyping(false);
  const crumbs = hit.crumbs.map((k) => t(k));
  setCrumbs(crumbs);
  // Fresh element per route so page-level event listeners never leak across pages.
  const old = $("#view");
  const view = old.cloneNode(false);
  old.replaceWith(view);
  cleanup = PAGES[hit.page].render(view, ...hit.args) ?? null;
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
    select.hidden = !hostFilterShown(list);
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
  $("#menuBtn").addEventListener("click", () => setNavOpen(!navOpen()));
  // More opens the sidebar in place; the tab bar itself does not navigate, so a page keeps its state.
  $("#moreBtn").addEventListener("click", () => setNavOpen(!navOpen()));
  // A press beside the open drawer closes it, as choosing an entry in it does.
  $("#navScrim").addEventListener("click", () => setNavOpen(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && navOpen()) setNavOpen(false);
  });
  // A phone's keyboard comes up over the bottom of the window, where the tab bar sits. While a field on the page has it,
  // the bar steps aside (`.shell.typing`), so the terminal keeps its last line and the menu button takes its place. A
  // press on the page itself, or a new page, brings the bar back. The drawer and the top bar leave the state alone, so
  // the press that opens the drawer does not take away the button it pressed.
  document.addEventListener("focusin", (e) => {
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (isField(target) && !target.closest(".sidebar")) setTyping(true);
    // Focus moving to something on the page that is not a field, such as the button that opened a dialog, puts the
    // keyboard away, so the bar comes back. The top bar and the drawer are left out: a press there must not take away
    // the button it is pressing.
    else if (target?.closest("#view")) setTyping(false);
  });
  document.addEventListener("pointerdown", (e) => {
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (isField(target) || !target?.closest("#view")) return;
    setTyping(false);
  });
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
