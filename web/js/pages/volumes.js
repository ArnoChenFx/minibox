import { bindFoldSections, foldSectionHtml } from "../components/fold-section.js";
import { field } from "../components/form-field.js";
import { bindToggles, limitList } from "../components/list-toggle.js";
import { bindSearchBox, searchBoxHtml } from "../components/search-box.js";
import { mountVolumeActions } from "../components/volume-actions.js";
import { mountVolumeBatch } from "../components/volume-batch.js";
import {
  ROLES,
  groupLabel,
  healthBadge,
  latestHtml,
  mountsHtml,
  poolHtml,
  roleLabel,
  rowButton,
  selectCellHtml,
  statusHtml,
} from "../components/volume-cells.js";
import { usageCellHtml } from "../components/volume-usage.js";
import { api } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { bytes } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { applyPoolDraft, poolChanges, poolDraft, poolForm, renameRole } from "../lib/pool-form.js";
import { filterBySearch } from "../lib/search.js";
import { confirmDialog, emptyState, openDialog, skeletonRows, toast, toastError } from "../lib/ui.js";
import {
  GROUP_BY,
  GROUP_LABELS,
  groupVolumes,
  loadGroupBy,
  saveGroupBy,
  volumeSearchFields,
} from "../lib/volume-list.js";
import { latestByVolume, snapshotPlan, stagedMountsByVolume } from "../lib/volume-row.js";
import { headerState, keepSelectable, toggleAll, toggleOne } from "../lib/volume-select.js";

/**
 * The storage page's Volumes tab. It reads the volumes, the pools, the boxes and the latest checkpoint of each volume,
 * keeps the page's state (the pool list and its role defaults, the volume list, the selection and the search), and turns
 * a click or a change on either table into the action it means. The pieces it calls draw what they are given:
 * `volume-cells` draws one volume's cells, `volume-batch` runs the prune and the bulk delete previews, and
 * `volume-actions` runs the buttons of a volume's row. The pools section stays here because it shares this page's pool
 * list with the volume rows (a row names the pool it is on) and with the Create dialog, and because a pool rename has to
 * carry the role defaults it is chosen for.
 */

const VOLUME_COLUMNS = 9;

/** How many volumes a list or group shows before its "show all" toggle. */
const VOLUME_LIMIT = 10;

function volumeRow(volume, { selected, pools, latest, staged }) {
  const over =
    volume.usage?.level === "hard" || volume.usage?.level === "soft" ? ` volume-over-${volume.usage.level}` : "";
  const role = volume.role ? `${roleLabel(volume.role)} · ` : "";
  const owner = volume.ownership === "owned" ? t("vol.ownedShort") : t("vol.independent");
  const ownerTip = volume.ownership === "owned" ? ` title="${esc(t("vol.owned"))}"` : "";
  const checkpoint = latest.get(volume.id);
  // `data-label` names each field for the phone layout, where the row is a card and the column header is gone. A field
  // with nothing in it is marked too, so that layout can leave it out instead of drawing a lone dash.
  const mountsClass = volume.mounts.length ? "vol-mounts" : "vol-mounts vol-empty";
  const latestClass = checkpoint ? "vol-latest-cell" : "vol-latest-cell vol-empty";
  return `<tr class="${over.trim()}">
    <td class="select-cell">${selectCellHtml(volume, selected)}</td>
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

/**
 * What saving the pools would change. `t()` does not escape, so the whole sentence is escaped once here. `changed` is
 * what `poolChanges` reads from the pools the page holds and the pools the preview returns: the server's preview names
 * a pool's backend but not the server, export, options, root or marker an edit changes.
 */
function poolPreviewHtml(preview, changed = []) {
  const pools = preview.pools
    .map((pool) => `${pool.name} · ${pool.backend}${pool.default ? ` · ${t("vol.defaultYes")}` : ""}`)
    .join("\n");
  const lines = changed
    .map(
      (change) =>
        `<p class="help">${esc(t("vol.savePreviewChanged", { name: change.name }))}</p><pre class="mono">${esc(`${change.from}\n→ ${change.to}`)}</pre>`,
    )
    .join("");
  return `<p class="help">${esc(t("vol.savePreviewNote"))}</p>
    <div class="field"><span class="label">${esc(t("vol.savePreviewPools"))}</span><pre class="mono">${esc(pools)}</pre></div>
    ${lines}
    ${preview.added.length ? `<p>${esc(t("vol.savePreviewAdded", { names: preview.added.join(", ") }))}</p>` : ""}
    ${preview.removed.length ? `<p>${esc(t("vol.savePreviewRemoved", { names: preview.removed.join(", ") }))}</p>` : ""}`;
}

/** Saves the pools. A replacement that would change the pool list is first refused with its preview, and sent again once the user confirms. */
async function putPools(body, changed = []) {
  try {
    return await api("/api/pools", { method: "PUT", body });
  } catch (err) {
    if (err.code !== "confirmation_required" || !err.details?.preview) throw err;
    const ok = await confirmDialog({
      title: t("vol.savePreviewTitle"),
      body: poolPreviewHtml(err.details.preview, changed),
      confirmText: t("vol.save"),
    });
    if (!ok) return null;
    return api("/api/pools", { method: "PUT", body: { ...body, confirm: true } });
  }
}

/**
 * A dialog with the fields of a form. `submit(root)` runs when its confirm button is pressed, and may return a promise:
 * returning `false` keeps the dialog open, which is how a refused save leaves its reason beside the field it is about.
 * The promise resolves to the dialog's root once it closes after a submit, and to null when it is closed another way.
 */
function formDialog(title, body, submit) {
  return new Promise((resolve) => {
    let settled = false;
    let accepted = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const { root, close } = openDialog({
      title,
      body: `<div class="stack form-stack">${body}</div>`,
      onClose: () => finish(accepted ? root : null),
      footer: `<button class="btn" data-close>${t("common.cancel")}</button><button class="btn btn-primary" id="vol-ok">${t("common.confirm")}</button>`,
    });
    root.querySelector("#vol-ok").addEventListener("click", async () => {
      if (submit && (await submit(root)) === false) return;
      accepted = true;
      close();
    });
  });
}

/**
 * The form of one pool, prefilled with what it holds. The backend is shown but not offered: changing it is what the
 * server refuses for a pool that still has volumes, so the row's backend stays as it is.
 */
const poolFormHtml = (pool) => {
  const form = poolForm(pool);
  const body =
    pool.backend === "nfs"
      ? `${field(t("vol.poolName"), `<input class="input" id="p-name" value="${esc(form.name)}" />`)}
        ${field(t("vol.server"), `<input class="input" id="p-server" value="${esc(form.server)}" placeholder="192.168.1.10" />`)}
        ${field(t("vol.exportPath"), `<input class="input" id="p-export" value="${esc(form.export)}" placeholder="/volume1/minibox" />`)}
        ${field(t("vol.options"), `<input class="input" id="p-options" value="${esc(form.options)}" placeholder="nfsvers=4.1, hard" />`, t("vol.optionsHelp"))}`
      : `${field(t("vol.poolName"), `<input class="input" id="p-name" value="${esc(form.name)}" />`)}
        ${field(t("vol.root"), `<input class="input" id="p-root" value="${esc(form.root)}" placeholder="/mnt/disk" />`)}
        ${field(t("vol.marker"), `<input class="input" id="p-marker" value="${esc(form.marker)}" />`, t("vol.markerHelp"))}`;
  return `${body}
    ${field(t("vol.colBackend"), `<input class="input" id="p-backend" value="${esc(pool.backend)}" readonly />`, t("vol.backendFixed"))}
    <label class="checkbox"><input type="checkbox" id="p-default" ${form.default ? "checked" : ""} /> ${esc(t("vol.makeDefault"))}</label>
    <p class="help" id="p-rename-help">${esc(t("vol.editRenameHelp"))}</p>
    <p class="help" id="p-mounts-help">${esc(t("vol.editMountsHelp"))}</p>
    <div class="error-text" id="p-error" role="alert"></div>`;
};

const readPoolForm = (root, pool) => ({
  ...poolForm(pool),
  name: root.querySelector("#p-name").value,
  server: root.querySelector("#p-server")?.value ?? "",
  export: root.querySelector("#p-export")?.value ?? "",
  options: root.querySelector("#p-options")?.value ?? "",
  root: root.querySelector("#p-root")?.value ?? "",
  marker: root.querySelector("#p-marker")?.value ?? "",
  default: root.querySelector("#p-default").checked,
});

export function render(view) {
  let pools = [];
  /** The pools as the server last gave them, so a save's preview can name what an edit changes. */
  let savedPools = [];
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
        // The local pool is the built-in one, so it is neither edited nor removed. Every other pool can be.
        const edit =
          pool.name === "local"
            ? ""
            : `<button class="btn btn-sm" data-action="edit-pool" data-name="${esc(pool.name)}">${t("vol.editPool")}</button>`;
        // A pool with no note draws nothing there, so its card does not hold a line for a dash.
        const noteClass = item?.message ? "pool-note" : "pool-note pool-empty";
        // `pool-table` and the data-labels give the row its card layout on a phone, as the volumes table has.
        return `<tr>
          <td class="pool-name" data-label="${esc(t("vol.colName"))}"><strong>${esc(pool.name)}</strong> ${pool.default ? `<span class="badge">${esc(t("vol.defaultYes"))}</span>` : ""}</td>
          <td class="pool-backend" data-label="${esc(t("vol.colBackend"))}">${esc(pool.backend)}</td>
          <td class="pool-health" data-label="${esc(t("vol.colHealth"))}">${healthBadge(item?.status ?? "unknown", item?.lowSpace)}</td>
          <td class="pool-free num" data-label="${esc(t("vol.colFree"))}">${esc(free)}</td>
          <td class="${noteClass}" data-label="${esc(t("vol.colMessage"))}">${item?.message ? `<span class="subtle">${esc(item.message)}</span>` : "—"}</td>
          <td class="pool-actions"><div class="actions"><button class="btn btn-sm" data-action="make-default" data-name="${esc(pool.name)}">${t("vol.defaultYes")}</button>${edit}${remove}</div></td>
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
    savedPools = poolBody.pools;
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

  const batch = mountVolumeBatch({
    ids: () => volumes.filter((volume) => selected.has(volume.id)).map((volume) => volume.id),
    clearSelection: () => {
      selected = new Set();
    },
    reload: () => load(),
  });

  const actions = mountVolumeActions({
    volumes: () => volumes,
    boxes: () => boxes,
    boxNames: () => boxNames,
    formDialog,
    reload: () => load(),
  });

  const readRoles = () => {
    const next = {};
    for (const [role] of ROLES) {
      const value = view.querySelector(`[data-role="${role}"]`)?.value ?? "";
      next[role] = value || null;
    }
    return next;
  };

  /** The `PUT /api/pools` body for the pools the page holds, and the role defaults it shows. */
  const poolsBody = () => ({
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

  const save = async () => {
    const saved = await putPools(poolsBody(), poolChanges(savedPools, pools));
    if (!saved) return;
    pools = saved.pools;
    savedPools = saved.pools;
    roles = saved.roles;
    health = saved.health;
    toast(t("vol.saved"));
    draw();
  };

  /**
   * Edits one pool: its fields are written back into the page's list, and the same save the card's button runs sends the
   * whole list, with the same confirmation preview. The page's own Save button is behind the dialog, so the dialog's
   * confirm does the save, and a refusal keeps the dialog open with its reason beside the field.
   */
  const editPool = async (name) => {
    const pool = pools.find((item) => item.name === name);
    if (!pool || pool.name === "local") return;
    await formDialog(t("vol.editPoolTitle", { name: pool.name }), poolFormHtml(pool), async (dialog) => {
      const fail = (text, field) => {
        dialog.querySelector("#p-error").textContent = text;
        if (field) dialog.querySelector(`#${field}`)?.focus();
      };
      const checked = poolDraft(readPoolForm(dialog, pool), { pool, pools });
      if (checked.error) {
        fail(checked.error, checked.field);
        return false;
      }
      const previous = pools;
      const rolesBefore = roles;
      const renamed = checked.pool.name !== pool.name;
      pools = applyPoolDraft(pools, pool.name, checked.pool);
      // The role selects still name the pool as it was, so a rename carries the roles it is chosen for along with it.
      const body = poolsBody();
      if (renamed) {
        body.roles = renameRole(body.roles, pool.name, checked.pool.name);
        roles = renameRole(roles, pool.name, checked.pool.name);
      }
      let saved;
      try {
        saved = await putPools(body, poolChanges(savedPools, pools));
      } catch (err) {
        // The server refused it, such as a rename of a pool that still has volumes: say so, and keep the dialog.
        pools = previous;
        roles = rolesBefore;
        fail(err.message, renamed ? "p-name" : "");
        return false;
      }
      if (!saved) {
        // The confirmation was cancelled: the dialog stays as it was, and nothing is saved.
        pools = previous;
        roles = rolesBefore;
        return false;
      }
      pools = saved.pools;
      savedPools = saved.pools;
      roles = saved.roles;
      health = saved.health;
      toast(t("vol.saved"));
      draw();
    });
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
        await batch.deleteSelected();
      } else if (action === "prune") {
        await batch.prune();
      } else if (action === "save") {
        await save();
      } else if (action === "make-default") {
        pools = pools.map((pool) => ({ ...pool, default: pool.name === target.dataset.name }));
        draw();
      } else if (action === "edit-pool") {
        await editPool(target.dataset.name);
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
        const form = readPoolForm(root, { backend: "nfs" });
        const checked = poolDraft(form, { pools });
        if (checked.error) return toastError(t("vol.saveFailed"), { message: checked.error });
        addPool(checked.pool);
      } else if (action === "add-path") {
        const body = `
          ${field(t("vol.poolName"), `<input class="input" id="p-name" />`)}
          ${field(t("vol.root"), `<input class="input" id="p-root" placeholder="/mnt/disk" />`)}
          ${field(t("vol.marker"), `<input class="input" id="p-marker" value=".minibox-mounted" />`, t("vol.markerHelp"))}
          <label class="checkbox"><input type="checkbox" id="p-default" /> ${esc(t("vol.makeDefault"))}</label>`;
        const root = await formDialog(t("vol.addPath"), body);
        if (!root) return;
        const form = readPoolForm(root, { backend: "path" });
        const checked = poolDraft(form, { pools });
        if (checked.error) return toastError(t("vol.saveFailed"), { message: checked.error });
        addPool(checked.pool);
      } else if (action === "create") {
        await actions.create(pools);
      } else if (action === "delete" || action === "measure") {
        const volume = volumes?.find((item) => item.id === target.dataset.id);
        if (!volume) return;
        if (action === "delete") await actions.remove(volume);
        else await actions.measure(volume);
      } else if (action === "limits" || action === "browse" || action === "snapshot" || action === "mount-to") {
        await actions.run(action, target.dataset.id);
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
