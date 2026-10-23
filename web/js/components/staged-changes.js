import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { movedBoxHash } from "../lib/routes.js";
import { refreshHost } from "../lib/store.js";
import { confirmDialog, openDialog, toast, toastError, withBusy } from "../lib/ui.js";
import { changeText } from "./box-actions.js";
import { bindFoldSections, foldSectionHtml } from "./fold-section.js";

/**
 * Changes that rebuild a box are staged on the server and applied together. The settings cards stage them; the banner
 * at the top of the box's settings shows how many wait, the difference, and applies or discards them. A card that
 * stages or a banner that applies announces the new state, so every part of the page draws the same one.
 */
const EVENT = "minibox:staged";

/** Tells the page that the staged changes of `boxId` are now `staged` (null when none wait). */
export function announceStaged(boxId, staged) {
  document.dispatchEvent(new CustomEvent(EVENT, { detail: { boxId, staged } }));
}

/** Calls `fn(staged)` when the staged changes of the box `boxIdOf()` names change. Returns the unsubscribe. */
export function onStaged(boxIdOf, fn) {
  const listener = (event) => {
    if (event.detail.boxId === boxIdOf()) fn(event.detail.staged);
  };
  document.addEventListener(EVENT, listener);
  return () => document.removeEventListener(EVENT, listener);
}

/** The box's staged changes, or null when none wait. */
export async function fetchStaged(boxRef) {
  return (await api(`/api/boxes/${enc(boxRef)}/staged`)).staged ?? null;
}

/** Stages `fields` on top of what is staged already, announces the result, and returns it. */
export async function stageFields(box, fields) {
  const { staged } = await api(`/api/boxes/${enc(box.id)}/staged`, { method: "PUT", body: fields });
  announceStaged(box.boxId, staged ?? null);
  return staged ?? null;
}

/** The staged value of `field`, or null when it is not pending. */
export function stagedField(staged, field) {
  return staged?.pending?.includes(field) ? staged.fields[field] : null;
}

function parseMounts(text) {
  try {
    const rows = JSON.parse(text);
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

const modeText = (mode) => t(mode === "ro" ? "vol.modeRo" : "vol.modeRw");

/**
 * The mounts a change adds, removes or switches to another volume or mode, one line each by path. Null when either
 * side is not the JSON a rebuild plan names mounts in.
 */
export function mountLines(change) {
  const before = parseMounts(change.from);
  const after = parseMounts(change.to);
  if (!before || !after) return null;
  const old = new Map(before.map((row) => [row.path, row]));
  const now = new Map(after.map((row) => [row.path, row]));
  const lines = [];
  for (const row of after) {
    const was = old.get(row.path);
    if (!was) lines.push(`+ ${row.path} (${modeText(row.mode)})`);
    else if (was.volume !== row.volume || was.mode !== row.mode) {
      lines.push(`~ ${row.path} (${modeText(was.mode)} → ${modeText(row.mode)})`);
    }
  }
  for (const row of before) if (!now.has(row.path)) lines.push(`− ${row.path}`);
  return lines;
}

function changeLines(change) {
  const label = t(`rebuild.field.${change.field}`);
  const mounts = change.field === "mounts" ? mountLines(change) : null;
  if (mounts?.length) return [`${label}:`, ...mounts.map((line) => `  ${line}`)];
  return [`${label}: ${changeText(change, change.from)} → ${changeText(change, change.to)}`];
}

/** The planned changes: field, then the value before and after. Mounts list each path that changes on its own line. */
export function changesHtml(changes) {
  const lines = (changes ?? []).flatMap(changeLines);
  return `<pre class="mono staged-changes">${esc(lines.join("\n") || "—")}</pre>`;
}

function sessionsText(sessions) {
  if (sessions === null || sessions === undefined) return t("stg.sessionsUnknown");
  return sessions === 0 ? t("stg.sessionsNone") : t("stg.sessions", { n: sessions });
}

/** The body of the apply dialog: the changes, the sessions that end, the writable layer and the volumes' promise. */
export function applyBodyHtml(preview) {
  const diff = preview.diff ?? [];
  const diffBody = diff.length
    ? `<pre class="mono staged-changes">${esc(diff.map((change) => `${t(`rebuild.diff.${change.kind}`)} ${change.path}`).join("\n"))}</pre>`
    : `<p class="help">${esc(t("rb.diffEmpty"))}</p>`;
  const sessionsTone = preview.sessions ? "warn" : "";
  return `<div class="staged-apply stack">
    <div><div class="label">${esc(t("stg.changes"))}</div>${changesHtml(preview.changes)}</div>
    <div class="callout ${sessionsTone}" data-staged-sessions>${icon("terminal")}<span>${esc(sessionsText(preview.sessions))}</span></div>
    ${foldSectionHtml({
      id: "stgDiff",
      title: esc(t("stg.diffTitle")),
      summary: esc(t("stg.diffSummary", { n: diff.length })),
      body: `<p class="help">${esc(t("stg.diffHelp"))}</p>${diffBody}`,
    })}
    <div class="callout info">${icon("disk")}<span>${esc(t("stg.volumesKept"))}</span></div>
  </div>`;
}

function checkpointField(preview) {
  return preview.systemCheckpoint
    ? { key: "checkpoint", label: t("stg.checkpoint"), help: t("stg.checkpointHelp"), checked: true }
    : { key: "checkpoint", label: t("stg.checkpointData"), help: t("stg.checkpointDataHelp"), checked: true };
}

/** Shows the planned changes. Resolves true when the user goes on to apply them from there. */
function openDiff(staged) {
  return new Promise((resolve) => {
    let next = false;
    const { root, close } = openDialog({
      title: t("stg.diffDialogTitle"),
      description: esc(t("stg.diffDialogText")),
      body: changesHtml(staged.changes),
      footer: `<button class="btn" data-close>${esc(t("common.close"))}</button><button class="btn btn-primary" data-staged-next ${staged.problem ? "disabled" : ""}>${icon("refresh")}${esc(t("stg.apply"))}</button>`,
      onClose: () => resolve(next),
    });
    root.querySelector("[data-staged-next]").addEventListener("click", () => {
      next = true;
      close();
    });
  });
}

/**
 * Applies the staged changes after the confirm dialog. Reads the box again, so the revision it sends is current, then
 * follows the box to its new container id. Resolves true when the box was rebuilt.
 */
async function applyStaged(box) {
  let fresh;
  let preview;
  try {
    ({ box: fresh } = await api(`/api/boxes/${enc(box.id)}`));
    ({ preview } = await api(`/api/boxes/${enc(fresh.id)}/staged/preview`));
  } catch (err) {
    toastError(t("stg.applyFailed"), err);
    return false;
  }
  const ok = await confirmDialog({
    title: t("stg.confirmTitle", { name: fresh.name }),
    message: esc(t("stg.confirmText")),
    body: applyBodyHtml(preview),
    confirmText: t("stg.apply"),
    danger: true,
    checkboxes: [checkpointField(preview)],
    onOpen: (root) => bindFoldSections(root),
  });
  if (!ok) return false;
  let result;
  try {
    result = await api(`/api/boxes/${enc(fresh.id)}/staged/apply`, {
      method: "POST",
      body: { checkpoint: ok.checkpoint, stagedAt: preview.stagedAt },
      headers: { "if-match": String(fresh.revision) },
    });
  } catch (err) {
    toastError(t("stg.applyFailed"), err);
    return false;
  }
  const safety = result?.safety ? ` ${t("rb.safetyTaken")}` : "";
  toast(t("rb.done"), { message: t("rb.doneText", { name: fresh.name }) + safety });
  announceStaged(fresh.boxId, null);
  refreshHost();
  const next = result?.box?.id;
  const address = next && next !== box.id ? movedBoxHash(location.hash, box.id, next) : null;
  if (address) location.hash = address;
  return true;
}

async function discardStaged(box) {
  const ok = await confirmDialog({
    title: t("stg.discardTitle"),
    message: esc(t("stg.discardText", { name: box.name })),
    confirmText: t("stg.discard"),
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/boxes/${enc(box.id)}/staged`, { method: "DELETE" });
  } catch (err) {
    toastError(t("stg.discardFailed"), err);
    return;
  }
  toast(t("stg.discarded"));
  announceStaged(box.boxId, null);
}

/** The banner's markup, or "" when nothing waits. */
export function stagedBannerHtml(staged) {
  const pending = staged?.pending ?? [];
  if (!pending.length) return "";
  const fields = pending.map((field) => t(`rebuild.field.${field}`)).join(t("stg.listSep"));
  const problem = staged.problem
    ? `<div class="callout danger staged-problem">${icon("alert")}<span><strong>${esc(t("stg.problem"))}</strong> ${esc(staged.problem)}</span></div>`
    : "";
  return `<div class="staged-banner callout warn" role="status">
      ${icon("alert")}
      <span class="staged-text"><strong>${esc(t("stg.banner", { n: pending.length }))}</strong><span class="staged-fields">${esc(fields)}</span></span>
      <span class="staged-actions">
        <button type="button" class="btn btn-sm" data-staged="diff">${esc(t("stg.viewDiff"))}</button>
        <button type="button" class="btn btn-sm btn-primary" data-staged="apply" ${staged.problem ? "disabled" : ""}>${icon("refresh")}${esc(t("stg.apply"))}</button>
        <button type="button" class="btn btn-sm" data-staged="discard">${esc(t("stg.discard"))}</button>
      </span>
    </div>${problem}`;
}

/**
 * The banner above a box's settings. It reads the staged changes when it mounts, again when the box's revision changes
 * (an apply or a rebuild may have used them), and draws what any card announces.
 */
export function mountStagedBanner(container, { box }) {
  let staged = null;
  let disposed = false;
  let revision = box().revision;
  let reads = 0;

  const draw = () => {
    if (disposed) return;
    container.innerHTML = stagedBannerHtml(staged);
    container.hidden = container.innerHTML === "";
  };

  const read = async () => {
    const seq = ++reads;
    try {
      const fresh = await fetchStaged(box().id);
      if (disposed || seq !== reads) return;
      staged = fresh;
    } catch {
      return;
    }
    draw();
  };

  container.addEventListener("click", (event) => {
    const button = event.target.closest("[data-staged]");
    if (!button || !staged) return;
    switch (button.dataset.staged) {
      case "diff":
        void openDiff(staged).then((next) => next && applyStaged(box()));
        break;
      case "apply":
        void withBusy(button, () => applyStaged(box()));
        break;
      case "discard":
        void discardStaged(box());
        break;
    }
  });

  const off = onStaged(
    () => box().boxId,
    (next) => {
      reads += 1;
      staged = next;
      draw();
    },
  );
  draw();
  void read();

  return {
    onBoxChange() {
      if (disposed || box().revision === revision) return;
      revision = box().revision;
      void read();
    },
    dispose() {
      disposed = true;
      off();
    },
  };
}
