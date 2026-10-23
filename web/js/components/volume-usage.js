import { esc } from "../lib/dom.js";
import { bytes } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { fillPercent, levelClass, levelLabelKey, usageSummary } from "../lib/volume-usage.js";

const LIMIT_KEY = { hard: "vol.limitHard", soft: "vol.limitSoft" };

function limitText(summary) {
  return summary.limit ? t(LIMIT_KEY[summary.limit.kind], { limit: bytes(summary.limit.bytes) }) : t("vol.noLimit");
}

function figureText(summary) {
  return summary.bytes == null ? "—" : bytes(summary.bytes);
}

function levelBadge(level) {
  const key = levelLabelKey(level);
  return key ? `<span class="badge ${level === "hard" ? "badge-danger" : "badge-warning"}">${esc(t(key))}</span>` : "";
}

/**
 * The volumes table's size cell: the figure with a button that measures it again, the limit as a button that edits it
 * (plain text on NFS, which takes no limit), the bar against the limit, and the level the volume is at. A note about the
 * reading, such as a failed check, is the figure's tooltip, so the cell keeps to two lines.
 */
export function usageCellHtml(volume) {
  const summary = usageSummary(volume);
  const fill = fillPercent(summary.bytes, summary.scale);
  const notes = [
    summary.shared ? t("vol.usageShare") : "",
    volume.usage?.lastError ? t("vol.usageFailed", { error: volume.usage.lastError }) : "",
  ].filter(Boolean);
  const tip = notes.length ? ` title="${esc(notes.join(" "))}"` : "";
  const warn = volume.usage?.lastError ? " vol-size-failed" : "";
  const measure = esc(t("vol.measure"));
  const limit =
    volume.backend === "nfs"
      ? `<span class="vol-limit" title="${esc(t("vol.limitsNfs"))}">${esc(limitText(summary))}</span>`
      : `<button type="button" class="vol-limit" data-action="limits" data-id="${esc(volume.id)}" title="${esc(t("vol.limits"))}">${esc(limitText(summary))}</button>`;
  return `<div class="vol-size">
    <div class="vol-size-line"><span class="mono${warn}"${tip}>${esc(figureText(summary))}</span><button type="button" class="icon-btn icon-btn-sm" data-action="measure" data-id="${esc(volume.id)}" title="${measure}" aria-label="${measure}">${icon("refresh")}</button>${levelBadge(summary.level)}</div>
    ${limit}
    ${fill === null ? "" : `<div class="bar ${levelClass(summary.level)}"><span style="width:${fill}%"></span></div>`}
  </div>`;
}

/** One line of a box's mount: the figure, the limit it is held to, and the level, or a dash for a volume not yet known. */
export function usageInlineHtml(volume) {
  if (!volume) return `<span class="subtle">—</span>`;
  const summary = usageSummary(volume);
  const share = summary.shared ? ` <span class="subtle">${esc(t("vol.usageShare"))}</span>` : "";
  return `<span class="mono">${esc(figureText(summary))}</span> <span class="subtle">${esc(limitText(summary))}</span> ${levelBadge(summary.level)}${share}`;
}
