import { api } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { dateTime } from "../lib/format.js";
import { bindLangSelect, langSelect, t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { currentTheme, toggleTheme } from "../lib/theme.js";

export function render(view) {
  view.innerHTML = `
    <div class="page-head"><div><h1>${t("nav.settings")}</h1><p>${t("st.subtitle")}</p></div></div>
    <div class="grid grid-2" id="stGrid"><div class="card"><div class="card-body"><div class="skeleton sk-line"></div></div></div></div>`;
  api("/api/system").then((s) => {
    view.querySelector("#stGrid").innerHTML = `
      <div class="stack">
        <div class="card"><div class="card-head"><h3>${t("st.runtime")}</h3>${icon("settings")}</div><div class="card-body"><dl class="kv">
          <dt>${t("st.listen")}</dt><dd class="mono">${esc(s.config.host)}:${s.config.port}</dd>
          <dt>Docker Socket</dt><dd class="mono">${esc(s.config.dockerSocket)}</dd>
          <dt>${t("st.labelPrefix")}</dt><dd class="mono">${esc(s.config.labelPrefix)}</dd>
          <dt>${t("st.baseTemplate")}</dt><dd class="mono">${esc(s.config.baseTemplate)}</dd>
          <dt>${t("st.interval")}</dt><dd>${t("st.intervalValue", { n: s.config.metricsIntervalMs / 1000 })}</dd>
          <dt>${t("st.boxLimits")}</dt><dd>${t("st.boxLimitsValue", { minC: s.limits.minCpus, maxC: s.limits.maxCpus, minM: s.limits.minMemoryMb, maxM: s.limits.maxMemoryMb })}</dd>
        </dl></div></div>
        <div class="card"><div class="card-head"><h3>${t("st.appearance")}</h3></div><div class="card-body stack"><div class="row between">
          <div><strong>${t("st.theme")}</strong><div class="help">${t("st.themeHelp")}</div></div>
          <button class="btn" id="stTheme">${icon(currentTheme() === "dark" ? "sun" : "moon")}${currentTheme() === "dark" ? t("st.toLight") : t("st.toDark")}</button></div>
          <div class="row between"><div><strong>${t("st.language")}</strong><div class="help">${t("st.languageHelp")}</div></div>${langSelect("stLang")}</div>
        </div></div>
      </div>
      <div class="stack">
        <div class="card"><div class="card-body" style="text-align:center;padding:32px 24px">
          <img data-logo src="/assets/${currentTheme() === "dark" ? "logo-dark" : "logo"}.svg" alt="MiniBox" style="height:40px" />
          <p class="muted" style="margin-top:12px">${t("common.tagline")}</p>
          <p class="subtle" style="margin-top:6px;font-size:12.5px">${t("st.version", { v: esc(s.version), t: dateTime(s.startedAt) })}</p>
          <div class="row" style="justify-content:center;margin-top:16px"><a class="btn btn-sm" href="https://github.com/ArnoChenFx/minibox" target="_blank" rel="noopener">${icon("github")}GitHub</a></div>
        </div></div>
      </div>`;
    bindLangSelect(view.querySelector("#stLang"));
    view.querySelector("#stTheme").addEventListener("click", () => {
      toggleTheme();
      render(view);
    });
  });
  return null;
}
