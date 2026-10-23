import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { canonicalEnv, checkEnvRows, envRowsOf } from "../lib/env.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { movedBoxHash } from "../lib/routes.js";
import { refreshHost } from "../lib/store.js";
import { confirmDialog, toast, withBusy } from "../lib/ui.js";
import { rebuildPreviewHtml } from "./box-actions.js";
import { bindEnvRows, envProblemText, envRow, readEnvRows, secretNames } from "./env-editor.js";

const MASK = "••••••••";

function revealLabel(revealed) {
  return t(revealed ? "env.hide" : "env.reveal");
}

function toggleReveal(button) {
  const span = button.closest("dd").querySelector("[data-plain]");
  const revealed = span.dataset.revealed !== "true";
  span.dataset.revealed = String(revealed);
  span.textContent = revealed ? span.dataset.plain : MASK;
  button.innerHTML = icon(revealed ? "eyeOff" : "eye");
  button.setAttribute("aria-pressed", String(revealed));
  button.setAttribute("aria-label", revealLabel(revealed));
  button.title = revealLabel(revealed);
}

function entryHtml(entry, secrets) {
  if (entry.secretRef !== undefined) {
    const missing = secrets !== null && !secrets.includes(entry.secretRef);
    return `<dt class="mono">${esc(entry.name)}</dt><dd class="env-kv-value"><span class="badge badge-accent env-secret">${esc(t("env.secretLabel", { name: entry.secretRef }))}</span>${
      missing ? ` <span class="badge badge-warning">${esc(t("env.secretMissing"))}</span>` : ""
    }</dd>`;
  }
  const value = entry.value ?? "";
  const shown = value
    ? `<span class="mono env-value" data-plain="${esc(value)}" data-revealed="false">${MASK}</span>
      <button type="button" class="icon-btn env-kv-reveal" data-env-action="reveal" aria-pressed="false" aria-label="${esc(revealLabel(false))}" title="${esc(revealLabel(false))}">${icon("eye")}</button>`
    : `<span class="subtle">${esc(t("env.emptyValue"))}</span>`;
  return `<dt class="mono">${esc(entry.name)}</dt><dd class="env-kv-value">${shown}</dd>`;
}

/**
 * The environment card on the overview tab. It reads the box from REST, because a live frame names the variables without
 * their values. A plain value stays masked until it is revealed, and a secret shows only its name. Saving rebuilds the box
 * after the same preview and confirmation as the rebuild dialog, and it is refused when the box changed since editing began.
 */
export function mountEnvCard(container, { box }) {
  let entries = [];
  let revision = null;
  let secrets = null;
  let loadError = "";
  let editing = false;
  let base = null;
  let disposed = false;
  let fetches = 0;

  container.innerHTML = `<div class="card"><div class="card-body"><span class="spinner"></span></div></div>`;

  const fetchBox = async () => {
    const seq = ++fetches;
    try {
      const { box: fresh } = await api(`/api/boxes/${enc(box().id)}`);
      if (disposed || seq !== fetches) return false;
      entries = fresh.env ?? [];
      revision = fresh.revision;
      loadError = "";
    } catch (e) {
      if (disposed || seq !== fetches) return false;
      loadError = e.message;
    }
    return true;
  };

  const drawView = () => {
    const body = entries.length
      ? `<dl class="kv env-kv">${entries.map((entry) => entryHtml(entry, secrets)).join("")}</dl>`
      : `<p class="subtle">${esc(t("env.none"))}</p>`;
    container.innerHTML = `<div class="card">
      <div class="card-head"><h3>${esc(t("env.section"))}</h3>
        <button type="button" class="btn btn-sm" data-env-action="edit">${icon("sliders")}${esc(t("env.edit"))}</button></div>
      <div class="card-body">
        <p class="help">${esc(t("env.detailHelp"))}</p>
        ${loadError ? `<div class="callout danger">${icon("alert")}<span>${esc(loadError)}</span></div>` : ""}
        ${body}
      </div>
    </div>`;
  };

  const drawEdit = () => {
    container.innerHTML = `<div class="card">
      <div class="card-head"><h3>${esc(t("env.section"))}</h3></div>
      <div class="card-body stack">
        <p class="help">${esc(t("env.editHelp"))}</p>
        <div class="env-rows" data-env-rows></div>
        <div><button type="button" class="btn" data-env-action="add">${icon("plus")}${esc(t("env.add"))}</button></div>
        <div class="callout">${icon("info")}<span>${esc(t("env.saveNote"))}</span></div>
        <div class="error-text" data-env-error></div>
      </div>
      <div class="card-body env-actions">
        <button type="button" class="btn" data-env-action="cancel">${esc(t("common.cancel"))}</button>
        <button type="button" class="btn btn-primary" data-env-action="save">${esc(t("common.save"))}</button>
      </div>
    </div>`;
    const rows = container.querySelector("[data-env-rows]");
    for (const row of envRowsOf(base.entries)) rows.append(envRow(row, secrets));
    bindEnvRows(rows, () => showError());
  };

  const draw = () => {
    if (disposed) return;
    if (editing) drawEdit();
    else drawView();
  };

  const showError = (message = "") => {
    const slot = container.querySelector("[data-env-error]");
    if (slot) slot.textContent = message;
  };

  const startEdit = () => {
    base = { entries, revision };
    editing = true;
    draw();
  };

  const stopEdit = () => {
    editing = false;
    base = null;
    draw();
  };

  const rebuild = async (env) => {
    const path = `/api/boxes/${enc(box().id)}/rebuild`;
    const headers = { "if-match": String(base.revision) };
    let result;
    try {
      result = await api(path, { method: "POST", body: { env }, headers });
    } catch (err) {
      if (err.code !== "confirmation_required" || !err.details?.preview) throw err;
      const ok = await confirmDialog({
        title: t("env.confirmTitle", { name: box().name }),
        message: esc(t("env.saveNote")),
        body: rebuildPreviewHtml(err.details.preview),
        confirmText: t("rb.apply"),
        danger: true,
        checkboxes: [{ key: "safetyCheckpoint", label: t("rb.safety"), help: t("rb.safetyHelp"), checked: true }],
      });
      if (!ok) return false;
      result = await api(path, {
        method: "POST",
        body: { env, confirm: true, safetyCheckpoint: ok.safetyCheckpoint },
        headers,
      });
    }
    const safety = result?.safety ? ` ${t("rb.safetyTaken")}` : "";
    toast(t("rb.done"), { message: t("rb.doneText", { name: box().name }) + safety });
    refreshHost();
    const next = result?.box?.id;
    const address = next && next !== box().id ? movedBoxHash(location.hash, box().id, next) : null;
    if (address) location.hash = address;
    return true;
  };

  const save = async (button) => {
    const checked = checkEnvRows(readEnvRows(container.querySelector("[data-env-rows]")));
    if ("problem" in checked) {
      showError(envProblemText(checked.problem));
      return;
    }
    if (canonicalEnv(checked.env) === canonicalEnv(base.entries)) {
      stopEdit();
      return;
    }
    showError();
    await withBusy(button, async () => {
      try {
        if (!(await rebuild(checked.env))) return;
      } catch (err) {
        showError(`${err.message}${err.hint ? ` ${err.hint}` : ""}`);
        return;
      }
      editing = false;
      base = null;
      await fetchBox();
      draw();
    });
  };

  container.addEventListener("click", (event) => {
    const button = event.target.closest("[data-env-action]");
    if (!button) return;
    switch (button.dataset.envAction) {
      case "edit":
        startEdit();
        break;
      case "cancel":
        stopEdit();
        break;
      case "add":
        container
          .querySelector("[data-env-rows]")
          .append(envRow({ name: "", kind: "value", value: "", secretRef: "" }, secrets));
        showError();
        break;
      case "save":
        void save(button);
        break;
      case "reveal":
        toggleReveal(button);
        break;
    }
  });

  void Promise.all([secretNames(), fetchBox()]).then(([names, current]) => {
    if (disposed || !current || editing) return;
    secrets = names;
    draw();
  });

  return {
    onBoxChange() {
      if (disposed || editing || box().revision === revision) return;
      void fetchBox().then((current) => {
        if (current && !editing) draw();
      });
    },
    dispose() {
      disposed = true;
    },
  };
}
