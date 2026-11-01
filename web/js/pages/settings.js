import { loadBackups } from "../components/settings-backups.js";
import { loadHosts } from "../components/settings-hosts.js";
import { loadNotify } from "../components/settings-notify.js";
import { loadRuntime, loadPreview } from "../components/settings-runtime.js";
import { loadSecrets } from "../components/settings-secrets.js";
import { loadSessions } from "../components/settings-sessions.js";
import { loadSshKeys } from "../components/settings-ssh-keys.js";
import { loadTargets } from "../components/settings-targets.js";
import { loadTokens } from "../components/settings-tokens.js";
import { esc } from "../lib/dom.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { SETTINGS_SECTIONS, sectionOf } from "../lib/settings-sections.js";
import { currentTheme, toggleTheme } from "../lib/theme.js";

/** Each category's card, and the loader that fills it. Only the shown category loads. */
const PANELS = {
  sessions: { html: () => `<div class="card" id="stSessions"></div>`, load: loadSessions },
  tokens: { html: () => `<div class="card" id="stTokens"></div>`, load: loadTokens },
  secrets: { html: () => `<div class="card" id="stSecrets"></div>`, load: loadSecrets },
  "ssh-keys": { html: () => `<div class="card" id="stSshKeys"></div>`, load: loadSshKeys },
  notify: { html: () => `<div class="card" id="stNotify"></div>`, load: loadNotify },
  targets: { html: () => `<div class="card" id="stTargets"></div>`, load: loadTargets },
  backups: {
    html: () => `<div class="card" id="stBackups">
          <div class="card-head"><h3>${t("st.backups")}</h3>${icon("disk")}</div>
          <div class="card-body"><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div></div>
        </div>`,
    load: loadBackups,
  },
  hosts: {
    html: () => `<div class="stack" id="stHostsPanel">
          <div class="card" id="stHosts"></div>
          <div class="card" id="stHostRemote"></div>
        </div>`,
    load: loadHosts,
  },
  runtime: {
    html: () => `<div class="card" id="stRuntime">
          <div class="card-head"><h3>${t("st.runtime")}</h3>${icon("settings")}</div>
          <div class="card-body"><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div></div>
        </div>`,
    load: loadRuntime,
  },
  preview: { html: () => `<div class="card" id="stPreview"></div>`, load: loadPreview },
  appearance: {
    html: () => `<div class="card" id="stAppearance">
          <div class="card-head"><h3>${t("st.appearance")}</h3></div>
          <div class="card-body row between">
            <div><strong>${t("st.theme")}</strong><div class="help">${t("st.themeHelp")}</div></div>
            <button class="btn" id="stTheme"></button>
          </div>
        </div>`,
  },
};

export function render(view, section) {
  const active = sectionOf(section);
  view.innerHTML = `
    <div class="page-narrow">
      <div class="page-head"><div><h1>${t("nav.settings")}</h1><p>${t("st.subtitle")}</p></div></div>
      <div class="settings">
        <nav class="settings-nav" aria-label="${esc(t("st.navLabel"))}">${SETTINGS_SECTIONS.map((s) => navLink(s, active.id)).join("")}</nav>
        <div class="settings-panel">${PANELS[active.id].html()}</div>
      </div>
    </div>`;

  let cleanup = null;
  const themeBtn = view.querySelector("#stTheme");
  if (themeBtn) {
    const paintTheme = () => {
      const dark = currentTheme() === "dark";
      themeBtn.innerHTML = `${icon(dark ? "sun" : "moon")}${dark ? t("st.toLight") : t("st.toDark")}`;
    };
    paintTheme();
    themeBtn.addEventListener("click", toggleTheme);
    document.addEventListener("themechange", paintTheme);
    cleanup = () => document.removeEventListener("themechange", paintTheme);
  }
  PANELS[active.id].load?.(view);
  return cleanup;
}

/** A sub-nav link. Each link is a route, so the browser's back and forward buttons move between categories. */
function navLink(section, activeId) {
  const current = section.id === activeId ? ' aria-current="page"' : "";
  return `<a href="#/settings/${section.id}"${current}>${esc(t(section.label))}</a>`;
}
