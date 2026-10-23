import { esc } from "../lib/dom.js";
import { t } from "../lib/i18n.js";

/** How a mount mode reads in the console: "Read-only" for `ro`, "Read-write" for `rw`. */
export function mountModeLabel(mode) {
  return t(mode === "ro" ? "vol.modeRo" : "vol.modeRw");
}

/**
 * The inner markup of one mount row: a volume, a path, a mode and a remove button. Without `volumes` the volume is a typed
 * name, which is how a rebuild names a standalone volume that does not exist yet. With `volumes`, each `{ id, name,
 * disabled }` is a choice, since a create mounts only recorded volumes.
 */
export function mountRowHtml(mount, { volumes } = {}) {
  const volume = volumes
    ? `<select class="select" data-volume aria-label="${esc(t("mount.volume"))}">
      <option value="">${esc(t("mount.choose"))}</option>${volumes
        .map(
          (choice) =>
            `<option value="${esc(choice.id)}" ${choice.id === mount.volume ? "selected" : ""} ${choice.disabled ? "disabled" : ""}>${esc(choice.name)}</option>`,
        )
        .join("")}</select>`
    : `<input class="input" data-volume value="${esc(mount.volume)}" placeholder="${esc(t("mount.volume"))}" aria-label="${esc(t("mount.volume"))}" />`;
  return `${volume}
    <input class="input" data-path value="${esc(mount.path)}" placeholder="${esc(t("mount.path"))}" aria-label="${esc(t("mount.path"))}" />
    <select class="select" data-mode aria-label="${esc(t("mount.mode"))}">
      <option value="rw" ${mount.mode === "rw" ? "selected" : ""}>${esc(mountModeLabel("rw"))}</option>
      <option value="ro" ${mount.mode === "ro" ? "selected" : ""}>${esc(mountModeLabel("ro"))}</option>
    </select>
    <button type="button" class="btn" data-remove-mount>${esc(t("mount.remove"))}</button>`;
}

/** One mount row as an element. Its remove button takes the row out of its list. */
export function mountRow(mount, options) {
  const row = document.createElement("div");
  row.className = "rebuild-mount";
  row.dataset.mount = "true";
  row.innerHTML = mountRowHtml(mount, options);
  row.querySelector("[data-remove-mount]").addEventListener("click", () => row.remove());
  return row;
}

/** The mounts a row list holds, read back from its rows. Volumes and paths are trimmed. */
export function readMountRows(container) {
  return [...container.querySelectorAll("[data-mount]")].map((row) => ({
    volume: row.querySelector("[data-volume]").value.trim(),
    path: row.querySelector("[data-path]").value.trim(),
    mode: row.querySelector("[data-mode]").value,
  }));
}
