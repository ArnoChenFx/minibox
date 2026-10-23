import { stripAnsi } from "../lib/ansi.js";
import { enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { bytes, relTime } from "../lib/format.js";
import { hostFilter, hostName, multiHost } from "../lib/hosts.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { ATTENTION_LABEL, attentionHref, attentionText, scopeToHost } from "../lib/overview.js";
import { terminalHash } from "../lib/routes.js";
import { emptyState } from "../lib/ui.js";
import { bindToggles, limitList } from "./list-toggle.js";

/** The rows each list shows before its toggle expands it. A progress row is tall, so its list is shorter. */
const PROGRESS_LIMIT = 3;
const ATTENTION_LIMIT = 5;

const hostSuffix = (hostId) => (multiHost() ? ` · ${esc(hostName(hostId))}` : "");

/** Where a progress row's actions lead: its session, or the box's activity when the command ran outside any session. */
const observeHref = (row) =>
  row.session ? terminalHash(row.box.id, row.session) : `#/boxes/${enc(row.box.id)}/activity`;

function progressRow(row) {
  const { box, principal, command, session, note } = row;
  const running = command?.running === true;
  const who = principal.type === "box-self" ? t("ov.byBox") : t("ov.byToken", { name: principal.name });
  const lines = command ? command.output.map((line) => stripAnsi(line)) : [];
  const href = observeHref(row);
  return `<li class="watch-row">
    <span class="watch-ico">${icon("terminal")}</span>
    <div class="watch-main">
      <div class="watch-head">
        <a class="watch-name" href="#/boxes/${enc(box.id)}">${esc(box.name)}</a>
        ${running ? `<span class="badge badge-success"><span class="dot"></span>${esc(t("ov.running"))}</span>` : ""}
        <span class="subtle">${esc(who)}${hostSuffix(box.hostId)}</span>
        <span class="time">${esc(relTime(row.lastAt))}</span>
      </div>
      ${
        command
          ? `<div class="watch-cmd">${running ? "" : `<span class="subtle">${esc(t("ov.lastCommand"))}</span>`}<code class="watch-code">${esc(command.text)}</code></div>`
          : ""
      }
      ${lines.length ? `<div class="watch-output">${lines.map((line) => `<span>${esc(line)}</span>`).join("")}</div>` : ""}
      ${
        session || note
          ? `<div class="watch-meta">${session ? `<span class="tag">${esc(t("ov.session", { name: session }))}</span>` : ""}${note ? `<span class="subtle">${esc(t("ov.note"))}: ${esc(note)}</span>` : ""}</div>`
          : ""
      }
    </div>
    <div class="watch-actions">
      <a class="btn btn-sm" href="${href}" title="${esc(t(session ? "ov.observeTitle" : "ov.observeActivityTitle"))}">${icon("eye")}${esc(t("ov.observe"))}</a>
      ${session ? `<a class="btn btn-sm" href="${href}" title="${esc(t("ov.takeOverTitle"))}">${icon("key")}${esc(t("ov.takeOver"))}</a>` : ""}
    </div>
  </li>`;
}

function attentionRow(item) {
  const error = item.severity === "error";
  const label = ATTENTION_LABEL[item.kind] ? t(ATTENTION_LABEL[item.kind]) : item.kind;
  const text = attentionText(item, { bytes });
  return `<li class="watch-row${error ? " is-error" : ""}">
    <span class="watch-ico${error ? " fail" : ""}">${icon(error ? "alertCircle" : "alert")}</span>
    <div class="watch-main">
      <div class="watch-head">
        <strong>${esc(label)}</strong>
        <span class="subtle">${esc(item.subject)}${hostSuffix(item.hostId)}</span>
        <span class="time">${item.at ? esc(relTime(item.at)) : ""}</span>
      </div>
      ${text ? `<div class="subtle">${esc(t(text.key, text.params))}</div>` : ""}
    </div>
    <div class="watch-actions">
      <a class="btn btn-sm" href="${attentionHref(item)}">${icon("chevronRight")}${esc(t("ov.view"))}</a>
    </div>
  </li>`;
}

/** Fills one watch card with its rows, and the toggle under them. The card is empty when it has nothing to list. */
function fill(root, section, { key, items, limit, rows, empty, redraw }) {
  if (!items.length) {
    section.innerHTML = empty;
    return;
  }
  const { shown, toggle } = limitList(root, key, items, { limit });
  section.innerHTML = `<ul class="watch-list">${shown.map(rows).join("")}</ul><div class="list-more">${toggle}</div>`;
  bindToggles(root, section, redraw);
}

/**
 * Draws the two watch lists of the overview into `root`: what agents are doing now, and what needs attention. The
 * lists follow the host filter. A list longer than its limit shows the first rows and a toggle for the rest.
 */
export function drawWatch(root, overview) {
  const host = hostFilter();
  const progress = scopeToHost(overview.inProgress, host, (row) => row.box.hostId);
  const attention = scopeToHost(overview.attention, host, (item) => item.hostId);
  const redraw = () => drawWatch(root, overview);
  fill(root, root.querySelector("#ovProgress"), {
    key: "progress",
    items: progress,
    limit: PROGRESS_LIMIT,
    rows: progressRow,
    empty: emptyState({ iconName: "activity", title: t("ov.progressNone"), text: t("ov.progressNoneText") }),
    redraw,
  });
  fill(root, root.querySelector("#ovAttention"), {
    key: "attention",
    items: attention,
    limit: ATTENTION_LIMIT,
    rows: attentionRow,
    empty: emptyState({ iconName: "check", title: t("ov.attentionNone"), text: t("ov.attentionNoneText") }),
    redraw,
  });
}
