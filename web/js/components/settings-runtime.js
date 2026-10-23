import { api, errorText } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";

export async function loadRuntime(view) {
  const body = view.querySelector("#stRuntime .card-body");
  let s;
  try {
    s = await api("/api/system");
  } catch (e) {
    body.innerHTML = `<div class="callout danger">${icon("alert")}<span>${esc(e.message)}</span></div>`;
    return;
  }
  const c = s.config;
  body.innerHTML = `<div class="kv-cols">
    <dl class="kv">
      <dt>${t("st.listen")}</dt><dd class="mono">${esc(c.host)}:${esc(c.port)}</dd>
      <dt>Docker Socket</dt><dd class="mono">${esc(c.dockerSocket)}</dd>
      <dt>${t("st.labelPrefix")}</dt><dd class="mono">${esc(c.labelPrefix)}</dd>
      <dt>${t("st.baseTemplate")}</dt><dd class="mono">${esc(c.baseTemplate)}</dd>
      <dt>${t("st.boxProfile")}</dt><dd>${t(`profile.${c.boxProfile}`)}</dd>
    </dl>
    <dl class="kv">
      <dt>${t("st.containerRuntime")}</dt><dd>${c.containerRuntime ? `<span class="mono">${esc(c.containerRuntime)}</span>` : t("st.runtimeDefault")}</dd>
      <dt>${t("st.pidsLimit")}</dt><dd>${t("st.pidsValue", { n: c.boxPidsLimit })}</dd>
      <dt>${t("st.boxNetwork")}</dt><dd class="mono">${esc(c.boxNetwork)}</dd>
      <dt>${t("st.interval")}</dt><dd>${t("st.intervalValue", { n: c.metricsIntervalMs / 1000 })}</dd>
      <dt>${t("st.boxLimits")}</dt><dd>${t("st.boxLimitsValue", { minC: s.limits.minCpus, maxC: s.limits.maxCpus, minM: s.limits.minMemoryMb, maxM: s.limits.maxMemoryMb })}</dd>
    </dl>
  </div>`;
}

export async function loadPreview(view) {
  const card = view.querySelector("#stPreview");
  let setup;
  try {
    setup = await api("/api/preview/setup");
  } catch (e) {
    if (e.status === 401) {
      location.href = "/login";
      return;
    }
    card.innerHTML = `<div class="card-head"><h3>${t("st.preview")}</h3></div>
      <div class="card-body"><div class="callout danger">${icon("alert")}<span>${esc(e.message)}</span></div></div>`;
    return;
  }
  if (setup.mode !== "subdomain") {
    card.innerHTML = `<div class="card-head"><div><h3>${t("st.preview")}</h3><p class="help">${esc(t("st.previewPathHelp"))}</p></div>${icon("link")}</div>`;
    return;
  }
  const checks = setup.checks
    .map((check) => {
      const kind = check.status === "ok" ? "" : check.status === "warn" ? " warn" : " danger";
      const text = errorText({ key: check.message.key, params: check.message.params, message: check.message.text });
      return `<div class="callout${kind}">${icon(check.status === "ok" ? "check" : "alert")}<span>${esc(text)}</span></div>`;
    })
    .join("");
  card.innerHTML = `
    <div class="card-head"><div><h3>${t("st.preview")}</h3><p class="help">${esc(t("st.previewHelp"))}</p></div>${icon("link")}</div>
    <div class="card-body stack">
      <dl class="kv"><dt>${t("st.previewBase")}</dt><dd class="mono">${esc(setup.baseDomain)}</dd></dl>
      ${checks}
    </div>`;
}
