/**
 * The rules of the box file browser, kept apart from the DOM so they can be tested without a browser. Paths are the files
 * API's: relative to the volume root, with no leading or trailing slash, and "" for the root itself. The listing names
 * the root "/", so `childrenOf` takes the folder's children from it.
 */

/** A text preview reads at most this many bytes. A larger file is offered as a download only. */
export const PREVIEW_MAX_BYTES = 256 * 1024;
/** The most entries one folder listing asks for. The API caps a listing at the same number. */
export const LISTING_LIMIT = 2000;
/** The longest name a file system takes, in bytes. */
export const NAME_MAX_BYTES = 255;

export function joinPath(dir, name) {
  return dir === "" ? name : `${dir}/${name}`;
}

export function parentOf(path) {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

export function baseOf(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The folders on the way to `dir`, each with its own path, for the breadcrumbs. */
export function crumbsOf(dir) {
  const parts = dir === "" ? [] : dir.split("/");
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join("/") }));
}

/** The direct children of `dir`, from a listing that holds the folder and everything under it to one level. */
export function childrenOf(entries, dir) {
  return entries
    .filter((entry) => entry.path !== "/" && parentOf(entry.path) === dir)
    .map((entry) => ({ ...entry, name: baseOf(entry.path) }));
}

/** The mounts that hold a volume, which are the roots a person can browse. A mount without one has nothing to show. */
export function rootsOf(mounts) {
  return mounts
    .filter((mount) => mount.volumeId)
    .map(({ path, volumeId, volumeName, role, mode }) => ({ path, volumeId, volumeName, role, mode }));
}

/** The root to show: the one asked for when the box still has it, else the workspace, else the first. */
export function pickRoot(roots, path) {
  return (
    roots.find((root) => root.path === path) ?? roots.find((root) => root.role === "workspace") ?? roots[0] ?? null
  );
}

/** The entries a person sees: hidden names are left out unless asked for, and the filter keeps names that contain it. */
export function visibleEntries(children, { query = "", showHidden = false } = {}) {
  const needle = query.trim().toLocaleLowerCase();
  return children.filter(
    (entry) =>
      (showHidden || !entry.name.startsWith(".")) && (needle === "" || entry.name.toLocaleLowerCase().includes(needle)),
  );
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const COMPARE = {
  name: (a, b) => collator.compare(a.name, b.name),
  size: (a, b) => (a.size ?? 0) - (b.size ?? 0),
  modified: (a, b) => (Date.parse(a.mtime ?? "") || 0) - (Date.parse(b.mtime ?? "") || 0),
};

const folderFirst = (entry) => (entry.type === "dir" ? 0 : 1);

/** Folders come first, whatever the key. Entries that tie on the key are ordered by name. */
export function sortEntries(entries, { key = "name", descending = false } = {}) {
  const compare = COMPARE[key] ?? COMPARE.name;
  const direction = descending ? -1 : 1;
  return entries.toSorted(
    (a, b) => folderFirst(a) - folderFirst(b) || direction * compare(a, b) || collator.compare(a.name, b.name),
  );
}

/**
 * Why a name cannot be used for a new folder or a rename, as a key of the UI dictionary, or "" when it can. The name is
 * already trimmed. A slash would name a folder inside the one shown, and a control character cannot be typed anyway.
 */
export function nameProblem(name) {
  if (name === "") return "fl.nameRequired";
  if (name === "." || name === "..") return "fl.nameReserved";
  if (name.includes("/") || [...name].some((char) => char.codePointAt(0) < 0x20 || char === "\u007f")) {
    return "fl.nameCharacters";
  }
  if (new TextEncoder().encode(name).length > NAME_MAX_BYTES) return "fl.nameLong";
  return "";
}

/**
 * Which planned uploads would replace a file that is already there. `plans` carry the `path` each file is written to.
 * `namesIn` maps a folder path to the names already in it. A folder that is not listed yet holds nothing.
 */
export function clashesOf(plans, namesIn) {
  return plans.filter((plan) => namesIn.get(parentOf(plan.path))?.has(baseOf(plan.path)) ?? false);
}

/** Whether a text preview may open this entry: a regular file no larger than the preview limit. */
export function previewable(entry) {
  return entry.type === "file" && entry.size !== null && entry.size <= PREVIEW_MAX_BYTES;
}

const filesOf = (volumeId) => `/api/volumes/${encodeURIComponent(volumeId)}/files`;
const withPath = (path) => `path=${encodeURIComponent(path)}`;

/** One folder, one level deep: its children, and the folder itself. */
export function listUrl(volumeId, dir) {
  const path = dir === "" ? "" : `${withPath(dir)}&`;
  return `${filesOf(volumeId)}?${path}maxDepth=1&limit=${LISTING_LIMIT}`;
}

export const contentUrl = (volumeId, path) => `${filesOf(volumeId)}/content?${withPath(path)}&encoding=utf-8`;

/** A file's bytes, or a folder as a gzip tar. The server names the download, so the link needs no name. */
export const downloadUrl = (volumeId, path) => `${filesOf(volumeId)}/stream?${withPath(path)}`;

export const uploadUrl = (volumeId, path, overwrite) =>
  `${filesOf(volumeId)}/stream?${withPath(path)}&overwrite=${overwrite ? "true" : "false"}`;

/** Without `confirm` the server only describes the removal; with it the removal happens. */
export const deleteUrl = (volumeId, path, confirm = false) =>
  `${filesOf(volumeId)}?${withPath(path)}${confirm ? "&confirm=true" : ""}`;

export const mkdirUrl = (volumeId) => `${filesOf(volumeId)}/directory`;

export const moveUrl = (volumeId) => `${filesOf(volumeId)}/move`;
