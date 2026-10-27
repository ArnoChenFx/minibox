import { esc } from "../lib/dom.js";
import { t } from "../lib/i18n.js";
import { createMountChoices, roleMount, roleOfValue } from "../lib/mounts.js";

/** How a mount mode reads in the console: "Read-only" for `ro`, "Read-write" for `rw`. */
export function mountModeLabel(mode) {
  return t(mode === "ro" ? "vol.modeRo" : "vol.modeRw");
}

/** The i18n key of a role's name, as the volumes pages label it. */
export const ROLE_LABEL_KEY = {
  workspace: "vol.roleWorkspace",
  home: "vol.roleHome",
  tools: "vol.roleTools",
  cache: "vol.roleCache",
};

/** The label of a role, as the console names it: "Workspace", "Home", "Tools", "Cache". */
export function roleLabel(role) {
  return t(ROLE_LABEL_KEY[role] ?? "mount.volume");
}

/**
 * The label of the choice that creates a role's volume for a new box, and of the shared tools volume it reuses. With a
 * prediction the label names the volume the create would make, and says it is only a preview: nothing exists yet.
 */
function roleChoiceLabel(role, shared, noShared, preview) {
  if (shared) return preview?.name ? t("mount.roleSharedExists", { name: preview.name }) : t("mount.roleShared");
  if (noShared) {
    if (preview?.name) return t("mount.roleWillCreate", { name: preview.name });
    if (preview && !preview.hostKnown) return t("mount.roleSharedNoneAuto");
    return t("mount.roleSharedNone");
  }
  if (!preview) return t("mount.roleCreate", { role: roleLabel(role) });
  if (!preview.name) return t("mount.roleCreateUnnamed", { role: roleLabel(role) });
  return t("mount.roleWillCreate", { name: preview.name });
}

/**
 * The options of a create row's volume select: the roles to create, then the volumes that already exist. A role shows the
 * name MiniBox would give its volume, and says it is a preview: nothing is created until the box is.
 */
function createVolumeOptions(choices, selected) {
  const options = [`<option value="">${esc(t("mount.choose"))}</option>`];
  for (const choice of choices.filter((item) => item.role)) {
    options.push(
      `<option value="${esc(choice.value)}" ${choice.value === selected ? "selected" : ""}>${esc(roleChoiceLabel(choice.role, choice.shared, choice.noShared, choice.preview))}</option>`,
    );
  }
  const group = choices
    .filter((item) => !item.role)
    .map(
      (choice) =>
        `<option value="${esc(choice.value)}" ${choice.value === selected ? "selected" : ""} ${choice.disabled ? "disabled" : ""}>${esc(choice.volume.name)}</option>`,
    );
  if (group.length) {
    options.push(`<optgroup label="${esc(t("mount.existing"))}">${group.join("")}</optgroup>`);
  }
  return options.join("");
}

/**
 * Replaces the role options of one row's select with new predictions, keeping the volume the row picked. The volumes that
 * exist stay as they were, so a row that names one keeps it.
 */
export function updateMountRowChoices(row, choices) {
  const select = row.querySelector("[data-volume]");
  if (!select) return;
  const chosen = select.value;
  select.innerHTML = createVolumeOptions(choices, chosen);
  select.value = chosen;
}

/**
 * The inner markup of one mount row: a volume, a path, a mode and a remove button. Without `volumes` the volume is a typed
 * name, which is how a rebuild names a standalone volume that does not exist yet. With `volumes`, each `{ id, name,
 * disabled }` is a choice, since a create mounts only recorded volumes. `create` adds the roles a new box can have
 * MiniBox create, which fix the row's path and mode.
 */
export function mountRowHtml(mount, { volumes, create = false, choices = null } = {}) {
  const role = create ? roleOfValue(mount.volume) : null;
  const volume = volumes
    ? `<select class="select" data-volume aria-label="${esc(t("mount.volume"))}">${
        create
          ? createVolumeOptions(choices ?? createMountChoices(volumes), mount.volume)
          : `<option value="">${esc(t("mount.choose"))}</option>${volumes
              .map(
                (choice) =>
                  `<option value="${esc(choice.id)}" ${choice.id === mount.volume ? "selected" : ""} ${choice.disabled ? "disabled" : ""}>${esc(choice.name)}</option>`,
              )
              .join("")}`
      }</select>`
    : `<input class="input" data-volume value="${esc(mount.volume)}" placeholder="${esc(t("mount.volume"))}" aria-label="${esc(t("mount.volume"))}" />`;
  const path = role
    ? `<input class="input" data-path value="${esc(mount.path)}" aria-label="${esc(t("mount.path"))}" readonly />`
    : `<input class="input" data-path value="${esc(mount.path)}" placeholder="${esc(t("mount.path"))}" aria-label="${esc(t("mount.path"))}" />`;
  const mode = role
    ? `<select class="select" data-mode aria-label="${esc(t("mount.mode"))}" disabled>
        <option value="${roleMount(role)?.mode}">${esc(mountModeLabel(roleMount(role)?.mode ?? "rw"))}</option>
      </select>`
    : `<select class="select" data-mode aria-label="${esc(t("mount.mode"))}">
      <option value="rw" ${mount.mode === "rw" ? "selected" : ""}>${esc(mountModeLabel("rw"))}</option>
      <option value="ro" ${mount.mode === "ro" ? "selected" : ""}>${esc(mountModeLabel("ro"))}</option>
    </select>`;
  return `${volume}
    ${path}
    ${mode}
    <button type="button" class="btn" data-remove-mount>${esc(t("mount.remove"))}</button>`;
}

/**
 * Sets the path and mode of a create row from the role it now names: a role fixes both, and a volume the operator picks
 * gives the row back its own fields. `mount` is the row's mount, as `readMountRows` would read it.
 */
export function syncRoleRow(row, mount) {
  const path = row.querySelector("[data-path]");
  const mode = row.querySelector("[data-mode]");
  if (!path || !mode) return;
  const role = roleOfValue(mount.volume);
  const fixed = role ? roleMount(role) : null;
  if (fixed) {
    path.value = fixed.path;
    path.readOnly = true;
    mode.innerHTML = `<option value="${fixed.mode}">${esc(mountModeLabel(fixed.mode))}</option>`;
    mode.disabled = true;
  } else {
    path.readOnly = false;
    if (!mode.disabled) return;
    mode.disabled = false;
    mode.innerHTML = `<option value="rw">${esc(mountModeLabel("rw"))}</option><option value="ro">${esc(mountModeLabel("ro"))}</option>`;
    mode.value = mount.mode === "ro" ? "ro" : "rw";
  }
}

/** One mount row as an element. Its remove button takes the row out of its list. */
export function mountRow(mount, options) {
  const row = document.createElement("div");
  row.className = "rebuild-mount";
  row.dataset.mount = "true";
  row.innerHTML = mountRowHtml(mount, options);
  row.querySelector("[data-remove-mount]").addEventListener("click", () => row.remove());
  if (options?.create) {
    row.querySelector("[data-volume]").addEventListener("change", () => {
      syncRoleRow(row, readMountRow(row));
    });
  }
  return row;
}

/** One row's mount, read back from its fields. Volumes and paths are trimmed. */
function readMountRow(row) {
  return {
    volume: row.querySelector("[data-volume]").value.trim(),
    path: row.querySelector("[data-path]").value.trim(),
    mode: row.querySelector("[data-mode]").value,
  };
}

/** The mounts a row list holds, read back from its rows. Volumes and paths are trimmed. */
export function readMountRows(container) {
  return [...container.querySelectorAll("[data-mount]")].map(readMountRow);
}
