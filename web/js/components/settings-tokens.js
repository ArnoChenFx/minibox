import { api, enc } from "../lib/api.js";
import { esc, copyText } from "../lib/dom.js";
import { relTime, dateTime } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { scopeRequest, summarizeScopes } from "../lib/token-scopes.js";
import { emptyState, openDialog, nameError, toast, toastError, confirmDialog } from "../lib/ui.js";
import { bindToggles, limitList } from "./list-toggle.js";
import { bindPermissions, permissionsHtml, presetFieldHtml } from "./token-permissions.js";

function linesOf(value) {
  return value
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** A token whose record can be deleted: revoked, or past its expiry. A live token has to be revoked first. */
function isEnded(token) {
  return tokenStatus(token).badge !== "badge-success";
}

function tokenStatus(token) {
  if (token.revokedAt) return { key: "st.tokenRevoked", badge: "badge-danger" };
  if (token.expiresAt && Date.parse(token.expiresAt) <= Date.now())
    return { key: "st.tokenExpired", badge: "badge-warning" };
  return { key: "st.tokenLive", badge: "badge-success" };
}

/** The preset's name, or 自定义 with the count and its base, and the full scope list folded under it. */
function scopeSummary(token, catalog) {
  const summary = summarizeScopes(token, catalog);
  const label =
    summary.kind === "preset"
      ? esc(t(`st.preset.${summary.name}`))
      : esc(t("st.tokenCustomCount", { n: summary.count }));
  const base =
    summary.kind === "custom" && summary.base
      ? ` <span class="subtle">${esc(t("st.tokenCustomBased", { preset: t(`st.preset.${summary.base}`) }))}</span>`
      : "";
  const list = token.scopes.map((scope) => `<code>${esc(scope)}</code>`).join("");
  return `<details class="scope-details">
    <summary title="${esc(token.scopes.join(", "))}">${icon("chevron")}<span>${label}</span>${base}</summary>
    <div class="scope-list" aria-label="${esc(t("st.tokenScopesList"))}">${list}</div>
  </details>`;
}

export async function loadTokens(view) {
  const card = view.querySelector("#stTokens");
  if (!card) return;
  let tokens;
  let catalog;
  try {
    [{ tokens }, catalog] = await Promise.all([
      api("/api/tokens"),
      // Without the preset list a token still shows its preset name.
      api("/api/tokens/presets").catch(() => undefined),
    ]);
  } catch (e) {
    if (e.status === 401) {
      location.href = "/login";
      return;
    }
    card.innerHTML = `<div class="card-head"><h3>${t("st.tokens")}</h3></div>
      <div class="card-body"><div class="callout danger">${icon("alert")}<span>${esc(e.message)}</span></div></div>`;
    return;
  }
  drawTokens(view, card, { tokens, catalog });
}

/**
 * Draws the tokens card from the data it already has. The list toggle redraws this, so expanding or collapsing the list
 * asks the API for nothing.
 */
function drawTokens(view, card, { tokens, catalog }) {
  const endedCount = tokens.filter(isEnded).length;
  const { shown, toggle } = limitList(view, "tokens", tokens);
  const rows = tokens.length
    ? shown.map((token) => tokenRow(token, catalog)).join("")
    : `<tr><td colspan="6">${emptyState({ iconName: "key", title: t("st.tokenNone") })}</td></tr>`;
  card.innerHTML = `
    <div class="card-head with-actions">
      <div><h3>${t("st.tokens")}</h3><p class="help">${t("st.tokensHelp")}</p></div>
      <div class="actions">
        ${endedCount ? `<button class="btn btn-sm" id="stTokenPrune">${icon("trash")}${t("st.tokenPrune")}</button>` : ""}
        <button class="btn btn-sm btn-primary" id="stTokenCreate">${icon("plus")}${t("st.tokenCreate")}</button>
      </div>
    </div>
    <div class="table-wrap"><table class="table">
      <thead><tr>
        <th>${t("label.tokenName")}</th><th>${t("st.tokenPrefix")}</th><th class="hide-sm">${t("st.tokenScopes")}</th>
        <th class="hide-sm">${t("st.tokenExpires")}</th><th>${t("st.tokenLastUsed")}</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="list-more">${toggle}</div>`;
  card.querySelector("#stTokenCreate").addEventListener("click", () => createToken(view));
  card.querySelector("#stTokenPrune")?.addEventListener("click", () => pruneTokens(view, endedCount));
  card.querySelectorAll("[data-revoke-token]").forEach((btn) => {
    btn.addEventListener("click", () => revokeToken(view, btn.dataset.revokeToken, btn.dataset.tokenName));
  });
  card.querySelectorAll("[data-delete-token]").forEach((btn) => {
    btn.addEventListener("click", () => deleteToken(view, btn.dataset.deleteToken, btn.dataset.tokenName));
  });
  bindToggles(view, card, () => drawTokens(view, card, { tokens, catalog }));
}

function tokenRow(token, catalog) {
  const status = tokenStatus(token);
  const action = isEnded(token)
    ? `<button class="btn btn-sm btn-danger" data-delete-token="${esc(token.id)}" data-token-name="${esc(token.name)}">${icon("trash")}${t("st.tokenDelete")}</button>`
    : `<button class="btn btn-sm btn-danger" data-revoke-token="${esc(token.id)}" data-token-name="${esc(token.name)}">${icon("x")}${t("st.tokenRevoke")}</button>`;
  const used = token.lastUsedAt
    ? `${esc(relTime(token.lastUsedAt))}${token.lastUsedIp ? ` <span class="subtle">${esc(token.lastUsedIp)}</span>` : ""}`
    : `<span class="subtle">${t("st.tokenUnused")}</span>`;
  return `<tr>
    <td><strong>${esc(token.name)}</strong> <span class="badge ${status.badge}">${t(status.key)}</span></td>
    <td class="mono">${esc(token.prefix)}</td>
    <td class="hide-sm">${scopeSummary(token, catalog)}</td>
    <td class="hide-sm subtle nowrap">${token.expiresAt ? esc(dateTime(token.expiresAt)) : t("st.tokenNever")}</td>
    <td class="subtle nowrap">${used}</td>
    <td class="nowrap"><div class="actions">${action}</div></td>
  </tr>`;
}

async function createToken(view) {
  let catalog;
  try {
    catalog = await api("/api/tokens/presets");
  } catch (e) {
    toastError(t("st.tokenCreateFailed"), e);
    return;
  }
  const { root, close } = openDialog({
    title: t("st.tokenCreate"),
    description: t("st.tokenPresetHelp"),
    iconName: "key",
    wide: true,
    body: `
      <form id="stTokenForm" class="stack">
        <label class="field">${t("label.tokenName")}<input class="input" name="name" autocomplete="off" required /></label>
        ${presetFieldHtml(catalog, catalog.presets[0].name)}
        ${permissionsHtml(catalog)}
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
        <div class="grid grid-2 form-grid">
          <label class="field">${t("st.tokenQuotaBoxes")}<input class="input" name="maxBoxes" inputmode="numeric" /></label>
          <label class="field">${t("st.tokenQuotaCpus")}<input class="input" name="maxCpus" inputmode="decimal" /></label>
          <label class="field">${t("st.tokenQuotaMemory")}<input class="input" name="maxMemoryMb" inputmode="numeric" /></label>
          <label class="field">${t("st.tokenQuotaTtl")}<input class="input" name="maxTtlHours" inputmode="numeric" /></label>
          <label class="field">${t("st.tokenQuotaRate")}<input class="input" name="rateLimit" inputmode="numeric" /></label>
          <label class="field">${t("st.tokenQuotaCheckpoints")}<input class="input" name="maxCheckpoints" inputmode="numeric" /></label>
        </div>
      </form>`,
    footer: `<button class="btn" data-close type="button">${t("common.cancel")}</button><button class="btn btn-primary" id="stTokenSave" type="button">${t("st.tokenCreate")}</button>`,
  });
  const form = root.querySelector("#stTokenForm");
  const boxes = form.elements.boxes;
  const storageNote = document.createElement("p");
  storageNote.className = "help";
  storageNote.textContent = t("st.storageAdminPolicy");
  form.append(storageNote);
  const syncBoxes = () => {
    root.querySelector("[data-box-ids]").hidden = boxes.value !== "ids";
    root.querySelector("[data-box-tags]").hidden = boxes.value !== "tags";
  };
  boxes.addEventListener("change", syncBoxes);
  const hosts = form.elements.hosts;
  // A preset starts the box and host scope from its own: admin takes every box and host. A choice made by hand stays.
  const touched = new Set();
  for (const select of [boxes, hosts]) select.addEventListener("change", () => touched.add(select.name));
  const permissions = bindPermissions(root, catalog, {
    onPreset: (preset) => {
      if (!touched.has("boxes")) boxes.value = preset.boxes === "all" ? "*" : "created-by-me";
      if (!touched.has("hosts")) hosts.value = preset.hosts === "all" ? "*" : "local";
      syncBoxes();
    },
  });
  root
    .querySelector("#stTokenSave")
    .addEventListener("click", () => submitToken(view, form, close, permissions, catalog));
}

function numberOrSkip(value) {
  const text = value.trim();
  if (!text) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : Number.NaN;
}

async function submitToken(view, form, close, permissions, catalog) {
  const data = new FormData(form);
  const name = String(data.get("name") ?? "").trim();
  const invalid = nameError(name, "tokenName");
  if (invalid) {
    toast(t("st.tokenCreateFailed"), { type: "error", message: invalid });
    return;
  }
  const scopes = permissions.scopes();
  if (scopes.length === 0) {
    toast(t("st.tokenCreateFailed"), { type: "error", message: t("st.tokenScopesEmpty") });
    return;
  }
  const body = { name, ...scopeRequest(permissions.preset(), scopes, catalog) };
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
  const maxCheckpoints = numberOrSkip(String(data.get("maxCheckpoints") ?? ""));
  if (maxBoxes !== undefined) quotas.maxBoxes = maxBoxes;
  if (maxCpus !== undefined) quotas.maxCpus = maxCpus;
  if (maxMemoryMb !== undefined) quotas.maxMemoryMb = maxMemoryMb;
  if (maxTtlHours !== undefined) quotas.maxTtlSec = Math.round(maxTtlHours * 3600);
  if (rateLimit !== undefined) quotas.rateLimit = rateLimit;
  if (maxCheckpoints !== undefined) quotas.maxCheckpoints = maxCheckpoints;
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
      await copyText(secret);
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

async function deleteToken(view, id, name) {
  const ok = await confirmDialog({
    title: t("st.tokenDeleteTitle"),
    message: t("st.tokenDeleteMessage", { name: esc(name ?? id) }),
    confirmText: t("st.tokenDelete"),
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/tokens/${enc(id)}/record`, { method: "DELETE" });
  } catch (e) {
    toastError(t("st.tokenDeleteFailed"), e);
    loadTokens(view);
    return;
  }
  toast(t("st.tokenDeletedToast"), { message: name ?? "" });
  loadTokens(view);
}

async function pruneTokens(view, count) {
  const ok = await confirmDialog({
    title: t("st.tokenPruneTitle"),
    message: t("st.tokenPruneMessage", { n: count }),
    confirmText: t("st.tokenPrune"),
    danger: true,
  });
  if (!ok) return;
  let deleted;
  try {
    ({ deleted } = await api("/api/tokens/prune", { method: "POST", body: {} }));
  } catch (e) {
    toastError(t("st.tokenPruneFailed"), e);
    return;
  }
  toast(t("st.tokenPrunedToast", { n: deleted.length }));
  loadTokens(view);
}
