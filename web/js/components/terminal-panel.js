import { api, enc, errorHint, errorText } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { duration } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { confirmDialog, emptyState, promptDialog, toast, toastError } from "../lib/ui.js";

const DEFAULT_NAME = "console";
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const POLL_MS = 10_000;

const rememberKey = (boxId) => `minibox.session.${boxId}`;

/** A failed request's message, followed by the hint that says what to do next when the server gives one. */
const withHint = (err) => [errorText(err), errorHint(err)].filter(Boolean).join(" ");

/** What holding the session means here: a takeover can time out, a session the console started stays with you. */
function humanHelp(view) {
  if (!view.takenOver) return t("bd.ctlOwnHelp");
  const idle = view.idleReturnSec > 0 ? t("bd.ctlIdle", { time: duration(view.idleReturnSec) }) : t("bd.ctlNoIdle");
  return `${t("bd.ctlHumanHelp")} ${idle}`;
}

function rememberedName(boxId) {
  try {
    return localStorage.getItem(rememberKey(boxId));
  } catch {
    return null;
  }
}

function remember(boxId, name) {
  try {
    localStorage.setItem(rememberKey(boxId), name);
  } catch {
    // Storage can be disabled. The page then reopens the first session instead of the last one.
  }
}

/**
 * The terminal tab. Each box has named tmux sessions that outlive the page. The session on screen is remembered per
 * box, so a refresh reattaches to it. An agent's session opens read-only; "Take over" gives this page the keyboard
 * until it is returned, by the button or by the idle timeout the server reports.
 */
export function mountTerminal(root, { box }) {
  const b = box();
  if (!b.running) {
    root.innerHTML = `<div class="card">${emptyState({ iconName: "terminal", title: t("bd.notRunning"), text: t("bd.termNotRunningText"), action: `<button class="btn btn-primary" data-action="start">${icon("play")}${t("bd.startBox")}</button>` })}</div>`;
    return null;
  }
  if (!window.Terminal || !window.FitAddon) {
    root.innerHTML = `<div class="callout danger">${t("bd.termLoadFailed")}</div>`;
    return null;
  }

  root.innerHTML = `<div class="session-bar">
      <div class="session-list" id="tSessions" role="group" aria-label="${esc(t("bd.sessions"))}"></div>
      <button class="btn btn-sm" id="tNew">${icon("plus")}${t("bd.newSession")}</button>
    </div>
    <div class="terminal-frame">
      <div class="terminal-bar"><span class="lights"><i></i><i></i><i></i></span><span class="mono" id="tTitle"></span>
        <span class="status" id="tStatus"><span class="dot"></span><span id="tStatusText">${t("common.connecting")}</span></span>
        <button class="btn btn-ghost btn-sm" id="tReconnect" style="color:#a1a1aa">${icon("refresh")}${t("bd.reconnect")}</button></div>
      <div class="control-bar" id="tControl" aria-live="polite"></div>
      <div class="terminal" id="term"></div></div>
    <p class="help" style="margin-top:8px">${t("bd.termHelp")}</p>`;

  const list = root.querySelector("#tSessions");
  const control = root.querySelector("#tControl");
  const status = root.querySelector("#tStatus");
  const statusText = root.querySelector("#tStatusText");
  const xterm = new window.Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
    theme: { background: "#0b0b0e", foreground: "#e4e4e7", cursor: "#a5a2ff", selectionBackground: "#3f3f7a" },
    scrollback: 5000,
  });
  const fit = new window.FitAddon.FitAddon();
  xterm.loadAddon(fit);
  xterm.open(root.querySelector("#term"));
  fit.fit();

  let sessions = [];
  let current = null;
  let view = null;
  let ws = null;
  let disposed = false;

  const setStatus = (on, text) => {
    status.classList.toggle("on", on);
    statusText.textContent = text;
  };

  const renderList = () => {
    list.innerHTML = sessions.length
      ? sessions
          .map(
            (
              s,
            ) => `<button type="button" class="session-chip" data-session="${esc(s.name)}" aria-pressed="${s.name === current}" title="${esc(s.origin === "human" ? t("bd.originHuman") : t("bd.originAgent"))}">
              ${icon("terminal")}<span class="mono">${esc(s.name)}</span><span class="chip-meta">${esc(s.controller === "human" ? t("bd.chipYou") : t("bd.chipAgent"))}</span></button>`,
          )
          .join("")
      : `<span class="subtle">${t("bd.noSessions")}</span>`;
    root.querySelector("#tTitle").textContent = current ? `${b.name}: ${current}` : b.name;
  };

  const renderControl = () => {
    if (!view) {
      control.innerHTML = "";
      xterm.options.disableStdin = true;
      return;
    }
    const human = view.controller === "human";
    const action = human
      ? `<button class="btn btn-sm" data-control="release">${icon("arrowLeft")}${t("bd.ctlRelease")}</button>`
      : `<button class="btn btn-sm btn-primary" data-control="takeover">${icon("key")}${t("bd.ctlTakeOver")}</button>`;
    control.innerHTML = `<span class="badge ${human ? "badge-accent" : "badge-warning"}"><span class="dot"></span>${esc(human ? t("bd.ctlHuman") : t("bd.ctlAgent"))}</span>
      <span class="control-help">${esc(human ? humanHelp(view) : t("bd.ctlAgentHelp"))}</span>
      <span class="control-actions">${action}<button class="btn btn-sm btn-ghost" data-control="close">${icon("x")}${t("bd.closeSession")}</button></span>`;
    xterm.options.disableStdin = !view.canType;
  };

  const loadSessions = async () => {
    const { sessions: listed } = await api(`/api/boxes/${enc(b.id)}/sessions`);
    sessions = listed;
    renderList();
    return listed;
  };

  const startSession = async (name) => {
    const { session } = await api(`/api/boxes/${enc(b.id)}/sessions`, { method: "POST", body: { name } });
    return session;
  };

  const receive = (text) => {
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (frame.type === "state") {
      view = frame;
      sessions = sessions.map((s) =>
        s.name === frame.name
          ? { ...s, origin: frame.origin, controller: frame.controller, takenOver: frame.takenOver }
          : s,
      );
      renderList();
      renderControl();
    } else if (frame.type === "error") {
      toast(errorText(frame.error), { type: "error", message: errorHint(frame.error) });
    }
  };

  const connect = () => {
    ws?.close();
    view = null;
    renderControl();
    xterm.reset();
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const sock = new WebSocket(`${proto}//${location.host}/api/boxes/${enc(b.id)}/terminal?session=${enc(current)}`);
    sock.binaryType = "arraybuffer";
    ws = sock;
    setStatus(false, t("common.connecting"));
    sock.addEventListener("open", () => {
      if (sock !== ws) return;
      setStatus(true, t("bd.connected"));
      sock.send(JSON.stringify({ type: "resize", cols: xterm.cols, rows: xterm.rows }));
      xterm.focus();
    });
    sock.addEventListener("message", (ev) => {
      if (sock !== ws) return;
      if (typeof ev.data === "string") receive(ev.data);
      else xterm.write(new Uint8Array(ev.data));
    });
    sock.addEventListener("close", (ev) => {
      if (sock !== ws) return;
      ws = null;
      if (ev.code === 1008) {
        location.href = "/login";
        return;
      }
      view = null;
      renderControl();
      setStatus(false, ev.code === 1000 ? t("bd.sessionEnded") : t("bd.disconnected"));
      loadSessions().catch(() => {});
    });
  };

  const select = (name) => {
    current = name;
    remember(b.id, name);
    renderList();
    connect();
  };

  const sendControl = (type) => {
    if (ws?.readyState === 1) ws.send(JSON.stringify({ type }));
    else toast(t("bd.disconnected"), { type: "error" });
  };

  const closeCurrent = async () => {
    const name = current;
    const ok = await confirmDialog({
      title: t("bd.closeSession"),
      message: esc(t("bd.closeSessionText", { name })),
      confirmText: t("bd.closeSession"),
      danger: true,
    });
    if (!ok || disposed) return;
    try {
      await api(`/api/boxes/${enc(b.id)}/sessions/${enc(name)}`, { method: "DELETE" });
      const left = await loadSessions();
      if (disposed) return;
      select(left[0] ? left[0].name : (await startSession(DEFAULT_NAME)).name);
    } catch (e) {
      toastError(t("bd.closeFailed"), e);
    }
  };

  const dataSub = xterm.onData((data) => {
    if (ws?.readyState === 1 && view?.canType) ws.send(new TextEncoder().encode(data));
  });
  const resizeSub = xterm.onResize(({ cols, rows }) => {
    if (ws?.readyState === 1) ws.send(JSON.stringify({ type: "resize", cols, rows }));
  });
  const onWin = () => fit.fit();
  window.addEventListener("resize", onWin);

  list.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-session]");
    if (chip && chip.dataset.session !== current) select(chip.dataset.session);
  });
  control.addEventListener("click", (e) => {
    const action = e.target.closest("[data-control]")?.dataset.control;
    if (action === "takeover" || action === "release") sendControl(action);
    else if (action === "close") closeCurrent();
  });
  root.querySelector("#tNew").addEventListener("click", async () => {
    const name = await promptDialog({
      title: t("bd.newSessionTitle"),
      description: t("bd.newSessionText"),
      label: t("bd.sessionName"),
      placeholder: DEFAULT_NAME,
      help: t("bd.sessionNameHelp"),
      confirmText: t("bd.newSession"),
      iconName: "terminal",
      validate: (value) => (NAME_RE.test(value) ? "" : t("bd.sessionNameInvalid")),
    });
    if (!name) return;
    try {
      const session = await startSession(name);
      await loadSessions();
      select(session.name);
    } catch (e) {
      toast(t("bd.sessionStartFailed"), { type: "error", message: withHint(e) });
    }
  });
  root.querySelector("#tReconnect").addEventListener("click", () => current && connect());

  const timer = setInterval(() => loadSessions().catch(() => {}), POLL_MS);

  (async () => {
    try {
      const listed = await loadSessions();
      if (disposed) return;
      const wanted = rememberedName(b.id);
      const pick = listed.find((s) => s.name === wanted) ?? listed[0];
      if (pick) {
        select(pick.name);
        return;
      }
      const created = await startSession(DEFAULT_NAME);
      if (disposed) return;
      await loadSessions();
      select(created.name);
    } catch (e) {
      if (disposed) return;
      setStatus(false, errorText(e));
      list.innerHTML = `<span class="callout danger">${esc(withHint(e))}</span>`;
    }
  })();

  return () => {
    disposed = true;
    clearInterval(timer);
    window.removeEventListener("resize", onWin);
    dataSub.dispose();
    resizeSub.dispose();
    ws?.close();
    ws = null;
    xterm.dispose();
  };
}
