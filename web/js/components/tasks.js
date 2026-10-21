import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { has, t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { isLive, onLiveState, subscribe } from "../lib/live.js";
import { invalidateTemplates } from "../lib/store.js";
import { toastError } from "../lib/ui.js";

const POLL_MS = 2000;
const BADGE = {
  running: "badge-accent",
  succeeded: "badge-success",
  failed: "badge-danger",
  cancelled: "badge-warning",
  interrupted: "badge-warning",
};

let root = null;
let tasks = [];
let selected = null;
let open = false;
let timer = null;
let source = null;
let logText = "";
const seenBuild = new Set();

/** Prefer the translated `err.*` key. The stored message is always English. */
export function taskErrorText(error) {
  if (!error) return "";
  const key = error.key ? `err.${error.key}` : "";
  if (key && has(key)) return t(key, error.params);
  return error.message ?? "";
}

/** `.btn` and `.badge` set `display`, which overrides the `hidden` attribute. */
function setHidden(node, hidden) {
  node.hidden = hidden;
  node.classList.toggle("hidden", hidden);
}

function labelOf(task) {
  const key = `task.op.${task.op}`;
  const name = t(key);
  const title = name === key ? task.summary : name;
  return task.target?.name ? `${title} · ${task.target.name}` : title;
}

function stopStream() {
  source?.close();
  source = null;
}

function paintBadge() {
  document.querySelector("#tasksBtn")?.classList.toggle(
    "has-task",
    tasks.some((task) => task.status === "running"),
  );
}

function paintList() {
  const list = root.querySelector("#taskList");
  if (!tasks.length) {
    list.innerHTML = `<p class="task-empty muted">${esc(t("task.empty"))}</p>`;
    return;
  }
  list.innerHTML = tasks
    .map(
      (
        task,
      ) => `<button type="button" class="task-item${task.id === selected ? " active" : ""}" data-id="${esc(task.id)}">
        <span class="badge ${BADGE[task.status] ?? ""}">${esc(t(`task.status.${task.status}`))}</span>
        <span class="task-item-name">${esc(labelOf(task))}</span>
      </button>`,
    )
    .join("");
}

function paintDetail(task) {
  const title = root.querySelector("#taskTitle");
  const badge = root.querySelector("#taskBadge");
  const error = root.querySelector("#taskError");
  const log = root.querySelector("#taskLog");
  const cancel = root.querySelector("[data-cancel]");
  if (!task) {
    title.textContent = t("task.empty");
    setHidden(badge, true);
    setHidden(error, true);
    log.textContent = "";
    setHidden(cancel, true);
    return;
  }
  title.textContent = labelOf(task);
  setHidden(badge, false);
  badge.className = `badge ${BADGE[task.status] ?? ""}`;
  badge.textContent = t(`task.status.${task.status}`);
  setHidden(error, !task.error);
  error.textContent = taskErrorText(task.error);
  log.textContent = logText;
  setHidden(cancel, task.status !== "running");
}

function listen(task) {
  stopStream();
  const after = task.logSeq > 0 ? `?after=${task.logSeq}` : "";
  source = new EventSource(`/api/tasks/${enc(task.id)}/events${after}`);
  source.addEventListener("message", (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (data.kind === "log" && data.text) {
      logText += data.text;
      const log = root.querySelector("#taskLog");
      if (log) {
        log.textContent = logText;
        log.scrollTop = log.scrollHeight;
      }
    }
    if (data.kind === "status") void refresh();
  });
  source.addEventListener("reset", () => {
    void select(task.id);
  });
}

async function select(id) {
  selected = id;
  stopStream();
  paintList();
  let task;
  try {
    task = await api(`/api/tasks/${enc(id)}`);
  } catch (e) {
    toastError(t("task.loadFailed"), e);
    return;
  }
  logText = task.output ?? "";
  paintDetail(task);
  if (task.status === "running") listen(task);
  if (task.op === "template.build" && task.status === "succeeded" && !seenBuild.has(task.id)) {
    seenBuild.add(task.id);
    invalidateTemplates();
    window.dispatchEvent(new CustomEvent("minibox-task-done", { detail: { op: task.op, id: task.id } }));
  }
}

async function refresh() {
  try {
    const data = await api("/api/tasks?limit=30");
    tasks = data.tasks ?? [];
  } catch {
    return;
  }
  paintBadge();
  if (!open) {
    schedule();
    return;
  }
  paintList();
  const current = tasks.find((task) => task.id === selected);
  if (!selected && tasks[0]) await select(tasks[0].id);
  else if (current) {
    const detail = await api(`/api/tasks/${enc(current.id)}`).catch(() => current);
    if (detail.output !== undefined && detail.logSeq !== undefined && !source) logText = detail.output;
    paintDetail({ ...current, ...detail, error: detail.error ?? current.error });
    if (current.status === "running" && !source) listen(detail.logSeq !== undefined ? detail : current);
    if (current.status !== "running") stopStream();
    if (current.op === "template.build" && current.status === "succeeded" && !seenBuild.has(current.id)) {
      seenBuild.add(current.id);
      invalidateTemplates();
      window.dispatchEvent(new CustomEvent("minibox-task-done", { detail: { op: current.op, id: current.id } }));
    }
  } else if (tasks[0]) await select(tasks[0].id);
  else paintDetail(null);
  schedule();
}

/** While the stream is up, status frames refresh the list. Polling covers only the time the stream is down. */
function schedule() {
  const want = (open || tasks.some((task) => task.status === "running")) && !isLive();
  if (!want) {
    if (timer) clearInterval(timer);
    timer = null;
    return;
  }
  if (!timer) timer = setInterval(() => void refresh(), POLL_MS);
}

export const trackTask = (taskId) => openTasks(taskId);

export function openTasks(taskId) {
  open = true;
  root.hidden = false;
  if (taskId) selected = taskId;
  void refresh().then(() => {
    if (taskId) return select(taskId);
    return undefined;
  });
}

export function closeTasks() {
  open = false;
  root.hidden = true;
  stopStream();
  schedule();
}

/** Opens the drawer and resolves with the terminal task. */
export async function waitTask(taskId) {
  openTasks(taskId);
  const deadline = Date.now() + 10 * 60 * 1000;
  for (;;) {
    const task = await api(`/api/tasks/${enc(taskId)}`);
    if (task.status !== "running") return task;
    if (Date.now() > deadline) return task;
    await nextStatus(taskId, isLive() ? 5000 : 400);
  }
}

/** Resolves when the task reports a status change, or after `ms` when no frame came. */
function nextStatus(taskId, ms) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(fallback);
      off();
      resolve();
    };
    const fallback = setTimeout(done, ms);
    const off = subscribe("task", (frame) => {
      if (frame.taskId === taskId && frame.kind === "status") done();
    });
  });
}

async function cancelSelected() {
  if (!selected) return;
  try {
    await api(`/api/tasks/${enc(selected)}/cancel`, { method: "POST" });
    await refresh();
  } catch (e) {
    toastError(t("task.cancelFailed"), e);
  }
}

export function mountTasks() {
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div id="taskDrawer" class="task-drawer" hidden>
      <button type="button" class="task-backdrop" data-close aria-label="${esc(t("common.close"))}"></button>
      <aside class="task-panel" role="dialog" aria-labelledby="taskHeading">
        <header class="task-head">
          <h2 id="taskHeading">${icon("activity")}${esc(t("task.title"))}</h2>
          <button type="button" class="icon-btn" data-close aria-label="${esc(t("common.close"))}">${icon("x")}</button>
        </header>
        <div class="task-body">
          <div id="taskList" class="task-list"></div>
          <div class="task-detail">
            <div class="task-detail-head">
              <h3 id="taskTitle"></h3>
              <span id="taskBadge" class="badge" hidden></span>
            </div>
            <p id="taskError" class="task-error" hidden></p>
            <pre id="taskLog" class="task-log" aria-label="${esc(t("task.log"))}"></pre>
            <button type="button" class="btn btn-sm" data-cancel hidden>${esc(t("task.cancel"))}</button>
          </div>
        </div>
      </aside>
    </div>`,
  );
  root = document.querySelector("#taskDrawer");
  root.querySelectorAll("[data-close]").forEach((node) => node.addEventListener("click", closeTasks));
  root.querySelector("[data-cancel]").addEventListener("click", () => void cancelSelected());
  root.querySelector("#taskList").addEventListener("click", (event) => {
    const item = event.target.closest("[data-id]");
    if (item) void select(item.dataset.id);
  });
  document.querySelector("#tasksBtn")?.addEventListener("click", () => (open ? closeTasks() : openTasks()));
  subscribe("task", (frame) => {
    if (frame.kind === "status") void refresh();
  });
  onLiveState(schedule);
  void refresh();
}
