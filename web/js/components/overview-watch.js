import { stripAnsi } from "../lib/ansi.js";
import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { bytes, cpus, relTime } from "../lib/format.js";
import { hostFilter, hostName, multiHost } from "../lib/hosts.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { ATTENTION_LABEL, attentionHref, attentionText, canRepair, scopeToHost } from "../lib/overview.js";
import { terminalHash } from "../lib/routes.js";
import { confirmDialog, toast, toastError } from "../lib/ui.js";
import { bindToggles, limitList } from "./list-toggle.js";

/** The rows each list shows before its toggle expands it. */
const PROGRESS_LIMIT = 3;
const ATTENTION_LIMIT = 5;

const hostSuffix = (hostId) => (multiHost() ? ` · ${esc(hostName(hostId))}` : "");

/** Where a progress row's actions lead: its session, or the box's activity when the command ran outside any session. */
const observeHref = (row) =>
  row.session ? terminalHash(row.box.id, row.session) : `#/boxes/${enc(row.box.id)}/activity`;

/** The rows whose output is open, per page view. A poll redraws the list, so the open rows are kept outside it. */
const openOutputs = new WeakMap();

function openSet(root) {
  let open = openOutputs.get(root);
  if (!open) {
    open = new Set();
    openOutputs.set(root, open);
  }
  return open;
}

/**
 * One line per box: icon | name | state | actor | command | time | actions. The last lines the command printed, and
 * the agent's note, sit behind a toggle under the line.
 */
function progressRow(row, open) {
  const { box, principal, command, session, note } = row;
  const running = command?.running === true;
  const who = principal.type === "box-self" ? t("ov.byBox") : t("ov.byToken", { name: principal.name });
  const lines = command ? command.output.map((line) => stripAnsi(line)) : [];
  const href = observeHref(row);
  const hasMore = lines.length > 0 || Boolean(note && command);
  const expanded = hasMore && open.has(box.id);
  const outputId = `ovOut-${box.id}`;
  return `<li class="watch-row${expanded ? " is-open" : ""}">
    <span class="watch-ico">${icon("terminal")}</span>
    <div class="watch-who">
      <a class="watch-name" href="#/boxes/${enc(box.id)}">${esc(box.name)}</a>
      <span class="watch-state">${running ? `<span class="badge badge-success"><span class="dot"></span>${esc(t("ov.running"))}</span>` : command ? `<span class="subtle">${esc(t("ov.lastCommand"))}</span>` : ""}</span>
      <span class="subtle watch-actor">${esc(who)}${hostSuffix(box.hostId)}</span>
    </div>
    <div class="watch-cmd">
      ${command ? `<code class="watch-code" title="${esc(command.text)}">${esc(command.text)}</code>` : note ? `<span class="subtle watch-code">${esc(note)}</span>` : ""}
      ${session ? `<span class="watch-meta"><span class="tag">${esc(t("ov.session", { name: session }))}</span></span>` : ""}
      ${
        hasMore
          ? `<button type="button" class="watch-more" data-output="${esc(box.id)}" aria-expanded="${expanded}" aria-controls="${esc(outputId)}" title="${esc(t(expanded ? "ov.hideOutput" : "ov.showOutput"))}" aria-label="${esc(t(expanded ? "ov.hideOutput" : "ov.showOutput"))}">${icon("chevron")}</button>`
          : ""
      }
    </div>
    <span class="time">${esc(relTime(row.lastAt))}</span>
    <div class="watch-actions">
      <a class="btn btn-sm" href="${href}" title="${esc(t(session ? "ov.observeTitle" : "ov.observeActivityTitle"))}">${icon("eye")}${esc(t("ov.observe"))}</a>
      ${session ? `<a class="btn btn-sm" href="${href}" title="${esc(t("ov.takeOverTitle"))}">${icon("key")}${esc(t("ov.takeOver"))}</a>` : ""}
    </div>
    ${
      hasMore
        ? `<div class="watch-detail" id="${esc(outputId)}"${expanded ? "" : " hidden"}>
      ${lines.length ? `<div class="watch-output">${lines.map((line) => `<span>${esc(line)}</span>`).join("")}</div>` : ""}
      ${note && command ? `<div class="subtle">${esc(t("ov.note"))}: ${esc(note)}</div>` : ""}
    </div>`
        : ""
    }
  </li>`;
}

/**
 * Asks the owner before anything is written, naming the host and the rule, then sends the repair. The warning row is
 * not removed here: it goes away when the server's next check finds the rules right.
 */
async function repairAttention(item) {
  const ok = await confirmDialog({
    title: t("ov.forwardRepairTitle", { host: hostName(item.hostId) }),
    message: esc(t("ov.forwardRepairMessage", { host: hostName(item.hostId), bridge: item.params.bridge })),
    body: `<div class="callout"><span>${esc(t("ov.forwardRepairWhat"))}</span></div>`,
    confirmText: t("ov.forwardRepair"),
  });
  if (!ok) return false;
  try {
    await api(`/api/hosts/${enc(item.hostId)}/forward`, { method: "POST", body: {} });
  } catch (e) {
    toastError(t("ov.forwardRepairFailed"), e);
    return false;
  }
  toast(t("ov.forwardRepaired"), { message: hostName(item.hostId) });
  return true;
}

function attentionRow(item) {
  const error = item.severity === "error";
  const label = ATTENTION_LABEL[item.kind] ? t(ATTENTION_LABEL[item.kind]) : item.kind;
  const text = attentionText(item, { bytes, cpus });
  const said = text ? t(text.key, text.params) : "";
  const repair = canRepair(item)
    ? `<button type="button" class="btn btn-sm" data-repair="${esc(item.kind)}" title="${esc(t("ov.forwardRepairHint"))}">${icon("shield")}${esc(t("ov.forwardRepair"))}</button>`
    : "";
  return `<li class="watch-row${error ? " is-error" : ""}" data-attn="${esc(item.kind)}" data-host="${esc(item.hostId)}">
    <span class="watch-ico${error ? " fail" : ""}">${icon(error ? "alertCircle" : "alert")}</span>
    <div class="watch-who"><strong>${esc(label)}</strong><span class="subtle watch-actor">${esc(item.subject)}${hostSuffix(item.hostId)}</span></div>
    <div class="watch-cmd"><span class="watch-text subtle" title="${esc(said)}">${esc(said)}</span></div>
    <span class="time">${item.at ? esc(relTime(item.at)) : ""}</span>
    <div class="watch-actions">${repair}<a class="btn btn-sm" href="${attentionHref(item)}">${icon("chevronRight")}${esc(t("ov.view"))}</a></div>
  </li>`;
}

/** The one line an empty list shows, so an empty card stays slim. */
const emptyLine = (iconName, title, hint) =>
  `<div class="watch-empty" title="${esc(hint)}">${icon(iconName)}<span>${esc(title)}</span></div>`;

/** Fills one watch card with its rows, and the toggle under them. The card is empty when it has nothing to list. */
function fill(root, section, { key, items, limit, rows, empty, redraw }) {
  const card = section.closest(".watch-card");
  card?.classList.toggle("is-empty", !items.length);
  if (!items.length) {
    section.innerHTML = empty;
    return;
  }
  const { shown, toggle } = limitList(root, key, items, { limit });
  section.innerHTML = `<ul class="watch-list watch-${key}">${shown.map(rows).join("")}</ul><div class="list-more">${toggle}</div>`;
  bindToggles(root, section, redraw);
}

/** Connects each row's output toggle. It opens or closes the lines in place, and the open rows survive the next poll. */
function bindOutputs(root, section) {
  const open = openSet(root);
  for (const button of section.querySelectorAll("[data-output]")) {
    button.addEventListener("click", () => {
      const id = button.dataset.output;
      const expanded = !open.has(id);
      if (expanded) open.add(id);
      else open.delete(id);
      const label = t(expanded ? "ov.hideOutput" : "ov.showOutput");
      button.setAttribute("aria-expanded", String(expanded));
      button.title = label;
      button.setAttribute("aria-label", label);
      button.closest(".watch-row")?.classList.toggle("is-open", expanded);
      const detail = button.closest(".watch-row")?.querySelector(".watch-detail");
      if (detail) detail.hidden = !expanded;
    });
  }
}

/** Connects each attention row's repair button. A repair the owner confirms redraws the list from a fresh read. */
function bindRepairs(root, section, items, refresh) {
  for (const button of section.querySelectorAll("[data-repair]")) {
    button.addEventListener("click", async () => {
      const row = button.closest("[data-attn]");
      const item = items.find(
        (candidate) => candidate.kind === row?.dataset.attn && candidate.hostId === row?.dataset.host,
      );
      if (!item) return;
      button.disabled = true;
      try {
        if (await repairAttention(item)) await refresh();
      } finally {
        button.disabled = false;
      }
    });
  }
}

/**
 * Draws the two watch lists of the overview into `root`: what agents are doing now, and what needs attention. The
 * lists follow the host filter. A list longer than its limit shows the first rows and a toggle for the rest. `refresh`
 * reads the overview again, which the repair button does after it changes the host.
 */
export function drawWatch(root, overview, refresh) {
  const host = hostFilter();
  const progress = scopeToHost(overview.inProgress, host, (row) => row.box.hostId);
  const attention = scopeToHost(overview.attention, host, (item) => item.hostId);
  // A toggle redraws from the same view, and keeps `refresh` so the repair button still reads again afterwards.
  const redraw = () => drawWatch(root, overview, refresh);
  fill(root, root.querySelector("#ovProgress"), {
    key: "progress",
    items: progress,
    limit: PROGRESS_LIMIT,
    rows: (row) => progressRow(row, openSet(root)),
    empty: emptyLine("activity", t("ov.progressNone"), t("ov.progressNoneText")),
    redraw,
  });
  bindOutputs(root, root.querySelector("#ovProgress"));
  const attentionSection = root.querySelector("#ovAttention");
  fill(root, attentionSection, {
    key: "attention",
    items: attention,
    limit: ATTENTION_LIMIT,
    rows: attentionRow,
    empty: emptyLine("check", t("ov.attentionNone"), t("ov.attentionNoneText")),
    redraw,
  });
  bindRepairs(root, attentionSection, attention, refresh ?? redraw);
}
