import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { forkName, takenNames } from "../lib/fork-name.js";
import { multiHost } from "../lib/hosts.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { invalidateTemplates } from "../lib/store.js";
import { forkMakesDraft, isUnbuilt } from "../lib/template-list.js";
import { nameError, openDialog, toast, toastError } from "../lib/ui.js";
import { openTasks } from "./tasks.js";

const ICON = "copy";

function formHtml(name, description, note) {
  return `<div class="field"><label class="label" for="tfName">${esc(t("label.templateName"))}</label>
      <input class="input" id="tfName" maxlength="63" value="${esc(name)}" placeholder="${esc(t("tp.namePlaceholder"))}" autocomplete="off" autofocus />
      <div class="error-text" id="tfNameErr"></div></div>
    <div class="field"><label class="label" for="tfDesc">${esc(t("tp.description"))} <span class="subtle">${esc(t("common.optional"))}</span></label>
      <input class="input" id="tfDesc" maxlength="200" value="${esc(description ?? "")}" autocomplete="off" /></div>
    <div class="callout info">${icon("info")}<span>${esc(note)}</span></div>`;
}

/** The line under the form: what the copy keeps, which differs for a source copy, an image copy and an unbuilt official. */
function noteFor(card, draft) {
  if (draft && isUnbuilt(card) && card.buildKind === "official") {
    return [t("tp.forkWhatOfficial"), ...(multiHost() ? [t("tp.forkHereLocal")] : [])].join(" ");
  }
  return t(draft ? "tp.forkWhat" : "tp.forkWhatImage");
}

/**
 * The duplicate dialog: a new template copied from the card's build source, or from its image when it was saved from a
 * box, with a name and a description of its own. The name is prefilled with a free `<name>-copy`, and the description
 * with the source's, or with the official catalog's for an official template no host has built yet. A duplicate answers
 * with the new template instead of a task, because nothing is built; the dialog closes and the card appears. A duplicate
 * made from a build source is a draft, so its card says it is not built yet. `onForked(template)` runs once the copy
 * exists.
 */
export function openForkTemplate({ card, cards = [], base = "", onForked } = {}) {
  const name = forkName(card.name, takenNames(cards));
  const draft = forkMakesDraft(card, base);
  const { root, close } = openDialog({
    title: t("tp.forkTitle", { name: esc(card.name) }),
    description: t(draft ? "tp.forkDesc" : "tp.forkDescImage", { ref: esc(card.ref) }),
    iconName: ICON,
    body: formHtml(name, card.description, noteFor(card, draft)),
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
    // A copy made from a build source is a draft, so the toast says nothing was built, as a saved draft does.
    toast(t(draft ? "tp.forkedDraft" : "tp.forked"), {
      message: draft ? t("tp.draftSavedText") : (made.template?.name ?? value),
      link: { href: `#/library/templates/${enc(made.template?.name ?? value)}`, text: t("tp.openTemplate") },
      timeout: 15000,
    });
    onForked?.(made.template);
  };
  ok.addEventListener("click", () => void submit());
  field.addEventListener("keydown", (event) => event.key === "Enter" && void submit());
  description.addEventListener("keydown", (event) => event.key === "Enter" && void submit());
}
