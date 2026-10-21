import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { dateTime, relTime } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { currentTheme, toggleTheme } from "../lib/theme.js";
import { confirmDialog, emptyState, toast, toastError } from "../lib/ui.js";

export function render(view) {
  view.innerHTML = `
    <div class="page-head"><div><h1>${t("nav.settings")}</h1><p>${t("st.subtitle")}</p></div></div>
    <div class="grid grid-2" id="stGrid"><div class="card"><div class="card-body"><div class="skeleton sk-line"></div></div></div></div>
    <div class="card" id="stSessions"></div>`;
  api("/api/system").then((s) => {
    view.querySelector("#stGrid").innerHTML = `
      <div class="stack">
        <div class="card"><div class="card-head"><h3>${t("st.runtime")}</h3>${icon("settings")}</div><div class="card-body"><dl class="kv">
          <dt>${t("st.listen")}</dt><dd class="mono">${esc(s.config.host)}:${s.config.port}</dd>
          <dt>Docker Socket</dt><dd class="mono">${esc(s.config.dockerSocket)}</dd>
          <dt>${t("st.labelPrefix")}</dt><dd class="mono">${esc(s.config.labelPrefix)}</dd>
          <dt>${t("st.baseTemplate")}</dt><dd class="mono">${esc(s.config.baseTemplate)}</dd>
          <dt>${t("st.boxProfile")}</dt><dd>${t(`profile.${s.config.boxProfile}`)}</dd>
          <dt>${t("st.containerRuntime")}</dt><dd>${s.config.containerRuntime ? `<span class="mono">${esc(s.config.containerRuntime)}</span>` : t("st.runtimeDefault")}</dd>
          <dt>${t("st.pidsLimit")}</dt><dd>${t("st.pidsValue", { n: s.config.boxPidsLimit })}</dd>
          <dt>${t("st.boxNetwork")}</dt><dd class="mono">${esc(s.config.boxNetwork)}</dd>
          <dt>${t("st.interval")}</dt><dd>${t("st.intervalValue", { n: s.config.metricsIntervalMs / 1000 })}</dd>
          <dt>${t("st.boxLimits")}</dt><dd>${t("st.boxLimitsValue", { minC: s.limits.minCpus, maxC: s.limits.maxCpus, minM: s.limits.minMemoryMb, maxM: s.limits.maxMemoryMb })}</dd>
        </dl></div></div>
        <div class="card"><div class="card-head"><h3>${t("st.appearance")}</h3></div><div class="card-body stack"><div class="row between">
          <div><strong>${t("st.theme")}</strong><div class="help">${t("st.themeHelp")}</div></div>
          <button class="btn" id="stTheme">${icon(currentTheme() === "dark" ? "sun" : "moon")}${currentTheme() === "dark" ? t("st.toLight") : t("st.toDark")}</button></div>
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
    view.querySelector("#stTheme").addEventListener("click", () => {
      toggleTheme();
      render(view);
    });
  });
  loadSessions(view);
  return null;
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
