import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { bytes, dateTime, relTime } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { targetBody } from "../lib/target-state.js";
import { emptyState, withBusy, toastError, toast, openDialog, confirmDialog } from "../lib/ui.js";
import { bindToggles, limitList } from "./list-toggle.js";

export async function loadTargets(view) {
  const card = view.querySelector("#stTargets");
  if (!card) return;
  let targets;
  try {
    ({ targets } = await api("/api/targets"));
  } catch (e) {
    if (e.status === 401) {
      location.href = "/login";
      return;
    }
    card.innerHTML = `<div class="card-head"><h3>${t("st.targets")}</h3></div>
      <div class="card-body"><div class="callout danger">${icon("alert")}<span>${esc(e.message)}</span></div></div>`;
    return;
  }
  const { shown, toggle } = limitList(view, "targets", targets);
  const rows = targets.length
    ? shown.map(targetRow).join("")
    : `<tr><td colspan="5">${emptyState({ iconName: "upload", title: t("st.targetNone") })}</td></tr>`;
  card.innerHTML = `
    <div class="card-head">
      <div><h3>${t("st.targets")}</h3><p class="help">${t("st.targetsHelp")}</p></div>
      <button class="btn btn-sm btn-primary" id="stTargetAdd">${icon("plus")}${t("st.targetAdd")}</button>
    </div>
    <div class="table-wrap"><table class="table">
      <thead><tr>
        <th>${t("label.targetName")}</th><th class="hide-sm">${t("st.targetColAddress")}</th><th>${t("st.targetColLastSync")}</th>
        <th class="hide-sm">${t("st.targetColSize")}</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="list-more">${toggle}</div>`;
  card.querySelector("#stTargetAdd").addEventListener("click", () => targetDialog(view));
  card.querySelectorAll("[data-target-check]").forEach((btn) => {
    btn.addEventListener("click", () => checkTarget(btn, btn.dataset.targetCheck, btn.dataset.targetName));
  });
  card.querySelectorAll("[data-target-remove]").forEach((btn) => {
    btn.addEventListener("click", () => removeTarget(view, btn.dataset.targetRemove, btn.dataset.targetName));
  });
  bindToggles(view, card, () => loadTargets(view));
}

function targetRow(target) {
  const folder = target.path ? `<div class="help">${esc(t("st.targetFolder", { path: target.path }))}</div>` : "";
  const missing = target.credentials
    ? ""
    : `<div class="help"><span class="badge badge-danger">${esc(t("st.targetCredentialsMissing"))}</span></div>`;
  const sync = target.lastSync;
  return `<tr>
    <td class="nowrap"><strong>${esc(target.name)}</strong> <span class="badge">${esc(t(`st.targetKind.${target.kind}`))}</span>${missing}</td>
    <td class="hide-sm"><span class="mono">${esc(target.address)}</span>${folder}</td>
    <td>${sync ? syncText(sync) : `<span class="subtle">${esc(t("st.targetNeverSynced"))}</span>`}</td>
    <td class="hide-sm nowrap">${sync ? bytes(sync.bytes) : "—"}</td>
    <td class="nowrap"><div class="actions">
      <button class="btn btn-sm" data-target-check="${esc(target.id)}" data-target-name="${esc(target.name)}">${icon("refresh")}<span class="hide-sm">${t("st.targetCheck")}</span></button>
      <button class="btn btn-sm btn-danger" data-target-remove="${esc(target.id)}" data-target-name="${esc(target.name)}">${icon("trash")}<span class="hide-sm">${t("st.targetRemove")}</span></button>
    </div></td>
  </tr>`;
}

function syncText(sync) {
  const when = `<span title="${esc(dateTime(sync.at))}">${esc(relTime(sync.at))}</span>`;
  const what = `<div class="help">${esc(t(`st.targetDirection.${sync.direction}`))} · ${esc(t(`st.targetObject.${sync.kind}`))} <span class="mono">${esc(sync.object)}</span></div>`;
  const failed = sync.error ? `<div class="error-text">${esc(sync.error)}</div>` : "";
  return `${when}${what}${failed}`;
}

async function checkTarget(button, id, name) {
  try {
    await withBusy(button, () => api(`/api/targets/${enc(id)}/check`));
  } catch (e) {
    toastError(t("st.targetCheckFailed"), e);
    return;
  }
  toast(t("st.targetChecked"), { message: name });
}

async function removeTarget(view, id, name) {
  const ok = await confirmDialog({
    title: t("st.targetRemoveTitle", { name }),
    message: t("st.targetRemoveMessage"),
    confirmText: t("st.targetRemove"),
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/targets/${enc(id)}`, { method: "DELETE" });
  } catch (e) {
    toastError(t("st.targetRemoveFailed"), e);
    return;
  }
  toast(t("st.targetRemoved"), { message: name });
  loadTargets(view);
}

const valuesOf = (form) => Object.fromEntries(new FormData(form));
/** Changing either of these points at another server, so a host key confirmed for the old one no longer applies. */
const HOST_FIELDS = new Set(["host", "port"]);

/**
 * Adds a target. An S3 target is saved as typed. An SFTP server is pinned to the host key it presents: a test shows that
 * key, the operator confirms it, and the target is saved with it. Saving an SFTP target runs that test first when no key
 * has been confirmed yet.
 */
function targetDialog(view) {
  const { root, close } = openDialog({
    title: t("st.targetAddTitle"),
    description: t("st.targetDialogHelp"),
    iconName: "upload",
    wide: true,
    body: `
      <form id="stTargetForm" class="stack" autocomplete="off">
        <div class="grid grid-2 form-grid">
          <label class="field">${t("label.targetName")}<input class="input" name="name" maxlength="64" autofocus /></label>
          <label class="field">${t("st.targetTypeLabel")}<select class="select" name="kind">
            <option value="s3">${esc(t("st.targetKind.s3"))}</option>
            <option value="sftp">${esc(t("st.targetKind.sftp"))}</option>
            <option value="webdav">${esc(t("st.targetKind.webdav"))}</option>
          </select></label>
        </div>
        <label class="field">${t("st.targetPath")}<input class="input mono" name="path" maxlength="512" spellcheck="false" /><span class="help">${t("st.targetPathHelp")}</span></label>
        <div class="stack" data-target-kind="s3">
          <div class="grid grid-2 form-grid">
            <label class="field">${t("label.endpoint")}<input class="input mono" name="endpoint" inputmode="url" placeholder="https://s3.example.com" spellcheck="false" /><span class="help">${t("st.targetEndpointHelp")}</span></label>
            <label class="field">${t("label.region")}<input class="input mono" name="region" placeholder="us-east-1" spellcheck="false" /></label>
            <label class="field">${t("label.bucket")}<input class="input mono" name="bucket" maxlength="63" spellcheck="false" /></label>
            <label class="field">${t("label.accessKeyId")}<input class="input mono" name="accessKeyId" autocomplete="off" spellcheck="false" /></label>
          </div>
          <label class="field">${t("label.secretAccessKey")}<input class="input mono" name="secretAccessKey" type="password" autocomplete="new-password" spellcheck="false" /><span class="help">${t("st.targetSecretHelp")}</span></label>
        </div>
        <div class="stack" data-target-kind="sftp" hidden>
          <div class="grid grid-2 form-grid">
            <label class="field">${t("label.host")}<input class="input mono" name="host" spellcheck="false" /></label>
            <label class="field">${t("label.port")}<input class="input mono" name="port" type="number" min="1" max="65535" placeholder="22" /></label>
            <label class="field">${t("label.user")}<input class="input mono" name="user" autocomplete="off" spellcheck="false" /></label>
          </div>
          <label class="field">${t("label.privateKey")}<textarea class="textarea mono" name="privateKey" rows="4" spellcheck="false"></textarea><span class="help">${t("st.targetSecretHelp")}</span></label>
        </div>
        <div class="stack" data-target-kind="webdav" hidden>
          <label class="field">${t("label.url")}<input class="input mono" name="url" inputmode="url" placeholder="https://dav.example.com/remote.php/dav/files/USER" spellcheck="false" /><span class="help">${t("st.targetWebdavUrlHelp")}</span></label>
          <div class="grid grid-2 form-grid">
            <label class="field">${t("label.user")}<input class="input mono" name="user" autocomplete="off" spellcheck="false" /></label>
            <label class="field">${t("label.password")}<input class="input mono" name="password" type="password" autocomplete="new-password" spellcheck="false" /><span class="help">${t("st.targetSecretHelp")}</span></label>
          </div>
        </div>
        <div id="stTargetResult"></div>
        <div class="error-text" id="stTargetErr"></div>
      </form>`,
    footer: `<button class="btn" data-close type="button">${t("common.cancel")}</button><button class="btn" id="stTargetTest" type="button">${icon("refresh")}${t("st.targetTest")}</button><button class="btn btn-primary" id="stTargetSave" type="button">${icon("plus")}${t("st.targetSave")}</button>`,
  });
  const form = root.querySelector("#stTargetForm");
  const result = root.querySelector("#stTargetResult");
  const error = root.querySelector("#stTargetErr");
  const kind = form.elements.namedItem("kind");
  let fingerprint = "";

  const clearResult = () => {
    result.innerHTML = "";
    error.textContent = "";
  };
  form.addEventListener("submit", (event) => event.preventDefault());
  kind.addEventListener("change", () => {
    for (const panel of form.querySelectorAll("[data-target-kind]"))
      panel.hidden = panel.dataset.targetKind !== kind.value;
    fingerprint = "";
    clearResult();
  });
  form.addEventListener("input", (event) => {
    if (HOST_FIELDS.has(event.target.name)) fingerprint = "";
    clearResult();
  });

  /** Reaches the target as typed. Returns the host key the SFTP server presented, when it has not been confirmed yet. */
  async function probe(pinned) {
    result.innerHTML = `<div class="callout">${icon("refresh")}<span>${esc(t("st.targetTesting"))}</span></div>`;
    try {
      await api("/api/targets/test", {
        method: "POST",
        body: targetBody(valuesOf(form), { named: false, fingerprint: pinned }),
      });
      return { ok: true };
    } catch (e) {
      if (e.key === "target_host_key_unconfirmed" && typeof e.details?.fingerprint === "string") {
        result.innerHTML = "";
        return { presented: e.details.fingerprint };
      }
      result.innerHTML = `<div class="callout danger">${icon("alert")}<span>${esc(e.message)}</span></div>`;
      return { ok: false };
    }
  }

  async function test() {
    let outcome = await probe(fingerprint);
    if (outcome.presented) {
      const confirmed = await confirmDialog({
        title: t("st.targetTrustTitle"),
        message: esc(t("st.targetTrustMessage", { fingerprint: outcome.presented })),
        confirmText: t("st.targetTrust"),
      });
      if (!confirmed) return false;
      fingerprint = outcome.presented;
      outcome = await probe(fingerprint);
    }
    if (!outcome.ok) return false;
    const pinned =
      kind.value === "sftp" && fingerprint
        ? `<div class="callout">${icon("info")}<span>${esc(t("st.targetFingerprint", { fingerprint }))}</span></div>`
        : "";
    result.innerHTML = `<div class="callout">${icon("check")}<span>${esc(t("st.targetTestOk"))}</span></div>${pinned}`;
    return true;
  }

  root.querySelector("#stTargetTest").addEventListener("click", (event) => withBusy(event.currentTarget, test));
  root.querySelector("#stTargetSave").addEventListener("click", (event) =>
    withBusy(event.currentTarget, async () => {
      error.textContent = "";
      if (kind.value === "sftp" && !fingerprint && !(await test())) return;
      const body = targetBody(valuesOf(form), { fingerprint });
      try {
        await api("/api/targets", { method: "POST", body });
      } catch (e) {
        error.textContent = e.message;
        return;
      }
      close();
      toast(t("st.targetAdded"), { message: body.name });
      loadTargets(view);
    }),
  );
}
