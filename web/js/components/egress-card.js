import { api, enc } from "../lib/api.js";
import { egressDraftOf, egressFieldOf, sameEgressDraft } from "../lib/box-rebuild-fields.js";
import { esc } from "../lib/dom.js";
import {
  denialReasonKey,
  EGRESS_PRESETS,
  EGRESS_TIERS,
  presetHintKey,
  presetKey,
  tierHintKey,
  tierKey,
} from "../lib/egress.js";
import { dateTime } from "../lib/format.js";
import { has, t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { pollWhileDown, subscribe } from "../lib/live.js";
import { toast, withBusy } from "../lib/ui.js";
import { fetchStaged, onStaged, stageFields, stagedField } from "./staged-changes.js";

/** How many recent denials the card lists. */
const DENIALS_LIMIT = 10;
/** How often the denials are read again while the live stream is down. */
const POLL_MS = 5000;
/** A burst of denials reads the list once, after it has settled. */
const REFRESH_DEBOUNCE_MS = 300;

/** Open is the ordinary state; the two restricted tiers get the accent. */
const TIER_TONE = { open: "", none: "badge-accent", "proxy-only": "badge-accent" };

const destinationOf = (detail) => (typeof detail.host === "string" ? `${detail.host}:${detail.port ?? ""}` : "—");

function reasonOf(detail) {
  const reason = typeof detail.reason === "string" ? detail.reason : "";
  const key = denialReasonKey(reason);
  return has(key) ? t(key) : reason || "—";
}

function denialsHtml(denials, error) {
  if (error) {
    return `<div class="callout danger">${icon("alert")}<span><strong>${esc(t("egress.denialsFailed"))}</strong> ${esc(error)}</span></div>`;
  }
  if (denials === null) return `<div class="skeleton sk-line"></div>`;
  if (denials.length === 0) return `<p class="subtle">${esc(t("egress.denialsEmpty"))}</p>`;
  const rows = denials
    .map((event) => {
      const detail = event.detail ?? {};
      return `<tr><td class="subtle">${esc(dateTime(new Date(event.ts).toISOString()))}</td><td class="mono">${esc(destinationOf(detail))}</td><td>${esc(reasonOf(detail))}</td></tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table class="table"><thead><tr><th>${esc(t("egress.colTime"))}</th><th>${esc(t("egress.colDestination"))}</th><th>${esc(t("egress.colReason"))}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/**
 * The network card's markup. The tier and what it means are always shown. A proxy-only box also shows its presets, its
 * allowlist and its recent denials, which `denials` holds once read (null while the read is pending). `staged` is the
 * staged policy when one waits, and the card then marks the tier as pending.
 */
export function egressCardHtml({ box, denials = null, denialsError = "", staged = null }) {
  const egress = staged ?? box.egress ?? null;
  const mode = egress?.mode ?? "open";
  const proxied = mode === "proxy-only";
  const presets = egress?.presets ?? [];
  const allow = egress?.allow ?? [];
  const details = proxied
    ? `<dl class="kv">
        <dt>${esc(t("egress.presets"))}</dt><dd>${esc(presets.length ? presets.map((preset) => t(presetKey(preset))).join(", ") : t("egress.presetsNone"))}</dd>
        <dt>${esc(t("egress.allowed"))}</dt><dd>${allow.length ? `<span class="egress-hosts">${allow.map((host) => `<span class="tag mono">${esc(host)}</span>`).join("")}</span>` : esc(t("egress.allowedNone"))}</dd>
      </dl>
      <div class="stack"><span class="label">${esc(t("egress.denials"))}</span><p class="help">${esc(t("egress.denialsHelp"))}</p>${denialsHtml(denials, denialsError)}</div>`
    : "";
  return `<div class="card">
    <div class="card-head"><h3>${esc(t("egress.section"))}${staged ? ` <span class="badge badge-warning" data-egress-pending>${esc(t("stg.pendingBadge"))}</span>` : ""}</h3>
      <button type="button" class="btn btn-sm" data-egress-action="edit">${icon("sliders")}${esc(t("egress.edit"))}</button></div>
    <div class="card-body stack">
      ${staged ? `<p class="help">${esc(t("egress.pendingHelp"))}</p>` : ""}
      <div class="egress-tier"><span class="badge ${TIER_TONE[mode] ?? ""}">${esc(t(tierKey(mode)))}</span><span class="help">${esc(t(tierHintKey(mode)))}</span></div>
      ${details}
    </div>
  </div>`;
}

/** A change of container or tier is a different network, so the denials are read again. */
const keyOf = (box) => `${box.id}/${box.egress?.mode ?? "open"}`;

/** Whether a draft holds the policy the box has or the one already staged, so a save that changes nothing stages nothing. */
const sameEgress = (a, b) => sameEgressDraft(egressDraftOf(a), egressDraftOf(b));

const tierButton = (mode, pressed) =>
  `<button type="button" class="seg" data-egress-tier="${esc(mode)}" aria-pressed="${pressed}"><strong>${esc(t(tierKey(mode)))}</strong><span>${esc(t(tierHintKey(mode)))}</span></button>`;

const presetRow = (preset, checked) => `<label class="check-row">
  <input class="sr-only" type="checkbox" value="${esc(preset)}" data-egress-preset="${esc(preset)}"${checked ? " checked" : ""} />
  <span class="check-mark" aria-hidden="true">${icon("check")}</span>
  <span class="check-body"><span class="check-title"><strong>${esc(t(presetKey(preset)))}</strong></span><span class="help">${esc(t(presetHintKey(preset)))}</span></span></label>`;

/**
 * The editor the network card opens: the three tiers, and for proxy-only the presets and the extra hosts. A save stages
 * the policy instead of rebuilding, so the box keeps its container until the banner applies the change.
 */
export function egressFormHtml({ draft, error = "" }) {
  const proxied = draft.mode === "proxy-only";
  return `<div class="card egress-form">
    <div class="card-head"><h3>${esc(t("egress.section"))}</h3></div>
    <div class="card-body stack">
      <p class="help">${esc(t("egress.editHelp"))}</p>
      <div class="field"><span class="label">${esc(t("cb.egress"))}</span>
        <div class="segmented segmented-3" role="group" aria-label="${esc(t("cb.egress"))}">${EGRESS_TIERS.map((mode) => tierButton(mode, mode === draft.mode)).join("")}</div>
      </div>
      <div data-egress-proxy${proxied ? "" : " hidden"}>
        <div class="field"><span class="label">${esc(t("egress.presets"))}</span>
          <div class="tool-checks">${EGRESS_PRESETS.map((preset) => presetRow(preset, draft.presets.includes(preset))).join("")}</div></div>
        <div class="field"><label class="label" for="bsEgressDomains">${esc(t("egress.domains"))}</label>
          <textarea class="textarea mono" id="bsEgressDomains" rows="2" spellcheck="false" autocapitalize="off">${esc(draft.domains)}</textarea>
          <div class="help">${esc(t("egress.domainsHelp"))}</div></div>
      </div>
      <div class="callout">${icon("info")}<span>${esc(t("egress.saveNote"))}</span></div>
      <div class="error-text" data-egress-error>${esc(error)}</div>
    </div>
    <div class="card-body env-actions">
      <button type="button" class="btn" data-egress-action="cancel">${esc(t("common.cancel"))}</button>
      <button type="button" class="btn btn-primary" data-egress-action="save">${esc(t("common.save"))}</button>
    </div>
  </div>`;
}

/**
 * The network card of a box's settings. It shows the box's tier; a proxy-only box also shows its allowlist and recent
 * denials, which come from the event log and are read again as the live stream reports one, or every few seconds while
 * the stream is down. Its editor stages a change of tier, presets or hosts instead of rebuilding, so the card marks the
 * tier as pending until the banner applies it.
 */
export function mountEgressCard(container, { box }) {
  let denials = null;
  let denialsError = "";
  let disposed = false;
  let reads = 0;
  let shown = "";
  let seen = keyOf(box());
  let refreshTimer = null;
  /** The staged policy, or null when none waits. It is what the card shows and what editing starts from. */
  let staged = null;
  let editing = null;
  let error = "";

  const paint = () => {
    if (disposed) return;
    const html = editing
      ? egressFormHtml({ draft: editing, error })
      : egressCardHtml({ box: box(), denials, denialsError, staged });
    if (html === shown) return;
    shown = html;
    container.innerHTML = html;
  };

  const showError = (message = "") => {
    error = message;
    const slot = container.querySelector("[data-egress-error]");
    if (slot) slot.textContent = message;
  };

  /** Shows the presets and hosts only for proxy-only, the one tier that uses them. */
  const showProxy = () => {
    const proxied =
      container.querySelector("[data-egress-tier][aria-pressed='true']")?.dataset.egressTier === "proxy-only";
    const panel = container.querySelector("[data-egress-proxy]");
    if (panel) panel.hidden = !proxied;
  };

  const pickTier = (mode) => {
    if (!editing) return;
    editing.mode = mode;
    for (const button of container.querySelectorAll("[data-egress-tier]")) {
      button.setAttribute("aria-pressed", String(button.dataset.egressTier === mode));
    }
    showProxy();
    showError();
  };

  const readDraft = () => ({
    mode: container.querySelector("[data-egress-tier][aria-pressed='true']")?.dataset.egressTier ?? "open",
    presets: [...container.querySelectorAll("[data-egress-preset]")]
      .filter((box) => box.checked)
      .map((box) => box.value),
    domains: container.querySelector("#bsEgressDomains")?.value ?? "",
  });

  /** Stages the policy. A box that already holds it has nothing staged for it, so the card shows the box's. */
  const save = async (button) => {
    const base = editing;
    const draft = readDraft();
    if (sameEgress(egressFieldOf(draft), staged ?? box().egress ?? null)) {
      editing = null;
      error = "";
      paint();
      return;
    }
    showError();
    await withBusy(button, async () => {
      let waiting;
      try {
        waiting = await stageFields(box(), { egress: egressFieldOf(draft) });
      } catch (err) {
        if (disposed || editing !== base) return;
        showError(`${err.message}${err.hint ? ` ${err.hint}` : ""}`);
        return;
      }
      staged = stagedField(waiting, "egress");
      editing = null;
      error = "";
      toast(t(staged ? "stg.staged" : "stg.unstaged"), staged ? { message: t("stg.stagedText") } : {});
      void read();
      paint();
    });
  };

  container.addEventListener("click", (event) => {
    const tier = event.target.closest("[data-egress-tier]");
    if (tier) return pickTier(tier.dataset.egressTier);
    const button = event.target.closest("[data-egress-action]");
    if (!button) return;
    switch (button.dataset.egressAction) {
      case "edit":
        editing = egressDraftOf(staged ?? box().egress ?? null);
        error = "";
        paint();
        container.querySelector("#bsEgressDomains")?.focus();
        break;
      case "cancel":
        editing = null;
        error = "";
        paint();
        break;
      case "save":
        void save(button);
        break;
    }
  });

  container.addEventListener("change", (event) => {
    if (event.target.matches("[data-egress-preset]")) showError();
  });

  container.addEventListener("input", (event) => {
    if (event.target.id === "bsEgressDomains") showError();
  });

  const read = async () => {
    const seq = ++reads;
    if (box().egress?.mode !== "proxy-only") {
      denials = null;
      denialsError = "";
      paint();
      return;
    }
    try {
      const page = await api(`/api/events?box=${enc(box().id)}&op=egress.denied&limit=${DENIALS_LIMIT}`);
      if (disposed || seq !== reads) return;
      denials = page.events;
      denialsError = "";
    } catch (e) {
      if (disposed || seq !== reads) return;
      denialsError = e.message;
    }
    paint();
  };

  const refreshSoon = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void read(), REFRESH_DEBOUNCE_MS);
  };

  const offEvent = subscribe("event", (event) => {
    if (event.op === "egress.denied" && event.target?.kind === "box" && event.target.id === box().id) refreshSoon();
  });
  const offReset = subscribe("reset", refreshSoon);
  const stopPolling = pollWhileDown(() => void read(), POLL_MS);

  paint();
  void read();
  const readStaged = () =>
    fetchStaged(box().id)
      .then((waiting) => {
        if (disposed || editing) return;
        staged = stagedField(waiting, "egress");
        paint();
      })
      .catch(() => undefined);
  void readStaged();

  const offStaged = onStaged(
    () => box().boxId,
    (waiting) => {
      reads += 1;
      staged = stagedField(waiting, "egress");
      if (!editing) paint();
    },
  );

  return {
    onBoxChange() {
      if (disposed) return;
      if (editing) return;
      const key = keyOf(box());
      if (key === seen) {
        paint();
        return;
      }
      seen = key;
      denials = null;
      denialsError = "";
      void readStaged();
      void read();
    },
    dispose() {
      disposed = true;
      clearTimeout(refreshTimer);
      offStaged();
      offEvent();
      offReset();
      stopPolling();
    },
  };
}
