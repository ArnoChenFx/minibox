import { bindToggles, limitList } from "../components/list-toggle.js";
import { bindSearchBox, searchBoxHtml } from "../components/search-box.js";
import { usageCellHtml } from "../components/volume-usage.js";
import { api, enc, errorText } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { bytes, dateTime } from "../lib/format.js";
import { hostName, multiHost } from "../lib/hosts.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
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

const VOLUME_COLUMNS = 8;

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

function volumeRow(volume, selected) {
  const mounts = volume.mounts
    .map((mount) => `${esc(mount.boxName)}:${esc(mount.path)} (${esc(mount.mode)})`)
    .join(", ");
  const over =
    volume.usage?.level === "hard" || volume.usage?.level === "soft" ? ` volume-over-${volume.usage.level}` : "";
  const limits =
    volume.backend === "nfs"
      ? `<button class="btn btn-sm" disabled title="${esc(t("vol.limitsNfs"))}">${t("vol.limits")}</button>`
      : `<button class="btn btn-sm" data-action="limits" data-id="${esc(volume.id)}">${t("vol.limits")}</button>`;
  const reason = unselectableReason(volume);
  const tip = reason ? ` title="${esc(selectReasonText(reason))}"` : "";
  const pick = `<label class="checkbox"${tip}><input type="checkbox" data-select="${esc(volume.id)}" aria-label="${esc(t("vol.selectOne", { name: volume.name }))}"${selected.has(volume.id) ? " checked" : ""}${reason ? " disabled" : ""} /></label>`;
  return `<tr class="${over.trim()}">
    <td class="select-cell">${pick}</td>
    <td><strong>${esc(volume.name)}</strong><div class="subtle mono">${esc(volume.id)}</div></td>
    <td>${volume.role ? esc(roleLabel(volume.role)) : "—"}</td>
    <td>${esc(volume.pool)}${volume.backend && volume.backend !== volume.pool ? ` <span class="subtle">${esc(volume.backend)}</span>` : ""}</td>
    <td>${volume.ownership === "owned" ? esc(t("vol.owned")) : esc(t("vol.independent"))}</td>
    <td>${mounts || "—"}</td>
    <td>${usageCellHtml(volume)}</td>
    <td><div class="actions">
      <button class="btn btn-sm" data-action="measure" data-id="${esc(volume.id)}">${t("vol.measure")}</button>
      ${limits}
      <button class="btn btn-sm" data-action="delete" data-id="${esc(volume.id)}" data-name="${esc(volume.name)}">${t("vol.delete")}</button>
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

function field(label, inner) {
  return `<label class="field"><span class="label">${esc(label)}</span>${inner}</label>`;
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
      body,
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
  </tr>`;
}

function deleteRowHtml(row, skipTrash, showHost) {
  const outcome = previewOutcome(row, skipTrash);
  const action = outcome.blocked
    ? `<span class="subtle">${esc(blockedText(outcome.blocked))}</span>`
    : esc(outcome.keepsCopy ? t("vol.willKeepBin") : t("vol.willDelete"));
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
  let query = "";
  let groupBy = loadGroupBy();
  const collapsed = new Set();
  const groupOptions = GROUP_BY.map(
    (key) => `<option value="${key}" ${key === groupBy ? "selected" : ""}>${esc(t(GROUP_LABELS[key]))}</option>`,
  ).join("");
  view.innerHTML = `
    <div class="page-head">
      <div><p>${t("vol.subtitle")}</p></div>
      <div class="page-actions">
        <button class="btn" data-action="refresh">${icon("refresh")}${t("common.refresh")}</button>
        <button class="btn" data-action="add-nfs">${t("vol.addNfs")}</button>
        <button class="btn" data-action="add-path">${t("vol.addPath")}</button>
        <button class="btn btn-primary" data-action="create">${icon("plus")}${t("vol.create")}</button>
        <button class="btn" data-action="prune">${icon("zap")}${t("vol.prune")}</button>
      </div>
    </div>
    <div id="volBody">${skeletonRows(3, 4)}</div>
    <div class="card" style="margin-top:16px">
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
      <div class="table-wrap"><table class="table">
        <thead><tr><th class="select-cell"><label class="checkbox"><input type="checkbox" id="volSelectAll" aria-label="${esc(t("vol.selectAll"))}" disabled /></label></th><th>${t("vol.colName")}</th><th>${t("vol.colRole")}</th><th>${t("vol.colPool")}</th><th>${t("vol.colOwnership")}</th><th>${t("vol.colMounts")}</th><th>${t("vol.colBytes")}</th><th></th></tr></thead>
        <tbody id="volRows">${skeletonRows(3, VOLUME_COLUMNS)}</tbody>
      </table></div>
    </div>`;

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
        return `<tr>
          <td><strong>${esc(pool.name)}</strong> ${pool.default ? `<span class="badge">${esc(t("vol.defaultYes"))}</span>` : ""}</td>
          <td>${esc(pool.backend)}</td>
          <td>${healthBadge(item?.status ?? "unknown", item?.lowSpace)}</td>
          <td class="num">${esc(free)}</td>
          <td>${item?.message ? `<span class="subtle">${esc(item.message)}</span>` : "—"}</td>
          <td><div class="actions"><button class="btn btn-sm" data-action="make-default" data-name="${esc(pool.name)}">${t("vol.defaultYes")}</button>${remove}</div></td>
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
    view.querySelector("#volBody").innerHTML = `
      <div class="card"><div class="card-head"><h3>${t("vol.pools")}</h3>
        <button class="btn btn-primary btn-sm" data-action="save">${t("vol.save")}</button></div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>${t("vol.colName")}</th><th>${t("vol.colBackend")}</th><th>${t("vol.colHealth")}</th><th>${t("vol.colFree")}</th><th></th><th></th></tr></thead>
          <tbody>${poolRows}</tbody>
        </table></div>
        <div class="card-body">
          <div class="section-intro"><h3>${t("vol.roles")}</h3><p class="help">${t("vol.cacheHint")}</p></div>
          <div class="grid grid-2 form-grid">${roleFields}</div>
        </div>
      </div>`;
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
    body.innerHTML = groupVolumes(matches, groupBy, { boxNames })
      .map((group) => {
        if (group.kind === "all") return group.rows.map((volume) => volumeRow(volume, selected)).join("");
        const isCollapsed = collapsed.has(group.id);
        return (
          groupRow(group, isCollapsed) +
          (isCollapsed ? "" : group.rows.map((volume) => volumeRow(volume, selected)).join(""))
        );
      })
      .join("");
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
    const [poolBody, volumeBody, boxBody] = await Promise.all([
      api("/api/pools?refresh=true"),
      api("/api/volumes"),
      // The owner's name is only a label: without the box list, a mount of the owner still names it. Volumes name
      // boxes by their stable boxId, not by the container id.
      api("/api/boxes?stats=false").catch(() => ({ boxes: [] })),
    ]);
    pools = poolBody.pools;
    roles = { ...roles, ...poolBody.roles };
    health = poolBody.health;
    volumes = volumeBody.volumes;
    selected = keepSelectable(selected, volumes);
    boxNames = new Map(boxBody.boxes.map((box) => [box.boxId, box.name]));
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
        const head = `<th>${t("vol.colName")}</th>${showHost ? `<th>${t("vol.colHost")}</th>` : ""}<th class="num">${t("vol.colBytes")}</th><th>${t("vol.lastUsed")}</th><th>${t("vol.formerBox")}</th>`;
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
      result = await api("/api/volumes/prune", { method: "POST", body: { dryRun: false } });
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
        )}
        <p class="help">${esc(t("vol.actionHelp"))}</p>`,
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
          ${field(t("vol.options"), `<input class="input" id="p-options" placeholder="nfsvers=4.1, hard" />`)}
          <p class="help">${t("vol.optionsHelp")}</p>
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
          ${field(t("vol.marker"), `<input class="input" id="p-marker" value=".minibox-mounted" />`)}
          <p class="help">${t("vol.markerHelp")}</p>
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
      } else if (action === "limits") {
        const volume = volumes?.find((item) => item.id === target.dataset.id);
        if (volume) await editLimits(volume);
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
