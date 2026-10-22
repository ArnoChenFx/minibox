import { api, enc, errorText } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { dateTime } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import {
  isWatching,
  STARTUP_COMMAND_MAX_BYTES,
  startupProblem,
  startupProblemKey,
  startupStatusView,
} from "../lib/startup.js";
import { confirmDialog, toast, toastError, withBusy } from "../lib/ui.js";

/** How often a card reads a command that is running, so its status and output stay current. */
const POLL_MS = 4000;

const actionButton = (action, label, iconName) =>
  `<button type="button" class="btn btn-sm" data-startup-action="${action}">${icon(iconName)}${esc(label)}</button>`;

function statusHtml(state) {
  const view = startupStatusView(state);
  const times = [
    state.startedAt ? t("sc.startedAt", { time: dateTime(state.startedAt) }) : "",
    state.exitedAt ? t("sc.exitedAt", { time: dateTime(state.exitedAt) }) : "",
  ]
    .filter(Boolean)
    .map(esc)
    .join(" · ");
  const dot = state.status === "running" ? `<span class="dot"></span>` : "";
  return `<div class="startup-status"><span class="badge ${view.tone}">${dot}${esc(t(view.key, view.params))}</span>${
    times ? `<span>${times}</span>` : ""
  }</div>`;
}

function commandHtml(state) {
  if (state.command === null) return `<p class="subtle">${esc(t("sc.none"))}</p>`;
  return `${statusHtml(state)}
    <pre class="startup-block startup-command">${esc(state.command)}</pre>
    ${state.error ? `<div class="callout danger">${icon("alert")}<span>${esc(errorText(state.error))}</span></div>` : ""}
    ${state.stale ? `<div class="callout warn">${icon("info")}<span>${esc(t("sc.stale"))}</span></div>` : ""}
    <span class="label">${esc(t("sc.output"))}</span>
    ${
      state.log.length
        ? `<pre class="startup-block startup-log" tabindex="0">${esc(state.log.join("\n"))}</pre>`
        : `<p class="subtle">${esc(t("sc.noOutput"))}</p>`
    }`;
}

function viewHtml({ state, running, forbidden, loadError }) {
  const actions = [];
  if (state && !forbidden) {
    actions.push(
      state.command === null
        ? actionButton("edit", t("sc.set"), "plus")
        : actionButton("edit", t("sc.edit"), "sliders"),
    );
    if (state.command !== null && running) actions.push(actionButton("run", t("sc.rerun"), "play"));
    if (state.command !== null) actions.push(actionButton("remove", t("sc.remove"), "trash"));
  }
  return `<div class="card" style="margin-top:16px">
    <div class="card-head"><h3>${esc(t("sc.section"))}</h3><div class="startup-actions">${actions.join("")}</div></div>
    <div class="card-body stack">
      <p class="help">${esc(t("sc.help"))}</p>
      ${loadError ? `<div class="callout danger">${icon("alert")}<span><strong>${esc(t("sc.loadFailed"))}</strong> ${esc(loadError)}</span></div>` : ""}
      ${forbidden ? `<div class="callout warn">${icon("alert")}<span>${esc(t("sc.forbidden"))}</span></div>` : ""}
      ${state && !forbidden ? commandHtml(state) : ""}
    </div>
  </div>`;
}

function editHtml({ draft, applyNow, error }, running) {
  const applyRow = running
    ? `<label class="check-row">
        <input class="sr-only" type="checkbox" data-startup-apply${applyNow ? " checked" : ""} />
        <span class="check-mark" aria-hidden="true">${icon("check")}</span>
        <span class="check-body"><span class="check-title"><strong>${esc(t("sc.applyNow"))}</strong></span><span class="help">${esc(t("sc.applyNowHelp"))}</span></span>
      </label>`
    : "";
  return `<div class="card" style="margin-top:16px">
    <div class="card-head"><h3>${esc(t("sc.section"))}</h3></div>
    <div class="card-body stack">
      <p class="help">${esc(t("sc.editHelp"))}</p>
      <label class="field"><span class="label">${esc(t("sc.section"))}</span>
        <textarea class="textarea command-input" data-startup-input rows="4" spellcheck="false" placeholder="${esc(t("cb.startupPlaceholder"))}">${esc(draft)}</textarea></label>
      ${applyRow}
      <div class="error-text" data-startup-error>${esc(error)}</div>
    </div>
    <div class="card-body startup-actions">
      <button type="button" class="btn" data-startup-action="cancel">${esc(t("common.cancel"))}</button>
      <button type="button" class="btn btn-primary" data-startup-action="save">${esc(t("common.save"))}</button>
    </div>
  </div>`;
}

/**
 * The startup card's markup. Without `editing` it shows the command, its status and the newest output lines; with it, the
 * editor holds the draft. The command and its output are escaped, so a command never runs as markup.
 */
export function startupCardHtml({ state = null, running = false, forbidden = false, loadError = "", editing = null }) {
  return editing ? editHtml(editing, running) : viewHtml({ state, running, forbidden, loadError });
}

/**
 * The startup command card on the overview tab. The box frame does not carry the command, so the card reads it from REST,
 * and reads it again every few seconds while it runs. A change takes effect at the next start, or at once with "apply now"
 * on a running box. A save is refused when the box changed since editing began, as the environment card does.
 */
export function mountStartupCard(container, { box }) {
  let state = null;
  let forbidden = false;
  let loadError = "";
  let editing = null;
  let disposed = false;
  let timer = null;
  let reads = 0;
  let shown = "";
  let seen = { revision: null, running: null };

  container.innerHTML = `<div class="card" style="margin-top:16px"><div class="card-body"><span class="spinner"></span></div></div>`;

  const apply = (next) => {
    reads += 1;
    state = next;
    forbidden = false;
    loadError = "";
  };

  const read = async () => {
    const seq = ++reads;
    try {
      const fresh = await api(`/api/boxes/${enc(box().id)}/startup-command`);
      if (disposed || seq !== reads) return;
      state = fresh;
      forbidden = false;
      loadError = "";
    } catch (e) {
      if (disposed || seq !== reads) return;
      forbidden = e.status === 403;
      loadError = forbidden ? "" : e.message;
    }
  };

  const paint = (html) => {
    const log = container.querySelector(".startup-log");
    const followed = !log || log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
    const top = log?.scrollTop ?? 0;
    shown = html;
    container.innerHTML = html;
    const next = container.querySelector(".startup-log");
    if (next) next.scrollTop = followed ? next.scrollHeight : top;
  };

  const draw = () => {
    if (disposed || editing || (!state && !forbidden && !loadError)) return;
    const html = startupCardHtml({ state, running: box().running, forbidden, loadError });
    if (html !== shown) paint(html);
  };

  const drawEdit = () => {
    shown = "";
    container.innerHTML = startupCardHtml({ running: box().running, editing });
  };

  const setEditError = (message) => {
    const slot = container.querySelector("[data-startup-error]");
    if (slot) slot.textContent = message;
  };

  const syncTimer = () => {
    const watching = !disposed && !editing && state !== null && isWatching(state, box().running);
    if (watching && timer === null) timer = setInterval(() => void refresh(), POLL_MS);
    if (!watching && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const refresh = async () => {
    await read();
    draw();
    syncTimer();
  };

  const startEdit = () => {
    if (!state || forbidden) return;
    editing = {
      revision: state.revision,
      command: state.command,
      draft: state.command ?? "",
      applyNow: false,
      error: "",
    };
    drawEdit();
    container.querySelector("[data-startup-input]")?.focus();
    syncTimer();
  };

  const stopEdit = () => {
    editing = null;
    draw();
    syncTimer();
  };

  const save = async (button) => {
    const base = editing;
    const text = container.querySelector("[data-startup-input]").value;
    const applyNow = Boolean(container.querySelector("[data-startup-apply]")?.checked);
    const problem = startupProblem(text);
    if (problem) {
      setEditError(t(startupProblemKey(problem), { max: STARTUP_COMMAND_MAX_BYTES }));
      return;
    }
    if (text === base.command && !applyNow) {
      stopEdit();
      return;
    }
    setEditError("");
    await withBusy(button, async () => {
      try {
        const saved = await api(`/api/boxes/${enc(box().id)}/startup-command`, {
          method: "PUT",
          body: { command: text, applyNow },
          headers: { "if-match": String(base.revision) },
        });
        if (disposed) return;
        apply(saved);
        if (editing === base) editing = null;
        toast(applyNow ? t("sc.ran") : t("sc.saved"), {
          message: t(applyNow ? "sc.ranText" : "sc.savedText", { name: box().name }),
        });
        draw();
        syncTimer();
      } catch (err) {
        if (disposed || editing !== base) return;
        setEditError(`${err.message}${err.hint ? ` ${err.hint}` : ""}`);
      }
    });
  };

  const runNow = async (button) => {
    await withBusy(button, async () => {
      try {
        apply(await api(`/api/boxes/${enc(box().id)}/startup-command/run`, { method: "POST" }));
        toast(t("sc.ran"), { message: t("sc.ranText", { name: box().name }) });
        draw();
        syncTimer();
      } catch (err) {
        toastError(t("sc.runFailed"), err);
      }
    });
  };

  const remove = async (button) => {
    const ok = await confirmDialog({
      title: t("sc.removeTitle"),
      message: esc(t("sc.removeText")),
      confirmText: t("sc.remove"),
      danger: true,
    });
    if (!ok) return;
    await withBusy(button, async () => {
      try {
        apply(
          await api(`/api/boxes/${enc(box().id)}/startup-command`, {
            method: "DELETE",
            headers: { "if-match": String(state.revision) },
          }),
        );
        toast(t("sc.removed"));
        draw();
        syncTimer();
      } catch (err) {
        toastError(t("sc.removeFailed"), err);
        void refresh();
      }
    });
  };

  container.addEventListener("click", (event) => {
    const target = event.target.closest("[data-startup-action]");
    if (!target || disposed) return;
    switch (target.dataset.startupAction) {
      case "edit":
        startEdit();
        break;
      case "cancel":
        stopEdit();
        break;
      case "save":
        void save(target);
        break;
      case "run":
        void runNow(target);
        break;
      case "remove":
        void remove(target);
        break;
    }
  });

  container.addEventListener("input", (event) => {
    if (event.target.matches("[data-startup-input]")) setEditError("");
  });

  seen = { revision: box().revision, running: box().running };
  void refresh();

  return {
    onBoxChange() {
      if (disposed) return;
      const current = box();
      if (current.revision === seen.revision && current.running === seen.running) return;
      seen = { revision: current.revision, running: current.running };
      void refresh();
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
