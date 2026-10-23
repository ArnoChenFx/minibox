import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { canonicalEnv, checkEnvRows, envRowsOf } from "../lib/env.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { toast, withBusy } from "../lib/ui.js";
import { bindEnvRows, envProblemText, envRow, readEnvRows, secretNames } from "./env-editor.js";
import { fetchStaged, onStaged, stageFields, stagedField } from "./staged-changes.js";

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
 * The environment card in a box's settings. It reads the box from REST, because a live frame names the variables without
 * their values. A plain value stays masked until it is revealed, and a secret shows only its name. Saving stages the
 * environment for the next rebuild instead of rebuilding: the card then shows the staged variables, marked as pending,
 * and the banner above the settings applies them with the other staged changes.
 */
export function mountEnvCard(container, { box }) {
  let entries = [];
  /** The staged environment, or null when none waits. It is what the card shows and what editing starts from. */
  let staged = null;
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
      const [{ box: fresh }, waiting] = await Promise.all([
        api(`/api/boxes/${enc(box().id)}`),
        fetchStaged(box().id).catch(() => null),
      ]);
      if (disposed || seq !== fetches) return false;
      entries = fresh.env ?? [];
      staged = stagedField(waiting, "env");
      revision = fresh.revision;
      loadError = "";
    } catch (e) {
      if (disposed || seq !== fetches) return false;
      loadError = e.message;
    }
    return true;
  };

  const drawView = () => {
    const shown = staged ?? entries;
    const body = shown.length
      ? `<dl class="kv env-kv">${shown.map((entry) => entryHtml(entry, secrets)).join("")}</dl>`
      : `<p class="subtle">${esc(t("env.none"))}</p>`;
    const pending = staged
      ? ` <span class="badge badge-warning" data-env-pending>${esc(t("stg.pendingBadge"))}</span>`
      : "";
    container.innerHTML = `<div class="card">
      <div class="card-head"><h3>${esc(t("env.section"))}${pending}</h3>
        <button type="button" class="btn btn-sm" data-env-action="edit">${icon("sliders")}${esc(t("env.edit"))}</button></div>
      <div class="card-body">
        <p class="help">${esc(t(staged ? "env.pendingHelp" : "env.detailHelp"))}</p>
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
        <div class="row-editor">
          <div class="env-rows" data-env-rows></div>
          <button type="button" class="btn" data-env-action="add">${icon("plus")}${esc(t("env.add"))}</button>
        </div>
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
    base = { entries: staged ?? entries, revision };
    editing = true;
    draw();
  };

  const stopEdit = () => {
    editing = false;
    base = null;
    draw();
  };

  /** Stages the environment. A box whose env already matches has nothing staged for it, so the card shows the box's. */
  const stage = async (env) => {
    const waiting = await stageFields(box(), { env });
    staged = stagedField(waiting, "env");
    toast(t(staged ? "stg.staged" : "stg.unstaged"), staged ? { message: t("stg.stagedText") } : {});
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
        await stage(checked.env);
      } catch (err) {
        showError(`${err.message}${err.hint ? ` ${err.hint}` : ""}`);
        return;
      }
      editing = false;
      base = null;
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

  const offStaged = onStaged(
    () => box().boxId,
    (waiting) => {
      staged = stagedField(waiting, "env");
      if (!editing) draw();
    },
  );

  return {
    onBoxChange() {
      if (disposed || editing || box().revision === revision) return;
      void fetchBox().then((current) => {
        if (current && !editing) draw();
      });
    },
    dispose() {
      disposed = true;
      offStaged();
    },
  };
}
