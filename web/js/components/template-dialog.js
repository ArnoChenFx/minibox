import { api } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { KIND_LABEL_KEYS, SOURCE_KINDS, templateSource } from "../lib/template-source.js";
import { nameError, openDialog, toast } from "../lib/ui.js";
import { secretChoicesHtml, secretNames } from "./env-editor.js";
import { trackTask } from "./tasks.js";

const KIND_HINT_KEYS = {
  dockerfile: "tp.kindDockerfileHint",
  git: "tp.kindGitHint",
  context: "tp.kindContextHint",
  devcontainer: "tp.kindDevcontainerHint",
};

const KIND_HELP_KEYS = {
  dockerfile: "tp.kindHelpDockerfile",
  git: "tp.kindHelpGit",
  context: "tp.kindHelpContext",
  devcontainer: "tp.kindHelpDevcontainer",
};

/** Which kinds each field serves. The dialog hides a field whose kind is not selected. */
const SHOWN_FOR = {
  dockerfile: "dockerfile",
  url: "git context devcontainer",
  branch: "git devcontainer",
  subdir: "git",
  dockerfilePath: "git context",
  devcontainerPath: "devcontainer",
  secret: "git devcontainer",
};

function kindButtons(active) {
  return SOURCE_KINDS.map(
    (kind) =>
      `<button type="button" class="seg" data-kind="${kind}" aria-pressed="${kind === active}"><strong>${esc(t(KIND_LABEL_KEYS[kind]))}</strong><span>${esc(t(KIND_HINT_KEYS[kind]))}</span></button>`,
  ).join("");
}

function fieldAttrs(key) {
  return `data-for="${SHOWN_FOR[key]}"`;
}

function dialogBody(names) {
  return `
    <div class="grid grid-2 form-grid">
      <div class="field"><label class="label" for="tnName">${t("tp.newName")}</label>
        <input class="input" id="tnName" placeholder="${esc(t("tp.namePlaceholder"))}" autocomplete="off" autofocus />
        <div class="error-text" id="tnNameErr"></div></div>
      <div class="field"><label class="label" for="tnDesc">${t("tp.newDescription")}</label>
        <input class="input" id="tnDesc" maxlength="200" autocomplete="off" /></div>
    </div>
    <div class="field"><span class="label">${t("tp.sourceKind")}</span>
      <div class="segmented" id="tnKinds" role="group" aria-label="${esc(t("tp.sourceKind"))}">${kindButtons("dockerfile")}</div>
      <div class="help" id="tnKindHelp">${t(KIND_HELP_KEYS.dockerfile)}</div></div>
    <div class="stack">
      <div class="field" ${fieldAttrs("dockerfile")}>
        <label class="label" for="tnDockerfile">${t("tp.dockerfile")}</label>
        <textarea class="textarea command-input" id="tnDockerfile" rows="9" spellcheck="false" placeholder="FROM node:24-bookworm-slim"></textarea>
        <div class="help">${t("tp.dockerfileHelp")}</div></div>
      <div class="grid grid-2 form-grid">
        <div class="field" ${fieldAttrs("url")}>
          <label class="label" for="tnUrl"><span id="tnUrlLabel">${t("src.url")}</span></label>
          <input class="input mono" id="tnUrl" placeholder="https://github.com/org/app.git" autocomplete="off" autocapitalize="off" spellcheck="false" />
          <div class="help" id="tnUrlHelp">${t("src.urlHelp")}</div></div>
        <div class="field" ${fieldAttrs("branch")}>
          <label class="label" for="tnBranch">${t("src.branch")}</label>
          <input class="input mono" id="tnBranch" placeholder="${esc(t("src.branchPlaceholder"))}" autocomplete="off" autocapitalize="off" spellcheck="false" /></div>
        <div class="field" ${fieldAttrs("subdir")}>
          <label class="label" for="tnSubdir">${t("src.subdir")}</label>
          <input class="input mono" id="tnSubdir" placeholder="services/api" autocomplete="off" autocapitalize="off" spellcheck="false" />
          <div class="help">${t("src.subdirHelp")}</div></div>
        <div class="field" ${fieldAttrs("dockerfilePath")}>
          <label class="label" for="tnDockerfilePath">${t("src.dockerfilePath")}</label>
          <input class="input mono" id="tnDockerfilePath" placeholder="Dockerfile" autocomplete="off" autocapitalize="off" spellcheck="false" />
          <div class="help">${t("src.dockerfilePathHelp")}</div></div>
        <div class="field" ${fieldAttrs("devcontainerPath")}>
          <label class="label" for="tnDevcontainerPath">${t("tp.devcontainerPath")}</label>
          <input class="input mono" id="tnDevcontainerPath" placeholder=".devcontainer/devcontainer.json" autocomplete="off" autocapitalize="off" spellcheck="false" />
          <div class="help">${t("tp.devcontainerPathHelp")}</div></div>
        <div class="field" ${fieldAttrs("secret")}>
          <label class="label" for="tnSecret">${t("src.secret")}</label>
          <select class="select" id="tnSecret">${secretChoicesHtml(names, t("src.secretNone"))}</select>
          <div class="help">${names === null ? t("env.secretsUnavailable") : t("src.secretHelp")}</div></div>
      </div>
    </div>
    <div class="error-text" id="tnErr"></div>`;
}

/**
 * The new-template dialog. It builds a template from one of four sources, and the build runs as a task whose log opens
 * in the task panel. **Save** keeps the source without building it, so a template can be built later from the Templates
 * page. `onCreated(response)` runs once the source is saved or the build has been accepted.
 */
export async function openNewTemplate({ onCreated } = {}) {
  const names = await secretNames();
  const state = { kind: "dockerfile" };
  const { root, close } = openDialog({
    title: t("tp.newTitle"),
    description: t("tp.newDesc"),
    iconName: "layers",
    wide: true,
    body: dialogBody(names),
    footer: `<button class="btn" data-close>${t("common.cancel")}</button><button class="btn" id="tnSave">${icon("check")}${t("tp.saveDraft")}</button><button class="btn btn-primary" id="tnSubmit">${icon("hammer")}${t("tp.submitBuild")}</button>`,
  });
  const q = (selector) => root.querySelector(selector);

  const showKind = (kind) => {
    state.kind = kind;
    for (const button of root.querySelectorAll("#tnKinds .seg")) {
      button.setAttribute("aria-pressed", String(button.dataset.kind === kind));
    }
    for (const node of root.querySelectorAll("[data-for]")) {
      node.hidden = !node.dataset.for.split(" ").includes(kind);
    }
    q("#tnUrlLabel").textContent = t(kind === "context" ? "tp.contextUrl" : "src.url");
    q("#tnUrlHelp").textContent = t(kind === "context" ? "tp.contextHelp" : "src.urlHelp");
    q("#tnKindHelp").textContent = t(KIND_HELP_KEYS[kind]);
    q("#tnErr").textContent = "";
  };

  const fieldValues = () => ({
    text: q("#tnDockerfile").value,
    url: q("#tnUrl").value,
    branch: q("#tnBranch").value,
    subdir: q("#tnSubdir").value,
    dockerfile: q("#tnDockerfilePath").value,
    path: q("#tnDevcontainerPath").value,
    secretRef: q("#tnSecret").value,
  });

  const showNameError = (message) => {
    q("#tnName").classList.toggle("invalid", message !== "");
    q("#tnNameErr").textContent = message;
  };

  q("#tnKinds").addEventListener("click", (event) => {
    const button = event.target.closest(".seg");
    if (button) showKind(button.dataset.kind);
  });
  q("#tnName").addEventListener("input", () => showNameError(""));
  showKind(state.kind);

  const submit = async (mode) => {
    const name = q("#tnName").value.trim();
    const problem = nameError(name, "templateName");
    if (problem) {
      showNameError(problem);
      q("#tnName").focus();
      return;
    }
    const built = templateSource(state.kind, fieldValues());
    if (built.problem) {
      q("#tnErr").textContent = t(built.key);
      return;
    }
    const body = { name, source: built.source };
    const description = q("#tnDesc").value.trim();
    if (description) body.description = description;
    const save = q("#tnSave");
    const build = q("#tnSubmit");
    const draft = mode === "draft";
    const pressed = draft ? save : build;
    for (const button of [save, build]) button.disabled = true;
    pressed.innerHTML = `<span class="spinner"></span>${t(draft ? "tp.saving" : "tp.starting")}`;
    try {
      if (draft) {
        await api("/api/templates/drafts", { method: "POST", body });
        close();
        toast(t("tp.draftSaved"), { type: "info", message: t("tp.draftSavedText") });
        onCreated?.();
      } else {
        const res = await api("/api/templates", { method: "POST", body });
        close();
        toast(t("tp.createStarted"), { type: "info", message: t("tp.createStartedText") });
        trackTask(res.taskId);
        onCreated?.(res);
      }
    } catch (e) {
      for (const button of [save, build]) button.disabled = false;
      save.innerHTML = `${icon("check")}${t("tp.saveDraft")}`;
      build.innerHTML = `${icon("hammer")}${t("tp.submitBuild")}`;
      if (e.details?.field === "name" || e.code === "conflict") showNameError(e.message);
      else q("#tnErr").textContent = `${e.message}${e.hint ? ` ${e.hint}` : ""}`;
    }
  };
  q("#tnSubmit").addEventListener("click", () => void submit("build"));
  q("#tnSave").addEventListener("click", () => void submit("draft"));
}
