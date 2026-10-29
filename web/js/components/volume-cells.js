/**
 * The cells and words of the storage page's volume table: the checkbox that picks a row, the mounts, pool, latest
 * checkpoint, status and action cells, and the labels its groups and roles read as. Every function is given the data it
 * draws and returns a string, so nothing here holds state, reads the page or sends a request. Which volumes are loaded,
 * which are selected, and what a button does stay with the page: this module only decides how one volume reads.
 */

import { enc } from "../lib/api.js";
import { checkpointGroupId } from "../lib/checkpoint-groups.js";
import { esc } from "../lib/dom.js";
import { dateTime, relTime } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { unselectableReason } from "../lib/volume-select.js";
import { mountModeLabel } from "./mount-editor.js";

/** The four volume roles and the i18n key of each name. The page's role selects and its create dialog are built from it. */
export const ROLES = [
  ["workspace", "vol.roleWorkspace"],
  ["home", "vol.roleHome"],
  ["tools", "vol.roleTools"],
  ["cache", "vol.roleCache"],
];

/** The capabilities a pool's row summarises, in the order it lists them. */
const CAPABILITIES = ["shareable", "snapshots", "quota", "clone", "crossHost"];

export const roleLabel = (role) => t(ROLES.find(([name]) => name === role)?.[1] ?? "vol.unknown");

/** Why a volume cannot be selected, in words for its checkbox's tooltip. */
function selectReasonText(reason) {
  return reason === "tools" ? t("vol.selectTools") : t("vol.selectMounted");
}

/** Why a batch delete skips a volume, from the `blocked` code its preview gives. */
export function blockedText(block) {
  switch (block) {
    case "in_use":
      return t("vol.blockInUse");
    case "forbidden":
      return t("vol.blockForbidden");
    case "tools":
      return t("vol.blockTools");
    case "not_found":
      return t("vol.blockNotFound");
    case "offline":
      return t("vol.blockOffline");
    default:
      return t("vol.blockUnavailable");
  }
}

/** The heading of a group of the volumes table, from the kind of group the list module grouped it under. */
export function groupLabel(group) {
  switch (group.kind) {
    case "box":
    case "pool":
      return group.name;
    case "role":
      return roleLabel(group.name);
    case "unattached":
      return t("vol.groupUnattached");
    case "other":
      return t("vol.groupOther");
    case "owned":
      return t("vol.owned");
    case "independent":
      return t("vol.independent");
    default:
      return "";
  }
}

/**
 * The status cell: a record the engine has lost or whose owner box was deleted, else whether a box mounts it. A volume no
 * box mounts says it can be cleaned up, except the shared tools volume, which boxes mount on demand.
 */
export function statusHtml(volume, staged) {
  const badges = [];
  if (volume.engineMissing) {
    badges.push(
      `<span class="badge badge-danger" title="${esc(t("vol.engineMissingHint"))}">${esc(t("vol.engineMissing"))}</span>`,
    );
  }
  if (volume.ownerMissing) {
    badges.push(
      `<span class="badge badge-warning" title="${esc(t("vol.ownerMissingHint"))}">${esc(t("vol.ownerMissing"))}</span>`,
    );
  }
  if (volume.mounts.length) {
    if (!badges.length) badges.push(`<span class="badge badge-success">${esc(t("vol.statusMounted"))}</span>`);
  } else {
    badges.push(`<span class="badge">${esc(t("vol.statusUnmounted"))}</span>`);
    if (staged?.length) {
      // Staged on a box: it mounts when that box applies its changes, so it is not one to clean up.
      badges.push(
        `<span class="vol-staged" title="${esc(t("vol.statusStagedText", { boxes: staged.join(", ") }))}">${esc(t("vol.statusStaged"))}</span>`,
      );
    } else if (volume.role !== "tools") {
      badges.push(
        `<span class="vol-hint" title="${esc(t("vol.cleanupHintText"))}">${esc(t("vol.cleanupHint"))}</span>`,
      );
    }
  }
  return `<div class="vol-status">${badges.join("")}</div>`;
}

function mountLine(mount) {
  const mode = mountModeLabel(mount.mode);
  return `<div class="vol-mount" title="${esc(`${mount.boxName}:${mount.path} (${mode})`)}"><span class="vol-mount-path">${esc(mount.boxName)}</span><span class="badge vol-mode vol-mode-${esc(mount.mode)}">${esc(mode)}</span></div>`;
}

/** The boxes that mount the volume, each with its mode. Two are listed and the rest are counted; the tooltip has all. */
export function mountsHtml(volume) {
  if (!volume.mounts.length) return `<span class="subtle">—</span>`;
  const shown = volume.mounts.slice(0, 2).map(mountLine).join("");
  const rest = volume.mounts.slice(2);
  const more = rest.length
    ? `<div class="subtle vol-mount-more" title="${esc(rest.map((mount) => `${mount.boxName}:${mount.path} (${mountModeLabel(mount.mode)})`).join("\n"))}">${esc(t("vol.mountsMore", { n: rest.length }))}</div>`
    : "";
  return shown + more;
}

/** The pool, and what it can do, as short words under its name. */
export function poolHtml(volume, pool) {
  const caps = CAPABILITIES.filter((cap) => pool?.capabilities?.[cap]);
  const words = caps.map((cap) => t(`vol.cap.${cap}`)).join(" · ");
  const backend =
    volume.backend && volume.backend !== volume.pool ? ` <span class="subtle">${esc(volume.backend)}</span>` : "";
  return `<div class="nowrap">${esc(volume.pool)}${backend}</div>${caps.length ? `<div class="subtle vol-caps" title="${esc(t("vol.capsTitle", { caps: words }))}">${esc(words)}</div>` : ""}`;
}

/** The newest checkpoint of a volume, linked to its group: the box that owns it, or the volume for a snapshot of its own. */
export function latestHtml(checkpoint) {
  if (!checkpoint) return `<span class="subtle">—</span>`;
  const tip = `${checkpoint.label} · ${dateTime(checkpoint.createdAt)}`;
  const focus = enc(checkpointGroupId(checkpoint));
  return `<a class="vol-latest" href="#/storage/checkpoints/${focus}" title="${esc(tip)}"><span class="nowrap">${esc(relTime(checkpoint.createdAt))}</span><span class="subtle truncate">${esc(checkpoint.label)}</span></a>`;
}

/** One button of a volume's actions cell, with the reason it is disabled when it is. */
export function rowButton(action, volume, iconName, label, { danger = false, block = "" } = {}) {
  const title = block ? `${label}: ${t(block)}` : label;
  return `<button type="button" class="icon-btn${danger ? " danger" : ""}" data-action="${action}" data-id="${esc(volume.id)}" data-name="${esc(volume.name)}" title="${esc(title)}" aria-label="${esc(label)}"${block ? " disabled" : ""}>${icon(iconName)}</button>`;
}

/** The checkbox that picks one volume, disabled with the reason when the server would refuse it. */
export function selectCellHtml(volume, selected) {
  const reason = unselectableReason(volume);
  const tip = reason ? ` title="${esc(selectReasonText(reason))}"` : "";
  return `<label class="checkbox"${tip}><input type="checkbox" data-select="${esc(volume.id)}" aria-label="${esc(t("vol.selectOne", { name: volume.name }))}"${selected.has(volume.id) ? " checked" : ""}${reason ? " disabled" : ""} /></label>`;
}

/** A pool's health as the badge its row shows, with a warning when the pool is low on space. */
export const healthBadge = (status, low) => {
  const cls = status === "reachable" ? "badge-success" : status === "unreachable" ? "badge-danger" : "";
  const label =
    status === "reachable" ? t("vol.reachable") : status === "unreachable" ? t("vol.unreachable") : t("vol.unknown");
  const extra = low ? ` <span class="badge badge-warning">${esc(t("vol.lowSpace"))}</span>` : "";
  return `<span class="badge ${cls}">${esc(label)}</span>${extra}`;
};
