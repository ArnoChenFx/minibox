import { ansiToHtml, stripAnsi } from "../lib/ansi.js";
import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { dateTime, elapsed, relTime } from "../lib/format.js";
import { has, t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { isLive, onLiveState, subscribe } from "../lib/live.js";
import { invalidateTemplates } from "../lib/store.js";
import { capLog, splitTaskLog } from "../lib/task-log.js";
import { subjectOf } from "../lib/task-subject.js";
import { toastError } from "../lib/ui.js";

const POLL_MS = 2000;
const TICK_MS = 1000;
/** Within this many pixels of the bottom, the log counts as followed. */
const FOLLOW_SLACK_PX = 24;
const COPY_FEEDBACK_MS = 1500;
/** The most log text kept while streaming. The server keeps 64 KiB, so this leaves room without growing forever. */
const LOG_MAX_CHARS = 128 * 1024;

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
let shown = null;
let open = false;
let timer = null;
let ticker = null;
let source = null;
let logText = "";
let renderedLog = null;
let renderedCommands = null;
let listHtml = null;
let outputFrame = 0;
let commandList = [];
let commandsOpen = false;
let follow = true;
let wrap = false;
let copyTimer = null;
let detailRequest = 0;
const TEMPLATE_OPS = new Set([
  "template.build",
  "template.save",
  "template.create",
  "template.rebuild",
  "template.sync",
]);
const seenTemplateTask = new Set();

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

/** The operation's name. Without a translation, its summary minus the target that the summary appends. */
function opLabel(task) {
  const key = `task.op.${task.op}`;
  if (has(key)) return t(key);
  const suffix = task.target?.name ? `: ${task.target.name}` : "";
  return suffix && task.summary.endsWith(suffix) ? task.summary.slice(0, -suffix.length) : task.summary;
}

/**
 * The operation, what it acted on (a tool, a snapshot, a template) and the box it ran in. A target that is not a box
 * stands in for the subject when the task names none.
 */
function namesOf(task) {
  const box = task.target?.kind === "box" ? task.target.name : "";
  const acted = subjectOf(task) || (box ? "" : (task.target?.name ?? ""));
  return { op: opLabel(task), acted, box };
}

const joined = (parts) => parts.filter(Boolean).join(" · ");

function titleOf(task) {
  const { op, acted, box } = namesOf(task);
  return joined([op, acted, box]);
}

function statusMark(task) {
  const label = esc(t(`task.status.${task.status}`));
  if (task.status === "running") return `<span class="task-mark spinner" role="img" aria-label="${label}"></span>`;
  return `<span class="task-mark" data-status="${esc(task.status)}" role="img" aria-label="${label}"></span>`;
}

function taskItem(task) {
  const { op, acted, box } = namesOf(task);
  const title = joined([op, acted]);
  const active = task.id === selected;
  return `<button type="button" class="task-item${active ? " active" : ""}" data-id="${esc(task.id)}"${active ? ' aria-current="true"' : ""}>
    ${statusMark(task)}
    <span class="task-item-main">
      <span class="task-item-title" title="${esc(title)}">${esc(title)}</span>
      <span class="task-item-meta">
        ${box ? `<span class="task-item-box">${esc(box)}</span>` : ""}
        <time datetime="${esc(task.createdAt)}" title="${esc(dateTime(task.createdAt))}">${esc(relTime(task.createdAt))}</time>
      </span>
    </span>
  </button>`;
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
  const html = tasks.length ? tasks.map(taskItem).join("") : `<p class="task-empty muted">${esc(t("task.empty"))}</p>`;
  if (html === listHtml) return;
  listHtml = html;
  list.innerHTML = html;
}

function paintElapsed() {
  if (!shown) return;
  const running = shown.status === "running";
  const end = running ? Date.now() : Date.parse(shown.finishedAt ?? "");
  root.querySelector("#taskDurationLabel").textContent = t(running ? "task.elapsed" : "task.duration");
  root.querySelector("#taskDuration").textContent = Number.isNaN(end) ? "—" : elapsed(shown.createdAt, end);
}

function paintDetail(task) {
  shown = task;
  const title = root.querySelector("#taskTitle");
  const badge = root.querySelector("#taskBadge");
  const facts = root.querySelector("#taskFacts");
  const error = root.querySelector("#taskError");
  const cancel = root.querySelector("[data-cancel]");
  if (!task) {
    title.textContent = t("task.empty");
    setHidden(badge, true);
    setHidden(facts, true);
    setHidden(error, true);
    setHidden(cancel, true);
    paintOutput();
    return;
  }
  title.textContent = titleOf(task);
  setHidden(badge, false);
  badge.className = `badge ${BADGE[task.status] ?? ""}`;
  badge.innerHTML = `<span class="dot"></span>${esc(t(`task.status.${task.status}`))}`;
  root.querySelector("#taskStarted").textContent = dateTime(task.createdAt);
  setHidden(facts, false);
  setHidden(error, !task.error);
  error.textContent = taskErrorText(task.error);
  setHidden(cancel, task.status !== "running");
  paintElapsed();
  paintOutput();
}

function paintOutput() {
  const { commands, output } = splitTaskLog(shown ? logText : "");
  commandList = commands;
  paintCommands(commands);
  paintLog(output);
  paintJump();
}

function commandHtml({ banner, command }) {
  const line = `<span class="task-cmd-line"><span class="task-cmd-prompt">$</span> ${esc(stripAnsi(command))}</span>`;
  return banner ? `<span class="task-cmd-banner">${esc(stripAnsi(banner))}</span>${line}` : line;
}

function paintCommands(commands) {
  setHidden(root.querySelector("#taskCommands"), commands.length === 0);
  const html = commands.map(commandHtml).join("");
  if (html !== renderedCommands) {
    renderedCommands = html;
    root.querySelector("#taskCommandBody").innerHTML = html;
  }
  paintCommandToggle();
}

function paintCommandToggle() {
  root.querySelector("#taskCommandToggle").setAttribute("aria-expanded", String(commandsOpen));
  setHidden(root.querySelector("#taskCommandBody"), !commandsOpen);
}

function logHtml(output) {
  if (!shown) return "";
  if (output) return ansiToHtml(output);
  const key = shown.status === "running" ? "task.waiting" : "task.noOutput";
  return `<span class="task-log-empty">${esc(t(key))}</span>`;
}

function paintLog(output) {
  const html = logHtml(output);
  if (html === renderedLog) return;
  renderedLog = html;
  const log = root.querySelector("#taskLog");
  log.innerHTML = html;
  if (follow && shown?.status === "running") log.scrollTop = log.scrollHeight;
}

function paintJump() {
  setHidden(root.querySelector("#taskJump"), follow || shown?.status !== "running");
}

function resetLogScroll() {
  const log = root.querySelector("#taskLog");
  log.scrollTop = shown?.status === "running" ? log.scrollHeight : 0;
  paintJump();
}

/** Output arrives in small chunks. One repaint per frame keeps a fast build from re-parsing the log for each chunk. */
function queueOutput() {
  if (outputFrame) return;
  outputFrame = requestAnimationFrame(() => {
    outputFrame = 0;
    paintOutput();
  });
}

function onLogScroll() {
  const log = root.querySelector("#taskLog");
  follow = log.scrollHeight - log.scrollTop - log.clientHeight <= FOLLOW_SLACK_PX;
  paintJump();
}

function jumpToLatest() {
  const log = root.querySelector("#taskLog");
  follow = true;
  log.scrollTop = log.scrollHeight;
  paintJump();
}

function toggleWrap(button) {
  wrap = !wrap;
  const log = root.querySelector("#taskLog");
  log.classList.toggle("wrap", wrap);
  button.setAttribute("aria-pressed", String(wrap));
  if (follow) log.scrollTop = log.scrollHeight;
}

function toggleCommands() {
  commandsOpen = !commandsOpen;
  paintCommandToggle();
}

async function copyCommands() {
  const button = root.querySelector("#taskCopy");
  try {
    await navigator.clipboard.writeText(commandList.map(({ command }) => stripAnsi(command)).join("\n"));
  } catch (e) {
    toastError(t("task.copyFailed"), e);
    return;
  }
  button.innerHTML = `${icon("check")}${esc(t("task.copied"))}`;
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    button.innerHTML = `${icon("copy")}${esc(t("task.copy"))}`;
  }, COPY_FEEDBACK_MS);
}

function listen(task) {
  stopStream();
  const after = task.logSeq > 0 ? `?after=${task.logSeq}` : "";
  const next = new EventSource(`/api/tasks/${enc(task.id)}/events${after}`);
  source = next;
  next.addEventListener("message", (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (data.kind === "log" && data.text) {
      logText = capLog(logText + data.text, LOG_MAX_CHARS);
      queueOutput();
    }
    if (data.kind === "status") void refresh();
  });
  next.addEventListener("reset", () => {
    void select(task.id);
  });
}

/** A template task that succeeded drops the cached template list, and tells the open pages to load it again. */
function noteFinished(task) {
  if (!TEMPLATE_OPS.has(task.op) || task.status !== "succeeded" || seenTemplateTask.has(task.id)) return;
  seenTemplateTask.add(task.id);
  invalidateTemplates();
  window.dispatchEvent(new CustomEvent("minibox-task-done", { detail: { op: task.op, id: task.id } }));
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
  if (selected !== id) return;
  logText = task.output ?? "";
  renderedLog = null;
  renderedCommands = null;
  follow = true;
  paintDetail(task);
  resetLogScroll();
  if (task.status === "running") listen(task);
  noteFinished(task);
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
  if (selected) await refreshDetail(selected);
  else if (tasks[0]) await select(tasks[0].id);
  else paintDetail(null);
  schedule();
}

/**
 * Polls and status frames can overlap, and the selection can change while a request is in flight. Only the newest
 * request for the selected task is applied.
 */
async function refreshDetail(id) {
  const request = ++detailRequest;
  const current = tasks.find((task) => task.id === id);
  const detail = await api(`/api/tasks/${enc(id)}`).catch(() => current);
  if (request !== detailRequest || selected !== id || !detail) return;
  const running = detail.status === "running";
  if (detail.output !== undefined && detail.logSeq !== undefined && (!source || !running)) logText = detail.output;
  paintDetail({ ...current, ...detail, error: detail.error ?? current?.error });
  if (running && !source) listen(detail);
  if (!running) stopStream();
  noteFinished(detail);
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

function startTicker() {
  if (!ticker) ticker = setInterval(() => shown?.status === "running" && paintElapsed(), TICK_MS);
}

function stopTicker() {
  clearInterval(ticker);
  ticker = null;
}

export const trackTask = (taskId) => openTasks(taskId);

export function openTasks(taskId) {
  open = true;
  root.hidden = false;
  if (taskId) selected = taskId;
  startTicker();
  void refresh().then(() => {
    if (taskId) return select(taskId);
    return undefined;
  });
}

export function closeTasks() {
  open = false;
  root.hidden = true;
  stopTicker();
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
              <div class="task-detail-actions">
                <span id="taskBadge" class="badge" hidden></span>
                <button type="button" class="btn btn-sm" data-cancel hidden>${esc(t("task.cancel"))}</button>
              </div>
            </div>
            <dl id="taskFacts" class="task-facts" hidden>
              <div><dt>${esc(t("task.started"))}</dt><dd id="taskStarted"></dd></div>
              <div><dt id="taskDurationLabel">${esc(t("task.duration"))}</dt><dd id="taskDuration"></dd></div>
            </dl>
            <p id="taskError" class="task-error" hidden></p>
            <section id="taskCommands" class="task-commands" hidden>
              <div class="task-command-row">
                <button type="button" id="taskCommandToggle" class="task-command-toggle" aria-expanded="false" aria-controls="taskCommandBody">${icon("chevron")}${esc(t("task.command"))}</button>
                <button type="button" id="taskCopy" class="btn btn-sm">${icon("copy")}${esc(t("task.copy"))}</button>
              </div>
              <pre id="taskCommandBody" class="task-command-body" hidden></pre>
            </section>
            <div class="task-log-frame">
              <div class="task-log-bar">
                <span class="task-log-title">${esc(t("task.log"))}</span>
                <button type="button" id="taskWrap" class="filter-chip" aria-pressed="false">${esc(t("task.wrap"))}</button>
              </div>
              <pre id="taskLog" class="task-log" tabindex="0" aria-label="${esc(t("task.log"))}"></pre>
              <button type="button" id="taskJump" class="btn btn-sm task-jump" hidden>${icon("chevron")}${esc(t("task.jumpLatest"))}</button>
            </div>
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
  root.querySelector("#taskCommandToggle").addEventListener("click", toggleCommands);
  root.querySelector("#taskCopy").addEventListener("click", () => void copyCommands());
  root.querySelector("#taskWrap").addEventListener("click", (event) => toggleWrap(event.currentTarget));
  root.querySelector("#taskLog").addEventListener("scroll", onLogScroll, { passive: true });
  root.querySelector("#taskJump").addEventListener("click", jumpToLatest);
  document.querySelector("#tasksBtn")?.addEventListener("click", () => (open ? closeTasks() : openTasks()));
  subscribe("task", (frame) => {
    if (frame.kind === "status") void refresh();
  });
  onLiveState(schedule);
  void refresh();
}
