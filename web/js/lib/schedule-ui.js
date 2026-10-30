import { errorText } from "./api.js";
import { browserTimezone, SCHEDULE_HOURS, scheduleBody, scheduleZone } from "./checkpoint-state.js";
import { esc } from "./dom.js";
import { dateTime } from "./format.js";
import { has, t } from "./i18n.js";
import { icon } from "./icons.js";

/**
 * The schedule card and dialog, shared by a box's checkpoint schedule and the instance's backup schedule. Both are the
 * same rule — every few hours, or once a day in a zone — so a person who has set one has set the other. The words that
 * differ (what a run makes, and what the card warns about) come in as `labels`.
 */

/** A time in the browser's local time, with the zone it is in, such as `2026/10/23 03:00（Asia/Shanghai）`. */
export function zonedTime(iso, zone) {
  return `${dateTime(iso)}${t("ck.inZone", { zone })}`;
}

/** The rule in words, as the card and the dialog say it. */
export function ruleText(schedule) {
  if (schedule.mode === "daily") return t("ck.scheduleDaily", { at: schedule.at, zone: scheduleZone(schedule) });
  return schedule.everyHours === 1 ? t("ck.scheduleEveryHour") : t("ck.scheduleEvery", { n: schedule.everyHours });
}

/**
 * The last run in words: `labels.ok` or `labels.failed` with the time, or `labels.none` when nothing has run yet.
 * `labels.ok` and `labels.failed` take `{ time }` and `{ time, error }`. A failure that came from a message is said in
 * the console's language, and one that did not is shown as the server wrote it. A schedule whose runs can be skipped
 * names `labels.skipped`, which takes `{ time, reason }`, and `labels.skipPrefix`, the dictionary prefix of each reason
 * code the server names; a code it has no words for is shown as it is.
 */
export function lastRunText(run, zone, labels) {
  if (!run) return t(labels.none);
  const time = zonedTime(run.at, zone);
  if (run.status === "ok") return t(labels.ok, { time });
  if (run.status === "skipped" && labels.skipped) {
    const key = `${labels.skipPrefix ?? ""}${run.reason}`;
    return t(labels.skipped, { time, reason: labels.skipPrefix && has(key) ? t(key) : (run.reason ?? "") });
  }
  const error = errorText({ key: run.errorKey, params: run.errorParams, message: run.error ?? "" });
  return t(labels.failed, { time, error });
}

/**
 * The card's line: off, or the rule with its next and last run, and the buttons that change it. `action` prefixes the
 * `data-action` names, so a page binds each card's buttons without them colliding. `blocked` is the dictionary key of
 * why a schedule cannot be set or changed right now: the card says so, and its set and change buttons are disabled
 * with that as their title, so the reason is read before a click and not after it. Turning a schedule off stays open.
 */
export function scheduleCardHtml(
  schedule,
  { zone = browserTimezone(), labels, action, lastRun = lastRunText, blocked = null },
) {
  const why = blocked ? `<div class="callout warn">${icon("alert")}<span>${esc(t(blocked))}</span></div>` : "";
  const shut = blocked ? ` disabled title="${esc(t(blocked))}"` : "";
  if (!schedule) {
    return `<div class="ck-schedule"><div class="ck-schedule-info">
      <div class="ck-schedule-line"><strong>${esc(t(labels.title))}</strong><span class="badge">${esc(t("ck.scheduleOff"))}</span></div>
      <div class="help">${esc(t(labels.offHelp))}</div>${why}</div>
      <div class="ck-schedule-actions"><button class="btn btn-sm" data-action="${esc(action)}"${shut}>${icon("clock")}${esc(t("ck.scheduleSet"))}</button></div>
    </div>`;
  }
  return `<div class="ck-schedule"><div class="ck-schedule-info">
    <div class="ck-schedule-line"><strong>${esc(t(labels.title))}</strong><span class="badge badge-accent">${esc(ruleText(schedule))}</span></div>
    <div class="help">${esc(t("ck.nextRun"))}: ${esc(zonedTime(schedule.nextRunAt, zone))}</div>
    <div class="help">${esc(t("ck.lastRun"))}: ${esc(lastRun(schedule.lastRun, zone, labels))}</div>
    <div class="help">${esc(t(labels.note))}</div>
    ${schedule.timezoneUnknown ? `<div class="callout warn">${icon("alert")}<span>${esc(t("ck.scheduleZoneUnknown", { zone: schedule.timezone ?? "" }))}</span></div>` : ""}
    ${why}
    </div>
    <div class="ck-schedule-actions">
      <button class="btn btn-sm" data-action="${esc(action)}"${shut}>${icon("clock")}${esc(t("ck.scheduleEdit"))}</button>
      <button class="btn btn-sm" data-action="${esc(`${action}-off`)}">${icon("x")}${esc(t("ck.scheduleTurnOff"))}</button>
    </div>
  </div>`;
}

/**
 * The dialog's fields. `ids` names the hours, time and error elements, so two dialogs on one page never share an id.
 */
export function scheduleFieldsHtml(schedule, { zone = browserTimezone(), ids, help }) {
  const mode = schedule?.mode ?? "interval";
  const saved = schedule?.mode === "daily" ? scheduleZone(schedule) : zone;
  const moved =
    saved !== zone ? `<div class="help">${esc(t("ck.scheduleZoneChange", { from: saved, zone }))}</div>` : "";
  const modeButton = (value, title, hint) =>
    `<button type="button" class="seg" data-mode="${value}" aria-pressed="${value === mode}"><strong>${esc(title)}</strong><span>${esc(hint)}</span></button>`;
  return `<div class="field"><span class="label">${esc(t("ck.scheduleWhen"))}</span>
      <div class="segmented segmented-2" role="group" aria-label="${esc(t("ck.scheduleWhen"))}">${modeButton("interval", t("ck.scheduleModeEvery"), t("ck.scheduleModeEveryHint"))}${modeButton("daily", t("ck.scheduleModeDaily"), t("ck.scheduleModeDailyHint"))}</div></div>
    <div class="field${mode === "daily" ? " hidden" : ""}" data-field="interval"><label class="label" for="${esc(ids.hours)}">${esc(t("ck.scheduleHours"))}</label>
      <input class="input" id="${esc(ids.hours)}" type="number" min="${SCHEDULE_HOURS.min}" max="${SCHEDULE_HOURS.max}" step="1" inputmode="numeric" value="${esc(schedule?.everyHours ?? 6)}" />
      <div class="help">${esc(t("ck.scheduleHoursHelp"))}</div></div>
    <div class="field${mode === "interval" ? " hidden" : ""}" data-field="daily"><label class="label" for="${esc(ids.at)}">${esc(t("ck.scheduleTime"))}</label>
      <input class="input mono" id="${esc(ids.at)}" type="text" inputmode="numeric" maxlength="5" placeholder="02:30" autocomplete="off" spellcheck="false" value="${esc(schedule?.at ?? "02:00")}" />
      <div class="help">${esc(t("ck.scheduleTimeHelp", { zone }))}</div>${moved}</div>
    <div class="error-text" id="${esc(ids.error)}"></div>
    <div class="callout info">${icon("alert")}<span>${esc(t(help))}</span></div>`;
}

/**
 * Binds the mode buttons and reads the rule from the fields, calling `onRule(body)` when the fields describe one. `err`
 * shows `invalid` when they do not.
 */
export function bindScheduleForm(root, { ids, invalid, onRule }) {
  let mode = root.querySelector('[data-mode][aria-pressed="true"]')?.dataset.mode ?? "interval";
  const err = root.querySelector(`#${ids.error}`);
  const show = (next) => {
    mode = next;
    for (const button of root.querySelectorAll("[data-mode]")) {
      button.setAttribute("aria-pressed", String(button.dataset.mode === next));
    }
    root.querySelector('[data-field="interval"]').classList.toggle("hidden", next !== "interval");
    root.querySelector('[data-field="daily"]').classList.toggle("hidden", next !== "daily");
  };
  for (const button of root.querySelectorAll("[data-mode]")) {
    button.addEventListener("click", () => show(button.dataset.mode));
  }
  return () => {
    const body = scheduleBody(mode, {
      hours: root.querySelector(`#${ids.hours}`).value,
      at: root.querySelector(`#${ids.at}`).value.trim(),
    });
    err.textContent = body ? "" : t(invalid);
    if (!body) return null;
    onRule(body);
    return body;
  };
}
