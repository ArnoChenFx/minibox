import { api } from "../lib/api.js";
import { copyText, esc } from "../lib/dom.js";
import { sendFile } from "../lib/file-transfer.js";
import {
  absolutePath,
  baseOf,
  childrenOf,
  clashesOf,
  contentUrl,
  crumbsOf,
  deleteUrl,
  downloadUrl,
  joinPath,
  listUrl,
  mkdirUrl,
  moveUrl,
  nameProblem,
  parentOf,
  pickRoot,
  previewable,
  rootsOf,
  sortEntries,
  uploadUrl,
  visibleEntries,
} from "../lib/files.js";
import { bytes, dateTime } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { confirmDialog, emptyState, openDialog, promptDialog, skeletonRows, toast, toastError } from "../lib/ui.js";
import { bindSearchBox, searchBoxHtml } from "./search-box.js";

const ROLE_LABEL = {
  workspace: "vol.roleWorkspace",
  home: "vol.roleHome",
  tools: "vol.roleTools",
  cache: "vol.roleCache",
};

const TYPE_ICON = { dir: "folder", file: "file", symlink: "link", other: "file" };
/** How many names the replace prompt lists. The rest are counted, so a large upload cannot fill the dialog. */
const SHOWN_NAMES = 8;

/** A root in the volume picker: its mount path, then the role of its volume, or the volume's name for a custom one. */
function rootLabel(root) {
  const name = ROLE_LABEL[root.role] ? t(ROLE_LABEL[root.role]) : (root.volumeName ?? root.volumeId);
  return `${root.path} · ${name}${root.mode === "ro" ? ` · ${t("vol.modeRo")}` : ""}`;
}

function shellHtml() {
  return `<div class="card fb" id="fbCard">
    <div class="card-head with-tools">
      <h3>${esc(t("fl.title"))}</h3>
      <div class="list-tools">
        ${searchBoxHtml({ id: "fbSearch", placeholder: t("fl.searchPlaceholder"), label: t("fl.search") })}
        <button type="button" class="btn btn-sm" data-fb="upload-files">${icon("upload")}${esc(t("fl.upload"))}</button>
        <button type="button" class="btn btn-sm" data-fb="upload-folder">${icon("upload")}${esc(t("fl.uploadFolder"))}</button>
        <button type="button" class="btn btn-sm" data-fb="new-folder">${icon("folderPlus")}${esc(t("fl.newFolder"))}</button>
        <button type="button" class="btn btn-sm" data-fb="refresh">${icon("refresh")}${esc(t("common.refresh"))}</button>
      </div>
    </div>
    <div class="card-body fb-intro"><p class="help">${esc(t("fl.help"))}</p></div>
    <div class="fb-toolbar">
      <div id="fbRoot"></div>
      <nav class="fb-crumbs" id="fbCrumbs" aria-label="${esc(t("fl.location"))}"></nav>
      <label class="checkbox fb-hidden"><input type="checkbox" id="fbHidden" checked /> <span>${esc(t("fl.showHidden"))}</span></label>
    </div>
    <div id="fbUploads"></div>
    <div class="table-wrap" id="fbBody"></div>
    <input class="sr-only" type="file" multiple id="fbPickFiles" tabindex="-1" aria-hidden="true" />
    <input class="sr-only" type="file" multiple webkitdirectory id="fbPickFolder" tabindex="-1" aria-hidden="true" />
  </div>`;
}

function sortHead(sort) {
  const column = (key, label, cls) => {
    const active = sort.key === key;
    const aria = active ? (sort.descending ? "descending" : "ascending") : "none";
    const arrow = active ? icon("chevron", `fb-arrow${sort.descending ? "" : " is-up"}`) : "";
    return `<th class="${cls}" aria-sort="${aria}"><button type="button" class="fb-sort" data-fb="sort" data-key="${key}">${esc(label)}${arrow}</button></th>`;
  };
  return `<thead><tr>${column("name", t("fl.colName"), "fb-col-name")}${column("size", t("fl.colSize"), "num fb-col-size")}${column("modified", t("fl.colModified"), "fb-col-modified")}<th class="fb-col-actions"><span class="sr-only">${esc(t("fl.colActions"))}</span></th></tr></thead>`;
}

const iconButton = (action, path, label, iconName, tone = "") =>
  `<button type="button" class="icon-btn${tone}" data-fb="${action}" data-path="${esc(path)}" title="${esc(label)}" aria-label="${esc(label)}">${icon(iconName)}</button>`;

/** One row of the listing. Folders open on a click and text files preview; every row can be renamed or removed. */
export function rowHtml(entry, volumeId) {
  const path = esc(entry.path);
  const glyph = icon(TYPE_ICON[entry.type] ?? "file", entry.type === "dir" ? "fb-type is-dir" : "fb-type");
  const label = `<span>${esc(entry.name)}</span>`;
  let name;
  if (entry.type === "dir") {
    name = `<button type="button" class="fb-name" data-fb="open" data-path="${path}">${glyph}${label}</button>`;
  } else if (previewable(entry)) {
    name = `<button type="button" class="fb-name" data-fb="preview" data-path="${path}">${glyph}${label}</button>`;
  } else {
    const note = entry.type === "symlink" ? ` title="${esc(t("fl.linkNote"))}"` : "";
    name = `<span class="fb-name"${note}>${glyph}${label}</span>`;
  }
  const download =
    entry.type === "file" || entry.type === "dir"
      ? `<a class="icon-btn" href="${esc(downloadUrl(volumeId, entry.path))}" title="${esc(entry.type === "dir" ? t("fl.downloadFolder") : t("fl.download"))}" aria-label="${esc(entry.type === "dir" ? t("fl.downloadFolder") : t("fl.download"))}">${icon("download")}</a>`
      : "";
  const preview = previewable(entry) ? iconButton("preview", entry.path, t("fl.preview"), "eye") : "";
  // The path a person would type in the box's terminal, so a copied one can be pasted there as it is.
  const copy = iconButton("copy-path", entry.path, t("fl.copyPath"), "copy");
  return `<tr>
    <td class="fb-col-name">${name}</td>
    <td class="num fb-col-size">${esc(entry.type === "file" ? bytes(entry.size) : "—")}</td>
    <td class="fb-col-modified">${esc(entry.mtime ? dateTime(entry.mtime) : "—")}</td>
    <td class="fb-col-actions"><div class="fb-actions">${preview}${copy}${download}${iconButton("rename", entry.path, t("fl.rename"), "pencil")}${iconButton("delete", entry.path, t("fl.delete"), "trash", " danger")}</div></td>
  </tr>`;
}

export function listingHtml(entries, { volumeId, sort }) {
  return `<table class="table fb-table">${sortHead(sort)}<tbody>${entries.map((entry) => rowHtml(entry, volumeId)).join("")}</tbody></table>`;
}

const problemOf = (name) => {
  const key = nameProblem(name);
  return key ? t(key) : "";
};

async function namesIn(volumeId, folder) {
  try {
    const reply = await api(listUrl(volumeId, folder));
    return new Set(childrenOf(reply.entries, folder).map((entry) => entry.name));
  } catch {
    return new Set();
  }
}

/** One prompt for the names an upload would replace: replace them, skip them, or cancel the whole upload. */
function askReplace(paths) {
  return new Promise((resolve) => {
    let choice = null;
    const listed = paths
      .slice(0, SHOWN_NAMES)
      .map((path) => `<li class="mono">${esc(baseOf(path))}</li>`)
      .join("");
    const more =
      paths.length > SHOWN_NAMES
        ? `<li class="subtle">${esc(t("fl.conflictMore", { n: paths.length - SHOWN_NAMES }))}</li>`
        : "";
    const { root, close } = openDialog({
      title: t("fl.conflictTitle"),
      description: esc(t("fl.conflictText")),
      iconName: "alert",
      body: `<ul class="fb-names">${listed}${more}</ul>`,
      footer: `<button class="btn" data-close type="button">${esc(t("common.cancel"))}</button><button class="btn" type="button" id="fbSkip">${esc(t("fl.conflictSkip"))}</button><button class="btn btn-danger" type="button" id="fbReplace">${esc(t("fl.conflictReplace"))}</button>`,
      onClose: () => resolve(choice),
    });
    root.querySelector("#fbSkip").addEventListener("click", () => {
      choice = "skip";
      close();
    });
    root.querySelector("#fbReplace").addEventListener("click", () => {
      choice = "replace";
      close();
    });
  });
}

const readBatch = (reader) => new Promise((resolve, reject) => reader.readEntries(resolve, reject));

const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");

/**
 * The upload items of a drop: each file with its path below the folder it was dropped on, and each folder, so an empty
 * one is still created. The entries are read at once, while the drop event still holds them.
 */
async function droppedItems(dataTransfer) {
  const entries = [...(dataTransfer.items ?? [])].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length === 0) return [...dataTransfer.files].map((file) => ({ relative: file.name, file }));
  const items = [];
  const walk = async (entry, prefix) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      items.push({ relative, file });
      return;
    }
    items.push({ relative, dir: true });
    const reader = entry.createReader();
    let batch = await readBatch(reader);
    while (batch.length > 0) {
      for (const child of batch) await walk(child, relative);
      batch = await readBatch(reader);
    }
  };
  for (const entry of entries) await walk(entry, "");
  return items;
}

/**
 * Mounts the file browser of one box: the volumes it mounts, a listing of the folder shown, uploads with progress and
 * cancel, and the actions on each entry. Works while the box is stopped, because the files API reads the volumes
 * through a helper. Returns the cleanup that the page calls when the tab closes.
 */
export function mountFiles(root, { box, onChange }) {
  const view = {
    disposed: false,
    roots: [],
    rootsKey: "",
    rootPath: null,
    dir: "",
    entries: [],
    truncated: false,
    error: null,
    loading: false,
    sort: { key: "name", descending: false },
    showHidden: true,
    query: "",
    seq: 0,
    upload: null,
    dragging: 0,
  };

  root.innerHTML = shellHtml();
  const card = root.querySelector("#fbCard");
  const search = bindSearchBox(root.querySelector("#fbSearch"), (text) => {
    view.query = text;
    paintBody();
  });

  const current = () => view.roots.find((item) => item.path === view.rootPath) ?? null;

  const refreshRoots = () => {
    const roots = rootsOf(box().mounts ?? []);
    const key = JSON.stringify(roots);
    if (key === view.rootsKey) return false;
    view.rootsKey = key;
    view.roots = roots;
    if (!roots.some((item) => item.path === view.rootPath)) {
      view.rootPath = pickRoot(roots, null)?.path ?? null;
      view.dir = "";
    }
    return true;
  };

  const paintRoot = () => {
    const host = root.querySelector("#fbRoot");
    if (view.roots.length === 0) {
      host.innerHTML = "";
      return;
    }
    const options = view.roots
      .map(
        (item) =>
          `<option value="${esc(item.path)}"${item.path === view.rootPath ? " selected" : ""}>${esc(rootLabel(item))}</option>`,
      )
      .join("");
    host.innerHTML = `<select class="select fb-root-select" id="fbRootSelect" aria-label="${esc(t("fl.root"))}">${options}</select>`;
  };

  const paintCrumbs = () => {
    const parts = crumbsOf(view.dir);
    const start = `<li><button type="button" class="fb-crumb" data-fb="crumb" data-dir=""${parts.length === 0 ? ' aria-current="page"' : ""}>${esc(view.rootPath ?? "/")}</button></li>`;
    const rest = parts.map((part, index) => {
      const last = index === parts.length - 1;
      const link = last
        ? `<span class="fb-crumb" aria-current="page">${esc(part.name)}</span>`
        : `<button type="button" class="fb-crumb" data-fb="crumb" data-dir="${esc(part.path)}">${esc(part.name)}</button>`;
      return `<li><span class="fb-sep" aria-hidden="true">${icon("chevronRight")}</span>${link}</li>`;
    });
    root.querySelector("#fbCrumbs").innerHTML = `<ol>${start}${rest.join("")}</ol>`;
  };

  const paintBody = () => {
    const host = root.querySelector("#fbBody");
    if (view.roots.length === 0) {
      host.innerHTML = emptyState({ iconName: "box", title: t("fl.noVolumes"), text: esc(t("fl.noVolumesText")) });
      return;
    }
    if (view.error) {
      host.innerHTML = emptyState({
        iconName: "alert",
        title: t("fl.loadFailed"),
        text: esc(view.error.message),
        action: `<button type="button" class="btn btn-sm" data-fb="up-to-root">${icon("arrowLeft")}${esc(t("fl.toRoot"))}</button>`,
      });
      return;
    }
    if (view.loading) {
      host.innerHTML = `<table class="table fb-table">${sortHead(view.sort)}<tbody>${skeletonRows(4, 4)}</tbody></table>`;
      return;
    }
    if (view.entries.length === 0) {
      host.innerHTML = emptyState({ iconName: "folder", title: t("fl.empty"), text: esc(t("fl.emptyText")) });
      return;
    }
    const visible = visibleEntries(view.entries, { query: view.query, showHidden: view.showHidden });
    if (visible.length === 0) {
      host.innerHTML = view.query
        ? emptyState({
            iconName: "search",
            title: t("fl.noMatch"),
            text: esc(t("fl.noMatchText", { q: view.query })),
            action: `<button type="button" class="btn btn-sm" data-fb="clear-filter">${esc(t("common.clearSearch"))}</button>`,
          })
        : emptyState({ iconName: "eyeOff", title: t("fl.onlyHidden"), text: esc(t("fl.onlyHiddenText")) });
      return;
    }
    const note = view.truncated ? `<p class="help fb-note">${esc(t("fl.truncated"))}</p>` : "";
    host.innerHTML =
      listingHtml(sortEntries(visible, view.sort), { volumeId: current()?.volumeId ?? "", sort: view.sort }) + note;
  };

  const paintUploads = () => {
    const host = root.querySelector("#fbUploads");
    if (!view.upload) {
      host.innerHTML = "";
      return;
    }
    host.innerHTML = `<div class="fb-upload" role="status" aria-live="polite">
      <div class="fb-upload-head"><strong>${esc(t("fl.uploading"))}</strong><span class="subtle" data-fb-count></span>
        <button type="button" class="btn btn-sm" data-fb="cancel-upload">${icon("x")}${esc(t("fl.cancelUpload"))}</button></div>
      <div class="bar"><span data-fb-bar style="width:0%"></span></div>
      <div class="fb-upload-line help"><span data-fb-name></span><span class="fb-upload-bytes" data-fb-bytes></span></div>
    </div>`;
    updateUploads();
  };

  /** Moves the bar and its numbers only, so the cancel button keeps its focus while the bytes go. */
  const updateUploads = () => {
    const upload = view.upload;
    const host = root.querySelector("#fbUploads");
    if (!upload || !host.querySelector(".fb-upload")) return;
    const sent = upload.sent + upload.loaded;
    const percent = upload.total > 0 ? Math.min(100, (sent / upload.total) * 100) : 100;
    host.querySelector("[data-fb-bar]").style.width = `${percent}%`;
    host.querySelector("[data-fb-count]").textContent = t("fl.uploadCount", {
      done: Math.min(upload.index + 1, upload.count),
      total: upload.count,
    });
    host.querySelector("[data-fb-name]").textContent = upload.name;
    host.querySelector("[data-fb-bytes]").textContent = t("fl.uploadBytes", {
      loaded: bytes(sent),
      total: bytes(upload.total),
    });
  };

  const paintAll = () => {
    paintRoot();
    paintCrumbs();
    paintBody();
    paintUploads();
  };

  const load = async () => {
    const volume = current();
    const token = ++view.seq;
    if (!volume) {
      view.entries = [];
      view.error = null;
      paintBody();
      return;
    }
    view.loading = true;
    view.error = null;
    paintBody();
    try {
      const reply = await api(listUrl(volume.volumeId, view.dir));
      if (view.disposed || token !== view.seq) return;
      view.entries = childrenOf(reply.entries, view.dir);
      view.truncated = Boolean(reply.truncated);
    } catch (err) {
      if (view.disposed || token !== view.seq) return;
      view.entries = [];
      view.truncated = false;
      view.error = err;
    }
    view.loading = false;
    paintBody();
  };

  const go = (dir) => {
    view.dir = dir;
    paintCrumbs();
    return load();
  };

  const setRoot = (path) => {
    view.rootPath = path;
    view.dir = "";
    paintCrumbs();
    return load();
  };

  const setSort = (key) => {
    view.sort = key === view.sort.key ? { key, descending: !view.sort.descending } : { key, descending: false };
    paintBody();
    root.querySelector(`[data-fb="sort"][data-key="${key}"]`)?.focus();
  };

  const cancelUpload = () => {
    if (!view.upload) return;
    view.upload.cancelled = true;
    view.upload.abort?.();
  };

  const reloadIfHere = (volumeId, rootPath, dir) => {
    if (view.disposed || current()?.volumeId !== volumeId || view.rootPath !== rootPath || view.dir !== dir) return;
    void load();
  };

  const uploadItems = async (items) => {
    const volume = current();
    if (!volume) return;
    if (view.upload) {
      toast(t("fl.uploadBusy"), { type: "info" });
      return;
    }
    const { volumeId, path: rootPath } = volume;
    const dir = view.dir;
    const folders = items.filter((item) => item.dir).map((item) => joinPath(dir, item.relative));
    const plans = items
      .filter((item) => item.file)
      .map((item) => ({ path: joinPath(dir, item.relative), relative: item.relative, file: item.file }));
    if (plans.length === 0 && folders.length === 0) return;

    const folderNames = await Promise.all(
      [...new Set(plans.map((plan) => parentOf(plan.path)))].map(async (folder) => [
        folder,
        await namesIn(volumeId, folder),
      ]),
    );
    const clashes = clashesOf(plans, new Map(folderNames));
    let replace = false;
    if (clashes.length > 0) {
      const choice = await askReplace(clashes.map((plan) => plan.path));
      if (choice === null) return;
      replace = choice === "replace";
    }
    const replaced = new Set(replace ? clashes : []);
    const queue = replace ? plans : plans.filter((plan) => !clashes.includes(plan));

    const upload = {
      total: queue.reduce((sum, plan) => sum + plan.file.size, 0),
      sent: 0,
      loaded: 0,
      index: 0,
      count: queue.length,
      name: "",
      cancelled: false,
      abort: null,
    };
    view.upload = upload;
    paintUploads();

    const failures = [];
    let uploaded = 0;
    for (const folder of folders) {
      if (upload.cancelled) break;
      try {
        await api(mkdirUrl(volumeId), { method: "POST", body: { path: folder } });
      } catch (err) {
        failures.push(err);
      }
    }
    for (const [index, plan] of queue.entries()) {
      if (upload.cancelled) break;
      upload.index = index;
      upload.name = plan.relative;
      upload.loaded = 0;
      updateUploads();
      const sender = sendFile(uploadUrl(volumeId, plan.path, replaced.has(plan)), plan.file, {
        onProgress: (loaded) => {
          upload.loaded = loaded;
          updateUploads();
        },
      });
      upload.abort = sender.abort;
      try {
        await sender.done;
        uploaded += 1;
      } catch (err) {
        if (err.name !== "AbortError") failures.push(err);
      }
      upload.sent += plan.file.size;
      upload.loaded = 0;
      upload.abort = null;
    }

    view.upload = null;
    paintUploads();
    if (uploaded > 0) toast(uploaded === 1 ? t("fl.uploadedOne") : t("fl.uploaded", { n: uploaded }));
    if (upload.cancelled) toast(t("fl.uploadCancelled"), { type: "info" });
    if (failures.length > 0) {
      toastError(t("fl.uploadFailed", { n: failures.length }), { message: failures[0].message });
    }
    if (uploaded > 0 || failures.length > 0) reloadIfHere(volumeId, rootPath, dir);
    if (clashes.length > 0 && !replace) toast(t("fl.skippedExisting", { n: clashes.length }), { type: "info" });
  };

  const newFolder = async () => {
    const volume = current();
    if (!volume) return;
    const name = await promptDialog({
      title: t("fl.newFolderTitle"),
      label: t("fl.newFolderLabel"),
      confirmText: t("fl.newFolder"),
      iconName: "folderPlus",
      validate: problemOf,
    });
    if (name === null) return;
    try {
      await api(mkdirUrl(volume.volumeId), { method: "POST", body: { path: joinPath(view.dir, name) } });
      toast(t("fl.created"), { message: name });
      await load();
    } catch (err) {
      toastError(t("fl.newFolderFailed"), err);
    }
  };

  const rename = async (path) => {
    const volume = current();
    if (!volume) return;
    const name = baseOf(path);
    const next = await promptDialog({
      title: t("fl.renameTitle", { name }),
      label: t("fl.renameLabel"),
      value: name,
      confirmText: t("fl.rename"),
      iconName: "pencil",
      validate: problemOf,
    });
    if (next === null || next === name) return;
    try {
      await api(moveUrl(volume.volumeId), { method: "POST", body: { from: path, to: joinPath(parentOf(path), next) } });
      toast(t("fl.renamed"), { message: next });
      await load();
    } catch (err) {
      toastError(t("fl.renameFailed"), err);
    }
  };

  /** The server describes a removal first and removes nothing until the same request comes back with confirm. */
  const remove = async (path) => {
    const volume = current();
    if (!volume) return;
    const name = baseOf(path);
    let preview;
    try {
      await api(deleteUrl(volume.volumeId, path, false), { method: "DELETE" });
      await load();
      return;
    } catch (err) {
      if (err.code !== "confirmation_required") {
        toastError(t("fl.deleteFailed"), err);
        return;
      }
      preview = err.details?.preview;
    }
    const folder = preview?.type === "dir";
    const agreed = await confirmDialog({
      title: t("fl.deleteTitle", { name }),
      message: esc(folder ? t("fl.deleteFolder") : t("fl.deleteFile")),
      confirmText: t("fl.deleteConfirm"),
      danger: true,
    });
    if (!agreed) return;
    try {
      await api(deleteUrl(volume.volumeId, path, true), { method: "DELETE" });
      toast(t("fl.deleted"), { message: name });
      await load();
    } catch (err) {
      toastError(t("fl.deleteFailed"), err);
    }
  };

  const preview = (path) => {
    const volume = current();
    if (!volume) return;
    const { root: dialog } = openDialog({
      title: baseOf(path),
      description: esc(path),
      iconName: "file",
      wide: true,
      body: `<div class="fb-preview"><span class="spinner"></span> ${esc(t("common.loading"))}</div>`,
      footer: `<a class="btn" href="${esc(downloadUrl(volume.volumeId, path))}">${icon("download")}${esc(t("fl.download"))}</a><button class="btn btn-primary" data-close type="button">${esc(t("common.close"))}</button>`,
    });
    const slot = dialog.querySelector(".fb-preview");
    api(contentUrl(volume.volumeId, path))
      .then((reply) => {
        slot.innerHTML = `<pre class="fb-code" tabindex="0">${esc(reply.content)}</pre>${reply.truncated ? `<p class="help fb-note">${esc(t("fl.previewTruncated"))}</p>` : ""}`;
      })
      .catch((err) => {
        slot.innerHTML = `<p class="help">${esc(err.key === "file_not_text" ? t("fl.notText") : err.message)}</p>`;
      });
  };

  const pick = (id) => root.querySelector(`#${id}`).click();

  /**
   * Copies a row's path as the box sees it, which is the volume's mount path plus the path inside it, so it can be
   * pasted straight into the box's terminal. The row's own path is relative to the volume, so a volume mounted at
   * `/workspace` shows `src/main.ts` and copies `/workspace/src/main.ts`.
   */
  const copyPath = async (path) => {
    const volume = current();
    if (!volume) return;
    const full = absolutePath(volume.path, path);
    try {
      await copyText(full);
      toast(t("fl.pathCopied"), { message: full });
    } catch (err) {
      toastError(t("fl.pathCopyFailed"), err);
    }
  };

  const actions = {
    "copy-path": (el) => void copyPath(el.dataset.path ?? ""),
    "upload-files": () => pick("fbPickFiles"),
    "upload-folder": () => pick("fbPickFolder"),
    "new-folder": () => void newFolder(),
    refresh: () => void load(),
    "clear-filter": () => search.clear(),
    "up-to-root": () => void go(""),
    crumb: (el) => void go(el.dataset.dir ?? ""),
    open: (el) => void go(el.dataset.path ?? ""),
    preview: (el) => preview(el.dataset.path ?? ""),
    rename: (el) => void rename(el.dataset.path ?? ""),
    delete: (el) => void remove(el.dataset.path ?? ""),
    sort: (el) => setSort(el.dataset.key),
    "cancel-upload": () => cancelUpload(),
  };

  const onClick = (event) => {
    const target = event.target.closest("[data-fb]");
    const run = target && actions[target.dataset.fb];
    if (!run || !root.contains(target)) return;
    event.preventDefault();
    run(target);
  };

  const onPicked = (event) => {
    const input = event.target;
    const files = [...(input.files ?? [])];
    input.value = "";
    if (files.length === 0) return;
    void uploadItems(files.map((file) => ({ relative: file.webkitRelativePath || file.name, file })));
  };

  const onFieldChange = (event) => {
    const target = event.target;
    if (target.id === "fbRootSelect") void setRoot(target.value);
    else if (target.id === "fbHidden") {
      view.showHidden = target.checked;
      paintBody();
    } else if (target.id === "fbPickFiles" || target.id === "fbPickFolder") onPicked(event);
  };

  const onDragEnter = (event) => {
    if (!hasFiles(event) || view.roots.length === 0) return;
    event.preventDefault();
    view.dragging += 1;
    card.classList.add("is-dropping");
  };
  const onDragOver = (event) => {
    if (!hasFiles(event) || view.roots.length === 0) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = (event) => {
    if (!hasFiles(event)) return;
    view.dragging = Math.max(0, view.dragging - 1);
    if (view.dragging === 0) card.classList.remove("is-dropping");
  };
  const onDrop = (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    view.dragging = 0;
    card.classList.remove("is-dropping");
    if (view.roots.length === 0) return;
    void droppedItems(event.dataTransfer).then(uploadItems);
  };

  root.addEventListener("click", onClick);
  root.addEventListener("change", onFieldChange);
  root.addEventListener("dragenter", onDragEnter);
  root.addEventListener("dragover", onDragOver);
  root.addEventListener("dragleave", onDragLeave);
  root.addEventListener("drop", onDrop);

  const targetKey = () => `${view.rootPath}\n${current()?.volumeId ?? ""}`;
  const offBox = onChange(() => {
    if (view.disposed) return;
    const before = targetKey();
    if (!refreshRoots()) return;
    paintRoot();
    if (targetKey() === before) return;
    paintCrumbs();
    void load();
  });

  refreshRoots();
  paintAll();
  void load();

  return () => {
    view.disposed = true;
    cancelUpload();
    offBox();
    root.removeEventListener("click", onClick);
    root.removeEventListener("change", onFieldChange);
    root.removeEventListener("dragenter", onDragEnter);
    root.removeEventListener("dragover", onDragOver);
    root.removeEventListener("dragleave", onDragLeave);
    root.removeEventListener("drop", onDrop);
  };
}
