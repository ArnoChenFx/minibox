import { esc } from "../lib/dom.js";
import { bytes } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { sparkline } from "../lib/sparkline.js";
import { fillPercent, levelClass, levelLabelKey, trendValues, usageSummary } from "../lib/volume-usage.js";

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

/** The volumes table's usage cell: the figure against its limit, the bar, the trend, and the level the volume is at. */
export function usageCellHtml(volume) {
  const summary = usageSummary(volume);
  const fill = fillPercent(summary.bytes, summary.scale);
  const trend = summary.history.length
    ? sparkline(trendValues(summary.history, summary.scale), { max: 100, height: 26, width: 180, id: volume.id })
    : "";
  const notes = [
    summary.shared ? t("vol.usageShare") : "",
    volume.usage?.lastError ? t("vol.usageFailed", { error: volume.usage.lastError }) : "",
  ].filter(Boolean);
  return `<div class="usage-cell">
    <div class="bar-label"><span>${esc(figureText(summary))}</span><span>${esc(limitText(summary))}</span></div>
    ${fill === null ? "" : `<div class="bar ${levelClass(summary.level)}"><span style="width:${fill}%"></span></div>`}
    ${trend}
    ${levelBadge(summary.level)}
    ${notes.map((note) => `<div class="subtle">${esc(note)}</div>`).join("")}
  </div>`;
}

/** One line of a box's mount: the figure, the limit it is held to, and the level, or a dash for a volume not yet known. */
export function usageInlineHtml(volume) {
  if (!volume) return `<span class="subtle">—</span>`;
  const summary = usageSummary(volume);
  const share = summary.shared ? ` <span class="subtle">${esc(t("vol.usageShare"))}</span>` : "";
  return `<span class="mono">${esc(figureText(summary))}</span> <span class="subtle">${esc(limitText(summary))}</span> ${levelBadge(summary.level)}${share}`;
}
