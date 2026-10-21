import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { dateTime, relTime } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { currentTheme, toggleTheme } from "../lib/theme.js";
import { confirmDialog, emptyState, toast, toastError } from "../lib/ui.js";

export function render(view) {
  view.innerHTML = `
    <div class="page-narrow">
      <div class="page-head"><div><h1>${t("nav.settings")}</h1><p>${t("st.subtitle")}</p></div></div>
      <div class="stack">
        <div class="card" id="stRuntime">
          <div class="card-head"><h3>${t("st.runtime")}</h3>${icon("settings")}</div>
          <div class="card-body"><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>${t("st.appearance")}</h3></div>
          <div class="card-body row between">
            <div><strong>${t("st.theme")}</strong><div class="help">${t("st.themeHelp")}</div></div>
            <button class="btn" id="stTheme"></button>
          </div>
        </div>
        <div class="card" id="stSessions"></div>
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
  loadSessions(view);
  return () => document.removeEventListener("themechange", paintTheme);
}

async function loadRuntime(view) {
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

async function loadSessions(view) {
  const card = view.querySelector("#stSessions");
  let sessions;
  try {
    ({ sessions } = await api("/api/auth/sessions"));
  } catch (e) {
    if (e.status === 401) {
      location.href = "/login";
      return;
    }
    card.innerHTML = `<div class="card-head"><h3>${t("st.sessions")}</h3></div>
      <div class="card-body"><div class="callout danger">${icon("alert")}<span>${esc(e.message)}</span></div></div>`;
    return;
  }
  const others = sessions.filter((s) => !s.current).length;
  const rows = sessions.length
    ? sessions.map(sessionRow).join("")
    : `<tr><td colspan="4">${emptyState({ iconName: "key", title: t("st.sessionsNone") })}</td></tr>`;
  card.innerHTML = `
    <div class="card-head">
      <div><h3>${t("st.sessions")}</h3><p class="help">${t("st.sessionsHelp")}</p></div>
      <button class="btn btn-sm" id="stSignOutOthers" ${others ? "" : "disabled"}>${icon("logout")}${t("st.signOutOthers")}</button>
    </div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>${t("st.sessionDevice")}</th><th class="hide-sm">${t("st.sessionCreated")}</th><th>${t("st.sessionLastSeen")}</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  card
    .querySelectorAll("[data-revoke]")
    .forEach((btn) => btn.addEventListener("click", () => revokeSession(view, btn.dataset.revoke)));
  card.querySelector("#stSignOutOthers")?.addEventListener("click", () => signOutOthers(view));
}

function sessionRow(s) {
  const device = s.userAgent ? esc(s.userAgent) : t("common.unknown");
  const action = s.current
    ? `<span class="badge badge-accent">${t("st.sessionCurrent")}</span>`
    : `<button class="btn btn-sm btn-danger" data-revoke="${esc(s.id)}">${icon("x")}${t("st.sessionRevoke")}</button>`;
  return `<tr>
    <td><div class="session-ua" title="${esc(s.userAgent)}">${device}</div></td>
    <td class="hide-sm subtle nowrap">${dateTime(s.createdAt)}</td>
    <td class="subtle nowrap">${relTime(s.lastSeenAt)}</td>
    <td class="nowrap"><div class="actions">${action}</div></td>
  </tr>`;
}

async function revokeSession(view, id) {
  const ok = await confirmDialog({
    title: t("st.sessionRevokeTitle"),
    message: t("st.sessionRevokeMessage"),
    confirmText: t("st.sessionRevoke"),
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/auth/sessions/${enc(id)}`, { method: "DELETE" });
  } catch (e) {
    toastError(t("st.sessionRevokeFailed"), e);
    return;
  }
  toast(t("st.sessionRevoked"));
  loadSessions(view);
}

async function signOutOthers(view) {
  const ok = await confirmDialog({
    title: t("st.signOutOthersTitle"),
    message: t("st.signOutOthersMessage"),
    confirmText: t("st.signOutOthers"),
    danger: true,
  });
  if (!ok) return;
  let revoked;
  try {
    ({ revoked } = await api("/api/auth/sessions/revoke-others", { method: "POST", body: {} }));
  } catch (e) {
    toastError(t("st.signOutOthersFailed"), e);
    return;
  }
  toast(t("st.signedOutOthers", { n: revoked }));
  loadSessions(view);
}
