import { esc } from "../lib/dom.js";
import { countTag, describe, detailsJson, iconOf, isFailed, opLabel, statusBadge } from "../lib/event-view.js";
import { dateTime, relTime } from "../lib/format.js";
import { hostTargetName } from "../lib/hosts.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";

/** A compact event summary shared by the overview and a box; only the box offers expandable audit details. */
export function activityRow(event, { expandable = false, open = false } = {}) {
  const iso = new Date(event.ts).toISOString();
  const target =
    event.target?.kind === "host" ? hostTargetName(event.target) : (event.target?.name ?? event.target?.id ?? "");
  const detail = expandable ? describe(event) : "";
  const failed = isFailed(event);
  const summary = `<span class="ico ${failed ? "fail" : ""}">${icon(failed ? "alert" : iconOf(event.op))}</span>
    <span class="truncate">${esc(opLabel(event.op))}${expandable ? (detail ? ` <span class="subtle mono">${esc(detail)}</span>` : "") : target ? ` <strong>${esc(target)}</strong>` : ""}</span>${statusBadge(event)}${expandable ? countTag(event) : ""}
    <time class="time activity-time" datetime="${esc(iso)}" title="${esc(dateTime(iso))}"><span class="time-full">${esc(relTime(iso))}</span><span class="time-compact">${esc(relTime(iso, { compact: true }))}</span></time>`;
  if (!expandable) return `<li>${summary}</li>`;
  return `<li class="event-row"><details class="event-entry" data-event-seq="${esc(event.seq)}"${open ? " open" : ""}>
    <summary class="activity-summary">${summary}<span class="event-chevron">${icon("chevron")}</span></summary>
    <div class="event-expanded"><div class="event-meta"><span>${esc(t(`ev.source.${event.source}`))}</span><time datetime="${esc(iso)}">${esc(dateTime(iso))}</time></div>${detailsJson(event)}</div>
  </details></li>`;
}
