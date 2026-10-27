import { api, enc } from "../lib/api.js";
import { parseToolJson } from "../lib/custom-tool-json.js";
import {
  COMMAND_FIELDS,
  commandsForSource,
  CUSTOM_LIMITS,
  customToolBody,
  customToolForm,
  isBuiltinId,
  validCustomId,
} from "../lib/custom-tool.js";
import { esc } from "../lib/dom.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { TOOL_CATEGORY_ORDER } from "../lib/tool-list.js";
import { confirmDialog, openDialog, toast, toastError, withBusy } from "../lib/ui.js";
import { bindFoldSections, foldSectionHtml } from "./fold-section.js";

const SOURCES = ["npm", "pip", "script"];
const SOURCE_HELP = { npm: "ct.sourceHelpNpm", pip: "ct.sourceHelpPip", script: "ct.sourceHelpScript" };
const COMMAND_HELP = { stop: "ct.stopHelp", detect: "ct.detectHelp" };
const INPUT_FIELDS = ["id", "name", "description", "category", "source", "package", "bin", "requires", "estimatedMb"];

/** The dictionary key of each field's label, so a refused paste names the field the way the form shows it. */
const FIELD_LABEL = {
  id: "ct.id",
  name: "ct.name",
  description: "ct.summary",
  category: "ct.category",
  source: "ct.source",
  package: "ct.package",
  bin: "ct.bin",
  requires: "ct.requires",
  estimatedMb: "ct.estimatedMb",
  install: "ct.install",
  upgrade: "ct.upgrade",
  uninstall: "ct.uninstall",
  stop: "ct.stop",
  detect: "ct.detect",
};

/** The label a field's refusal names it by, the way the form shows it. */
const fieldLabel = (field) => t(FIELD_LABEL[field] ?? field);

/** The readable text of a refused paste. A field at fault is named by its label. */
function pasteProblemText(error) {
  if (error.code === "json") return t("ct.pasteBadJson", { detail: error.detail });
  if (error.code === "unknownFields") return t("ct.pasteUnknownFields", { fields: error.fields.join(", ") });
  if (error.code === "required") return t("ct.pasteRequired", { field: fieldLabel(error.field) });
  if (error.code === "type") return t("ct.pasteType", { field: fieldLabel(error.field), type: error.expected });
  if (error.code === "tooLong") return t("ct.pasteTooLong", { field: fieldLabel(error.field), max: error.max });
  if (error.code === "category") return t("ct.pasteCategory", { value: error.value });
  if (error.code === "source") return t("ct.pasteSource", { value: error.value });
  if (error.code === "id") return t("ct.pasteId", { value: error.value });
  return t("ct.pasteEstimatedMb", { value: error.value });
}

const categoryOptions = (selected) =>
  TOOL_CATEGORY_ORDER.map(
    (category) =>
      `<option value="${category}" ${category === selected ? "selected" : ""}>${esc(t(`tool.cat.${category}`))}</option>`,
  ).join("");

const sourceOptions = (selected) =>
  SOURCES.map((source) => `<option value="${source}" ${source === selected ? "selected" : ""}>${source}</option>`).join(
    "",
  );

function field(name, label, control, { wide = false, help = "", helpId = "" } = {}) {
  const helpLine = help || helpId ? `<div class="help"${helpId ? ` id="${helpId}"` : ""}>${esc(help)}</div>` : "";
  return `<div class="field${wide ? " field-wide" : ""}"><label class="label" for="ct-${name}">${esc(label)}</label>${control}${helpLine}</div>`;
}

/** The folded paste box: a JSON description dropped in here fills the form, and the form is still what is saved. */
function pasteHtml() {
  return foldSectionHtml({
    id: "ctPaste",
    title: t("ct.pasteTitle"),
    open: false,
    body: `<div class="help">${esc(t("ct.pasteHelp"))}</div>
      <textarea class="textarea mono" id="ct-paste" rows="6" spellcheck="false" aria-label="${esc(t("ct.pasteTitle"))}"></textarea>
      <div class="ct-paste-row">
        <button type="button" class="btn btn-sm" id="ct-paste-apply">${esc(t("ct.pasteApply"))}</button>
        <span class="error-text" id="ct-paste-error" role="alert"></span>
      </div>`,
  });
}

function formHtml(values, editing) {
  const focus = editing ? "name" : "id";
  const text = (name, maxLength, extra = "") =>
    `<input class="input" id="ct-${name}" name="${name}" maxlength="${maxLength}" value="${esc(values[name])}" autocomplete="off" spellcheck="false" ${extra}${name === focus ? " autofocus" : ""} />`;
  const command = (name) =>
    `<textarea class="textarea command-input" id="ct-${name}" name="${name}" maxlength="${CUSTOM_LIMITS.command}" rows="2" spellcheck="false">${esc(values[name])}</textarea>`;
  return `<form id="ct-form" class="grid grid-2 form-grid" novalidate>
    ${field("id", t("ct.id"), text("id", CUSTOM_LIMITS.id, editing ? "disabled" : ""), { help: t("ct.idHelp"), helpId: "ct-id-help" })}
    ${field("name", t("ct.name"), text("name", CUSTOM_LIMITS.name))}
    <div class="field-wide" id="ct-builtin" hidden><div class="stack">
      <div class="callout warn">${icon("alert")}<span id="ct-builtin-text"></span></div>
      <label class="checkbox"><input type="checkbox" name="overrideBuiltin" ${values.overrideBuiltin ? "checked" : ""} /><span>${esc(t("ct.overrideBuiltin"))}<div class="help">${esc(t("ct.overrideBuiltinHelp"))}</div></span></label>
    </div></div>
    ${field("description", t("ct.summary"), text("description", CUSTOM_LIMITS.description), { wide: true })}
    ${field("category", t("ct.category"), `<select class="select" id="ct-category" name="category">${categoryOptions(values.category)}</select>`)}
    ${field("source", t("ct.source"), `<select class="select" id="ct-source" name="source">${sourceOptions(values.source)}</select>`, { help: t(SOURCE_HELP[values.source]), helpId: "ct-source-help" })}
    ${field("package", t("ct.package"), text("package", CUSTOM_LIMITS.package), { help: t("ct.packageHelp") })}
    ${field("bin", t("ct.bin"), text("bin", CUSTOM_LIMITS.bin), { help: t("ct.binHelp") })}
    ${field("requires", t("ct.requires"), text("requires", CUSTOM_LIMITS.requires), { help: t("ct.requiresHelp") })}
    ${field("estimatedMb", t("ct.estimatedMb"), `<input class="input" id="ct-estimatedMb" name="estimatedMb" type="number" min="1" step="1" value="${esc(values.estimatedMb)}" />`)}
    <label class="checkbox field-wide"><input type="checkbox" name="needsRoot" ${values.needsRoot ? "checked" : ""} /><span>${esc(t("ct.needsRoot"))}<div class="help">${esc(t("ct.needsRootHelp"))}</div></span></label>
    <div class="section-intro field-wide"><h3>${esc(t("ct.commands"))}</h3><p class="help">${esc(t("ct.commandsHelp"))}</p></div>
    ${COMMAND_FIELDS.map((name) => field(name, t(`ct.${name}`), command(name), { wide: true, help: COMMAND_HELP[name] ? t(COMMAND_HELP[name]) : "" })).join("")}
    <div class="field-wide" id="ct-paste-field">${pasteHtml()}</div>
  </form>`;
}

/**
 * The add and edit dialog for one custom entry. `entry` is the entry being edited, or `null` for a new one. `customById`
 * maps the custom entries by id, and `catalogIds` holds every id the merged catalog lists, so the dialog can warn about a
 * built-in id before the server refuses it.
 */
export function openCustomToolDialog({ entry = null, catalogIds, customById, onSaved }) {
  const editing = entry !== null;
  const { root, close } = openDialog({
    title: t(editing ? "ct.titleEdit" : "ct.title"),
    description: esc(t("ct.intro")),
    iconName: "hammer",
    wide: true,
    body: formHtml(customToolForm(entry), editing),
    footer: `<span class="error-text" id="ct-error" role="alert"></span><button class="btn" data-close>${esc(t("common.cancel"))}</button><button class="btn btn-primary" type="submit" form="ct-form" id="ct-save">${esc(t("common.save"))}</button>`,
  });
  const form = root.querySelector("#ct-form");
  const saveButton = root.querySelector("#ct-save");
  const errorBox = root.querySelector("#ct-error");
  const read = (name) => form.querySelector(`[name="${name}"]`);

  const readValues = () => {
    const values = { needsRoot: read("needsRoot").checked, overrideBuiltin: read("overrideBuiltin").checked };
    for (const name of [...INPUT_FIELDS, ...COMMAND_FIELDS]) values[name] = read(name).value;
    return values;
  };

  const refreshId = () => {
    const id = read("id").value.trim();
    const builtin = isBuiltinId(id, catalogIds, customById);
    root.querySelector("#ct-builtin").hidden = !builtin;
    root.querySelector("#ct-builtin-text").textContent = builtin ? t("ct.builtin", { id }) : "";
    const replaces = !editing && !builtin && customById.has(id);
    root.querySelector("#ct-id-help").textContent = replaces ? t("ct.idReplaces") : t("ct.idHelp");
  };

  let source = read("source").value;
  read("source").addEventListener("change", () => {
    const next = read("source").value;
    const current = Object.fromEntries(COMMAND_FIELDS.map((name) => [name, read(name).value]));
    const commands = commandsForSource(current, source, next);
    for (const name of COMMAND_FIELDS) read(name).value = commands[name];
    source = next;
    root.querySelector("#ct-source-help").textContent = t(SOURCE_HELP[next]);
  });

  /**
   * Every id a paste must avoid: the ids the merged catalog lists, which covers the built-in tools and the saved custom
   * entries. A paste never takes one of them, so it always adds an entry rather than replacing a built-in one.
   */
  const takenIds = () => new Set([...catalogIds, ...customById.keys()]);

  /** Fills the form from a pasted JSON description. A refusal names what is wrong and leaves everything typed as it is. */
  const applyPaste = () => {
    const box = root.querySelector("#ct-paste");
    const problem = root.querySelector("#ct-paste-error");
    const parsed = parseToolJson(box.value, { taken: takenIds() });
    if (!parsed.ok) {
      problem.textContent = pasteProblemText(parsed.error);
      box.classList.add("invalid");
      box.setAttribute("aria-invalid", "true");
      box.focus();
      return;
    }
    problem.textContent = "";
    box.classList.remove("invalid");
    box.removeAttribute("aria-invalid");
    const { values } = parsed;
    // The id is the one field an edit keeps: the file it names is the entry being edited, so a paste only fills the rest.
    if (!editing) read("id").value = values.id;
    for (const name of ["name", "description", "category", "source", "package", "bin", "requires", "estimatedMb"]) {
      read(name).value = values[name];
    }
    for (const name of COMMAND_FIELDS) read(name).value = values[name];
    read("needsRoot").checked = values.needsRoot;
    read("overrideBuiltin").checked = false;
    source = values.source;
    root.querySelector("#ct-source-help").textContent = t(SOURCE_HELP[values.source]);
    refreshId();
  };

  bindFoldSections(root);
  root.querySelector("#ct-paste-apply").addEventListener("click", applyPaste);
  root.querySelector("#ct-paste").addEventListener("input", () => {
    root.querySelector("#ct-paste-error").textContent = "";
    root.querySelector("#ct-paste").classList.remove("invalid");
  });

  read("id").addEventListener("input", refreshId);
  refreshId();

  const fail = (name, message) => {
    const control = name ? read(name) : null;
    if (control) {
      control.classList.add("invalid");
      control.setAttribute("aria-invalid", "true");
      control.focus();
    }
    errorBox.textContent = message;
  };

  form.addEventListener("input", (event) => {
    event.target.classList.remove("invalid");
    event.target.removeAttribute("aria-invalid");
  });

  let saving = false;
  const save = async () => {
    if (saving) return;
    errorBox.textContent = "";
    const values = readValues();
    const id = values.id.trim();
    if (!validCustomId(id)) return fail("id", t("err.tool_id_invalid"));
    if (isBuiltinId(id, catalogIds, customById) && !values.overrideBuiltin) {
      return fail("overrideBuiltin", t("ct.builtinUnconfirmed"));
    }
    saving = true;
    try {
      await withBusy(saveButton, () =>
        api(`/api/tools/custom/${enc(id)}`, { method: "PUT", body: customToolBody(values) }),
      );
      toast(t("ct.saved"));
      close();
      onSaved?.();
    } catch (e) {
      fail(e.details?.field, e.message);
    } finally {
      saving = false;
    }
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void save();
  });
}

/** Asks first, then deletes the tools.d file of one custom entry. The shared tools volume is left as it is. */
export async function deleteCustomTool(entry, { onDeleted } = {}) {
  const ok = await confirmDialog({
    title: t("ct.deleteTitle"),
    message: esc(t("ct.deleteText", { id: entry.id })),
    body: entry.overridesBuiltin ? `<p class="help">${esc(t("ct.deleteBuiltin", { id: entry.id }))}</p>` : "",
    confirmText: t("bd.customDelete"),
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/tools/custom/${enc(entry.id)}`, { method: "DELETE" });
    toast(t("ct.deleted"));
    onDeleted?.();
  } catch (e) {
    toastError(t("ct.deleteFailed"), e);
  }
}
