import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { dateTime, relTime } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { emptyState, openDialog, withBusy, toast, confirmDialog, toastError } from "../lib/ui.js";
import { bindToggles, limitList } from "./list-toggle.js";

/** The owner's public keys for direct SSH. Each one signs in to any box, with the box name as the username. */
export async function loadSshKeys(view) {
  const card = view.querySelector("#stSshKeys");
  if (!card) return;
  let keys;
  try {
    ({ keys } = await api("/api/ssh-keys"));
  } catch (e) {
    if (e.status === 401) {
      location.href = "/login";
      return;
    }
    card.innerHTML = `<div class="card-head"><h3>${t("st.sshKeys")}</h3></div>
      <div class="card-body"><div class="callout danger">${icon("alert")}<span>${esc(e.message)}</span></div></div>`;
    return;
  }
  drawSshKeys(view, card, { keys });
}

/**
 * Draws the SSH keys card from the data it already has. The list toggle redraws this, so expanding or collapsing the
 * list asks the API for nothing.
 */
function drawSshKeys(view, card, { keys }) {
  const { shown, toggle } = limitList(view, "sshKeys", keys);
  const rows = keys.length
    ? shown.map(keyRow).join("")
    : `<tr><td colspan="4">${emptyState({ iconName: "key", title: t("st.sshKeyNone") })}</td></tr>`;
  card.innerHTML = `
    <div class="card-head">
      <div><h3>${t("st.sshKeys")}</h3><p class="help">${t("st.sshKeysHelp")}</p></div>
      <button class="btn btn-sm btn-primary" id="stSshKeyAdd">${icon("plus")}${t("st.sshKeyAdd")}</button>
    </div>
    <div class="card-note"><p class="help">${t("st.sshKeysNote")}</p></div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>${t("st.sshKeyLabel")}</th><th class="hide-sm">${t("st.sshKeyAdded")}</th><th class="hide-sm">${t("st.sshKeyLastUsed")}</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="list-more">${toggle}</div>`;
  card.querySelector("#stSshKeyAdd").addEventListener("click", () => addDialog(view));
  card.querySelectorAll("[data-sshkey-delete]").forEach((btn) => {
    btn.addEventListener("click", () => deleteKey(view, btn.dataset.sshkeyDelete, btn.dataset.label));
  });
  bindToggles(view, card, () => drawSshKeys(view, card, { keys }));
}

function when(iso) {
  return iso
    ? `<span title="${esc(dateTime(iso))}">${esc(relTime(iso))}</span>`
    : `<span class="subtle">${t("st.sshKeyNever")}</span>`;
}

function keyRow(key) {
  return `<tr>
    <td class="ssh-key-cell"><strong>${esc(key.label)}</strong>
      <div class="subtle mono ssh-key-fp" title="${esc(key.fingerprint)}">${esc(key.algorithm)} · ${esc(key.fingerprint)}</div></td>
    <td class="hide-sm subtle nowrap">${when(key.createdAt)}</td>
    <td class="hide-sm subtle nowrap">${when(key.lastUsedAt)}</td>
    <td class="nowrap"><div class="actions">
      <button class="btn btn-sm btn-danger" data-sshkey-delete="${esc(key.id)}" data-label="${esc(key.label)}" title="${esc(t("st.sshKeyDelete"))}" aria-label="${esc(t("st.sshKeyDelete"))}">${icon("trash")}<span class="hide-sm">${t("st.sshKeyDelete")}</span></button>
    </div></td>
  </tr>`;
}

function addDialog(view) {
  const { root, close } = openDialog({
    title: t("st.sshKeyDialog"),
    description: t("st.sshKeyDialogHelp"),
    iconName: "key",
    body: `<form id="stSshKeyForm" class="stack" autocomplete="off">
      <label class="field">${t("st.sshKeyPublic")}
        <textarea class="textarea mono" name="publicKey" rows="4" autofocus required autocapitalize="off" spellcheck="false" placeholder="ssh-ed25519 AAAA… me@laptop"></textarea>
        <span class="help">${t("st.sshKeyPublicHelp")}</span></label>
      <label class="field">${t("st.sshKeyLabel")}
        <input class="input" name="label" maxlength="64" autocomplete="off" />
        <span class="help">${t("st.sshKeyLabelHelp")}</span></label>
      <div class="error-text" id="stSshKeyErr"></div>
    </form>`,
    footer: `<button class="btn" data-close type="button">${t("common.cancel")}</button><button class="btn btn-primary" id="stSshKeySave" type="button">${t("st.sshKeySave")}</button>`,
  });
  const error = root.querySelector("#stSshKeyErr");
  root.querySelector("#stSshKeySave").addEventListener("click", async (event) => {
    const data = new FormData(root.querySelector("#stSshKeyForm"));
    const publicKey = String(data.get("publicKey") ?? "").trim();
    const label = String(data.get("label") ?? "").trim();
    if (!publicKey) {
      error.textContent = t("err.ssh_key_invalid");
      return;
    }
    if (/PRIVATE KEY/.test(publicKey)) {
      error.textContent = t("err.ssh_key_private");
      return;
    }
    error.textContent = "";
    try {
      const { key } = await withBusy(event.currentTarget, () =>
        api("/api/ssh-keys", { method: "POST", body: label ? { publicKey, label } : { publicKey } }),
      );
      close();
      toast(t("st.sshKeySaved"), { message: key.label });
      loadSshKeys(view);
    } catch (e) {
      error.textContent = e.message;
    }
  });
}

async function deleteKey(view, id, label) {
  const ok = await confirmDialog({
    title: t("st.sshKeyDeleteTitle", { label }),
    message: t("st.sshKeyDeleteMessage"),
    confirmText: t("st.sshKeyDelete"),
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/ssh-keys/${enc(id)}`, { method: "DELETE" });
  } catch (e) {
    toastError(t("st.sshKeyDeleteFailed"), e);
    return;
  }
  toast(t("st.sshKeyDeleted"), { message: label });
  loadSshKeys(view);
}
