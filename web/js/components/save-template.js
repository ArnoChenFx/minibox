import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { invalidateTemplates } from "../lib/store.js";
import { nameError, openDialog, toast, toastError } from "../lib/ui.js";
import { openTasks, taskErrorText, waitTask } from "./tasks.js";

const ICON = "layers";

function formHtml() {
  return `<div class="field"><label class="label" for="stName">${esc(t("label.templateName"))}</label>
      <input class="input" id="stName" maxlength="63" placeholder="${esc(t("tp.namePlaceholder"))}" autocomplete="off" />
      <div class="error-text" id="stNameErr"></div></div>
    <div class="field"><label class="label" for="stDesc">${esc(t("tp.description"))} <span class="subtle">${esc(t("common.optional"))}</span></label>
      <input class="input" id="stDesc" maxlength="200" autocomplete="off" /></div>
    <div class="callout info">${icon("info")}<span>${esc(t("tp.saveScope"))}</span></div>`;
}

/**
 * Asks for a template name and an optional description, then saves the box as a template and waits for the task. A
 * name that is already taken keeps the dialog open with the message under the name.
 */
export function openSaveTemplate(box) {
  const { root, close } = openDialog({
    title: t("tp.saveTitle"),
    description: esc(t("tp.saveDesc", { name: box.name })),
    iconName: ICON,
    body: formHtml(),
    footer: `<button class="btn" data-close>${esc(t("common.cancel"))}</button><button class="btn btn-primary" id="stOk">${icon(ICON)}${esc(t("tp.saveConfirm"))}</button>`,
  });
  const name = root.querySelector("#stName");
  const description = root.querySelector("#stDesc");
  const ok = root.querySelector("#stOk");
  const error = root.querySelector("#stNameErr");

  const idle = () => {
    ok.disabled = false;
    ok.innerHTML = `${icon(ICON)}${esc(t("tp.saveConfirm"))}`;
  };
  const refuse = (message) => {
    idle();
    name.classList.add("invalid");
    error.textContent = message;
    name.focus();
  };
  name.addEventListener("input", () => {
    name.classList.remove("invalid");
    error.textContent = "";
  });

  const submit = async () => {
    if (ok.disabled) return;
    const value = name.value.trim();
    const text = description.value.trim();
    const problem = nameError(value, "templateName");
    if (problem) return refuse(problem);
    ok.disabled = true;
    ok.innerHTML = `<span class="spinner"></span>${esc(t("tp.saving"))}`;
    let started;
    try {
      started = await api(`/api/boxes/${enc(box.boxId)}/template`, {
        method: "POST",
        body: { name: value, ...(text ? { description: text } : {}) },
      });
    } catch (err) {
      if (err.details?.taskId) {
        close();
        toast(t("task.alreadyRunning"), { type: "info" });
        openTasks(err.details.taskId);
      } else if (err.code === "conflict") {
        refuse(err.message);
      } else {
        close();
        toastError(t("tp.saveFailed"), err);
      }
      return;
    }
    close();
    toast(t("tp.saveStarted"), { type: "info", message: value });
    const done = await waitTask(started.taskId);
    if (done.status !== "succeeded") {
      toastError(t("tp.saveFailed"), { message: taskErrorText(done.error) || t(`task.status.${done.status}`) });
      return;
    }
    invalidateTemplates();
    toast(t("tp.saved"), {
      message: value,
      link: { href: `#/templates/${enc(value)}`, text: t("tp.openTemplate") },
      timeout: 8000,
    });
  };
  ok.addEventListener("click", () => void submit());
  name.addEventListener("keydown", (event) => event.key === "Enter" && void submit());
  description.addEventListener("keydown", (event) => event.key === "Enter" && void submit());
}
