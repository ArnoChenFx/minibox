import { sameTemplate, templateFieldOf } from "../lib/box-rebuild-fields.js";
import { esc } from "../lib/dom.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { toast, withBusy } from "../lib/ui.js";
import { fetchStaged, onStaged, stageFields, stagedField } from "./staged-changes.js";

/**
 * The template card in a box's settings. The template a box runs is a rebuild setting, so saving it stages the change:
 * the card then shows the staged reference, marked as pending, and the banner above the settings applies it with the
 * other staged changes.
 */
export function templateCardHtml({ box, staged = null, editing = false, error = "" }) {
  const ref = staged ?? box.template ?? "";
  const pending = staged
    ? ` <span class="badge badge-warning" data-template-pending>${esc(t("stg.pendingBadge"))}</span>`
    : "";
  if (editing) {
    return `<div class="card">
      <div class="card-head"><h3>${esc(t("bd.templateCard"))}</h3></div>
      <div class="card-body stack">
        <p class="help">${esc(t("bd.templateEditHelp"))}</p>
        <div class="field"><label class="label" for="bsTemplateRef">${esc(t("bd.template"))}</label>
          <input class="input mono" id="bsTemplateRef" value="${esc(ref)}" autocomplete="off" autocapitalize="off" spellcheck="false" />
        </div>
        <div class="error-text" data-template-error>${esc(error)}</div>
      </div>
      <div class="card-body env-actions">
        <button type="button" class="btn" data-template-action="cancel">${esc(t("common.cancel"))}</button>
        <button type="button" class="btn btn-primary" data-template-action="save">${esc(t("common.save"))}</button>
      </div>
    </div>`;
  }
  return `<div class="card">
    <div class="card-head"><h3>${esc(t("bd.templateCard"))}${pending}</h3>
      <button type="button" class="btn btn-sm" data-template-action="edit">${icon("sliders")}${esc(t("env.edit"))}</button></div>
    <div class="card-body">
      <p class="help">${esc(t(staged ? "bd.templatePendingHelp" : "bd.templateHelp"))}</p>
      <dl class="kv"><dt>${esc(t("bd.template"))}</dt><dd class="mono">${esc(ref || "—")}</dd></dl>
    </div>
  </div>`;
}

/**
 * Mounts the template card. The card reads the staged changes once and follows every announcement, so it and the banner
 * always show the same state.
 */
export function mountTemplateCard(container, { box }) {
  let staged = null;
  let editing = false;
  let error = "";
  let disposed = false;
  let reads = 0;

  const draw = () => {
    if (disposed) return;
    container.innerHTML = templateCardHtml({ box: box(), staged, editing, error });
    if (editing) container.querySelector("#bsTemplateRef")?.focus();
  };

  const read = async () => {
    const seq = ++reads;
    try {
      const waiting = await fetchStaged(box().id);
      if (disposed || seq !== reads) return;
      staged = stagedField(waiting, "template");
    } catch {
      return;
    }
    draw();
  };

  const showError = (message = "") => {
    error = message;
    const slot = container.querySelector("[data-template-error]");
    if (slot) slot.textContent = message;
  };

  /** Stages the reference. A box whose template already matches has nothing staged for it, so the card shows the box's. */
  const save = async (button) => {
    const input = container.querySelector("#bsTemplateRef");
    const value = input?.value ?? "";
    if (sameTemplate({ template: staged ?? box().template }, value)) {
      editing = false;
      error = "";
      draw();
      return;
    }
    const checked = templateFieldOf(value);
    if ("problem" in checked) {
      showError(t(checked.problem));
      return;
    }
    showError();
    await withBusy(button, async () => {
      let waiting;
      try {
        waiting = await stageFields(box(), checked);
      } catch (err) {
        showError(`${err.message}${err.hint ? ` ${err.hint}` : ""}`);
        return;
      }
      staged = stagedField(waiting, "template");
      editing = false;
      error = "";
      toast(t(staged ? "stg.staged" : "stg.unstaged"), staged ? { message: t("stg.stagedText") } : {});
      draw();
    });
  };

  container.addEventListener("click", (event) => {
    const button = event.target.closest("[data-template-action]");
    if (!button) return;
    switch (button.dataset.templateAction) {
      case "edit":
        editing = true;
        error = "";
        draw();
        break;
      case "cancel":
        editing = false;
        error = "";
        draw();
        break;
      case "save":
        void save(button);
        break;
    }
  });

  container.addEventListener("input", (event) => {
    if (event.target.id === "bsTemplateRef") showError();
  });

  draw();
  void read();

  const offStaged = onStaged(
    () => box().boxId,
    (waiting) => {
      reads += 1;
      staged = stagedField(waiting, "template");
      if (!editing) draw();
    },
  );

  return {
    onBoxChange() {
      if (disposed || editing) return;
      draw();
    },
    dispose() {
      disposed = true;
      offStaged();
    },
  };
}
