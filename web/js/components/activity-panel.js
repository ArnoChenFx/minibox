import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { isRoutine } from "../lib/event-view.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { pollWhileDown, subscribe } from "../lib/live.js";
import { lineWindow, openBoxLogs } from "../lib/logs-stream.js";
import { emptyState, toastError } from "../lib/ui.js";
import { activityRow } from "./activity-row.js";

const PAGE = 100;
/** How often the activity list is read again while the live stream is down. */
const POLL_MS = 5000;
/** How often the log is read again while its live stream is down. */
const LOG_FALLBACK_MS = 4000;
/** A burst of events reads the list once, after it has settled. */
const REFRESH_DEBOUNCE_MS = 300;

/** The log panel's status badge: its colour and the key of its label. */
const LOG_STATES = {
  connecting: ["", "common.connecting"],
  live: ["success", "bd.logsLive"],
  reconnecting: ["warning", "bd.logsReconnecting"],
  manual: ["", "bd.logsManual"],
  ended: ["", "bd.logsEnded"],
};

const FILTERS = [
  { key: "all", label: "bd.filterAll", match: () => true },
  { key: "exec", label: "bd.filterExec", match: (op) => op.startsWith("exec.") },
  { key: "container", label: "bd.filterContainer", match: (op) => op.startsWith("container.") },
  {
    key: "sessions",
    label: "bd.filterSessions",
    match: (op) => op.startsWith("session.") || op.startsWith("terminal."),
  },
  { key: "egress", label: "bd.filterEgress", match: (op) => op.startsWith("egress.") },
];

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
  let refreshTimer = null;
  let disposed = false;
  const expanded = new Set();

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
        <label class="checkbox" style="align-items:center"><input type="checkbox" id="lAuto" style="margin:0" checked />${t("bd.autoRefresh")}</label>
        <button class="btn btn-sm" id="lRefresh">${icon("refresh")}${t("common.refresh")}</button>
        <span class="badge" id="lState" style="margin-left:auto"><span class="dot"></span><span id="lStateText"></span></span>
      </div>
      <pre class="logs" id="lView">${t("common.loading")}</pre>
      <p class="help" style="margin-top:8px">${t("bd.logsHelp")}</p>
    </details>`;

  const body = root.querySelector("#aBody");
  const foot = root.querySelector("#aFoot");
  const more = root.querySelector("#aMore");

  body.addEventListener(
    "toggle",
    (event) => {
      const entry = event.target;
      if (!entry.matches?.(".event-entry") || !body.contains(entry)) return;
      if (entry.open) expanded.add(entry.dataset.eventSeq);
      else expanded.delete(entry.dataset.eventSeq);
    },
    true,
  );

  const render = () => {
    const match = FILTERS.find((f) => f.key === filter).match;
    const shown = events.filter((event) => !isRoutine(event) && match(event.op));
    if (shown.length) {
      body.innerHTML = `<ul class="activity">${shown.map((event) => activityRow(event, { expandable: true, open: expanded.has(String(event.seq)) })).join("")}</ul>`;
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
  const refreshSoon = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => loadNewest().catch(() => {}), REFRESH_DEBOUNCE_MS);
  };
  const offEvent = subscribe("event", (event) => {
    if (event.target?.kind === "box" && event.target.id === b.id) refreshSoon();
  });
  const offReset = subscribe("reset", refreshSoon);
  const stopPolling = pollWhileDown(() => loadNewest().catch(() => {}), POLL_MS);

  const logs = root.querySelector("#dLogs");
  const logView = root.querySelector("#lView");
  const logTail = root.querySelector("#lTail");
  const logAuto = root.querySelector("#lAuto");
  const logState = root.querySelector("#lState");
  const logStateText = root.querySelector("#lStateText");
  let shown = lineWindow(Number(logTail.value));
  let stream = null;
  let fallback = null;
  let painting = 0;
  let stick = false;
  /** Bumped whenever the stream takes over or stops, so a read that was in flight does not overwrite newer lines. */
  let logEpoch = 0;

  const setLogState = (name) => {
    const [variant, key] = LOG_STATES[name];
    logState.className = `badge${variant ? ` badge-${variant}` : ""}`;
    logStateText.textContent = t(key);
  };

  /** Repaints the log once per frame, however many lines arrived since. `toBottom` keeps the view at the newest line. */
  const paintLogs = (toBottom) => {
    stick = stick || toBottom;
    if (painting) return;
    painting = requestAnimationFrame(() => {
      painting = 0;
      const pinned = stick || logView.scrollHeight - logView.scrollTop - logView.clientHeight < 40;
      stick = false;
      const lines = shown.lines();
      logView.textContent = lines.length ? lines.join("\n") : t("bd.noLogs");
      if (pinned) logView.scrollTop = logView.scrollHeight;
    });
  };

  const readLogsOnce = async (toBottom = false) => {
    const epoch = logEpoch;
    try {
      const { logs: text } = await api(`/api/boxes/${enc(b.id)}/logs?tail=${logTail.value}`);
      if (disposed || epoch !== logEpoch) return;
      shown.replace(text ? text.replace(/\r?\n$/, "").split(/\r?\n/) : []);
      paintLogs(toBottom);
    } catch (e) {
      if (disposed || epoch !== logEpoch) return;
      logView.textContent = t("bd.logsFailed", { msg: e.message });
    }
  };

  const stopFallback = () => {
    logEpoch += 1;
    clearInterval(fallback);
    fallback = null;
  };

  const startFallback = () => {
    if (fallback) return;
    void readLogsOnce();
    fallback = setInterval(() => void readLogsOnce(), LOG_FALLBACK_MS);
  };

  const stopLogs = () => {
    stream?.close();
    stream = null;
    stopFallback();
  };

  /** Shows the log the panel's controls ask for: the stream while it is open and auto-refresh is on, else one read. */
  const startLogs = () => {
    stopLogs();
    shown = lineWindow(Number(logTail.value));
    if (!logs.open) return;
    if (!logAuto.checked) {
      setLogState("manual");
      void readLogsOnce(true);
      return;
    }
    setLogState("connecting");
    stream = openBoxLogs({
      boxId: b.id,
      tail: Number(logTail.value),
      onSync: (lines) => {
        shown.replace(lines);
        paintLogs(true);
      },
      onLine: (text) => {
        shown.push(text);
        paintLogs(false);
      },
      onClosed: () => {
        stopFallback();
        setLogState("ended");
      },
      onState: (live) => {
        if (live) {
          stopFallback();
          setLogState("live");
        } else {
          setLogState("reconnecting");
          startFallback();
        }
      },
    });
  };

  logs.addEventListener("toggle", () => (logs.open ? startLogs() : stopLogs()));
  logAuto.addEventListener("change", startLogs);
  logTail.addEventListener("change", startLogs);
  root.querySelector("#lRefresh").addEventListener("click", () => {
    if (logAuto.checked) startLogs();
    else void readLogsOnce();
  });

  return () => {
    disposed = true;
    clearTimeout(refreshTimer);
    cancelAnimationFrame(painting);
    offEvent();
    offReset();
    stopPolling();
    stopLogs();
  };
}
