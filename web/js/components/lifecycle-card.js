import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { dateTime } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import {
  idleModeOf,
  LIFETIME_UNITS,
  lifetimeDraft,
  lifetimePatch,
  MAX_LIFETIME_SEC,
  ttlModeOf,
} from "../lib/lifetime.js";
import { toast, withBusy } from "../lib/ui.js";

/** The idle-timeout modes, in the order the card lists them. `label` and `help` are dictionary keys. */
const IDLE_MODES = [
  { id: "inherit", label: "lc.idleInherit", help: "lc.idleInheritHelp" },
  { id: "never", label: "lc.idleNever", help: "lc.idleNeverHelp" },
  { id: "custom", label: "lc.idleCustom", help: "lc.idleCustomHelp" },
];

const TTL_MODES = [
  { id: "none", label: "lc.ttlNone", help: "lc.ttlNoneHelp" },
  { id: "set", label: "lc.ttlSet", help: "lc.ttlSetHelp" },
];

const modeButton = (group, mode) =>
  `<button type="button" class="seg" data-lc-${group}-mode="${mode.id}" aria-pressed="false"><strong>${esc(t(mode.label))}</strong><span>${esc(t(mode.help))}</span></button>`;

const unitOptions = (unit) =>
  LIFETIME_UNITS.map(
    (candidate) =>
      `<option value="${candidate.id}"${candidate.id === unit ? " selected" : ""}>${esc(t(`lc.unit.${candidate.id}`))}</option>`,
  ).join("");

/** The number and its unit for one lifetime. The number's own limit is the largest lifetime, in seconds. */
function lifetimeField({ name, label, help, draft }) {
  return `<div class="field" data-lc-part="${name}">
      <label class="label" for="lc-${name}">${esc(t(label))}</label>
      <div class="lifetime-row">
        <input class="input" id="lc-${name}" type="number" min="1" max="${MAX_LIFETIME_SEC}" step="1" inputmode="numeric" value="${draft.value}" data-lc-value="${name}" />
        <select class="select" data-lc-unit="${name}" aria-label="${esc(t(label))}">${unitOptions(draft.unit)}</select>
      </div>
      <div class="help">${esc(t(help))}</div>
    </div>`;
}

/** The card as it reads: what the box does now, with the button that opens the editor. */
export function lifecycleCardHtml(b) {
  return `<div class="card">
    <div class="card-head"><h3>${esc(t("bd.setLifecycle"))}</h3>
      <button type="button" class="btn btn-sm" data-lc-action="edit">${icon("sliders")}${esc(t("lc.edit"))}</button></div>
    <div class="card-body"><dl class="kv">
      <dt>${t("bd.desired")}</dt><dd>${b.desired === "stopped" ? t("bd.desiredStopped") : t("bd.desiredRunning")}</dd>
      <dt>${t("bd.sleeping")}</dt><dd>${b.sleeping ? t("bd.sleepingYes") : t("bd.sleepingNo")}${b.stopReason ? ` <span class="subtle">(${esc(t(`bd.stopReason.${b.stopReason}`))})</span>` : ""}</dd>
      <dt>${t("bd.lastActivity")}</dt><dd>${b.lastActivityAt ? dateTime(b.lastActivityAt) : t("bd.lastActivityUnknown")}</dd>
      <dt>${t("bd.idleTimeout")}</dt><dd>${b.idleTimeoutSec === 0 ? t("bd.idleNever") : b.idleTimeoutSec != null ? t("bd.seconds", { n: b.idleTimeoutSec }) : t("bd.idleInherit")}</dd>
      <dt>${t("bd.ttl")}</dt><dd>${b.ttlSec != null ? t("bd.seconds", { n: b.ttlSec }) : t("bd.ttlNone")}</dd>
    </dl><div class="callout" style="margin-top:16px">${icon("info")}<span>${esc(t("lc.viewNote"))}</span></div></div>
  </div>`;
}

/** The editor's markup, filled from the box's own values. Saving sends only what changed, and `null` is a value here. */
export function lifetimeFormHtml(box) {
  const idleDraft = lifetimeDraft(box.idleTimeoutSec ?? undefined);
  const ttlDraft = lifetimeDraft(box.ttlSec ?? undefined, 86_400);
  return `<div class="card lifecycle-form">
    <div class="card-head"><h3>${esc(t("bd.setLifecycle"))}</h3></div>
    <div class="card-body stack">
      <p class="help">${esc(t("lc.editHelp"))}</p>
      <div class="field"><span class="label">${esc(t("bd.idleTimeout"))}</span>
        <div class="segmented segmented-3" role="group" aria-label="${esc(t("bd.idleTimeout"))}">${IDLE_MODES.map((mode) => modeButton("idle", mode)).join("")}</div>
      </div>
      ${lifetimeField({ name: "idle", label: "lc.idleAfter", help: "lc.idleAfterHelp", draft: idleDraft })}
      <div class="field"><span class="label">${esc(t("bd.ttl"))}</span>
        <div class="segmented segmented-2" role="group" aria-label="${esc(t("bd.ttl"))}">${TTL_MODES.map((mode) => modeButton("ttl", mode)).join("")}</div>
        <div class="help">${esc(t("lc.ttlCountsFromCreate"))}</div>
      </div>
      ${lifetimeField({ name: "ttl", label: "lc.ttlAfter", help: "lc.ttlAfterHelp", draft: ttlDraft })}
      <div class="callout">${icon("info")}<span>${esc(t("lc.applyNote"))}</span></div>
      <div class="error-text" data-lc-error></div>
    </div>
    <div class="card-body env-actions">
      <button type="button" class="btn" data-lc-action="cancel">${esc(t("common.cancel"))}</button>
      <button type="button" class="btn btn-primary" data-lc-action="save">${esc(t("common.save"))}</button>
    </div>
  </div>`;
}

/**
 * The Lifecycle card of a box's settings: what the box does now, and an editor for its idle timeout and its TTL. Both are
 * in-place fields, so a save applies at once through `box.update` and needs no rebuild. A box that changed while the
 * editor was open keeps the values the editor holds: the save is refused with a conflict, and the editor stays open with
 * the server's message, as the environment card does.
 */
export function mountLifecycleCard(container, { box, refreshBox }) {
  let editing = null;
  let disposed = false;
  let shown = "";

  const showError = (message = "") => {
    const slot = container.querySelector("[data-lc-error]");
    if (slot) slot.textContent = message;
  };

  /** Marks the chosen modes and hides a lifetime the chosen mode does not use: inherit and never take no number. */
  const showModes = () => {
    const pressed = (group, fallback) =>
      container.querySelector(`[data-lc-${group}-mode][aria-pressed="true"]`)?.dataset[
        group === "idle" ? "lcIdleMode" : "lcTtlMode"
      ] ?? fallback;
    container.querySelector("[data-lc-part='idle']").hidden = pressed("idle", "inherit") !== "custom";
    container.querySelector("[data-lc-part='ttl']").hidden = pressed("ttl", "none") !== "set";
  };

  const pickMode = (group, mode) => {
    for (const button of container.querySelectorAll(`[data-lc-${group}-mode]`)) {
      const chosen = group === "idle" ? button.dataset.lcIdleMode : button.dataset.lcTtlMode;
      button.setAttribute("aria-pressed", String(chosen === mode));
    }
    showModes();
    showError();
  };

  const draw = () => {
    if (disposed) return;
    const html = editing ? lifetimeFormHtml(editing.box) : lifecycleCardHtml(box());
    if (html === shown) return;
    shown = html;
    container.innerHTML = html;
    if (editing) {
      pickMode("idle", idleModeOf(editing.box.idleTimeoutSec));
      pickMode("ttl", ttlModeOf(editing.box.ttlSec));
    }
  };

  const startEdit = () => {
    editing = { box: box() };
    draw();
    container.querySelector("[data-lc-value='idle']")?.focus();
  };

  const stopEdit = () => {
    editing = null;
    draw();
  };

  const readForm = () => ({
    idleMode: container.querySelector("[data-lc-idle-mode][aria-pressed='true']")?.dataset.lcIdleMode ?? "inherit",
    idleValue: container.querySelector("[data-lc-value='idle']").value,
    idleUnit: container.querySelector("[data-lc-unit='idle']").value,
    ttlMode: container.querySelector("[data-lc-ttl-mode][aria-pressed='true']")?.dataset.lcTtlMode ?? "none",
    ttlValue: container.querySelector("[data-lc-value='ttl']").value,
    ttlUnit: container.querySelector("[data-lc-unit='ttl']").value,
  });

  const save = async (button) => {
    const base = editing;
    const { patch, problem } = lifetimePatch(base.box, readForm());
    if (problem) {
      showError(t(problem === "idle" ? "lc.idleInvalid" : "lc.ttlInvalid", { max: MAX_LIFETIME_SEC }));
      return;
    }
    if (Object.keys(patch).length === 0) {
      stopEdit();
      return;
    }
    showError("");
    await withBusy(button, async () => {
      try {
        await api(`/api/boxes/${enc(box().id)}`, {
          method: "PATCH",
          body: patch,
          headers: { "if-match": String(base.box.revision) },
        });
        if (disposed) return;
        editing = null;
        toast(t("lc.saved"), { message: t("lc.savedText", { name: box().name }) });
        draw();
        // The card reads the box again, so the rows show the saved values whether or not a frame follows the save.
        void refreshBox().catch(() => undefined);
      } catch (err) {
        if (disposed || editing !== base) return;
        showError(`${err.message}${err.hint ? ` ${err.hint}` : ""}`);
      }
    });
  };

  container.addEventListener("click", (event) => {
    if (disposed) return;
    const idleMode = event.target.closest("[data-lc-idle-mode]");
    if (idleMode) return pickMode("idle", idleMode.dataset.lcIdleMode);
    const ttlMode = event.target.closest("[data-lc-ttl-mode]");
    if (ttlMode) return pickMode("ttl", ttlMode.dataset.lcTtlMode);
    const action = event.target.closest("[data-lc-action]");
    if (!action) return;
    switch (action.dataset.lcAction) {
      case "edit":
        startEdit();
        break;
      case "cancel":
        stopEdit();
        break;
      case "save":
        void save(action);
        break;
    }
  });

  container.addEventListener("input", (event) => {
    if (event.target.matches("[data-lc-value]")) showError();
  });

  draw();

  return {
    onBoxChange() {
      if (!disposed && !editing) draw();
    },
    dispose() {
      disposed = true;
    },
  };
}
