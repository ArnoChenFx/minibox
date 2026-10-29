import { CATEGORIES, eventsQuery } from "../lib/activity-log.js";
import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { countTag, describe, iconOf, isFailed, isRoutine, opLabel, statusBadge } from "../lib/event-view.js";
import { dateTime, relTime } from "../lib/format.js";
import { hostTargetName } from "../lib/hosts.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { pollWhileDown, subscribe } from "../lib/live.js";
import { emptyState, skeletonRows, toastError } from "../lib/ui.js";

const COLUMNS = 5;
/** A burst of events reads the first page once, after it has settled. */
const REFRESH_DEBOUNCE_MS = 400;
const POLL_MS = 10_000;

const STATUSES = ["ok", "error", "denied", "started"];

function targetCell(event) {
  const target = event.target;
  if (!target) return '<span class="subtle">—</span>';
  const name = target.kind === "host" ? hostTargetName(target) : (target.name ?? target.id ?? "");
  if (target.kind === "box" && target.id) {
    return `<a href="#/boxes/${enc(target.id)}" class="truncate" title="${esc(name)}"><strong>${esc(name)}</strong></a>`;
  }
  return `<span class="truncate" title="${esc(`${name} · ${target.kind}`)}">${esc(name)} <span class="subtle">${esc(target.kind)}</span></span>`;
}

function principalText(principal) {
  if (principal.type === "owner") return t("actv.owner");
  if (principal.type === "box-self") return t("actv.boxAgent", { name: principal.name });
  return principal.name;
}

/** A started operation records its finish as a separate row, so in the log a start is only a start, not "running". */
function resultBadge(event) {
  if (event.status === "started") return `<span class="badge">${esc(t("actv.started"))}</span>`;
  return statusBadge(event, { showOk: true });
}

/** The operation cell: its name and a one-line reading, and the recorded fields one click away. */
function opCell(event) {
  const detail = describe(event);
  const head = `<span class="actv-op-line"><span class="ico ${isFailed(event) ? "fail" : ""}">${icon(iconOf(event.op))}</span><strong class="truncate">${esc(opLabel(event.op))}</strong>${countTag(event)}${event.detail === undefined ? "" : `<span class="actv-chev">${icon("chevron")}</span>`}</span>${detail ? `<span class="event-detail mono" title="${esc(detail)}">${esc(detail)}</span>` : ""}`;
  if (event.detail === undefined) return head;
  return `<details class="actv-ev"><summary title="${esc(t("ev.details"))}">${head}</summary><pre>${esc(JSON.stringify(event.detail, null, 2))}</pre></details>`;
}

function whoCell(event) {
  const who = principalText(event.principal);
  const via = t(`ev.source.${event.source}`);
  return `<span class="truncate" title="${esc(`${who} · ${via}`)}">${esc(who)} <span class="subtle">${esc(via)}</span></span>`;
}

export function logRow(event) {
  const when = new Date(event.ts).toISOString();
  return `<tr>
    <td class="actv-time" title="${esc(dateTime(when))}">${esc(relTime(when))}</td>
    <td class="actv-op">${opCell(event)}</td>
    <td class="actv-target">${targetCell(event)}</td>
    <td class="actv-who">${whoCell(event)}</td>
    <td class="actv-status">${resultBadge(event)}</td>
  </tr>`;
}

const option = (value, label, current) =>
  `<option value="${esc(value)}"${value === current ? " selected" : ""}>${esc(label)}</option>`;

/**
 * The whole event log: every recorded operation, newest first, with filters for the box, the kind of operation, the
 * outcome and who acted, a page at a time. The overview keeps only a short summary of it.
 */
export function render(view) {
  const filters = { box: "", category: "", status: "", principal: "", reads: false };
  /** The cursor of each page shown so far: `cursors[0]` is the first page's (none). */
  let cursors = [null];
  let nextCursor = null;
  let events = null;
  let boxes = [];
  let tokens = [];
  let disposed = false;
  let loading = 0;
  let refreshTimer = null;

  view.innerHTML = `
    <div class="page-head">
      <div><h1>${t("nav.activity")}</h1><p>${t("actv.subtitle")}</p></div>
      <div class="page-actions"><button class="btn" id="actvRefresh">${icon("refresh")}${t("common.refresh")}</button></div>
    </div>
    <div class="card actv-card">
      <div class="actv-filters" role="group" aria-label="${esc(t("actv.filters"))}">
        <select class="select actv-filter" id="actvBox" aria-label="${esc(t("actv.box"))}"></select>
        <select class="select actv-filter" id="actvCategory" aria-label="${esc(t("actv.category"))}">${[option("", t("actv.allCategories"), "")].concat(CATEGORIES.map((c) => option(c, t(`actv.cat.${c}`), ""))).join("")}</select>
        <select class="select actv-filter" id="actvStatus" aria-label="${esc(t("actv.status"))}">${[option("", t("actv.allStatuses"), "")].concat(STATUSES.map((s) => option(s, t(`ev.status.${s}`), ""))).join("")}</select>
        <select class="select actv-filter" id="actvPrincipal" aria-label="${esc(t("actv.principal"))}"></select>
        <label class="checkbox actv-reads"><input type="checkbox" id="actvReads" />${t("actv.showReads")}</label>
      </div>
      <div class="table-wrap"><table class="table actv-table">
        <colgroup><col class="actv-c-time" /><col /><col class="actv-c-target" /><col class="actv-c-who" /><col class="actv-c-status" /></colgroup>
        <thead><tr><th>${t("actv.colTime")}</th><th>${t("actv.colOp")}</th><th>${t("actv.colTarget")}</th><th>${t("actv.colWho")}</th><th>${t("actv.colStatus")}</th></tr></thead>
        <tbody id="actvRows">${skeletonRows(6, COLUMNS)}</tbody>
      </table></div>
      <div class="actv-pager">
        <span class="subtle" id="actvPage"></span>
        <div class="actions">
          <button class="btn btn-sm" id="actvPrev" disabled>${icon("chevronLeft")}${t("actv.prev")}</button>
          <button class="btn btn-sm" id="actvNext" disabled>${t("actv.next")}${icon("chevronRight")}</button>
        </div>
      </div>
    </div>`;

  const $ = (sel) => view.querySelector(sel);
  const rows = $("#actvRows");

  const drawBoxes = () => {
    $("#actvBox").innerHTML = [option("", t("actv.allBoxes"), filters.box)]
      .concat(boxes.map((b) => option(b.id, b.name, filters.box)))
      .join("");
  };
  const drawPrincipals = () => {
    $("#actvPrincipal").innerHTML = [
      option("", t("actv.allPrincipals"), filters.principal),
      option("owner", t("actv.owner"), filters.principal),
    ]
      .concat(tokens.map((token) => option(token.id, token.name, filters.principal)))
      .join("");
  };

  const filtered = () => Boolean(filters.box || filters.category || filters.status || filters.principal);

  const draw = () => {
    const page = cursors.length;
    if (!events.length) {
      const [title, text] =
        filtered() || filters.reads
          ? [t("actv.noMatch"), t("actv.noMatchText")]
          : [t("ov.noActivity"), t("actv.emptyText")];
      rows.innerHTML = `<tr><td colspan="${COLUMNS}">${emptyState({ iconName: "activity", title, text: esc(text) })}</td></tr>`;
    } else {
      rows.innerHTML = events.map(logRow).join("");
    }
    $("#actvPage").textContent = t("actv.pageLine", { page, n: events.length });
    $("#actvPrev").disabled = page === 1;
    $("#actvNext").disabled = nextCursor === null;
  };

  const load = async () => {
    const ticket = ++loading;
    const page = await api(eventsQuery(filters, cursors.at(-1)));
    if (disposed || ticket !== loading) return;
    events = page.events;
    nextCursor = page.nextCursor;
    draw();
  };
  const reload = () =>
    load().catch((e) => {
      if (disposed) return;
      if (events === null) {
        rows.innerHTML = `<tr><td colspan="${COLUMNS}"><div class="callout danger">${icon("alert")}<span>${esc(e.message)}</span></div></td></tr>`;
      }
      toastError(t("actv.loadFailed"), e);
    });

  /** A filter change starts again from the first page. */
  const refilter = () => {
    cursors = [null];
    void reload();
  };

  const bindFilter = (id, key) =>
    $(id).addEventListener("change", (e) => {
      filters[key] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
      refilter();
    });
  bindFilter("#actvBox", "box");
  bindFilter("#actvCategory", "category");
  bindFilter("#actvStatus", "status");
  bindFilter("#actvPrincipal", "principal");
  bindFilter("#actvReads", "reads");
  $("#actvRefresh").addEventListener("click", () => void reload());
  $("#actvPrev").addEventListener("click", () => {
    if (cursors.length === 1) return;
    cursors.pop();
    void reload();
  });
  $("#actvNext").addEventListener("click", () => {
    if (nextCursor === null) return;
    cursors.push(nextCursor);
    void reload();
  });

  drawBoxes();
  drawPrincipals();
  void reload();
  api("/api/boxes?stats=false")
    .then((r) => {
      if (disposed) return;
      boxes = r.boxes.toSorted((a, b) => a.name.localeCompare(b.name));
      drawBoxes();
    })
    .catch(() => {});
  api("/api/tokens")
    .then((r) => {
      if (disposed) return;
      tokens = r.tokens;
      drawPrincipals();
    })
    .catch(() => {});

  /** Only the first page follows new events; an older page stays put while it is read. Reading the log is itself a
   * routine read, so routine reads never trigger a refresh. */
  const refreshSoon = () => {
    if (cursors.length !== 1) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void load().catch(() => {}), REFRESH_DEBOUNCE_MS);
  };
  const offEvent = subscribe("event", (event) => {
    if (!isRoutine(event)) refreshSoon();
  });
  const offReset = subscribe("reset", refreshSoon);
  const stopPolling = pollWhileDown(refreshSoon, POLL_MS);

  return () => {
    disposed = true;
    clearTimeout(refreshTimer);
    offEvent();
    offReset();
    stopPolling();
  };
}
