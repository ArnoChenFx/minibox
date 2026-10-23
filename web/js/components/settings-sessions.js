import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { dateTime, relTime } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { pinFirst } from "../lib/list-limit.js";
import { emptyState, confirmDialog, toastError, toast } from "../lib/ui.js";
import { bindToggles, limitList } from "./list-toggle.js";

export async function loadSessions(view) {
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
  const { shown, toggle } = limitList(
    view,
    "sessions",
    pinFirst(sessions, (s) => s.current),
  );
  const rows = sessions.length
    ? shown.map(sessionRow).join("")
    : `<tr><td colspan="4">${emptyState({ iconName: "key", title: t("st.sessionsNone") })}</td></tr>`;
  card.innerHTML = `
    <div class="card-head">
      <div><h3>${t("st.sessions")}</h3><p class="help">${t("st.sessionsHelp")}</p></div>
      <button class="btn btn-sm" id="stSignOutOthers" ${others ? "" : "disabled"}>${icon("logout")}${t("st.signOutOthers")}</button>
    </div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>${t("st.sessionDevice")}</th><th class="hide-sm">${t("st.sessionCreated")}</th><th>${t("st.sessionLastSeen")}</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="list-more">${toggle}</div>`;
  card
    .querySelectorAll("[data-revoke]")
    .forEach((btn) => btn.addEventListener("click", () => revokeSession(view, btn.dataset.revoke)));
  card.querySelector("#stSignOutOthers")?.addEventListener("click", () => signOutOthers(view));
  bindToggles(view, card, () => loadSessions(view));
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
