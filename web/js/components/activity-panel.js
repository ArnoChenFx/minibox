import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { bytes, dateTime } from "../lib/format.js";
import { has, t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { emptyState, toastError } from "../lib/ui.js";

const PAGE = 100;
const POLL_MS = 5000;
const LOG_POLL_MS = 4000;
const COMMAND_MAX = 160;

const FILTERS = [
  { key: "all", label: "bd.filterAll", match: () => true },
  { key: "exec", label: "bd.filterExec", match: (op) => op.startsWith("exec.") },
  { key: "container", label: "bd.filterContainer", match: (op) => op.startsWith("container.") },
  {
    key: "sessions",
    label: "bd.filterSessions",
    match: (op) => op.startsWith("session.") || op.startsWith("terminal."),
  },
];

const opLabel = (op) => (has(`ev.${op}`) ? t(`ev.${op}`) : op);

function iconOf(op) {
  if (op.startsWith("exec.")) return "zap";
  if (op.startsWith("container.")) return "box";
  if (op.startsWith("session.") || op.startsWith("terminal.")) return "terminal";
  return "activity";
}

/** A reads that succeeded, such as polling a session list, is not history. Failed or refused reads still show. */
const isRoutine = (event) => event.kind === "read" && event.status === "ok";

function commandOf(detail) {
  const text = typeof detail.cmd === "string" ? detail.cmd : Array.isArray(detail.argv) ? detail.argv.join(" ") : "";
  return text.length > COMMAND_MAX ? `${text.slice(0, COMMAND_MAX - 1)}…` : text;
}

/** A one-line reading of what an event did, taken from its fields. Nothing here is free text from the event. */
function describe(event) {
  const d = event.detail ?? {};
  if (event.op === "exec.finish") {
    const parts = [t("ev.exit", { code: d.exitCode ?? "—" })];
    if (typeof d.durationMs === "number") parts.push(t("ev.duration", { s: (d.durationMs / 1000).toFixed(1) }));
    return parts.join(" · ");
  }
  if (event.op === "session.send") return t("ev.send", { n: d.keys ?? 0, bytes: bytes(d.bytes ?? 0) });
  if (event.op === "terminal.close") {
    return t("ev.io", { in: bytes(d.bytesIn ?? 0), out: bytes(d.bytesOut ?? 0) });
  }
  if (event.op.startsWith("exec.")) return commandOf(d);
  if (typeof d.session === "string") return d.session;
  return "";
}

function row(event) {
  const detail = describe(event);
  const failed = event.status === "error" || event.status === "denied";
  const badge =
    event.status === "ok"
      ? ""
      : `<span class="badge ${failed ? "badge-danger" : event.status === "started" ? "badge-warning" : ""}">${esc(t(`ev.status.${event.status}`))}</span>`;
  const count = event.count > 1 ? `<span class="tag">×${event.count}</span>` : "";
  const json =
    event.detail === undefined
      ? ""
      : `<details class="event-json"><summary>${esc(t("ev.details"))}</summary><pre>${esc(JSON.stringify(event.detail, null, 2))}</pre></details>`;
  return `<li class="event-row">
      <span class="ico ${failed ? "fail" : ""}">${icon(iconOf(event.op))}</span>
      <div class="event-main">
        <div class="event-title"><strong>${esc(opLabel(event.op))}</strong>${detail ? `<span class="event-detail mono">${esc(detail)}</span>` : ""}${badge}${count}</div>
        <div class="subtle">${esc(t(`ev.source.${event.source}`))}</div>${json}
      </div>
      <span class="time">${esc(dateTime(new Date(event.ts).toISOString()))}</span>
    </li>`;
}

/**
 * The box's activity: exec history, container events, and terminal sessions, read from the event store. Keystrokes are
 * not in it. The `docker logs` output of the container's main process sits below as a secondary option.
 */
export function mountActivity(root, { box }) {
  const b = box();
  let filter = "all";
  let events = [];
  const seen = new Set();
  let nextCursor = null;
  let loadingOlder = false;
  let disposed = false;

  root.innerHTML = `<div class="card">
      <div class="card-head"><h3>${t("bd.activity")}</h3>
        <div class="row activity-tools">
          <div class="filter-chips" role="group" aria-label="${esc(t("bd.activity"))}">${FILTERS.map(
            (f) =>
              `<button type="button" class="filter-chip" data-filter="${f.key}" aria-pressed="${f.key === filter}">${esc(t(f.label))}</button>`,
          ).join("")}</div>
          <button class="btn btn-sm" id="aRefresh">${icon("refresh")}${t("common.refresh")}</button>
        </div>
      </div>
      <div id="aBody"><div class="card-body"><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div></div></div>
      <div class="card-foot" id="aFoot" hidden><button class="btn btn-sm" id="aMore">${t("bd.loadOlder")}</button></div>
    </div>
    <p class="help" style="margin-top:8px">${t("bd.activityHelp")}</p>
    <details class="card docker-logs" id="dLogs" style="margin-top:16px">
      <summary>${icon("logs")}<strong>${t("bd.dockerLogs")}</strong><span class="subtle">${t("bd.dockerLogsHint")}</span></summary>
      <div class="row docker-logs-tools">
        <select class="select" id="lTail" style="width:auto;height:30px">${[200, 1000, 5000].map((n) => `<option value="${n}">${t("bd.lastLines", { n })}</option>`).join("")}</select>
        <label class="checkbox" style="align-items:center"><input type="checkbox" id="lAuto" style="accent-color:var(--accent);margin:0" checked />${t("bd.autoRefresh")}</label>
        <button class="btn btn-sm" id="lRefresh">${icon("refresh")}${t("common.refresh")}</button>
      </div>
      <pre class="logs" id="lView">${t("common.loading")}</pre>
      <p class="help" style="margin-top:8px">${t("bd.logsHelp")}</p>
    </details>`;

  const body = root.querySelector("#aBody");
  const foot = root.querySelector("#aFoot");
  const more = root.querySelector("#aMore");

  const render = () => {
    const match = FILTERS.find((f) => f.key === filter).match;
    const shown = events.filter((event) => !isRoutine(event) && match(event.op));
    if (shown.length) {
      body.innerHTML = `<ul class="activity">${shown.map(row).join("")}</ul>`;
    } else if (filter === "all" && nextCursor === null) {
      body.innerHTML = `<div class="card-body">${emptyState({ iconName: "activity", title: t("bd.activityEmpty"), text: t("bd.activityEmptyText") })}</div>`;
    } else {
      const text = nextCursor === null ? t("bd.activityNoMatchNow") : t("bd.activityNoMatchOlder");
      body.innerHTML = `<div class="card-body">${emptyState({ iconName: "activity", title: t("bd.activityNoMatch"), text })}</div>`;
    }
    foot.hidden = nextCursor === null;
  };

  const absorb = (page) => {
    const fresh = page.events.filter((event) => !seen.has(event.seq));
    for (const event of fresh) seen.add(event.seq);
    return fresh;
  };

  const loadNewest = async () => {
    const page = await api(`/api/events?box=${enc(b.id)}&limit=${PAGE}`);
    if (disposed) return;
    const fresh = absorb(page);
    if (events.length === 0) nextCursor = page.nextCursor;
    events = fresh.concat(events);
    render();
  };

  const reportFailure = (e) => {
    if (disposed) return;
    if (events.length === 0) {
      body.innerHTML = `<div class="card-body"><div class="callout danger">${icon("alert")}<span>${esc(e.message)}</span></div></div>`;
    }
    toastError(t("bd.activityFailed"), e);
  };

  const loadOlder = async () => {
    if (nextCursor === null || loadingOlder) return;
    loadingOlder = true;
    more.disabled = true;
    try {
      const page = await api(`/api/events?box=${enc(b.id)}&limit=${PAGE}&cursor=${nextCursor}`);
      if (disposed) return;
      events = events.concat(absorb(page));
      nextCursor = page.nextCursor;
      render();
    } catch (e) {
      toastError(t("bd.activityFailed"), e);
    } finally {
      loadingOlder = false;
      more.disabled = false;
    }
  };

  root.querySelector(".filter-chips").addEventListener("click", (e) => {
    const key = e.target.closest("[data-filter]")?.dataset.filter;
    if (!key) return;
    filter = key;
    for (const button of root.querySelectorAll("[data-filter]")) {
      button.setAttribute("aria-pressed", String(button.dataset.filter === key));
    }
    render();
  });
  root.querySelector("#aRefresh").addEventListener("click", () => loadNewest().catch(reportFailure));
  more.addEventListener("click", loadOlder);

  loadNewest().catch(reportFailure);
  const timer = setInterval(() => loadNewest().catch(() => {}), POLL_MS);

  const logs = root.querySelector("#dLogs");
  const logView = root.querySelector("#lView");
  const loadLogs = async () => {
    try {
      const { logs: text } = await api(`/api/boxes/${enc(b.id)}/logs?tail=${root.querySelector("#lTail").value}`);
      const atBottom = logView.scrollHeight - logView.scrollTop - logView.clientHeight < 40;
      logView.textContent = text || t("bd.noLogs");
      if (atBottom) logView.scrollTop = logView.scrollHeight;
    } catch (e) {
      logView.textContent = t("bd.logsFailed", { msg: e.message });
    }
  };
  let logTimer = null;
  logs.addEventListener("toggle", () => {
    clearInterval(logTimer);
    logTimer = null;
    if (!logs.open) return;
    loadLogs().then(() => (logView.scrollTop = logView.scrollHeight));
    logTimer = setInterval(() => root.querySelector("#lAuto").checked && loadLogs(), LOG_POLL_MS);
  });
  root.querySelector("#lRefresh").addEventListener("click", loadLogs);
  root.querySelector("#lTail").addEventListener("change", loadLogs);

  return () => {
    disposed = true;
    clearInterval(timer);
    clearInterval(logTimer);
  };
}
