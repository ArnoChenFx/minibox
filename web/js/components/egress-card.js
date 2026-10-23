import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { denialReasonKey, presetKey, tierHintKey, tierKey } from "../lib/egress.js";
import { dateTime } from "../lib/format.js";
import { has, t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { pollWhileDown, subscribe } from "../lib/live.js";

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
 * allowlist and its recent denials, which `denials` holds once read (null while the read is pending).
 */
export function egressCardHtml({ box, denials = null, denialsError = "" }) {
  const egress = box.egress ?? null;
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
  return `<div class="card" style="margin-top:16px">
    <div class="card-head"><h3>${esc(t("egress.section"))}</h3></div>
    <div class="card-body stack">
      <div class="egress-tier"><span class="badge ${TIER_TONE[mode] ?? ""}">${esc(t(tierKey(mode)))}</span><span class="help">${esc(t(tierHintKey(mode)))}</span></div>
      ${details}
    </div>
  </div>`;
}

/** A change of container or tier is a different network, so the denials are read again. */
const keyOf = (box) => `${box.id}/${box.egress?.mode ?? "open"}`;

/**
 * The network card on the overview tab. It shows the box's tier; a proxy-only box also shows its allowlist and recent
 * denials. The denials come from the event log and are read again as the live stream reports one, or every few seconds
 * while the stream is down.
 */
export function mountEgressCard(container, { box }) {
  let denials = null;
  let denialsError = "";
  let disposed = false;
  let reads = 0;
  let shown = "";
  let seen = keyOf(box());
  let refreshTimer = null;

  const paint = () => {
    if (disposed) return;
    const html = egressCardHtml({ box: box(), denials, denialsError });
    if (html === shown) return;
    shown = html;
    container.innerHTML = html;
  };

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

  return {
    onBoxChange() {
      if (disposed) return;
      const key = keyOf(box());
      if (key === seen) {
        paint();
        return;
      }
      seen = key;
      denials = null;
      denialsError = "";
      void read();
    },
    dispose() {
      disposed = true;
      clearTimeout(refreshTimer);
      offEvent();
      offReset();
      stopPolling();
    },
  };
}
