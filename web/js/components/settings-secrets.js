import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { ENV_VALUE_MAX, SECRET_NAME_RE, validSecretValue } from "../lib/env.js";
import { dateTime, relTime } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { emptyState, openDialog, withBusy, toast, confirmDialog, toastError } from "../lib/ui.js";

export async function loadSecrets(view) {
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
    <div class="card-note"><p class="help">${t("st.secretsNote")}</p></div>
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
    <td class="nowrap"><strong>${esc(secret.name)}</strong></td>
    <td class="hide-sm subtle nowrap" title="${esc(dateTime(secret.updatedAt))}">${esc(relTime(secret.updatedAt))}</td>
    <td>${used}</td>
    <td class="nowrap"><div class="actions">
      <button class="btn btn-sm" data-secret-replace="${esc(secret.name)}" title="${esc(t("st.secretReplace"))}" aria-label="${esc(t("st.secretReplace"))}">${icon("key")}<span class="hide-sm">${t("st.secretReplace")}</span></button>
      <button class="btn btn-sm btn-danger" data-secret-delete="${esc(secret.name)}" title="${esc(t("st.secretDelete"))}" aria-label="${esc(t("st.secretDelete"))}">${icon("trash")}<span class="hide-sm">${t("st.secretDelete")}</span></button>
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
