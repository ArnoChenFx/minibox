import { api, enc, errorHint, errorText } from "../lib/api.js";
import { powerState } from "../lib/box-state.js";
import { esc } from "../lib/dom.js";
import { duration } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { terminalHash } from "../lib/routes.js";
import { DEFAULT_SESSION_NAME, nextSessionName, sessionNameProblem } from "../lib/session-name.js";
import {
  availableHeight,
  ceilingHeight,
  clampHeight,
  clearHeight,
  defaultHeight,
  heightForKey,
  MIN_HEIGHT,
  readHeight,
  resetsHeight,
  writeHeight,
} from "../lib/terminal-height.js";
import { ctrlChar, keyBytes, keysReveal, TERM_KEYS } from "../lib/terminal-keys.js";
import { confirmDialog, emptyState, promptDialog, toast, toastError } from "../lib/ui.js";

const DEFAULT_NAME = DEFAULT_SESSION_NAME;
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

/** Writes the session on screen into the address, without a navigation, so a reload or a shared link opens it. */
function reflectInAddress(boxId, name) {
  if (!location.hash.startsWith(terminalHash(boxId))) return;
  history.replaceState(history.state, "", terminalHash(boxId, name));
}

/**
 * The terminal tab. Each box has named tmux sessions that outlive the page. The session on screen is remembered per
 * box, so a refresh reattaches to it. `session` is the one the address names, and it opens first. An agent's session
 * opens read-only; "Take over" gives this page the keyboard until it is returned, by the button or by the idle timeout
 * the server reports. A box that is not running shows why, and no socket is opened for it until it runs.
 */
export function mountTerminal(root, { box, onChange, rerender, session = "" }) {
  let shown = null;
  let waking = false;
  let teardownLive = null;
  let disposed = false;

  const sync = () => {
    if (disposed) return;
    const state = waking ? "waking" : powerState(box());
    if (state === shown) return;
    shown = state;
    teardownLive?.();
    teardownLive = null;
    if (state === "running") teardownLive = mountLive(root, box(), session);
    else root.innerHTML = offlineView(state);
  };

  /** Starting a session wakes the box, and the server answers once it runs. The tab then mounts again with the box. */
  const wake = async () => {
    if (waking || disposed) return;
    waking = true;
    sync();
    try {
      await api(`/api/boxes/${enc(box().id)}/sessions`, { method: "POST", body: { name: DEFAULT_NAME } });
    } catch (e) {
      if (disposed) return;
      waking = false;
      sync();
      toast(t("bd.wakeFailed"), { type: "error", message: withHint(e) });
      return;
    }
    if (!disposed) void rerender();
  };

  const onClick = (event) => {
    if (event.target.closest('[data-action="wake"]')) void wake();
  };
  root.addEventListener("click", onClick);
  const unsubscribe = onChange(sync);
  sync();

  return () => {
    disposed = true;
    unsubscribe();
    root.removeEventListener("click", onClick);
    teardownLive?.();
    teardownLive = null;
  };
}

/**
 * One session's chip: its name, and who created it. A session without an origin mark reads as an agent's, as the API
 * says.
 */
export function sessionChipHtml(session, current) {
  const origin = session.origin === "human" ? t("bd.originHuman") : t("bd.originAgent");
  return `<button type="button" class="session-chip" data-session="${esc(session.name)}" aria-pressed="${session.name === current}" title="${esc(origin)}">${icon("terminal")}<span class="mono">${esc(session.name)}</span><span class="chip-meta">${esc(origin)}</span></button>`;
}

/** What the tab shows in place of the terminal while the box is not running. */
function offlineView(state) {
  if (state === "expired") {
    return `<div class="card">${emptyState({ iconName: "clock", title: t("bd.expiredTitle"), text: esc(t("bd.expiredText")) })}</div>`;
  }
  if (state === "sleeping") {
    return `<div class="card">${emptyState({ iconName: "moon", title: t("bd.sleepTitle"), text: esc(t("bd.sleepText")), action: `<button class="btn btn-primary" data-action="wake">${icon("terminal")}${t("bd.wakeSession")}</button>` })}</div>`;
  }
  if (state === "waking") {
    return `<div class="card">${emptyState({ iconName: "moon", title: t("bd.wakingTitle"), text: esc(t("bd.wakingText")), action: `<button class="btn btn-primary" disabled aria-busy="true"><span class="spinner"></span>${t("bd.wakeSession")}</button>` })}</div>`;
  }
  return `<div class="card">${emptyState({ iconName: "terminal", title: t("bd.notRunning"), text: t("bd.termNotRunningText"), action: `<button class="btn btn-primary" data-action="start">${icon("play")}${t("bd.startBox")}</button>` })}</div>`;
}

/**
 * The row's press must not move focus off xterm's textarea: that is what closes a phone's keyboard, and what would send
 * the next character somewhere other than the terminal. `pointerdown` and `mousedown` both cancel, since a browser may
 * dispatch either, and the click then runs the key without focusing the button.
 */
const holdFocus = (event) => event.preventDefault();

/**
 * The auxiliary row a phone gets in place of the keys its on-screen keyboard lacks: Esc, Tab, the arrows, Ctrl and the
 * two control combinations a terminal needs most. Every key is a real button with its own `aria-label`, and the row is
 * drawn only under the 640px breakpoint (`.term-keys` in terminal-logs.css); a desktop's own keyboard has these keys.
 */
function keysRowHtml() {
  return `<div class="term-keys" id="tKeys" role="group" aria-label="${esc(t("bd.termKeys"))}">${TERM_KEYS.map(
    (key) =>
      `<button type="button" class="term-key" data-key="${esc(key.id)}" aria-label="${esc(t(key.aria))}"${key.sticky ? ' aria-pressed="false"' : ""} title="${esc(t(key.aria))}">${esc(key.label)}</button>`,
  ).join("")}</div>`;
}

/** The breakpoint the stylesheet draws a desktop's grabber and window-following height at (`.term-grabber`). */
const DESKTOP = "(min-width: 901px)";

/** Whether this window is a desktop's, as the stylesheet counts one: a phone and a tablet keep the height they had. */
const desktopScreen = () => window.matchMedia(DESKTOP).matches;

/**
 * localStorage, or null when the browser refuses it. A console that cannot remember a height still works: the height
 * then applies to this page and the default comes back on the next one.
 */
function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The grabber at the foot of the terminal frame: a desktop drags it to make the screen taller or shorter, and it is
 * hidden by the stylesheet at 900px and below, where the height is the phone's own. It is a separator, so a screen reader
 * says what it is and how far it has been moved, and focusable, so the arrow keys and Home/End work on it. It comes
 * before the screen in the page because xterm keeps Tab for the terminal, so a handle after it could never be reached
 * from the keyboard; the desktop stylesheet puts it last in the frame on screen (`order` in `.term-grabber`).
 */
function grabberHtml() {
  return `<div class="term-grabber" id="tGrabber" role="separator" aria-orientation="horizontal" tabindex="0" aria-label="${esc(t("bd.termResize"))}" title="${esc(t("bd.termResizeHint"))}"></div>`;
}

/** Mounts the live terminal for a running box, on `session` when it is listed. Returns the function that tears it down. */
function mountLive(root, b, session) {
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
      ${grabberHtml()}
      <div class="terminal" id="term"></div>
      ${keysRowHtml()}</div>
    <p class="help" style="margin-top:8px">${t("bd.termHelp")}</p>`;

  const list = root.querySelector("#tSessions");
  const control = root.querySelector("#tControl");
  const keys = root.querySelector("#tKeys");
  const screen = root.querySelector("#term");
  const grabber = root.querySelector("#tGrabber");
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
  xterm.open(screen);

  /**
   * The height the reader asked for, or null while they never have. It is kept as they left it even when the window is
   * too small for it, so a window that grows back gives the height back; what is drawn is always the clamped value.
   */
  let preferred = readHeight(storage());
  let height = 0;

  /**
   * The room this page leaves for the screen, measured rather than assumed: the window's height, less where the screen
   * starts, less what the page draws under it. The last two come from the page itself — the screen's own box and the
   * content's foot, which is under the grabber, the help line and the content's padding — so a box whose name wraps the
   * page head onto two lines, a narrower window or a longer help line needs no special case. Measured on every apply,
   * since the page's furniture changes with the window's width as well as its height.
   */
  const room = () => {
    const content = root.closest(".content") ?? document.body;
    const screenBox = screen.getBoundingClientRect();
    // Measured in the page's own coordinates, which `getBoundingClientRect()` is not: it is relative to the window, so a
    // page the reader has scrolled down would report a smaller top and a larger room, and a drag that scrolled the page
    // would then hand back a taller "default" than the page really leaves.
    const scrolled = window.scrollY;
    return availableHeight({
      viewportHeight: window.innerHeight,
      screenTop: screenBox.top + scrolled,
      screenBottom: screenBox.bottom + scrolled,
      contentBottom: content.getBoundingClientRect().bottom + scrolled,
    });
  };

  /**
   * Draws the screen `height` pixels tall and refits xterm to it, which is what makes the terminal rework its columns
   * and rows: `fit.fit()` calls `terminal.resize()`, the panel's `onResize` subscription sends the new `{type:"resize"}`
   * frame to tmux, and the shell inside redraws to the new size. A height that does not fit the room the page leaves is
   * clamped, not dropped. The handle tells a screen reader where it sits between its ends.
   *
   * By default the screen takes exactly the room there is, so the whole terminal and its grabber are in the window; the
   * old 460px stays as the floor for a window too short even for that. More lines than the window holds are the reader's
   * to ask for, by dragging the grabber, which may take the screen past the fold.
   *
   * Only a desktop takes a height of its own. At 900px and below the screen keeps the height the stylesheet gives it — a
   * phone's `min(52vh, 340px)`, a tablet's 460px — so nothing about a phone changes, and the property is taken back off
   * when a window is narrowed across the breakpoint.
   */
  /** The room the last apply measured, so a re-measure can tell whether anything moved. */
  let lastRoom = -1;
  const reapply = (refit = true) => {
    const space = room();
    lastRoom = space;
    height = clampHeight(preferred ?? defaultHeight(space), space);
    if (desktopScreen()) screen.style.setProperty("--term-h", `${height}px`);
    else screen.style.removeProperty("--term-h");
    if (refit) fit.fit();
    if (grabber) {
      grabber.setAttribute("aria-valuemin", String(MIN_HEIGHT));
      grabber.setAttribute("aria-valuemax", String(ceilingHeight(space)));
      grabber.setAttribute("aria-valuenow", String(height));
    }
  };

  /** Remembers the height on this machine, so a reload, another box or another session opens the same way. */
  const rememberHeight = () => writeHeight(storage(), height);

  /**
   * Measures again and redraws only when the room has moved: the frame is built before the session chips and the control
   * bar are filled in, and either may wrap onto a second line and push the screen down. What is under the screen is not
   * affected by the screen's own height, so this is a stable measurement rather than a moving one.
   */
  const syncHeight = () => {
    if (room() !== lastRoom) reapply();
  };

  reapply();

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
      ? sessions.map((s) => sessionChipHtml(s, current)).join("")
      : `<span class="subtle">${t("bd.noSessions")}</span>`;
    root.querySelector("#tTitle").textContent = current ? `${b.name}: ${current}` : b.name;
    syncHeight();
  };

  const renderControl = () => {
    if (!view) {
      control.innerHTML = "";
      xterm.options.disableStdin = true;
      setKeysEnabled(false);
      syncHeight();
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
    setKeysEnabled(view.canType);
    syncHeight();
  };

  /**
   * The auxiliary row is for the on-screen keyboard, so it only works while the terminal can take keys. A read-only
   * session, or no session yet, leaves the buttons visibly disabled instead of looking pressable and sending nothing.
   */
  const setKeysEnabled = (enabled) => {
    if (!keys) return;
    keys.classList.toggle("off", !enabled);
    for (const button of keys.querySelectorAll("[data-key]")) button.disabled = !enabled;
    if (!enabled) setCtrl(false);
  };

  /** Sends a key's bytes through xterm, the same channel the keyboard uses, so the panel's send path and checks apply. */
  const sendBytes = (data) => {
    if (!view?.canType || ws?.readyState !== 1) return false;
    xterm.input(data, true);
    return true;
  };

  /**
   * Ctrl is sticky: it sends nothing, it arms the next character. `aria-pressed` says whether it is armed, and the armed
   * button is drawn in the accent colour, so a phone shows the modifier is on before the letter that uses it.
   */
  const setCtrl = (armed) => {
    if (!keys) return;
    const button = keys.querySelector('[data-key="ctrl"]');
    if (!button) return;
    button.setAttribute("aria-pressed", String(armed));
    button.classList.toggle("on", armed);
  };
  const ctrlArmed = () => keys?.querySelector('[data-key="ctrl"]')?.getAttribute("aria-pressed") === "true";

  /**
   * A press on a key sends it and hands focus back to xterm's textarea, so the on-screen keyboard stays up and the next
   * character typed goes to the terminal. The press never focuses the button itself, which would close the keyboard.
   */
  const pressKey = (id) => {
    if (id === "ctrl") {
      setCtrl(!ctrlArmed());
      return;
    }
    if (ctrlArmed()) setCtrl(false);
    const data = keyBytes(id, xterm.modes);
    if (data !== null) sendBytes(data);
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
    reflectInAddress(b.id, name);
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
    if (ws?.readyState !== 1 || !view?.canType) return;
    // The armed Ctrl turns the next single character into its control character, and then resets, as a keyboard's Ctrl
    // does. A paste or an input-method composition is not one key, so it goes out as it is.
    const control = ctrlArmed() ? ctrlChar(data) : null;
    if (control !== null) setCtrl(false);
    ws.send(new TextEncoder().encode(control ?? data));
  });
  const resizeSub = xterm.onResize(({ cols, rows }) => {
    if (ws?.readyState === 1) ws.send(JSON.stringify({ type: "resize", cols, rows }));
  });

  /**
   * The row sits at the foot of the terminal frame, below the screen (`min(52vh, 340px)` on a phone). When a phone's
   * keyboard comes up it covers the bottom of the window, which can leave the row under it. This brings the row into the
   * part of the page the keyboard leaves visible, and does nothing when the row is already there, when the row is not laid
   * out (a desktop hides it, and draws the grabber there instead), or when the page cannot scroll any further.
   */
  const revealKeys = () => {
    if (!keys || keys.getBoundingClientRect().height === 0) return;
    const view = window.visualViewport;
    const top = view ? view.offsetTop : 0;
    const bottom = view ? view.offsetTop + view.height : window.innerHeight;
    const delta = keysReveal(keys.getBoundingClientRect(), { top, bottom });
    if (delta !== 0) window.scrollBy(0, delta);
  };
  // The keyboard opening and closing changes the visual viewport without a window resize, so it has a listener of its own.
  const onViewport = () => requestAnimationFrame(revealKeys);
  window.visualViewport?.addEventListener("resize", onViewport);
  // Tapping the terminal's screen, or the socket's own focus, brings the keyboard up; the row comes into view with it.
  const onFocusIn = (event) => {
    if (event.target?.closest?.(".xterm")) onViewport();
  };
  root.addEventListener("focusin", onFocusIn);

  // A shorter window may leave no room for the height the reader picked: it is clamped to what fits, and the window
  // growing back restores the rest, since the height they asked for is kept as they left it.
  const onWin = () => reapply();
  window.addEventListener("resize", onWin);

  /**
   * A drag of the handle: the pointer's own vertical travel, added to the height it started at, so the frame's bottom edge
   * follows the pointer — down makes the terminal taller, up makes it shorter. The press cancels its default, which is what
   * stops the page from scrolling and the terminal's text from being selected as the pointer sweeps over it (a browser may
   * dispatch `pointerdown`, `mousedown`, or both, so both cancel); the moves are drawn once a frame, so a fast drag does
   * not queue a resize for every pixel it crossed, and the last one is drawn when the pointer is released.
   */
  let drag = null;
  let dragFrame = 0;
  const onGrabberDown = (event) => {
    if (!grabber || event.button !== 0) return;
    // The default is cancelled before anything else, on both the pointer event and the mouse event a browser may send for
    // the same press, so neither a selection nor the page's own scroll starts under the pointer.
    event.preventDefault();
    if (drag) return;
    // Whether the terminal had the keyboard decides whether it gets it back: a drag must not cost the reader the typing
    // that a press on the handle would otherwise take away. The handle is reachable from the keyboard with Tab, which is
    // where the arrow keys and Home/End work; a pointer drag leaves the keyboard where it was.
    const hadKeyboard = document.activeElement?.closest?.(".xterm") != null;
    drag = { startY: event.clientY, startHeight: height, next: height, hadKeyboard };
    grabber.setPointerCapture?.(event.pointerId);
    document.body.classList.add("term-resizing");
  };
  const onGrabberMove = (event) => {
    if (!drag) return;
    event.preventDefault();
    drag.next = drag.startHeight + (event.clientY - drag.startY);
    if (dragFrame) return;
    dragFrame = requestAnimationFrame(() => {
      dragFrame = 0;
      if (drag) preferred = drag.next;
      reapply();
    });
  };
  const onGrabberUp = (event) => {
    if (!drag) return;
    if (dragFrame) {
      cancelAnimationFrame(dragFrame);
      dragFrame = 0;
    }
    preferred = drag.next;
    reapply();
    rememberHeight();
    document.body.classList.remove("term-resizing");
    grabber?.releasePointerCapture?.(event.pointerId);
    const hadKeyboard = drag.hadKeyboard;
    drag = null;
    if (hadKeyboard) xterm.focus();
  };

  /**
   * The handle's keys: Up makes the terminal taller and Down shorter, a step at a time, and Home or End (or Enter, which a
   * separator does not usually take) puts the default height back. Up and Down are the two keys a separator takes by
   * convention, and the frame moves the way the reader presses: Up grows it. Forgetting the remembered height is what
   * makes the screen follow the window again, so a reset is also what a double click does.
   */
  const onGrabberKey = (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const next = heightForKey(event.key, height, room());
    if (next === null) return;
    event.preventDefault();
    if (resetsHeight(event.key)) {
      preferred = null;
      clearHeight(storage());
    } else {
      preferred = next;
    }
    reapply();
    // Written after the frame is drawn, so what is remembered is the height the reader can see rather than the one
    // the last step left behind.
    if (!resetsHeight(event.key)) rememberHeight();
  };

  /** A double click on the handle is the mouse's way of asking for the default height back. */
  const onGrabberDoubleClick = () => {
    preferred = null;
    clearHeight(storage());
    reapply();
  };

  if (grabber) {
    grabber.addEventListener("pointerdown", onGrabberDown);
    // A browser may dispatch `pointerdown`, `mousedown` or both for one press; both cancel, so neither a selection drag
    // nor the page's own scrolling starts under the pointer.
    grabber.addEventListener("mousedown", onGrabberDown);
    grabber.addEventListener("pointermove", onGrabberMove);
    grabber.addEventListener("pointerup", onGrabberUp);
    grabber.addEventListener("pointercancel", onGrabberUp);
    grabber.addEventListener("keydown", onGrabberKey);
    grabber.addEventListener("dblclick", onGrabberDoubleClick);
  }

  if (keys) {
    keys.addEventListener("pointerdown", holdFocus);
    keys.addEventListener("mousedown", holdFocus);
    keys.addEventListener("click", (e) => {
      const button = e.target.closest("[data-key]");
      if (!button || button.disabled) return;
      pressKey(button.dataset.key);
      xterm.focus();
    });
    setKeysEnabled(false);
  }

  list.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-session]");
    if (chip && chip.dataset.session !== current) select(chip.dataset.session);
  });
  control.addEventListener("click", (e) => {
    const action = e.target.closest("[data-control]")?.dataset.control;
    if (action === "takeover" || action === "release") sendControl(action);
    else if (action === "close") closeCurrent();
  });
  /** The names the box holds, which the dialog offers a name from and refuses a name against. */
  const taken = () => sessions.map((s) => s.name);
  root.querySelector("#tNew").addEventListener("click", async () => {
    // The dialog opens with a name already in it, so a person can press Enter, and a name the box already holds is refused
    // in the dialog instead of by the server after the request. The names come from the list the panel has: it is read
    // when the tab opens, again after every session this page creates, and by the poll below. A session another client
    // started a moment ago may not be in it yet; the server then answers with that session rather than a second one, and
    // the list catches up on the next poll. A name the server refuses for its form still comes back as a notification.
    const name = await promptDialog({
      title: t("bd.newSessionTitle"),
      description: t("bd.newSessionText"),
      label: t("bd.sessionName"),
      value: nextSessionName(taken()),
      help: t("bd.sessionNameHelp"),
      confirmText: t("bd.newSession"),
      iconName: "terminal",
      validate: (value) => {
        const problem = sessionNameProblem(value, taken());
        return problem ? t(problem, { name: value.trim() }) : "";
      },
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
      const pick =
        listed.find((s) => s.name === session) ?? listed.find((s) => s.name === rememberedName(b.id)) ?? listed[0];
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
    if (dragFrame) cancelAnimationFrame(dragFrame);
    dragFrame = 0;
    drag = null;
    document.body.classList.remove("term-resizing");
    grabber?.removeEventListener("pointerdown", onGrabberDown);
    grabber?.removeEventListener("mousedown", onGrabberDown);
    grabber?.removeEventListener("pointermove", onGrabberMove);
    grabber?.removeEventListener("pointerup", onGrabberUp);
    grabber?.removeEventListener("pointercancel", onGrabberUp);
    grabber?.removeEventListener("keydown", onGrabberKey);
    grabber?.removeEventListener("dblclick", onGrabberDoubleClick);
    window.removeEventListener("resize", onWin);
    window.visualViewport?.removeEventListener("resize", onViewport);
    root.removeEventListener("focusin", onFocusIn);
    dataSub.dispose();
    resizeSub.dispose();
    ws?.close();
    ws = null;
    xterm.dispose();
  };
}
