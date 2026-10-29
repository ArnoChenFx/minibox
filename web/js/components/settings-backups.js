import { api } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { dateTime } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { bindScheduleForm, scheduleCardHtml, scheduleFieldsHtml } from "../lib/schedule-ui.js";
import { openDialog, toast, toastError } from "../lib/ui.js";

/**
 * Settings → Backups: the one backup schedule of this instance. It has the checkpoint card's shape, because it is the
 * same rule: every few hours, or once a day in a zone. It is off until an operator sets one, and the page says what a
 * scheduled run needs (`BACKUP_PASSPHRASE`) and what keeps it small (`BACKUP_KEEP`).
 */

const LABELS = {
  title: "st.backupSchedule",
  offHelp: "st.backupScheduleOffHelp",
  note: "st.backupScheduleNote",
  ok: "st.backupRunOk",
  failed: "st.backupRunFailed",
  none: "ck.lastRunNone",
};

const IDS = { hours: "stBackupHours", at: "stBackupAt", error: "stBackupErr" };

export async function loadBackups(view) {
  const card = view.querySelector("#stBackups");
  if (!card) return;
  let schedule;
  try {
    ({ schedule } = await api("/api/backups/schedule"));
  } catch (e) {
    if (e.status === 401) {
      location.href = "/login";
      return;
    }
    card.innerHTML = `<div class="card-head"><h3>${t("st.backups")}</h3></div>
      <div class="card-body"><div class="callout danger">${icon("alert")}<span>${esc(e.message)}</span></div></div>`;
    return;
  }
  card.innerHTML = `
    <div class="card-head">
      <div><h3>${t("st.backups")}</h3><p class="help">${t("st.backupsHelp")}</p></div>${icon("disk")}
    </div>
    <div class="card-body">
      ${scheduleCardHtml(schedule, { labels: LABELS, action: "st-backup-schedule" })}
    </div>`;
  card
    .querySelector('[data-action="st-backup-schedule"]')
    .addEventListener("click", () => editSchedule(view, schedule));
  card.querySelector('[data-action="st-backup-schedule-off"]')?.addEventListener("click", () => turnOff(view));
}

/** The dialog for a schedule, with the same fields as the checkpoint one. Resolves to the rule, or null when cancelled. */
function askSchedule(schedule) {
  return new Promise((resolve) => {
    let result = null;
    const { root, close } = openDialog({
      title: t("st.backupScheduleTitle"),
      description: esc(t("st.backupScheduleDesc")),
      iconName: "clock",
      body: scheduleFieldsHtml(schedule, { ids: IDS, help: "st.backupScheduleHelp" }),
      footer: `<button class="btn" data-close>${esc(t("common.cancel"))}</button><button class="btn btn-primary" id="stBackupOk">${esc(t("ck.scheduleSave"))}</button>`,
      onClose: () => resolve(result),
    });
    const submit = bindScheduleForm(root, {
      ids: IDS,
      invalid: "ck.scheduleInvalid",
      onRule: (body) => {
        result = body;
      },
    });
    root.querySelector("#stBackupOk").addEventListener("click", () => {
      if (submit() !== null) close();
    });
  });
}

async function editSchedule(view, schedule) {
  const body = await askSchedule(schedule);
  if (!body) return;
  try {
    const saved = await api("/api/backups/schedule", { method: "PUT", body });
    toast(t("st.backupScheduleSaved"), { message: t("ck.nextRun") + ": " + dateTime(saved.schedule.nextRunAt) });
  } catch (e) {
    toastError(t("st.backupScheduleFailed"), e);
  }
  loadBackups(view);
}

async function turnOff(view) {
  try {
    await api("/api/backups/schedule", { method: "DELETE" });
    toast(t("st.backupScheduleOffDone"));
  } catch (e) {
    toastError(t("st.backupScheduleFailed"), e);
    return;
  }
  loadBackups(view);
}
