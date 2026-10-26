import { api, enc } from "../lib/api.js";
import { groupCheckpoints } from "../lib/checkpoint-groups.js";
import { kindsOf, rowActions } from "../lib/checkpoint-state.js";
import { esc } from "../lib/dom.js";
import { bytes, dateTime, relTime } from "../lib/format.js";
import { hostOfBox } from "../lib/host-list.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { subscribe } from "../lib/live.js";
import { emptyState } from "../lib/ui.js";
import {
  confirmPending,
  contentsText,
  forkCheckpoint,
  importCheckpoint,
  KIND_CLASS,
  removeCheckpoint,
  rollBack,
  setPinned,
  takeCheckpoint,
  undoPending,
  usageHtml,
} from "./checkpoints.js";
import { bindToggles, flip, isToggled, limitList } from "./list-toggle.js";

/** How many checkpoints a box's group shows before its "show all" toggle. */
const GROUP_LIMIT = 5;
const COLUMNS = 6;

/** A rollback that waits for its confirm or undo, as one line with both buttons. They name the box they act on. */
function pendingLineHtml(group) {
  const pending = group.pending;
  const replaced = pending.replaced.map((volume) => volume.name).join(", ") || "—";
  const text = t("ck.pendingLine", { box: group.name, label: pending.checkpoint.label });
  const kept = t("ck.pendingKept", { volumes: replaced, time: dateTime(pending.createdAt) });
  return `<div class="callout warn sck-pending" data-box="${esc(group.id)}">${icon("alert")}<div class="sck-pending-body">
      <div title="${esc(text)}"><strong>${esc(text)}</strong></div>
      <div class="help" title="${esc(`${kept} ${t("ck.pendingLineHelp")}`)}">${esc(kept)}</div></div>
      <div class="sck-pending-actions">
        <button type="button" class="btn btn-sm btn-danger" data-action="ck-confirm" data-box="${esc(group.id)}">${icon("check")}${esc(t("ck.pendingConfirm"))}</button>
        <button type="button" class="btn btn-sm" data-action="ck-undo" data-box="${esc(group.id)}">${icon("history")}${esc(t("ck.pendingUndo"))}</button>
      </div></div>`;
}

function actionButton(action, checkpoint, iconName, label, rule, { danger = false } = {}) {
  const title = rule.allowed ? label : `${label}: ${t(rule.reason)}`;
  return `<button type="button" class="icon-btn${danger ? " danger" : ""}" data-action="${action}" data-id="${esc(checkpoint.id)}" title="${esc(title)}" aria-label="${esc(label)}"${rule.allowed ? "" : " disabled"}>${icon(iconName)}</button>`;
}

function rowHtml(checkpoint, group) {
  const elsewhere = group.box ? checkpoint.hostId !== hostOfBox(group.box) : false;
  const rules = rowActions(checkpoint, {
    held: group.pending?.safetyCheckpointId === checkpoint.id,
    pending: Boolean(group.pending),
    elsewhere,
  });
  // A deleted box has nothing to roll back: a fork brings its data back as a new box. A volume snapshot has no box at
  // all, so `rules.rollback` already says why, and the deleted-box wording would name a box that never existed.
  const rollback = group.deleted ? { allowed: false, reason: "ck.reasonBoxDeleted" } : rules.rollback;
  const kinds = kindsOf(checkpoint)
    .map((kind) => `<span class="badge ${KIND_CLASS[kind]}">${esc(t(`ck.kind.${kind}`))}</span>`)
    .join("");
  const contents = contentsText(checkpoint);
  // `data-label` names the contents on a phone, where the row is a card and the column header is gone. The other fields
  // name themselves there: a date, a size and a kind badge read as what they are. Contents that hold nothing are marked
  // so that layout leaves the line out instead of drawing a lone dash.
  const contentsClass = contents === "—" ? "sck-contents sck-empty" : "sck-contents";
  return `<tr>
    <td class="sck-time nowrap" title="${esc(dateTime(checkpoint.createdAt))}">${esc(dateTime(checkpoint.createdAt))}<div class="subtle">${esc(relTime(checkpoint.createdAt))}</div></td>
    <td class="sck-label"><div class="truncate" title="${esc(checkpoint.label)}">${esc(checkpoint.label)}</div>${checkpoint.reason ? `<div class="subtle truncate" title="${esc(checkpoint.reason)}">${esc(checkpoint.reason)}</div>` : ""}</td>
    <td class="sck-kind-cell"><div class="ck-badges sck-kinds">${kinds}</div></td>
    <td class="${contentsClass}" data-label="${esc(t("ck.colContents"))}"><div class="truncate" title="${esc(contents)}">${esc(contents)}</div></td>
    <td class="sck-size num nowrap">${esc(bytes(checkpoint.bytes))}</td>
    <td class="sck-actions"><div class="actions">
      ${actionButton("ck-fork", checkpoint, "copy", t("ck.fork"), rules.fork)}
      ${actionButton("ck-rollback", checkpoint, "history", t("ck.rollback"), rollback)}
      ${actionButton("ck-pin", checkpoint, "layers", checkpoint.pinned ? t("ck.unpin") : t("ck.pin"), rules.pin)}
      ${actionButton("ck-delete", checkpoint, "trash", t("ck.delete"), rules.delete, { danger: true })}
    </div></td>
  </tr>`;
}

function groupHeadHtml(group, folded) {
  const size = group.rows.length ? `<span class="subtle">${esc(bytes(group.bytes))}</span>` : "";
  const deleted = group.deleted ? `<span class="badge">${esc(t("ck.boxDeleted"))}</span>` : "";
  // A group named after a volume holds snapshots of that volume, not of a box: the badge says so.
  const volume = group.volume ? `<span class="badge badge-accent">${esc(t("ck.volumeGroup"))}</span>` : "";
  const pending = group.pending ? `<span class="badge badge-warning">${esc(t("ck.pendingTitle"))}</span>` : "";
  const tools = group.box
    ? `<a class="icon-btn" href="#/boxes/${enc(group.box.id)}/settings/checkpoints" title="${esc(t("ck.openBox"))}" aria-label="${esc(t("ck.openBox"))}">${icon("settings")}</a>
       <button type="button" class="icon-btn" data-action="ck-take" data-box="${esc(group.id)}" title="${esc(t("act.checkpoint"))}" aria-label="${esc(t("act.checkpoint"))}">${icon("camera")}</button>`
    : "";
  return `<tr class="group-row sck-group" data-group="${esc(group.id)}"><td colspan="${COLUMNS}"><div class="sck-group-head">
    <button type="button" class="group-toggle" data-action="ck-group" data-group="${esc(group.id)}" aria-expanded="${!folded}"${group.rows.length ? "" : " disabled"}>
      ${icon("chevron")}<strong>${esc(group.name)}</strong><span class="badge">${group.rows.length}</span>${size}${volume}${deleted}${pending}
    </button>
    <div class="sck-group-tools">${tools}</div>
  </div></td></tr>`;
}

/**
 * The storage page's Checkpoints tab: every checkpoint, grouped by box, newest first, with the actions on each and a
 * line for every rollback that waits for its confirm or undo. `focus` is a box id from the route, which shows only that
 * box. Returns the cleanup the page calls when the tab closes.
 */
export function mountStorageCheckpoints(root, { focus = "" } = {}) {
  let disposed = false;
  let seq = 0;
  let groups = [];
  let usage = null;

  const draw = () => {
    const shown = focus ? groups.filter((group) => group.id === focus) : groups;
    const pendingLines = shown
      .filter((group) => group.pending)
      .map(pendingLineHtml)
      .join("");
    const filter = focus
      ? `<div class="sck-filter help">${esc(t("ck.focusOnly", { box: shown[0]?.name ?? focus }))} <a href="#/storage/checkpoints">${esc(t("ck.focusAll"))}</a></div>`
      : "";
    const total = shown.reduce((sum, group) => sum + group.rows.length, 0);
    const body = shown.length
      ? shown
          .map((group) => {
            const folded = isToggled(root, `ckg:${group.id}`);
            if (folded || !group.rows.length) return groupHeadHtml(group, folded);
            const { shown: rows, toggle } = limitList(root, `ck:${group.id}`, group.rows, {
              limit: GROUP_LIMIT,
              keep: (row) => row.pinned,
            });
            const more = toggle ? `<tr class="toggle-row"><td colspan="${COLUMNS}">${toggle}</td></tr>` : "";
            return groupHeadHtml(group, false) + rows.map((row) => rowHtml(row, group)).join("") + more;
          })
          .join("")
      : `<tr><td colspan="${COLUMNS}">${emptyState({ iconName: "history", title: t("ck.noneAnywhere"), text: esc(t("ck.noneAnywhereText")) })}</td></tr>`;
    root.innerHTML = `
      <div class="page-head sck-head">
        <div class="sck-usage">${usage ? usageHtml(usage) : ""}</div>
        <div class="page-actions">
          <button type="button" class="btn" data-action="ck-refresh">${icon("refresh")}${esc(t("common.refresh"))}</button>
          <button type="button" class="btn" data-action="ck-import">${icon("upload")}${esc(t("ck.import"))}</button>
        </div>
      </div>
      ${pendingLines ? `<div class="sck-pendings">${pendingLines}</div>` : ""}
      <div class="card">
        <div class="card-head"><h3>${esc(t("ck.timeline"))}</h3><span class="subtle">${esc(t("ck.timelineCount", { n: total, boxes: shown.filter((group) => group.rows.length).length }))}</span></div>
        ${filter}
        <div class="table-wrap" id="sckWrap"><table class="table sck-table">
          <colgroup><col class="sck-c-time" /><col /><col class="sck-c-kind" /><col class="sck-c-contents" /><col class="sck-c-size" /><col class="sck-c-actions" /></colgroup>
          <thead><tr><th>${esc(t("ck.colTaken"))}</th><th>${esc(t("ck.colLabel"))}</th><th>${esc(t("ck.colKind"))}</th><th>${esc(t("ck.colContents"))}</th><th class="num">${esc(t("bd.colSize"))}</th><th class="actions-head">${esc(t("bx.colActions"))}</th></tr></thead>
          <tbody id="sckRows">${body}</tbody>
        </table></div>
      </div>`;
    bindToggles(root, root.querySelector("#sckRows"), draw);
  };

  const load = async () => {
    const token = ++seq;
    try {
      const [{ checkpoints }, { boxes }, usageBody, pendingBody] = await Promise.all([
        api("/api/checkpoints"),
        api("/api/boxes?stats=false"),
        api("/api/checkpoints/usage").catch(() => null),
        // Every box's waiting rollback comes in one read. A read that fails shows no pending line, as a box that could not
        // answer used to.
        api("/api/rollbacks").catch(() => ({ rollbacks: [] })),
      ]);
      if (disposed || token !== seq) return;
      usage = usageBody;
      const pendings = (pendingBody.rollbacks ?? []).map((entry) => [entry.box.boxId, entry.rollback]);
      groups = groupCheckpoints(checkpoints, boxes, new Map(pendings));
      draw();
    } catch (err) {
      if (disposed || token !== seq) return;
      root.innerHTML = emptyState({ iconName: "alert", title: t("ck.loadFailed"), text: esc(err.message) });
    }
  };

  const boxOf = (id) => groups.find((group) => group.id === id)?.box ?? null;
  const findRow = (id) => {
    for (const group of groups) {
      const checkpoint = group.rows.find((row) => row.id === id);
      if (checkpoint) return { checkpoint, group };
    }
    return null;
  };

  const run = async (button) => {
    const action = button.dataset.action;
    if (action === "ck-group") {
      flip(root, `ckg:${button.dataset.group}`);
      draw();
      root.querySelector(`.group-toggle[data-group="${CSS.escape(button.dataset.group)}"]`)?.focus();
      return;
    }
    if (action === "ck-refresh") return load();
    if (action === "ck-import") return importCheckpoint();
    const box = button.dataset.box ? boxOf(button.dataset.box) : null;
    if (action === "ck-take") return box && takeCheckpoint(box);
    if (action === "ck-confirm") return box && confirmPending(box);
    if (action === "ck-undo") return box && undoPending(box);
    const found = findRow(button.dataset.id);
    if (!found) return;
    const { checkpoint, group } = found;
    if (action === "ck-fork") return forkCheckpoint(checkpoint, group.box ?? { name: group.name });
    if (action === "ck-rollback") return group.box && rollBack(group.box, checkpoint);
    if (action === "ck-pin") return setPinned(checkpoint, !checkpoint.pinned);
    if (action === "ck-delete") return removeCheckpoint(checkpoint);
  };

  const onClick = (event) => {
    const button = event.target.closest("[data-action]");
    if (!button || button.disabled || !root.contains(button)) return;
    const reloads = button.dataset.action !== "ck-group" && button.dataset.action !== "ck-refresh";
    void Promise.resolve(run(button)).finally(() => {
      if (reloads && !disposed) void load();
    });
  };
  root.addEventListener("click", onClick);

  const off = subscribe("task", (frame) => {
    if (frame.kind === "status" && frame.status !== "running" && !disposed) void load();
  });

  root.innerHTML = `<div class="card"><div class="card-body"><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div></div></div>`;
  void load();
  return () => {
    disposed = true;
    off();
    root.removeEventListener("click", onClick);
  };
}
