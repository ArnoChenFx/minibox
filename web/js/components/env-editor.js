import { api } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { ENV_VALUE_MAX } from "../lib/env.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";

/** The names of the secrets set on this host, in the order the server lists them. `null` when they cannot be read. */
export async function secretNames() {
  try {
    const { secrets } = await api("/api/secrets");
    return secrets.map((secret) => secret.name);
  } catch {
    return null;
  }
}

/**
 * The inner markup of one env row: a name, a kind (a plain value or a secret), the value field or the secret chooser, and
 * a remove button. The value is a password input, so a plain value stays masked until its reveal button is pressed; the
 * button sits inside the input, so the value field is as wide as the secret chooser and every row has the same columns.
 * `secrets` lists the names to choose from, or is `null` when they could not be read.
 */
export function envRowHtml(row, secrets) {
  const secret = row.kind === "secret";
  const names = [...new Set([...(secrets ?? []), ...(secret && row.secretRef ? [row.secretRef] : [])])];
  const empty = names.length ? t("env.chooseSecret") : t(secrets === null ? "env.secretsUnavailable" : "env.noSecrets");
  return `<div class="env-row" data-env-row>
    <input class="input mono" data-env-name value="${esc(row.name)}" placeholder="NAME" aria-label="${esc(t("env.name"))}" autocomplete="off" autocapitalize="off" spellcheck="false" />
    <select class="select" data-env-kind aria-label="${esc(t("env.kind"))}">
      <option value="value"${secret ? "" : " selected"}>${esc(t("env.kindValue"))}</option>
      <option value="secret"${secret ? " selected" : ""}>${esc(t("env.kindSecret"))}</option>
    </select>
    <div class="env-field env-field-reveal" data-env-field="value"${secret ? " hidden" : ""}>
      <input class="input mono" data-env-value type="password" value="${esc(row.value)}" aria-label="${esc(t("env.value"))}" autocomplete="off" autocapitalize="off" spellcheck="false" />
      <button type="button" class="icon-btn env-reveal" data-env-reveal aria-pressed="false" aria-label="${esc(t("env.reveal"))}" title="${esc(t("env.reveal"))}">${icon("eye")}</button>
    </div>
    <div class="env-field" data-env-field="secret"${secret ? "" : " hidden"}>
      <select class="select" data-env-secret aria-label="${esc(t("env.secret"))}">
        <option value="">${esc(empty)}</option>${names
          .map(
            (name) => `<option value="${esc(name)}"${name === row.secretRef ? " selected" : ""}>${esc(name)}</option>`,
          )
          .join("")}
      </select>
    </div>
    <button type="button" class="btn" data-env-remove>${esc(t("env.remove"))}</button>
  </div>`;
}

/** One env row as an element, ready to append to an editor. */
export function envRow(row, secrets) {
  const template = document.createElement("template");
  template.innerHTML = envRowHtml(row, secrets).trim();
  return template.content.firstElementChild;
}

/** The rows an editor holds, read back as `checkEnvRows` takes them. Names are as typed. */
export function readEnvRows(container) {
  return [...container.querySelectorAll("[data-env-row]")].map((row) => ({
    name: row.querySelector("[data-env-name]").value,
    kind: row.querySelector("[data-env-kind]").value,
    value: row.querySelector("[data-env-value]").value,
    secretRef: row.querySelector("[data-env-secret]").value,
  }));
}

function toggleReveal(button, input) {
  const shown = input.type === "text";
  input.type = shown ? "password" : "text";
  const label = t(shown ? "env.reveal" : "env.hide");
  button.innerHTML = icon(shown ? "eye" : "eyeOff");
  button.setAttribute("aria-pressed", String(!shown));
  button.setAttribute("aria-label", label);
  button.title = label;
}

/**
 * Wires the rows of an editor. The kind select shows the value field or the secret chooser, the reveal button shows a
 * plain value, and remove takes a row out. `onChange` runs after each of those and after any typing, so the caller can
 * count the rows or drop a message that no longer applies.
 */
export function bindEnvRows(container, onChange = () => {}) {
  container.addEventListener("change", (event) => {
    const kind = event.target.closest("[data-env-kind]");
    if (!kind) return;
    const secret = kind.value === "secret";
    const row = kind.closest("[data-env-row]");
    row.querySelector('[data-env-field="value"]').hidden = secret;
    row.querySelector('[data-env-field="secret"]').hidden = !secret;
    onChange();
  });
  container.addEventListener("input", onChange);
  container.addEventListener("click", (event) => {
    const reveal = event.target.closest("[data-env-reveal]");
    if (reveal) {
      toggleReveal(reveal, reveal.closest("[data-env-field]").querySelector("[data-env-value]"));
      return;
    }
    const remove = event.target.closest("[data-env-remove]");
    if (!remove) return;
    remove.closest("[data-env-row]").remove();
    onChange();
  });
}

/** The message for the first row the server would refuse, in the UI language. */
export function envProblemText(problem) {
  switch (problem.code) {
    case "count":
      return t("env.problem.count", { max: problem.max });
    case "duplicate":
      return t("env.problem.duplicate", { name: problem.name });
    case "value":
      return t("env.problem.value", { name: problem.name, max: ENV_VALUE_MAX });
    case "secret":
      return t("env.problem.secret", { name: problem.name });
    default:
      return t("env.problem.name");
  }
}
