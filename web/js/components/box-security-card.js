import { profileFieldOf, SECURITY_PROFILES } from "../lib/box-rebuild-fields.js";
import { esc } from "../lib/dom.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { toast, withBusy } from "../lib/ui.js";
import { fetchStaged, onStaged, stageFields, stagedField } from "./staged-changes.js";

/** The profile a box gets when it is created without one, and the one an editor starts on when there is none. */
const DEFAULT_PROFILE = "standard";

const profileLabel = (profile) => (profile ? t(`profile.${profile}`) : t("bd.profileLegacy"));

const profileButton = (profile, pressed) =>
  `<button type="button" class="seg" data-profile-choice="${esc(profile)}" aria-pressed="${pressed}"><strong>${esc(t(`profile.${profile}`))}</strong><span>${esc(t(`profile.${profile}Hint`))}</span></button>`;

/**
 * The security card of a box's settings: the profile the box was built with and the agent token it holds. The profile is
 * a rebuild setting, so choosing another one stages it; the card then shows the staged profile, marked as pending, and
 * the banner above the settings applies it. The agent token is fixed at create time and only shown here.
 */
export function securityCardHtml({ box, staged = null, editing = false, error = "" }) {
  // A box created before profiles existed has none; its editor starts on the default, which staging upgrades it to.
  const current = staged ?? box.profile ?? DEFAULT_PROFILE;
  const pending = staged
    ? ` <span class="badge badge-warning" data-profile-pending>${esc(t("stg.pendingBadge"))}</span>`
    : "";
  if (editing) {
    return `<div class="card">
      <div class="card-head"><h3>${esc(t("bd.setSecurity"))}</h3></div>
      <div class="card-body stack">
        <p class="help">${esc(t("bd.profileEditHelp"))}</p>
        <div class="field"><span class="label">${esc(t("bd.profile"))}</span>
          <div class="segmented segmented-3" role="group" aria-label="${esc(t("bd.profile"))}">${SECURITY_PROFILES.map((profile) => profileButton(profile, profile === current)).join("")}</div>
        </div>
        <div class="callout">${icon("info")}<span>${esc(t("bd.profileSaveNote"))}</span></div>
        <div class="error-text" data-profile-error>${esc(error)}</div>
      </div>
      <div class="card-body env-actions">
        <button type="button" class="btn" data-profile-action="cancel">${esc(t("common.cancel"))}</button>
        <button type="button" class="btn btn-primary" data-profile-action="save">${esc(t("common.save"))}</button>
      </div>
    </div>`;
  }
  return `<div class="card">
    <div class="card-head"><h3>${esc(t("bd.setSecurity"))}${pending}</h3>
      <button type="button" class="btn btn-sm" data-profile-action="edit">${icon("sliders")}${esc(t("env.edit"))}</button></div>
    <div class="card-body stack">
      <p class="help">${esc(t(staged ? "bd.profilePendingHelp" : "bd.securityHelp"))}</p>
      <dl class="kv">
        <dt>${esc(t("bd.profile"))}</dt><dd>${esc(profileLabel(current))}</dd>
        <dt>${esc(t("bd.selfToken"))}</dt><dd>${box.selfToken ? esc(t("bd.selfTokenOn")) : esc(t("bd.selfTokenOff"))}</dd>
      </dl>
    </div>
  </div>`;
}

/** Mounts the security card. It reads the staged changes once and follows every announcement. */
export function mountSecurityCard(container, { box }) {
  let staged = null;
  let editing = false;
  let error = "";
  let disposed = false;
  let reads = 0;

  const draw = () => {
    if (disposed) return;
    container.innerHTML = securityCardHtml({ box: box(), staged, editing, error });
  };

  const read = async () => {
    const seq = ++reads;
    try {
      const waiting = await fetchStaged(box().id);
      if (disposed || seq !== reads) return;
      staged = stagedField(waiting, "profile");
    } catch {
      return;
    }
    draw();
  };

  const showError = (message = "") => {
    error = message;
    const slot = container.querySelector("[data-profile-error]");
    if (slot) slot.textContent = message;
  };

  const chosen = () =>
    container.querySelector("[data-profile-choice][aria-pressed='true']")?.dataset.profileChoice ?? "";

  const pick = (profile) => {
    for (const button of container.querySelectorAll("[data-profile-choice]")) {
      button.setAttribute("aria-pressed", String(button.dataset.profileChoice === profile));
    }
    showError();
  };

  /** Stages the profile. A box that already holds it has nothing staged for it, so the card shows the box's. */
  const save = async (button) => {
    const field = profileFieldOf(chosen());
    if (!field) {
      showError(t("bd.profileInvalid"));
      return;
    }
    if (field.profile === (staged ?? box().profile ?? DEFAULT_PROFILE)) {
      editing = false;
      error = "";
      draw();
      return;
    }
    showError();
    await withBusy(button, async () => {
      let waiting;
      try {
        waiting = await stageFields(box(), field);
      } catch (err) {
        showError(`${err.message}${err.hint ? ` ${err.hint}` : ""}`);
        return;
      }
      staged = stagedField(waiting, "profile");
      editing = false;
      error = "";
      toast(t(staged ? "stg.staged" : "stg.unstaged"), staged ? { message: t("stg.stagedText") } : {});
      draw();
    });
  };

  container.addEventListener("click", (event) => {
    const choice = event.target.closest("[data-profile-choice]");
    if (choice) return pick(choice.dataset.profileChoice);
    const button = event.target.closest("[data-profile-action]");
    if (!button) return;
    switch (button.dataset.profileAction) {
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

  draw();
  void read();

  const offStaged = onStaged(
    () => box().boxId,
    (waiting) => {
      reads += 1;
      staged = stagedField(waiting, "profile");
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
