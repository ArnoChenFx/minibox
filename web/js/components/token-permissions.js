import { esc } from "../lib/dom.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { allScopes, sameScopes } from "../lib/token-scopes.js";
import { bindFoldSections, foldSectionHtml } from "./fold-section.js";

const presetLabel = (name) => t(`st.preset.${name}`);

/** The preset choices: a name and one line saying what it grants. The dialog keeps the chosen one in `aria-pressed`. */
export function presetFieldHtml(catalog, selected) {
  const options = catalog.presets
    .map(
      (preset) => `<button type="button" class="seg preset-seg" role="radio" data-preset="${esc(preset.name)}"
        aria-checked="${preset.name === selected}" aria-pressed="${preset.name === selected}">
        <strong>${esc(presetLabel(preset.name))}</strong><span>${esc(t(`st.presetDesc.${preset.name}`))}</span>
      </button>`,
    )
    .join("");
  return `<div class="field">
    <div class="perm-label"><span id="stPresetLabel">${t("st.tokenPreset")}</span><span class="badge badge-warning" id="stPresetCustom" hidden></span></div>
    <div class="preset-list" role="radiogroup" aria-labelledby="stPresetLabel">${options}</div>
  </div>`;
}

function scopeRowHtml(scope, danger) {
  return `<label class="checkbox perm-scope${danger ? " is-danger" : ""}">
    <input type="checkbox" name="scope" value="${esc(scope)}" />
    <span class="perm-text">
      <span class="perm-name">${esc(t(`st.scope.${scope}`))}${danger ? `<span class="badge badge-danger">${icon("alert")}${t("st.tokenDanger")}</span>` : ""}</span>
      <code class="perm-id">${esc(scope)}</code>
      ${danger ? `<span class="perm-hint">${esc(t(`st.scopeHint.${scope}`))}</span>` : ""}
    </span>
  </label>`;
}

function groupHtml(group) {
  return `<div class="perm-group${group.danger ? " is-danger" : ""}">
    <div class="perm-group-title">${esc(t(`st.scopeGroup.${group.id}`))}</div>
    ${group.scopes.map((scope) => scopeRowHtml(scope, group.danger)).join("")}
  </div>`;
}

/** The folded 权限 section: every scope as a checkbox, grouped. */
export function permissionsHtml(catalog) {
  return foldSectionHtml({
    id: "stPerms",
    title: t("st.tokenPermissions"),
    open: false,
    body: `<div class="perm-bar">
        <span class="subtle" id="stPermCount"></span>
        <button type="button" class="btn btn-sm btn-ghost" id="stPermReset" hidden>${t("st.tokenScopesReset")}</button>
      </div>
      <div class="perm-grid">${catalog.groups.map(groupHtml).join("")}</div>
      <div class="help" id="stPermNote" hidden>${t("st.tokenAdminAudit")}</div>`,
  });
}

/**
 * Connects the preset list and the permission checkboxes under `root`. Choosing a preset ticks its scopes and calls
 * `onPreset(preset)`; ticking a scope by hand makes the token custom. Returns what the form submits.
 */
export function bindPermissions(root, catalog, { onPreset = () => {} } = {}) {
  bindFoldSections(root);
  const buttons = [...root.querySelectorAll("[data-preset]")];
  const boxes = [...root.querySelectorAll("input[name=scope]")];
  const total = allScopes(catalog).length;
  let current =
    buttons.find((b) => b.getAttribute("aria-pressed") === "true")?.dataset.preset ?? catalog.presets[0].name;
  const presetOf = (name) => catalog.presets.find((p) => p.name === name);
  const chosen = () => boxes.filter((box) => box.checked).map((box) => box.value);

  function paint() {
    const preset = presetOf(current);
    const scopes = chosen();
    const custom = !sameScopes(scopes, preset.scopes);
    for (const button of buttons) {
      const on = button.dataset.preset === current;
      button.setAttribute("aria-pressed", String(on));
      button.setAttribute("aria-checked", String(on));
    }
    const badge = root.querySelector("#stPresetCustom");
    badge.hidden = !custom;
    badge.textContent = `${t("st.tokenCustom")} · ${t("st.tokenCustomBased", { preset: presetLabel(current) })}`;
    root.querySelector("#stPermReset").hidden = !custom;
    root.querySelector("#stPermNote").hidden = !(custom && current === "admin");
    root.querySelector("#stPermCount").textContent = t("st.tokenPermissionsCount", { n: scopes.length, total });
    const name = custom ? t("st.tokenCustom") : presetLabel(current);
    root.querySelector("#stPermsSummary").textContent = `${name} · ${scopes.length}/${total}`;
  }

  function apply(name) {
    current = name;
    const scopes = presetOf(name).scopes;
    for (const box of boxes) box.checked = scopes.includes(box.value);
    paint();
  }

  for (const button of buttons) {
    button.addEventListener("click", () => {
      apply(button.dataset.preset);
      onPreset(presetOf(button.dataset.preset));
    });
  }
  for (const box of boxes) box.addEventListener("change", paint);
  root.querySelector("#stPermReset").addEventListener("click", () => apply(current));
  apply(current);
  return { preset: () => current, scopes: chosen };
}
