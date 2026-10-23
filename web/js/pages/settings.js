import { loadHosts } from "../components/settings-hosts.js";
import { loadNotify } from "../components/settings-notify.js";
import { loadRuntime, loadPreview } from "../components/settings-runtime.js";
import { loadSecrets } from "../components/settings-secrets.js";
import { loadSessions } from "../components/settings-sessions.js";
import { loadTargets } from "../components/settings-targets.js";
import { loadTokens } from "../components/settings-tokens.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { currentTheme, toggleTheme } from "../lib/theme.js";

export function render(view) {
  view.innerHTML = `
    <div class="page-narrow">
      <div class="page-head"><div><h1>${t("nav.settings")}</h1><p>${t("st.subtitle")}</p></div></div>
      <div class="stack">
        <div class="card" id="stRuntime">
          <div class="card-head"><h3>${t("st.runtime")}</h3>${icon("settings")}</div>
          <div class="card-body"><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div></div>
        </div>
        <div class="card" id="stPreview"></div>
        <div class="card" id="stHosts"></div>
        <div class="card">
          <div class="card-head"><h3>${t("st.appearance")}</h3></div>
          <div class="card-body row between">
            <div><strong>${t("st.theme")}</strong><div class="help">${t("st.themeHelp")}</div></div>
            <button class="btn" id="stTheme"></button>
          </div>
        </div>
        <div class="card" id="stSessions"></div>
        <div class="card" id="stTokens"></div>
        <div class="card" id="stSecrets"></div>
        <div class="card" id="stNotify"></div>
        <div class="card" id="stTargets"></div>
      </div>
    </div>`;

  const themeBtn = view.querySelector("#stTheme");
  const paintTheme = () => {
    const dark = currentTheme() === "dark";
    themeBtn.innerHTML = `${icon(dark ? "sun" : "moon")}${dark ? t("st.toLight") : t("st.toDark")}`;
  };
  paintTheme();
  themeBtn.addEventListener("click", toggleTheme);
  document.addEventListener("themechange", paintTheme);

  loadRuntime(view);
  loadPreview(view);
  loadHosts(view);
  loadSessions(view);
  loadTokens(view);
  loadSecrets(view);
  loadNotify(view);
  loadTargets(view);
  return () => document.removeEventListener("themechange", paintTheme);
}
