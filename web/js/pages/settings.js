import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { ENV_VALUE_MAX, SECRET_NAME_RE, validSecretValue } from "../lib/env.js";
import { dateTime, relTime } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { currentTheme, toggleTheme } from "../lib/theme.js";
import { confirmDialog, emptyState, nameError, openDialog, toast, toastError, withBusy } from "../lib/ui.js";

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
        <div class="card" id="stTokens"></div>
        <div class="card" id="stSecrets"></div>
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
  loadTokens(view);
  loadSecrets(view);
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

const PRESETS = ["readonly", "operator", "sandboxed-agent", "admin"];

function linesOf(value) {
  return value
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function tokenStatus(token) {
  if (token.revokedAt) return { key: "st.tokenRevoked", badge: "badge-danger" };
  if (token.expiresAt && Date.parse(token.expiresAt) <= Date.now())
    return { key: "st.tokenExpired", badge: "badge-warning" };
  return { key: "st.tokenLive", badge: "badge-success" };
}

function scopeSummary(token) {
  const scopes = token.scopes.join(", ");
  return `<span class="subtle" title="${esc(scopes)}">${esc(token.preset ? t(`st.preset.${token.preset}`) : scopes)}</span>`;
}

async function loadTokens(view) {
  const card = view.querySelector("#stTokens");
  if (!card) return;
  let tokens;
  try {
    ({ tokens } = await api("/api/tokens"));
  } catch (e) {
    if (e.status === 401) {
      location.href = "/login";
      return;
    }
    card.innerHTML = `<div class="card-head"><h3>${t("st.tokens")}</h3></div>
      <div class="card-body"><div class="callout danger">${icon("alert")}<span>${esc(e.message)}</span></div></div>`;
    return;
  }
  const rows = tokens.length
    ? tokens.map(tokenRow).join("")
    : `<tr><td colspan="6">${emptyState({ iconName: "key", title: t("st.tokenNone") })}</td></tr>`;
  card.innerHTML = `
    <div class="card-head">
      <div><h3>${t("st.tokens")}</h3><p class="help">${t("st.tokensHelp")}</p></div>
      <button class="btn btn-sm btn-primary" id="stTokenCreate">${icon("plus")}${t("st.tokenCreate")}</button>
    </div>
    <div class="table-wrap"><table class="table">
      <thead><tr>
        <th>${t("label.tokenName")}</th><th>${t("st.tokenPrefix")}</th><th class="hide-sm">${t("st.tokenScopes")}</th>
        <th class="hide-sm">${t("st.tokenExpires")}</th><th>${t("st.tokenLastUsed")}</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  card.querySelector("#stTokenCreate").addEventListener("click", () => createToken(view));
  card.querySelectorAll("[data-revoke-token]").forEach((btn) => {
    btn.addEventListener("click", () => revokeToken(view, btn.dataset.revokeToken, btn.dataset.tokenName));
  });
}

function tokenRow(token) {
  const status = tokenStatus(token);
  const action = token.revokedAt
    ? `<span class="badge ${status.badge}">${t(status.key)}</span>`
    : `<button class="btn btn-sm btn-danger" data-revoke-token="${esc(token.id)}" data-token-name="${esc(token.name)}">${icon("x")}${t("st.tokenRevoke")}</button>`;
  const used = token.lastUsedAt
    ? `${esc(relTime(token.lastUsedAt))}${token.lastUsedIp ? ` <span class="subtle">${esc(token.lastUsedIp)}</span>` : ""}`
    : `<span class="subtle">${t("st.tokenUnused")}</span>`;
  return `<tr>
    <td><strong>${esc(token.name)}</strong> <span class="badge ${status.badge}">${t(status.key)}</span></td>
    <td class="mono">${esc(token.prefix)}</td>
    <td class="hide-sm">${scopeSummary(token)}</td>
    <td class="hide-sm subtle nowrap">${token.expiresAt ? esc(dateTime(token.expiresAt)) : t("st.tokenNever")}</td>
    <td class="subtle nowrap">${used}</td>
    <td class="nowrap"><div class="actions">${action}</div></td>
  </tr>`;
}

function createToken(view) {
  const presetOptions = PRESETS.map((name) => `<option value="${name}">${esc(t(`st.preset.${name}`))}</option>`).join(
    "",
  );
  const { root, close } = openDialog({
    title: t("st.tokenCreate"),
    description: t("st.tokenPresetHelp"),
    iconName: "key",
    wide: true,
    body: `
      <form id="stTokenForm" class="stack">
        <label class="field">${t("label.tokenName")}<input class="input" name="name" autocomplete="off" required /></label>
        <label class="field">${t("st.tokenPreset")}<select class="select" name="preset">${presetOptions}</select></label>
        <label class="field">${t("st.tokenBoxes")}
          <select class="select" name="boxes">
            <option value="created-by-me">${esc(t("st.tokenBoxesCreated"))}</option>
            <option value="*">${esc(t("st.tokenBoxesAll"))}</option>
            <option value="ids">${esc(t("st.tokenBoxesIds"))}</option>
            <option value="tags">${esc(t("st.tokenBoxesTags"))}</option>
          </select>
        </label>
        <label class="field" data-box-ids hidden>${t("st.tokenBoxList")}<textarea class="textarea token-lines" name="boxIds"></textarea><span class="help">${t("st.tokenBoxListHelp")}</span></label>
        <label class="field" data-box-tags hidden>${t("st.tokenTags")}<textarea class="textarea token-lines" name="boxTags"></textarea><span class="help">${t("st.tokenTagsHelp")}</span></label>
        <label class="field">${t("st.tokenVolumes")}<textarea class="textarea token-lines" name="volumes"></textarea><span class="help">${t("st.tokenVolumesHelp")}</span></label>
        <label class="checkbox"><input type="checkbox" name="volumesAll" /> <span>${t("st.tokenVolumesAll")}</span></label>
        <label class="field">${t("st.tokenHosts")}
          <select class="select" name="hosts">
            <option value="local">${esc(t("st.tokenHostsLocal"))}</option>
            <option value="*">${esc(t("st.tokenHostsAll"))}</option>
          </select>
        </label>
        <label class="field">${t("st.tokenExpiry")}<input class="input" name="days" inputmode="numeric" /><span class="help">${t("st.tokenExpiryHelp")}</span></label>
        <div class="field"><strong>${t("st.tokenQuotas")}</strong><span class="help">${t("st.tokenQuotaHelp")}</span></div>
        <div class="grid grid-2">
          <label class="field">${t("st.tokenQuotaBoxes")}<input class="input" name="maxBoxes" inputmode="numeric" /></label>
          <label class="field">${t("st.tokenQuotaCpus")}<input class="input" name="maxCpus" inputmode="decimal" /></label>
          <label class="field">${t("st.tokenQuotaMemory")}<input class="input" name="maxMemoryMb" inputmode="numeric" /></label>
          <label class="field">${t("st.tokenQuotaTtl")}<input class="input" name="maxTtlHours" inputmode="numeric" /></label>
          <label class="field">${t("st.tokenQuotaRate")}<input class="input" name="rateLimit" inputmode="numeric" /></label>
        </div>
      </form>`,
    footer: `<button class="btn" data-close type="button">${t("common.cancel")}</button><button class="btn btn-primary" id="stTokenSave" type="button">${t("st.tokenCreate")}</button>`,
  });
  const form = root.querySelector("#stTokenForm");
  const boxes = form.elements.boxes;
  const syncBoxes = () => {
    root.querySelector("[data-box-ids]").hidden = boxes.value !== "ids";
    root.querySelector("[data-box-tags]").hidden = boxes.value !== "tags";
  };
  boxes.addEventListener("change", syncBoxes);
  root.querySelector("#stTokenSave").addEventListener("click", () => submitToken(view, form, close));
}

function numberOrSkip(value) {
  const text = value.trim();
  if (!text) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : Number.NaN;
}

async function submitToken(view, form, close) {
  const data = new FormData(form);
  const name = String(data.get("name") ?? "").trim();
  const invalid = nameError(name, "tokenName");
  if (invalid) {
    toast(t("st.tokenCreateFailed"), { type: "error", message: invalid });
    return;
  }
  const body = { name, preset: String(data.get("preset")) };
  const boxes = String(data.get("boxes"));
  if (boxes === "*") body.boxes = "*";
  else if (boxes === "ids") body.boxes = { ids: linesOf(String(data.get("boxIds") ?? "")) };
  else if (boxes === "tags") body.boxes = { tags: linesOf(String(data.get("boxTags") ?? "")) };
  else body.boxes = "created-by-me";
  if (data.get("volumesAll")) body.volumes = "*";
  else {
    const volumes = linesOf(String(data.get("volumes") ?? ""));
    if (volumes.length) body.volumes = volumes;
  }
  if (String(data.get("hosts")) === "*") body.hosts = "*";
  const days = numberOrSkip(String(data.get("days") ?? ""));
  if (days !== undefined) body.expiresInSec = Math.round(days * 86_400);
  const quotas = {};
  const maxBoxes = numberOrSkip(String(data.get("maxBoxes") ?? ""));
  const maxCpus = numberOrSkip(String(data.get("maxCpus") ?? ""));
  const maxMemoryMb = numberOrSkip(String(data.get("maxMemoryMb") ?? ""));
  const maxTtlHours = numberOrSkip(String(data.get("maxTtlHours") ?? ""));
  const rateLimit = numberOrSkip(String(data.get("rateLimit") ?? ""));
  if (maxBoxes !== undefined) quotas.maxBoxes = maxBoxes;
  if (maxCpus !== undefined) quotas.maxCpus = maxCpus;
  if (maxMemoryMb !== undefined) quotas.maxMemoryMb = maxMemoryMb;
  if (maxTtlHours !== undefined) quotas.maxTtlSec = Math.round(maxTtlHours * 3600);
  if (rateLimit !== undefined) quotas.rateLimit = rateLimit;
  if (Object.keys(quotas).length) body.quotas = quotas;
  let created;
  try {
    created = await api("/api/tokens", { method: "POST", body });
  } catch (e) {
    toastError(t("st.tokenCreateFailed"), e);
    return;
  }
  close();
  showTokenSecret(created.token);
  loadTokens(view);
}

function showTokenSecret(secret) {
  const origin = location.origin;
  const curl = `curl -s -H "Authorization: Bearer ${secret}" ${origin}/api/boxes`;
  const mcp = JSON.stringify(
    { mcpServers: { minibox: { url: `${origin}/mcp`, headers: { Authorization: `Bearer ${secret}` } } } },
    null,
    2,
  );
  const { root } = openDialog({
    title: t("st.tokenCreate"),
    description: t("st.tokenOnce"),
    iconName: "key",
    wide: true,
    body: `
      <div class="stack">
        <div class="token-secret" id="stTokenSecret">${esc(secret)}</div>
        <div><div class="help">${t("st.tokenCurl")}</div><pre class="token-snippet">${esc(curl)}</pre></div>
        <div><div class="help">${t("st.tokenMcp")}</div><pre class="token-snippet">${esc(mcp)}</pre></div>
        <div class="callout warn">${icon("alert")}<span>${t("st.tokenMcpNote")}</span></div>
      </div>`,
    footer: `<button class="btn" id="stTokenCopy" type="button">${icon("copy")}${t("st.tokenCopy")}</button><button class="btn btn-primary" data-close type="button">${t("common.close")}</button>`,
  });
  root.querySelector("#stTokenCopy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(secret);
      toast(t("st.tokenCopied"));
    } catch (e) {
      toastError(t("st.tokenCopy"), e);
    }
  });
}

async function revokeToken(view, id, name) {
  const ok = await confirmDialog({
    title: t("st.tokenRevokeTitle"),
    message: t("st.tokenRevokeMessage"),
    confirmText: t("st.tokenRevoke"),
    danger: true,
    checkbox: { label: t("st.tokenDeleteCreated"), help: t("st.tokenDeleteCreatedHelp") },
  });
  if (!ok) return;
  try {
    await api(`/api/tokens/${enc(id)}?deleteCreated=${ok.checked ? "true" : "false"}`, { method: "DELETE" });
  } catch (e) {
    toastError(t("st.tokenRevokeFailed"), e);
    return;
  }
  toast(t("st.tokenRevokedToast"), { message: name ?? "" });
  loadTokens(view);
}

async function loadSecrets(view) {
  const card = view.querySelector("#stSecrets");
  if (!card) return;
  let secrets;
  try {
    ({ secrets } = await api("/api/secrets"));
  } catch (e) {
    if (e.status === 401) {
      location.href = "/login";
      return;
    }
    card.innerHTML = `<div class="card-head"><h3>${t("st.secrets")}</h3></div>
      <div class="card-body"><div class="callout danger">${icon("alert")}<span>${esc(e.message)}</span></div></div>`;
    return;
  }
  const rows = secrets.length
    ? secrets.map(secretRow).join("")
    : `<tr><td colspan="4">${emptyState({ iconName: "key", title: t("st.secretNone") })}</td></tr>`;
  card.innerHTML = `
    <div class="card-head">
      <div><h3>${t("st.secrets")}</h3><p class="help">${t("st.secretsHelp")}</p></div>
      <button class="btn btn-sm btn-primary" id="stSecretAdd">${icon("plus")}${t("st.secretAdd")}</button>
    </div>
    <div class="card-body"><p class="help">${t("st.secretsNote")}</p></div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>${t("label.name")}</th><th class="hide-sm">${t("st.secretUpdated")}</th><th>${t("st.secretUsedBy")}</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  card.querySelector("#stSecretAdd").addEventListener("click", () => secretDialog(view));
  card.querySelectorAll("[data-secret-replace]").forEach((btn) => {
    btn.addEventListener("click", () => secretDialog(view, btn.dataset.secretReplace));
  });
  card.querySelectorAll("[data-secret-delete]").forEach((btn) => {
    btn.addEventListener("click", () => deleteSecret(view, btn.dataset.secretDelete));
  });
}

function secretRow(secret) {
  const used = secret.boxes.length
    ? secret.boxes.map((name) => `<span class="badge mono">${esc(name)}</span>`).join(" ")
    : `<span class="subtle">${t("st.secretUnused")}</span>`;
  return `<tr>
    <td class="mono"><strong>${esc(secret.name)}</strong></td>
    <td class="hide-sm subtle nowrap" title="${esc(dateTime(secret.updatedAt))}">${esc(relTime(secret.updatedAt))}</td>
    <td>${used}</td>
    <td class="nowrap"><div class="actions">
      <button class="btn btn-sm" data-secret-replace="${esc(secret.name)}">${icon("key")}${t("st.secretReplace")}</button>
      <button class="btn btn-sm btn-danger" data-secret-delete="${esc(secret.name)}">${icon("trash")}${t("st.secretDelete")}</button>
    </div></td>
  </tr>`;
}

/** Adds a secret, or replaces the value of `replacing`. The value is sent once and never shown again. */
function secretDialog(view, replacing = "") {
  const { root, close } = openDialog({
    title: replacing ? t("st.secretDialogReplace", { name: replacing }) : t("st.secretDialogAdd"),
    description: t("st.secretDialogHelp"),
    iconName: "key",
    body: `<form id="stSecretForm" class="stack" autocomplete="off">
      <label class="field">${t("st.secretNameLabel")}
        <input class="input mono" name="name" value="${esc(replacing)}"${replacing ? " readonly" : " autofocus"} required autocapitalize="off" autocomplete="off" spellcheck="false" />
        <span class="help">${t("st.secretNameHelp")}</span></label>
      <label class="field">${t("st.secretValueLabel")}
        <input class="input mono" name="value" type="password"${replacing ? " autofocus" : ""} required autocapitalize="off" autocomplete="new-password" spellcheck="false" />
        <span class="help">${t("st.secretValueHelp", { max: ENV_VALUE_MAX })}</span></label>
      <div class="error-text" id="stSecretErr"></div>
    </form>`,
    footer: `<button class="btn" data-close type="button">${t("common.cancel")}</button><button class="btn btn-primary" id="stSecretSave" type="button">${t("st.secretSave")}</button>`,
  });
  const error = root.querySelector("#stSecretErr");
  root.querySelector("#stSecretSave").addEventListener("click", async (event) => {
    const data = new FormData(root.querySelector("#stSecretForm"));
    const name = String(data.get("name") ?? "").trim();
    const value = String(data.get("value") ?? "");
    if (!SECRET_NAME_RE.test(name)) {
      error.textContent = t("err.secret_name_invalid");
      return;
    }
    if (!validSecretValue(value)) {
      error.textContent = t("err.secret_value_invalid", { max: ENV_VALUE_MAX });
      return;
    }
    error.textContent = "";
    try {
      const { created } = await withBusy(event.currentTarget, () =>
        api(`/api/secrets/${enc(name)}`, { method: "PUT", body: { value } }),
      );
      close();
      toast(t(created ? "st.secretSaved" : "st.secretReplaced"), { message: name });
      loadSecrets(view);
    } catch (e) {
      error.textContent = e.message;
    }
  });
}

async function deleteSecret(view, name) {
  const ok = await confirmDialog({
    title: t("st.secretDeleteTitle", { name }),
    message: t("st.secretDeleteMessage"),
    confirmText: t("st.secretDelete"),
    danger: true,
  });
  if (ok) await removeSecret(view, name, false);
}

/** Deletes a secret. When boxes still use it, the server names them and the user confirms a forced delete. */
async function removeSecret(view, name, force) {
  try {
    await api(`/api/secrets/${enc(name)}${force ? "?force=true" : ""}`, { method: "DELETE" });
  } catch (e) {
    if (e.status === 409 && Array.isArray(e.details?.boxes)) {
      const again = await confirmDialog({
        title: t("st.secretInUseTitle", { name }),
        message: esc(t("st.secretInUseMessage", { boxes: e.details.boxes.join(", ") })),
        confirmText: t("st.secretDeleteAnyway"),
        danger: true,
      });
      if (again) await removeSecret(view, name, true);
      return;
    }
    toastError(t("st.secretDeleteFailed"), e);
    return;
  }
  toast(t("st.secretDeleted"), { message: name });
  loadSecrets(view);
}
