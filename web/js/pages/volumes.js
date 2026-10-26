import { stageMount } from "../components/box-volumes.js";
import { mountFiles } from "../components/files.js";
import { bindFoldSections, foldSectionHtml } from "../components/fold-section.js";
import { bindToggles, limitList } from "../components/list-toggle.js";
import { mountModeLabel } from "../components/mount-editor.js";
import { bindSearchBox, searchBoxHtml } from "../components/search-box.js";
import { waitTask, taskErrorText } from "../components/tasks.js";
import { usageCellHtml } from "../components/volume-usage.js";
import { api, enc, errorText } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { bytes, dateTime, relTime } from "../lib/format.js";
import { hostName, multiHost } from "../lib/hosts.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { validMountPath } from "../lib/mounts.js";
import { filterBySearch } from "../lib/search.js";
import {
  checkboxField,
  confirmDialog,
  emptyState,
  nameError,
  openDialog,
  skeletonRows,
  toast,
  toastError,
} from "../lib/ui.js";
import {
  GROUP_BY,
  GROUP_LABELS,
  groupVolumes,
  loadGroupBy,
  saveGroupBy,
  volumeSearchFields,
} from "../lib/volume-list.js";
import { latestByVolume, snapshotPlan, stagedMountsByVolume } from "../lib/volume-row.js";
import {
  headerState,
  keepSelectable,
  previewOutcome,
  tallyRows,
  toggleAll,
  toggleOne,
  unselectableReason,
} from "../lib/volume-select.js";
import { limitDraft, limitsBody } from "../lib/volume-usage.js";

const ROLES = [
  ["workspace", "vol.roleWorkspace"],
  ["home", "vol.roleHome"],
  ["tools", "vol.roleTools"],
  ["cache", "vol.roleCache"],
];

const VOLUME_COLUMNS = 9;

/** How many volumes a list or group shows before its "show all" toggle. */
const VOLUME_LIMIT = 10;

const CAPABILITIES = ["shareable", "snapshots", "quota", "clone", "crossHost"];

const roleLabel = (role) => t(ROLES.find(([name]) => name === role)?.[1] ?? "vol.unknown");

/** Why a volume cannot be selected, in words for its checkbox's tooltip. */
function selectReasonText(reason) {
  return reason === "tools" ? t("vol.selectTools") : t("vol.selectMounted");
}

/** Why a batch delete skips a volume, from the `blocked` code its preview gives. */
function blockedText(block) {
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

function groupLabel(group) {
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
function statusHtml(volume, staged) {
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

/** Browses the volume's files in a dialog, through the same file browser a box's Files tab has. */
function browse(volume) {
  const box = {
    mounts: [{ path: "/", volumeId: volume.id, volumeName: volume.name, role: null, mode: "rw" }],
  };
  let dispose = null;
  const { root } = openDialog({
    title: t("vol.browseTitle", { name: volume.name }),
    iconName: "folder",
    wide: true,
    body: `<div class="vol-browse"></div>`,
    onClose: () => dispose?.(),
  });
  dispose = mountFiles(root.querySelector(".vol-browse"), { box: () => box, onChange: () => () => {} });
}

/** The boxes that mount the volume, each with its mode. Two are listed and the rest are counted; the tooltip has all. */
function mountsHtml(volume) {
  if (!volume.mounts.length) return `<span class="subtle">—</span>`;
  const shown = volume.mounts.slice(0, 2).map(mountLine).join("");
  const rest = volume.mounts.slice(2);
  const more = rest.length
    ? `<div class="subtle vol-mount-more" title="${esc(rest.map((mount) => `${mount.boxName}:${mount.path} (${mountModeLabel(mount.mode)})`).join("\n"))}">${esc(t("vol.mountsMore", { n: rest.length }))}</div>`
    : "";
  return shown + more;
}

/** The pool, and what it can do, as short words under its name. */
function poolHtml(volume, pool) {
  const caps = CAPABILITIES.filter((cap) => pool?.capabilities?.[cap]);
  const words = caps.map((cap) => t(`vol.cap.${cap}`)).join(" · ");
  const backend =
    volume.backend && volume.backend !== volume.pool ? ` <span class="subtle">${esc(volume.backend)}</span>` : "";
  return `<div class="nowrap">${esc(volume.pool)}${backend}</div>${caps.length ? `<div class="subtle vol-caps" title="${esc(t("vol.capsTitle", { caps: words }))}">${esc(words)}</div>` : ""}`;
}

/** The newest checkpoint of a volume, linked to its group: the box that owns it, or the volume for a snapshot of its own. */
function latestHtml(checkpoint) {
  if (!checkpoint) return `<span class="subtle">—</span>`;
  const tip = `${checkpoint.label} · ${dateTime(checkpoint.createdAt)}`;
  const focus = checkpoint.boxId ? enc(checkpoint.boxId) : enc(`volume:${checkpoint.boxName ?? ""}`);
  return `<a class="vol-latest" href="#/storage/checkpoints/${focus}" title="${esc(tip)}"><span class="nowrap">${esc(relTime(checkpoint.createdAt))}</span><span class="subtle truncate">${esc(checkpoint.label)}</span></a>`;
}

function rowButton(action, volume, iconName, label, { danger = false, block = "" } = {}) {
  const title = block ? `${label}: ${t(block)}` : label;
  return `<button type="button" class="icon-btn${danger ? " danger" : ""}" data-action="${action}" data-id="${esc(volume.id)}" data-name="${esc(volume.name)}" title="${esc(title)}" aria-label="${esc(label)}"${block ? " disabled" : ""}>${icon(iconName)}</button>`;
}

function volumeRow(volume, { selected, pools, latest, staged }) {
  const over =
    volume.usage?.level === "hard" || volume.usage?.level === "soft" ? ` volume-over-${volume.usage.level}` : "";
  const reason = unselectableReason(volume);
  const tip = reason ? ` title="${esc(selectReasonText(reason))}"` : "";
  const pick = `<label class="checkbox"${tip}><input type="checkbox" data-select="${esc(volume.id)}" aria-label="${esc(t("vol.selectOne", { name: volume.name }))}"${selected.has(volume.id) ? " checked" : ""}${reason ? " disabled" : ""} /></label>`;
  const role = volume.role ? `${roleLabel(volume.role)} · ` : "";
  const owner = volume.ownership === "owned" ? t("vol.ownedShort") : t("vol.independent");
  const ownerTip = volume.ownership === "owned" ? ` title="${esc(t("vol.owned"))}"` : "";
  const checkpoint = latest.get(volume.id);
  // `data-label` names each field for the phone layout, where the row is a card and the column header is gone. A field
  // with nothing in it is marked too, so that layout can leave it out instead of drawing a lone dash.
  const mountsClass = volume.mounts.length ? "vol-mounts" : "vol-mounts vol-empty";
  const latestClass = checkpoint ? "vol-latest-cell" : "vol-latest-cell vol-empty";
  return `<tr class="${over.trim()}">
    <td class="select-cell">${pick}</td>
    <td class="vol-name"><strong class="truncate" title="${esc(volume.name)}">${esc(volume.name)}</strong><div class="subtle truncate" title="${esc(volume.id)}">${esc(role)}<span class="mono">${esc(volume.id)}</span></div></td>
    <td class="vol-usage" data-label="${esc(t("vol.colSize"))}">${usageCellHtml(volume)}</td>
    <td class="${mountsClass}" data-label="${esc(t("vol.colMounts"))}">${mountsHtml(volume)}</td>
    <td class="vol-owner nowrap"${ownerTip} data-label="${esc(t("vol.colOwnership"))}">${esc(owner)}</td>
    <td class="vol-pool" data-label="${esc(t("vol.colPool"))}">${poolHtml(volume, pools.get(volume.pool))}</td>
    <td class="${latestClass}" data-label="${esc(t("vol.colLatest"))}">${latestHtml(checkpoint)}</td>
    <td class="vol-status-cell nowrap">${statusHtml(volume, staged.get(volume.id))}</td>
    <td class="vol-actions nowrap"><div class="actions">
      ${rowButton("browse", volume, "folder", t("vol.browse"))}
      ${rowButton("snapshot", volume, "camera", t("vol.snapshot"), { block: snapshotPlan(volume).block })}
      ${rowButton("mount-to", volume, "link", t("vol.mountTo"))}
      ${rowButton("delete", volume, "trash", t("vol.delete"), { danger: true })}
    </div></td>
  </tr>`;
}

function groupRow(group, collapsed) {
  return `<tr class="group-row"><td colspan="${VOLUME_COLUMNS}">
    <button type="button" class="group-toggle" data-action="toggle-group" data-group="${esc(group.id)}" aria-expanded="${!collapsed}">
      ${icon("chevron")}<strong>${esc(groupLabel(group))}</strong><span class="badge">${group.rows.length}</span>
    </button>
  </td></tr>`;
}

const healthBadge = (status, low) => {
  const cls = status === "reachable" ? "badge-success" : status === "unreachable" ? "badge-danger" : "";
  const label =
    status === "reachable" ? t("vol.reachable") : status === "unreachable" ? t("vol.unreachable") : t("vol.unknown");
  const extra = low ? ` <span class="badge badge-warning">${esc(t("vol.lowSpace"))}</span>` : "";
  return `<span class="badge ${cls}">${esc(label)}</span>${extra}`;
};

/** A labelled control. `help` is trusted HTML shown under the control, inside the field so it sits close to it. */
function field(label, inner, help = "") {
  const hint = help ? `<span class="help">${help}</span>` : "";
  return `<label class="field"><span class="label">${esc(label)}</span>${inner}${hint}</label>`;
}

const limitInput = (id, value) =>
  `<input class="input" id="${id}" type="number" min="0" step="any" inputmode="decimal" value="${esc(value)}" placeholder="${esc(t("vol.noLimit"))}" />`;

/** What saving the pools would change. `t()` does not escape, so the whole sentence is escaped once here. */
function poolPreviewHtml(preview) {
  const pools = preview.pools
    .map((pool) => `${pool.name} · ${pool.backend}${pool.default ? ` · ${t("vol.defaultYes")}` : ""}`)
    .join("\n");
  return `<p class="help">${esc(t("vol.savePreviewNote"))}</p>
    <div class="field"><span class="label">${esc(t("vol.savePreviewPools"))}</span><pre class="mono">${esc(pools)}</pre></div>
    ${preview.added.length ? `<p>${esc(t("vol.savePreviewAdded", { names: preview.added.join(", ") }))}</p>` : ""}
    ${preview.removed.length ? `<p>${esc(t("vol.savePreviewRemoved", { names: preview.removed.join(", ") }))}</p>` : ""}`;
}

/** Saves the pools. A replacement that would change the pool list is first refused with its preview, and sent again once the user confirms. */
async function putPools(body) {
  try {
    return await api("/api/pools", { method: "PUT", body });
  } catch (err) {
    if (err.code !== "confirmation_required" || !err.details?.preview) throw err;
    const ok = await confirmDialog({
      title: t("vol.savePreviewTitle"),
      body: poolPreviewHtml(err.details.preview),
      confirmText: t("vol.save"),
    });
    if (!ok) return null;
    return api("/api/pools", { method: "PUT", body: { ...body, confirm: true } });
  }
}

function formDialog(title, body) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const { root, close } = openDialog({
      title,
      body: `<div class="stack form-stack">${body}</div>`,
      onClose: () => finish(null),
      footer: `<button class="btn" data-close>${t("common.cancel")}</button><button class="btn btn-primary" id="vol-ok">${t("common.confirm")}</button>`,
    });
    root.querySelector("#vol-ok").addEventListener("click", () => {
      finish(root);
      close();
    });
  });
}

/**
 * A dialog that shows what a change to volumes would do. It resolves to the dialog's root when its confirm button is
 * pressed, and to null when it is closed another way. Cancel has the focus, so Enter does not confirm a removal.
 */
function previewDialog({ title, description, body, confirmText, confirmDisabled = false }, draw) {
  return new Promise((resolve) => {
    let confirmed = false;
    const { root, close } = openDialog({
      title,
      description,
      iconName: "alert",
      tone: "danger",
      wide: true,
      body,
      footer: `<button class="btn" data-close autofocus>${t("common.cancel")}</button><button class="btn btn-danger" id="vol-ok"${confirmDisabled ? " disabled" : ""}>${esc(confirmText)}</button>`,
      onClose: () => resolve(confirmed ? root : null),
    });
    draw(root);
    root.querySelector("#vol-ok").addEventListener("click", () => {
      confirmed = true;
      close();
    });
  });
}

/**
 * Draws a preview table into `box`. A long table shows its first rows and a toggle for the rest. The scope remembers
 * whether the toggle is open, so a redraw keeps it.
 */
function drawTable(box, scope, { head, items, row }) {
  const { shown, toggle } = limitList(scope, "rows", items);
  box.innerHTML = `<div class="table-wrap"><table class="table">
      <thead><tr>${head}</tr></thead>
      <tbody>${shown.map(row).join("")}</tbody>
    </table></div>
    <div class="list-more">${toggle}</div>`;
  bindToggles(scope, box, () => drawTable(box, scope, { head, items, row }));
}

/** One line for each host a prune did not check. The volumes on such a host were left alone. */
const skippedHostNotes = (hosts) =>
  hosts.filter((host) => host.status !== "checked").map((host) => errorText(host.error));

function pruneRowHtml(volume, showHost) {
  return `<tr>
    <td><strong>${esc(volume.name)}</strong></td>
    ${showHost ? `<td>${esc(hostName(volume.hostId))}</td>` : ""}
    <td class="num">${esc(bytes(volume.bytes))}</td>
    <td>${esc(dateTime(volume.lastUsedAt))}</td>
    <td>${volume.formerBox ? esc(volume.formerBox) : "—"}</td>
    <td class="nowrap">${esc(volume.keepsCopy ? t("vol.willKeepBin") : t("vol.willDeleteForever"))}</td>
  </tr>`;
}

function deleteRowHtml(row, skipTrash, showHost) {
  const outcome = previewOutcome(row, skipTrash);
  const action = outcome.blocked
    ? `<span class="subtle">${esc(blockedText(outcome.blocked))}</span>`
    : esc(outcome.keepsCopy ? t("vol.willKeepBin") : t("vol.willDeleteForever"));
  return `<tr>
    <td><strong>${esc(row.name)}</strong></td>
    ${showHost ? `<td>${esc(hostName(row.hostId))}</td>` : ""}
    <td class="num">${esc(bytes(row.bytes))}</td>
    <td>${action}</td>
  </tr>`;
}

/**
 * The preview of a batch delete. The server answers a request without confirm with its preview and removes nothing, so
 * this only reads that answer.
 */
async function previewDelete(ids) {
  try {
    await api("/api/volumes/delete", { method: "POST", body: { ids } });
    return [];
  } catch (err) {
    if (err.code !== "confirmation_required" || !err.details?.preview) throw err;
    return err.details.preview.volumes;
  }
}

export function render(view) {
  let pools = [];
  let roles = { workspace: null, home: null, tools: null, cache: null };
  let health = [];
  let volumes = null;
  let matches = [];
  let selected = new Set();
  let boxNames = new Map();
  let boxes = [];
  let latest = new Map();
  let stagedMounts = new Map();
  let poolsOpen = false;
  let query = "";
  let groupBy = loadGroupBy();
  const collapsed = new Set();
  const groupOptions = GROUP_BY.map(
    (key) => `<option value="${key}" ${key === groupBy ? "selected" : ""}>${esc(t(GROUP_LABELS[key]))}</option>`,
  ).join("");
  view.innerHTML = `
    <div class="page-head vol-head">
      <div class="page-actions">
        <button class="btn" data-action="refresh">${icon("refresh")}${t("common.refresh")}</button>
        <button class="btn" data-action="add-nfs">${t("vol.addNfs")}</button>
        <button class="btn" data-action="add-path">${t("vol.addPath")}</button>
        <button class="btn btn-primary" data-action="create">${icon("plus")}${t("vol.create")}</button>
        <button class="btn" data-action="prune">${icon("zap")}${t("vol.prune")}</button>
      </div>
    </div>
    <div class="card">
      <div class="card-head with-tools"><h3>${t("vol.volumes")}</h3>
        <div class="list-tools">
          ${searchBoxHtml({ id: "volSearch", placeholder: t("vol.searchPlaceholder"), label: t("vol.search") })}
          <div class="group-by"><label for="volGroup">${t("vol.groupBy")}</label><select class="select" id="volGroup">${groupOptions}</select></div>
        </div>
      </div>
      <div class="bulk-bar" id="volBulk" hidden>
        <span id="volBulkCount"></span>
        <div class="bulk-actions">
          <button class="btn btn-sm" data-action="clear-selection">${t("vol.clearSelection")}</button>
          <button class="btn btn-sm btn-danger" data-action="bulk-delete">${icon("trash")}${t("vol.deleteSelected")}</button>
        </div>
      </div>
      <div class="table-wrap" id="volWrap"><table class="table vol-table">
        <thead><tr><th class="select-cell" data-label="${esc(t("vol.selectAllShort"))}"><label class="checkbox"><input type="checkbox" id="volSelectAll" aria-label="${esc(t("vol.selectAll"))}" disabled /></label></th><th>${t("vol.colName")}</th><th class="nowrap">${t("vol.colSize")}</th><th class="nowrap">${t("vol.colMounts")}</th><th class="nowrap">${t("vol.colOwnership")}</th><th class="nowrap">${t("vol.colPool")}</th><th class="nowrap">${t("vol.colLatest")}</th><th class="nowrap">${t("vol.colStatus")}</th><th class="nowrap actions-head">${t("vol.colAction")}</th></tr></thead>
        <tbody id="volRows">${skeletonRows(3, VOLUME_COLUMNS)}</tbody>
      </table></div>
    </div>
    <div id="volBody" class="vol-pools">${skeletonRows(1, 4)}</div>`;

  const healthOf = (name) => health.find((item) => item.pool === name);

  const draw = () => {
    const poolRows = pools
      .map((pool) => {
        const item = healthOf(pool.name);
        const free = item?.freeBytes != null ? bytes(item.freeBytes) : "—";
        const remove =
          pool.name === "local"
            ? ""
            : `<button class="btn btn-sm" data-action="remove-pool" data-name="${esc(pool.name)}">${t("vol.removePool")}</button>`;
        // A pool with no note draws nothing there, so its card does not hold a line for a dash.
        const noteClass = item?.message ? "pool-note" : "pool-note pool-empty";
        // `pool-table` and the data-labels give the row its card layout on a phone, as the volumes table has.
        return `<tr>
          <td class="pool-name" data-label="${esc(t("vol.colName"))}"><strong>${esc(pool.name)}</strong> ${pool.default ? `<span class="badge">${esc(t("vol.defaultYes"))}</span>` : ""}</td>
          <td class="pool-backend" data-label="${esc(t("vol.colBackend"))}">${esc(pool.backend)}</td>
          <td class="pool-health" data-label="${esc(t("vol.colHealth"))}">${healthBadge(item?.status ?? "unknown", item?.lowSpace)}</td>
          <td class="pool-free num" data-label="${esc(t("vol.colFree"))}">${esc(free)}</td>
          <td class="${noteClass}" data-label="${esc(t("vol.colMessage"))}">${item?.message ? `<span class="subtle">${esc(item.message)}</span>` : "—"}</td>
          <td class="pool-actions"><div class="actions"><button class="btn btn-sm" data-action="make-default" data-name="${esc(pool.name)}">${t("vol.defaultYes")}</button>${remove}</div></td>
        </tr>`;
      })
      .join("");
    const roleFields = ROLES.map(([role, label]) => {
      const options = [`<option value="">${esc(t("vol.roleRule"))}</option>`]
        .concat(
          pools.map(
            (pool) =>
              `<option value="${esc(pool.name)}" ${roles[role] === pool.name ? "selected" : ""}>${esc(pool.name)}</option>`,
          ),
        )
        .join("");
      return field(t(label), `<select class="select" data-role="${role}">${options}</select>`);
    }).join("");
    const unhealthy = pools.filter((pool) => {
      const item = healthOf(pool.name);
      return item && (item.status === "unreachable" || item.lowSpace);
    }).length;
    const summary = esc(
      unhealthy
        ? t("vol.poolsSummaryWarn", { n: pools.length, bad: unhealthy })
        : t("vol.poolsSummary", { n: pools.length }),
    );
    const host = view.querySelector("#volBody");
    host.innerHTML = foldSectionHtml({
      id: "volPools",
      title: esc(t("vol.poolsAndRoles")),
      summary,
      open: poolsOpen,
      body: `<div class="card">
        <div class="card-head"><p class="help">${t("vol.subtitle")}</p>
          <button class="btn btn-primary btn-sm" data-action="save">${t("vol.save")}</button></div>
        <div class="table-wrap"><table class="table pool-table">
          <thead><tr><th>${t("vol.colName")}</th><th>${t("vol.colBackend")}</th><th>${t("vol.colHealth")}</th><th>${t("vol.colFree")}</th><th></th><th></th></tr></thead>
          <tbody>${poolRows}</tbody>
        </table></div>
        <div class="card-body">
          <div class="section-intro"><h3>${t("vol.roles")}</h3><p class="help">${t("vol.cacheHint")}</p></div>
          <div class="grid grid-2 form-grid">${roleFields}</div>
        </div>
      </div>`,
    });
    bindFoldSections(host, (_id, open) => {
      poolsOpen = open;
    });
  };

  /** The header checkbox and the bulk bar follow the selection and the matches on screen. */
  const syncSelection = () => {
    const header = view.querySelector("#volSelectAll");
    const state = headerState(selected, matches);
    header.disabled = state.disabled;
    header.checked = state.checked;
    header.indeterminate = state.indeterminate;
    view.querySelector("#volBulk").hidden = selected.size === 0;
    view.querySelector("#volBulkCount").textContent = t("vol.selectedCount", { n: selected.size });
  };

  const drawVolumes = () => {
    if (!volumes) return;
    const body = view.querySelector("#volRows");
    matches = volumes.length
      ? filterBySearch(volumes, query, (volume) => volumeSearchFields(volume, { boxNames, roleLabel }))
      : [];
    syncSelection();
    if (!volumes.length) {
      body.innerHTML = `<tr><td colspan="${VOLUME_COLUMNS}">${emptyState({ iconName: "folder", title: t("vol.none"), text: "" })}</td></tr>`;
      return;
    }
    if (!matches.length) {
      body.innerHTML = `<tr><td colspan="${VOLUME_COLUMNS}">${emptyState({
        iconName: "search",
        title: t("vol.noMatch"),
        text: t("vol.noMatchText", { q: esc(query) }),
        action: `<button class="btn btn-sm" data-action="clear-search">${t("common.clearSearch")}</button>`,
      })}</td></tr>`;
      return;
    }
    const poolMap = new Map(pools.map((pool) => [pool.name, pool]));
    const rowsOf = (key, rows) => {
      const { shown, toggle } = limitList(view, `vol:${key}`, rows, {
        keep: (volume) => selected.has(volume.id),
        searching: Boolean(query),
        limit: VOLUME_LIMIT,
      });
      const html = shown
        .map((volume) => volumeRow(volume, { selected, pools: poolMap, latest, staged: stagedMounts }))
        .join("");
      return toggle ? `${html}<tr class="toggle-row"><td colspan="${VOLUME_COLUMNS}">${toggle}</td></tr>` : html;
    };
    body.innerHTML = groupVolumes(matches, groupBy, { boxNames })
      .map((group) => {
        if (group.kind === "all") return rowsOf("all", group.rows);
        const isCollapsed = collapsed.has(group.id);
        return groupRow(group, isCollapsed) + (isCollapsed ? "" : rowsOf(group.id, group.rows));
      })
      .join("");
    bindToggles(view, body, drawVolumes);
  };

  const toggleGroup = (id) => {
    if (collapsed.has(id)) collapsed.delete(id);
    else collapsed.add(id);
    drawVolumes();
    [...view.querySelectorAll(".group-toggle")].find((button) => button.dataset.group === id)?.focus();
  };

  const search = bindSearchBox(view.querySelector("#volSearch"), (text) => {
    query = text;
    drawVolumes();
  });
  view.querySelector("#volGroup").addEventListener("change", (event) => {
    groupBy = event.target.value;
    saveGroupBy(groupBy);
    drawVolumes();
  });

  view.addEventListener("change", (event) => {
    const input = event.target;
    if (input.id === "volSelectAll") {
      selected = toggleAll(selected, matches);
      drawVolumes();
    } else if (input.dataset.select !== undefined) {
      const volume = volumes?.find((item) => item.id === input.dataset.select);
      if (volume) selected = toggleOne(selected, volume, input.checked);
      syncSelection();
    }
  });

  const load = async () => {
    const [poolBody, volumeBody, boxBody, checkpointBody] = await Promise.all([
      api("/api/pools?refresh=true"),
      api("/api/volumes"),
      // The owner's name is only a label: without the box list, a mount of the owner still names it. Volumes name
      // boxes by their stable boxId, not by the container id.
      api("/api/boxes?stats=false").catch(() => ({ boxes: [] })),
      // The latest checkpoint column is a hint: the table still draws without it.
      api("/api/checkpoints").catch(() => ({ checkpoints: [] })),
    ]);
    pools = poolBody.pools;
    roles = { ...roles, ...poolBody.roles };
    health = poolBody.health;
    volumes = volumeBody.volumes;
    selected = keepSelectable(selected, volumes);
    boxes = boxBody.boxes;
    boxNames = new Map(boxes.map((box) => [box.boxId, box.name]));
    latest = latestByVolume(checkpointBody.checkpoints);
    // A mount staged from here, or on the box, shows as pending rather than as a volume to clean up. Every box's staged
    // changes come in one read, and a read that fails leaves the table as it is without the pending column.
    const stagedEntries = await api("/api/staged")
      .then((body) => body.staged ?? [])
      .catch(() => []);
    stagedMounts = stagedMountsByVolume(stagedEntries, volumes);
    draw();
    drawVolumes();
  };

  const pruneOrphans = async () => {
    let preview;
    try {
      preview = await api("/api/volumes/prune", { method: "POST", body: { dryRun: true } });
    } catch (err) {
      return toastError(t("vol.pruneFailed"), err);
    }
    const notes = skippedHostNotes(preview.hosts);
    if (!preview.volumes.length) return toast(t("vol.pruneNone"), { type: "info", message: notes.join(" ") });
    const showHost = multiHost();
    const scope = {};
    const confirmed = await previewDialog(
      {
        title: t("vol.pruneTitle"),
        description: esc(t("vol.pruneDesc")),
        body: `<div class="preview-notes">${notes.map((note) => `<div class="callout warn">${icon("alert")}<span>${esc(note)}</span></div>`).join("")}</div><div class="prune-list"></div>`,
        confirmText: t("vol.pruneConfirm"),
      },
      (root) => {
        const head = `<th>${t("vol.colName")}</th>${showHost ? `<th>${t("vol.colHost")}</th>` : ""}<th class="num">${t("vol.colBytes")}</th><th>${t("vol.lastUsed")}</th><th>${t("vol.formerBox")}</th><th>${t("vol.colAction")}</th>`;
        drawTable(root.querySelector(".prune-list"), scope, {
          head,
          items: preview.volumes,
          row: (volume) => pruneRowHtml(volume, showHost),
        });
      },
    );
    if (!confirmed) return;
    let result;
    try {
      // Only the volumes the preview showed: the server refuses any that stopped being orphans and removes nothing else.
      const ids = preview.volumes.map((volume) => volume.id);
      result = await api("/api/volumes/prune", { method: "POST", body: { dryRun: false, ids } });
    } catch (err) {
      return toastError(t("vol.pruneFailed"), err);
    }
    const tally = tallyRows(result.volumes);
    toast(t("vol.pruned"), {
      type: tally.failed ? "error" : "success",
      message: [t("vol.resultTally", tally), ...skippedHostNotes(result.hosts)].join(" "),
    });
    await load();
  };

  const deleteSelected = async () => {
    const ids = volumes.filter((volume) => selected.has(volume.id)).map((volume) => volume.id);
    if (!ids.length) return;
    let rows;
    try {
      rows = await previewDelete(ids);
    } catch (err) {
      return toastError(t("vol.deleteFailed"), err);
    }
    const removable = rows.filter((row) => previewOutcome(row, false).removes).length;
    const showHost = multiHost();
    const scope = {};
    const confirmed = await previewDialog(
      {
        title: t("vol.deleteSelectedTitle"),
        description: `${esc(t("vol.deleteSummary", { removed: removable, skipped: rows.length - removable }))} ${esc(t("vol.deleteSelectedDesc"))}`,
        body: `${checkboxField({ id: "bd-skip", label: esc(t("vol.skipTrash")), help: esc(t("vol.skipTrashHelp")) })}<div class="prune-list"></div>`,
        confirmText: t("vol.delete"),
        confirmDisabled: removable === 0,
      },
      (root) => {
        const skip = root.querySelector("#bd-skip");
        const head = `<th>${t("vol.colName")}</th>${showHost ? `<th>${t("vol.colHost")}</th>` : ""}<th class="num">${t("vol.colBytes")}</th><th>${t("vol.colAction")}</th>`;
        const box = root.querySelector(".prune-list");
        const draw = () =>
          drawTable(box, scope, { head, items: rows, row: (row) => deleteRowHtml(row, skip.checked, showHost) });
        skip.addEventListener("change", draw);
        draw();
      },
    );
    if (!confirmed) return;
    const skipTrash = confirmed.querySelector("#bd-skip").checked;
    let done;
    try {
      done = await api("/api/volumes/delete", { method: "POST", body: { ids, confirm: true, skipTrash } });
    } catch (err) {
      return toastError(t("vol.deleteFailed"), err);
    }
    const tally = tallyRows(done.volumes);
    toast(t("vol.bulkDone"), { type: tally.failed ? "error" : "success", message: t("vol.resultTally", tally) });
    selected = new Set();
    await load();
  };

  const readRoles = () => {
    const next = {};
    for (const [role] of ROLES) {
      const value = view.querySelector(`[data-role="${role}"]`)?.value ?? "";
      next[role] = value || null;
    }
    return next;
  };

  const save = async () => {
    const saved = await putPools({
      pools: pools.map((pool) => ({
        name: pool.name,
        backend: pool.backend,
        default: pool.default,
        server: pool.server ?? undefined,
        export: pool.export ?? undefined,
        options: pool.options,
        root: pool.root ?? undefined,
        marker: pool.marker ?? undefined,
      })),
      roles: readRoles(),
    });
    if (!saved) return;
    pools = saved.pools;
    roles = saved.roles;
    health = saved.health;
    toast(t("vol.saved"));
    draw();
  };

  const addPool = (pool) => {
    if (pools.some((item) => item.name === pool.name)) {
      toastError(t("vol.saveFailed"), { message: t("err.pool_duplicate") });
      return;
    }
    if (pool.default) pools = pools.map((item) => ({ ...item, default: false }));
    pools = [...pools, pool];
    draw();
  };

  const editLimits = async (volume) => {
    const draft = limitDraft(volume.limits);
    const root = await formDialog(
      t("vol.limitsTitle", { name: volume.name }),
      `<p class="help">${esc(t("vol.limitsHelp"))}</p>
        ${field(t("vol.softLimit"), limitInput("lim-soft", draft.soft))}
        ${field(t("vol.hardLimit"), limitInput("lim-hard", draft.hard))}
        ${field(
          t("vol.limitAction"),
          `<select class="select" id="lim-action">
            <option value="warn" ${draft.action === "warn" ? "selected" : ""}>${esc(t("vol.actionWarn"))}</option>
            <option value="stop" ${draft.action === "stop" ? "selected" : ""}>${esc(t("vol.actionStop"))}</option>
          </select>`,
          esc(t("vol.actionHelp")),
        )}`,
    );
    if (!root) return;
    const parsed = limitsBody({
      soft: root.querySelector("#lim-soft").value,
      hard: root.querySelector("#lim-hard").value,
      action: root.querySelector("#lim-action").value,
    });
    if (parsed.error) return toastError(t("vol.limitsFailed"), { message: t(parsed.error) });
    try {
      await api(`/api/volumes/${enc(volume.id)}/limits`, { method: "PUT", body: parsed.body });
    } catch (e) {
      return toastError(t("vol.limitsFailed"), e);
    }
    toast(t("vol.limitsSaved"));
    await load();
  };

  /**
   * Snapshots the volume. An owned volume is a checkpoint of its owner box, which always includes it. An independent one
   * is snapshotted on its own, without a box, whether or not a box mounts it.
   */
  const snapshot = async (volume) => {
    const plan = snapshotPlan(volume);
    if (plan.block) return toast(t("vol.snapshot"), { type: "info", message: t(plan.block) });
    const boxName = plan.own ? null : (plan.boxName ?? boxNames.get(plan.boxId) ?? plan.boxId);
    const ok = await confirmDialog({
      title: t("vol.snapshotTitle", { name: volume.name }),
      message: esc(
        t(
          plan.own
            ? volume.mounts.length
              ? "vol.snapshotSelfMountedText"
              : "vol.snapshotSelfText"
            : "vol.snapshotOwnedText",
          { box: boxName ?? "" },
        ),
      ),
      confirmText: t("vol.snapshot"),
    });
    if (!ok) return;
    const label = `${volume.name} ${dateTime(new Date().toISOString())}`.slice(0, 80);
    let started;
    try {
      started = plan.own
        ? await api(`/api/volumes/${enc(volume.id)}/checkpoints`, { method: "POST", body: { label } })
        : await api(`/api/boxes/${enc(plan.boxId)}/checkpoints`, { method: "POST", body: { label } });
    } catch (e) {
      return toastError(t("ck.takeFailed"), e);
    }
    toast(t("ck.takeStarted"), { type: "info", message: boxName ?? volume.name });
    const done = await waitTask(started.taskId);
    if (done.status !== "succeeded") return toastError(t("ck.takeFailed"), { message: taskErrorText(done.error) });
    toast(t("ck.takeDone"), { message: done.result?.checkpoint?.label ?? label });
    await load();
  };

  /** Stages a mount of the volume on a box. It applies with the box's other staged changes, like one added there. */
  const mountTo = async (volume) => {
    if (!boxes.length) return toast(t("vol.mountTo"), { type: "info", message: t("vol.mountToNoBoxes") });
    const owner = volume.ownership === "owned" && !volume.ownerMissing ? volume.ownerBoxId : null;
    const mountedOn = new Set(volume.mounts.map((mount) => mount.boxId));
    const options = boxes
      .map((box) => {
        const blocked = owner && box.boxId !== owner;
        const note = mountedOn.has(box.boxId) ? ` (${t("vol.mountToMounted")})` : "";
        return `<option value="${esc(box.boxId)}"${blocked ? " disabled" : ""}${box.boxId === owner ? " selected" : ""}>${esc(box.name + note)}</option>`;
      })
      .join("");
    const ro = volume.role === "tools";
    const root = await formDialog(
      t("vol.mountToTitle", { name: volume.name }),
      `${owner ? `<p class="help">${esc(t("vol.mountToOwned"))}</p>` : ""}
       ${field(t("vol.mountToBox"), `<select class="select" id="mt-box">${options}</select>`)}
       ${field(t("vol.pathLabel"), `<input class="input mono" id="mt-path" value="${esc(`/mnt/${volume.name}`)}" />`)}
       ${field(t("vol.colMode"), `<select class="select" id="mt-mode"><option value="rw"${ro ? "" : " selected"}>${esc(mountModeLabel("rw"))}</option><option value="ro"${ro ? " selected" : ""}>${esc(mountModeLabel("ro"))}</option></select>`)}`,
    );
    if (!root) return;
    const box = boxes.find((item) => item.boxId === root.querySelector("#mt-box").value);
    const path = root.querySelector("#mt-path").value.trim();
    if (!box) return;
    if (!validMountPath(path)) return toastError(t("vol.attachFailed"), { message: t("vol.mountToBadPath") });
    const staged = await stageMount(
      box,
      volume,
      { id: volume.id, path, mode: root.querySelector("#mt-mode").value },
      t("vol.mountStagedText", { box: box.name }),
    );
    if (staged) await load();
  };

  view.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-action]");
    if (!target || !view.contains(target)) return;
    const action = target.dataset.action;
    try {
      if (action === "refresh") {
        target.disabled = true;
        await load();
        target.disabled = false;
      } else if (action === "toggle-group") {
        toggleGroup(target.dataset.group);
      } else if (action === "clear-search") {
        search.clear();
      } else if (action === "clear-selection") {
        selected = new Set();
        drawVolumes();
      } else if (action === "bulk-delete") {
        await deleteSelected();
      } else if (action === "prune") {
        await pruneOrphans();
      } else if (action === "save") {
        await save();
      } else if (action === "make-default") {
        pools = pools.map((pool) => ({ ...pool, default: pool.name === target.dataset.name }));
        draw();
      } else if (action === "remove-pool") {
        pools = pools.filter((pool) => pool.name !== target.dataset.name);
        if (!pools.some((pool) => pool.default)) {
          pools = pools.map((pool) => ({ ...pool, default: pool.name === "local" }));
        }
        draw();
      } else if (action === "add-nfs") {
        const body = `
          ${field(t("vol.poolName"), `<input class="input" id="p-name" />`)}
          ${field(t("vol.server"), `<input class="input" id="p-server" placeholder="192.168.1.10" />`)}
          ${field(t("vol.exportPath"), `<input class="input" id="p-export" placeholder="/volume1/minibox" />`)}
          ${field(t("vol.options"), `<input class="input" id="p-options" placeholder="nfsvers=4.1, hard" />`, t("vol.optionsHelp"))}
          <label class="checkbox"><input type="checkbox" id="p-default" /> ${esc(t("vol.makeDefault"))}</label>`;
        const root = await formDialog(t("vol.addNfs"), body);
        if (!root) return;
        const name = root.querySelector("#p-name").value.trim();
        const invalid = nameError(name, "name");
        if (invalid) return toastError(t("vol.saveFailed"), { message: invalid });
        addPool({
          name,
          backend: "nfs",
          default: root.querySelector("#p-default").checked,
          server: root.querySelector("#p-server").value.trim(),
          export: root.querySelector("#p-export").value.trim(),
          options: root
            .querySelector("#p-options")
            .value.split(",")
            .map((part) => part.trim())
            .filter(Boolean),
          root: null,
          marker: null,
          capabilities: { shareable: true, snapshots: false, quota: false, clone: false, crossHost: true },
        });
      } else if (action === "add-path") {
        const body = `
          ${field(t("vol.poolName"), `<input class="input" id="p-name" />`)}
          ${field(t("vol.root"), `<input class="input" id="p-root" placeholder="/mnt/disk" />`)}
          ${field(t("vol.marker"), `<input class="input" id="p-marker" value=".minibox-mounted" />`, t("vol.markerHelp"))}
          <label class="checkbox"><input type="checkbox" id="p-default" /> ${esc(t("vol.makeDefault"))}</label>`;
        const root = await formDialog(t("vol.addPath"), body);
        if (!root) return;
        const name = root.querySelector("#p-name").value.trim();
        const invalid = nameError(name, "name");
        if (invalid) return toastError(t("vol.saveFailed"), { message: invalid });
        addPool({
          name,
          backend: "path",
          default: root.querySelector("#p-default").checked,
          server: null,
          export: null,
          options: [],
          root: root.querySelector("#p-root").value.trim(),
          marker: root.querySelector("#p-marker").value.trim() || ".minibox-mounted",
          capabilities: { shareable: true, snapshots: false, quota: false, clone: false, crossHost: false },
        });
      } else if (action === "create") {
        const options = pools.map((pool) => `<option value="${esc(pool.name)}">${esc(pool.name)}</option>`).join("");
        const roleOptions = [`<option value="">—</option>`]
          .concat(ROLES.map(([role, label]) => `<option value="${role}">${esc(t(label))}</option>`))
          .join("");
        const root = await formDialog(
          t("vol.createTitle"),
          `${field(t("vol.colName"), `<input class="input" id="v-name" />`)}
           ${field(t("vol.colPool"), `<select class="select" id="v-pool">${options}</select>`)}
           ${field(t("vol.colRole"), `<select class="select" id="v-role">${roleOptions}</select>`)}`,
        );
        if (!root) return;
        const name = root.querySelector("#v-name").value.trim();
        const invalid = nameError(name, "name");
        if (invalid) return toastError(t("vol.createFailed"), { message: invalid });
        await api("/api/volumes", {
          method: "POST",
          body: {
            name,
            pool: root.querySelector("#v-pool").value,
            role: root.querySelector("#v-role").value || null,
            confirm: true,
          },
        });
        toast(t("vol.created"));
        await load();
      } else if (action === "delete") {
        const res = await confirmDialog({
          title: t("vol.deleteTitle"),
          message: esc(t("vol.deleteMessage", { name: target.dataset.name })),
          confirmText: t("vol.delete"),
          danger: true,
          checkboxes: [{ key: "skipTrash", label: t("vol.skipTrash"), help: t("vol.skipTrashHelp") }],
        });
        if (!res) return;
        const query = new URLSearchParams({ confirm: "true", skipTrash: String(res.skipTrash) });
        const deleted = await api(`/api/volumes/${enc(target.dataset.id)}?${query}`, { method: "DELETE" });
        toast(
          t("vol.deleted"),
          deleted.trash ? { message: t("vol.keptInBin", { date: dateTime(deleted.trash.expiresAt) }) } : {},
        );
        await load();
      } else if (action === "measure") {
        const result = await api(`/api/volumes/${enc(target.dataset.id)}/usage`, { method: "POST" });
        toast(t("vol.measure"), { message: t("vol.measured", { bytes: bytes(result.volume.bytes) }) });
        await load();
      } else if (action === "limits" || action === "browse" || action === "snapshot" || action === "mount-to") {
        const volume = volumes?.find((item) => item.id === target.dataset.id);
        if (!volume) return;
        if (action === "limits") await editLimits(volume);
        else if (action === "browse") browse(volume);
        else if (action === "snapshot") await snapshot(volume);
        else await mountTo(volume);
      }
    } catch (e) {
      toastError(t("vol.loadingFailed"), e);
      if (action === "refresh") target.disabled = false;
    }
  });

  load().catch((e) => {
    const failure = emptyState({ iconName: "alert", title: t("vol.loadingFailed"), text: esc(e.message) });
    view.querySelector("#volBody").innerHTML = failure;
    view.querySelector("#volRows").innerHTML = `<tr><td colspan="${VOLUME_COLUMNS}">${failure}</td></tr>`;
  });
}
