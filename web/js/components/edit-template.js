import { api, enc, errorText } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { invalidateTemplates } from "../lib/store.js";
import { commandText, initOf, readPorts } from "../lib/template-edit.js";
import { KIND_LABEL_KEYS, SOURCE_KINDS, templateSource } from "../lib/template-source.js";
import { openDialog, toast, toastError } from "../lib/ui.js";
import { secretChoicesHtml, secretNames } from "./env-editor.js";

const ICON = "pencil";

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

/**
 * The sources the dialog offers. An official template's Dockerfile ships with MiniBox, so there is no field to edit and
 * the dialog says so instead.
 */
const EDITABLE_KINDS = SOURCE_KINDS;

function kindButtons(active) {
  return EDITABLE_KINDS.map(
    (kind) =>
      `<button type="button" class="seg" data-kind="${kind}" aria-pressed="${kind === active}"><strong>${esc(t(KIND_LABEL_KEYS[kind]))}</strong><span>${esc(t(KIND_HINT_KEYS[kind]))}</span></button>`,
  ).join("");
}

const fieldAttrs = (key) => `data-for="${SHOWN_FOR[key]}"`;

function bodyHtml(names, recipe) {
  const source = recipe?.source ?? {};
  const official = recipe?.buildKind === "official";
  const kind = EDITABLE_KINDS.includes(recipe?.buildKind) ? recipe.buildKind : "dockerfile";
  // MiniBox builds an official template from the Dockerfile that ships with it, so the dialog has no source to show and
  // sends none: the setup and the description are what such a template owns.
  const sourceHtml = official
    ? `<div class="callout warn">${icon("alert")}<span>${esc(t("tp.editOfficial"))}</span></div>`
    : `
    <div class="field"><span class="label">${t("tp.sourceKind")}</span>
      <div class="segmented" id="teKinds" role="group" aria-label="${esc(t("tp.sourceKind"))}">${kindButtons(kind)}</div>
      <div class="help" id="teKindHelp">${t(KIND_HELP_KEYS[kind])}</div></div>
    <div class="stack">
      <div class="field" ${fieldAttrs("dockerfile")}>
        <label class="label" for="teDockerfile">${t("tp.dockerfile")}</label>
        <textarea class="textarea command-input" id="teDockerfile" rows="12" spellcheck="false" placeholder="FROM node:24-bookworm-slim">${esc(source.text ?? "")}</textarea>
        <div class="help">${t("tp.dockerfileHelp")}</div></div>
      <div class="grid grid-2 form-grid">
        <div class="field" ${fieldAttrs("url")}>
          <label class="label" for="teUrl"><span id="teUrlLabel">${t("src.url")}</span></label>
          <input class="input mono" id="teUrl" value="${esc(source.url ?? "")}" autocomplete="off" autocapitalize="off" spellcheck="false" />
          <div class="help" id="teUrlHelp">${t("src.urlHelp")}</div></div>
        <div class="field" ${fieldAttrs("branch")}>
          <label class="label" for="teBranch">${t("src.branch")}</label>
          <input class="input mono" id="teBranch" value="${esc(source.branch ?? "")}" placeholder="${esc(t("src.branchPlaceholder"))}" autocomplete="off" autocapitalize="off" spellcheck="false" /></div>
        <div class="field" ${fieldAttrs("subdir")}>
          <label class="label" for="teSubdir">${t("src.subdir")}</label>
          <input class="input mono" id="teSubdir" value="${esc(source.subdir ?? "")}" placeholder="services/api" autocomplete="off" autocapitalize="off" spellcheck="false" />
          <div class="help">${t("src.subdirHelp")}</div></div>
        <div class="field" ${fieldAttrs("dockerfilePath")}>
          <label class="label" for="teDockerfilePath">${t("src.dockerfilePath")}</label>
          <input class="input mono" id="teDockerfilePath" value="${esc(source.dockerfile ?? "")}" placeholder="Dockerfile" autocomplete="off" autocapitalize="off" spellcheck="false" />
          <div class="help">${t("src.dockerfilePathHelp")}</div></div>
        <div class="field" ${fieldAttrs("devcontainerPath")}>
          <label class="label" for="teDevcontainerPath">${t("tp.devcontainerPath")}</label>
          <input class="input mono" id="teDevcontainerPath" value="${esc(source.path ?? "")}" placeholder=".devcontainer/devcontainer.json" autocomplete="off" autocapitalize="off" spellcheck="false" />
          <div class="help">${t("tp.devcontainerPathHelp")}</div></div>
        <div class="field" ${fieldAttrs("secret")}>
          <label class="label" for="teSecret">${t("src.secret")}</label>
          <select class="select" id="teSecret">${secretChoicesHtml(names, t("src.secretNone"), source.secretRef ?? "")}</select>
          <div class="help">${names === null ? t("env.secretsUnavailable") : t("src.secretHelp")}</div></div>
      </div>
    </div>`;
  return `
    <div class="grid grid-2 form-grid">
      <div class="field"><label class="label" for="teDesc">${t("tp.newDescription")}</label>
        <input class="input" id="teDesc" maxlength="200" autocomplete="off" value="${esc(recipe?.description ?? "")}" /></div>
      <div class="field"><label class="label" for="tePorts">${t("tp.editPorts")} <span class="subtle">${esc(t("common.optional"))}</span></label>
        <input class="input mono" id="tePorts" placeholder="3000, 8080" autocomplete="off" value="${esc((recipe?.forwardPorts ?? []).join(", "))}" />
        <div class="help">${t("tp.editPortsHelp")}</div></div>
    </div>
    <div class="field"><label class="label" for="tePostCreate">${t("tp.postCreate")} <span class="subtle">${esc(t("common.optional"))}</span></label>
      <input class="input mono" id="tePostCreate" placeholder="npm ci" autocomplete="off" value="${esc(commandText(recipe?.postCreate))}" />
      <div class="help">${t("tp.editPostCreateHelp")}</div></div>
    ${sourceHtml}
    <div class="callout info">${icon("info")}<span>${esc(t("tp.editWhat"))}</span></div>
    <div class="error-text" id="teErr"></div>`;
}

/**
 * The edit dialog: the source a template rebuilds from, the setup a box created from it gets, and its description. The
 * dialog reads the recipe first, so every field starts with what the template has now. Saving changes the recipe only; the
 * template's image stays as it is until **Rebuild** runs, so boxes created before then are unaffected. `onEdited(name)`
 * runs once the change is stored.
 */
export async function openEditTemplate({ card, onEdited } = {}) {
  const names = await secretNames();
  const recipe = await api(`/api/templates/${enc(card.ref)}/recipe`)
    .then((body) => body.recipe)
    .catch((e) => {
      toastError(t("tp.editFailed"), e);
      return null;
    });
  if (!recipe) return;
  // An official template's Dockerfile ships with MiniBox, so the dialog shows no source fields and sends none: only the
  // setup and the description are the template's own. The server refuses a source there too.
  const official = recipe.buildKind === "official";
  const state = { kind: EDITABLE_KINDS.includes(recipe.buildKind) ? recipe.buildKind : "dockerfile" };
  const { root, close } = openDialog({
    title: t("tp.editTitle", { name: esc(card.name) }),
    description: t("tp.editDesc", { ref: esc(card.ref) }),
    iconName: ICON,
    wide: true,
    body: bodyHtml(names, { ...recipe, description: card.description ?? "" }),
    footer: `<button class="btn" data-close>${esc(t("common.cancel"))}</button><button class="btn btn-primary" id="teOk">${icon(ICON)}${esc(t("tp.editConfirm"))}</button>`,
  });
  const q = (selector) => root.querySelector(selector);
  const initialCommand = q("#tePostCreate").value;

  const showKind = (kind) => {
    state.kind = kind;
    for (const button of root.querySelectorAll("#teKinds .seg")) {
      button.setAttribute("aria-pressed", String(button.dataset.kind === kind));
    }
    for (const node of root.querySelectorAll("[data-for]")) {
      node.hidden = !node.dataset.for.split(" ").includes(kind);
    }
    q("#teUrlLabel").textContent = t(kind === "context" ? "tp.contextUrl" : "src.url");
    q("#teUrlHelp").textContent = t(kind === "context" ? "tp.contextHelp" : "src.urlHelp");
    q("#teKindHelp").textContent = t(KIND_HELP_KEYS[kind]);
    q("#teErr").textContent = "";
  };

  const fieldValues = () => ({
    text: q("#teDockerfile").value,
    url: q("#teUrl").value,
    branch: q("#teBranch").value,
    subdir: q("#teSubdir").value,
    dockerfile: q("#teDockerfilePath").value,
    path: q("#teDevcontainerPath").value,
    secretRef: q("#teSecret").value,
  });

  if (!official) {
    q("#teKinds").addEventListener("click", (event) => {
      const button = event.target.closest(".seg");
      if (button) showKind(button.dataset.kind);
    });
    showKind(state.kind);
  }

  const submit = async () => {
    const ok = q("#teOk");
    if (ok.disabled) return;
    const built = official ? { source: undefined } : templateSource(state.kind, fieldValues());
    if (built.problem) {
      q("#teErr").textContent = t(built.key);
      return;
    }
    const ports = readPorts(q("#tePorts").value);
    if (ports.problem !== undefined) {
      q("#teErr").textContent = t("tp.errPort", { port: esc(ports.problem) });
      return;
    }
    const description = q("#teDesc").value.trim();
    ok.disabled = true;
    ok.innerHTML = `<span class="spinner"></span>${esc(t("tp.editing"))}`;
    try {
      await api(`/api/templates/${enc(card.ref)}`, {
        method: "PATCH",
        body: {
          ...(built.source === undefined ? {} : { source: built.source }),
          init:
            q("#tePostCreate").value === initialCommand
              ? { postCreate: recipe.postCreate ?? [], forwardPorts: ports.ports }
              : initOf(q("#tePostCreate").value, ports.ports),
          ...(description === "" ? {} : { description }),
        },
      });
    } catch (e) {
      ok.disabled = false;
      ok.innerHTML = `${icon(ICON)}${esc(t("tp.editConfirm"))}`;
      q("#teErr").textContent = errorText(e);
      return;
    }
    close();
    invalidateTemplates();
    toast(t("tp.edited"), {
      message: card.name,
      link: { href: `#/library/templates/${enc(card.name)}`, text: t("tp.openTemplate") },
      timeout: 15000,
    });
    onEdited?.(card.name);
  };
  q("#teOk").addEventListener("click", () => void submit());
  q("#teDockerfile")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void submit();
  });
}
