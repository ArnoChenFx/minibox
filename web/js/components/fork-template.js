import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { forkName, takenNames } from "../lib/fork-name.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { invalidateTemplates } from "../lib/store.js";
import { nameError, openDialog, toast, toastError } from "../lib/ui.js";
import { openTasks } from "./tasks.js";

const ICON = "copy";

function formHtml(name, description) {
  return `<div class="field"><label class="label" for="tfName">${esc(t("label.templateName"))}</label>
      <input class="input" id="tfName" maxlength="63" value="${esc(name)}" placeholder="${esc(t("tp.namePlaceholder"))}" autocomplete="off" autofocus />
      <div class="error-text" id="tfNameErr"></div></div>
    <div class="field"><label class="label" for="tfDesc">${esc(t("tp.description"))} <span class="subtle">${esc(t("common.optional"))}</span></label>
      <input class="input" id="tfDesc" maxlength="200" value="${esc(description ?? "")}" autocomplete="off" /></div>
    <div class="callout info">${icon("info")}<span>${esc(t("tp.forkWhat"))}</span></div>`;
}

/**
 * The fork dialog: a new template that copies the source template's image and build recipe, with a name and a
 * description of its own. The name is prefilled with a free `<name>-copy`, and the description with the source's. A fork
 * is a fast commit, so it answers with the new template instead of a task; the dialog closes and the card appears.
 * `onForked(template)` runs once the copy exists.
 */
export function openForkTemplate({ card, cards = [], onForked } = {}) {
  const name = forkName(card.name, takenNames(cards));
  const { root, close } = openDialog({
    title: t("tp.forkTitle", { name: esc(card.name) }),
    description: t("tp.forkDesc", { ref: esc(card.ref) }),
    iconName: ICON,
    body: formHtml(name, card.description),
    footer: `<button class="btn" data-close>${esc(t("common.cancel"))}</button><button class="btn btn-primary" id="tfOk">${icon(ICON)}${esc(t("tp.forkConfirm"))}</button>`,
  });
  const field = root.querySelector("#tfName");
  const description = root.querySelector("#tfDesc");
  const ok = root.querySelector("#tfOk");
  const error = root.querySelector("#tfNameErr");

  const idle = () => {
    ok.disabled = false;
    ok.innerHTML = `${icon(ICON)}${esc(t("tp.forkConfirm"))}`;
  };
  const refuse = (message) => {
    idle();
    field.classList.add("invalid");
    error.textContent = message;
    field.focus();
  };
  field.addEventListener("input", () => {
    field.classList.remove("invalid");
    error.textContent = "";
  });

  const submit = async () => {
    if (ok.disabled) return;
    const value = field.value.trim();
    const text = description.value.trim();
    const problem = nameError(value, "templateName");
    if (problem) return refuse(problem);
    ok.disabled = true;
    ok.innerHTML = `<span class="spinner"></span>${esc(t("tp.forking"))}`;
    let made;
    try {
      made = await api(`/api/templates/${enc(card.ref)}/fork`, {
        method: "POST",
        body: { name: value, ...(text ? { description: text } : {}) },
      });
    } catch (e) {
      if (e.details?.taskId) {
        close();
        toast(t("task.alreadyRunning"), { type: "info" });
        openTasks(e.details.taskId);
      } else if (e.code === "conflict") {
        refuse(e.message);
      } else {
        close();
        toastError(t("tp.forkFailed"), e);
      }
      return;
    }
    close();
    invalidateTemplates();
    toast(t("tp.forked"), {
      message: made.template?.name ?? value,
      link: { href: `#/library/templates/${enc(made.template?.name ?? value)}`, text: t("tp.openTemplate") },
      timeout: 15000,
    });
    onForked?.(made.template);
  };
  ok.addEventListener("click", () => void submit());
  field.addEventListener("keydown", (event) => event.key === "Enter" && void submit());
  description.addEventListener("keydown", (event) => event.key === "Enter" && void submit());
}
