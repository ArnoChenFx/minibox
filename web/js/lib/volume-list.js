/**
 * The volumes table's search fields and groups. Pure apart from the saved group-by choice: the functions return keys and
 * names, and the page translates the labels. A group id names its group uniquely, so the page can remember which groups
 * it collapsed.
 */

export const GROUP_BY = ["none", "box", "role", "pool", "ownership"];

/** The label key of each choice in the group-by select. */
export const GROUP_LABELS = {
  none: "vol.groupNone",
  box: "vol.groupBox",
  role: "vol.groupRole",
  pool: "vol.groupPool",
  ownership: "vol.groupOwnership",
};

const STORAGE_KEY = "minibox.volumeGroupBy";
/** Role groups in display order. `null` is the group of volumes that have no role. */
const ROLE_ORDER = ["workspace", "home", "tools", "cache", null];
const OWNERSHIP_ORDER = ["owned", "independent"];

/** The owner box's name: from the box list when it names the box, otherwise from a mount of that box. */
export function ownerBoxName(volume, boxNames) {
  if (!volume.ownerBoxId) return null;
  const mounted = volume.mounts.find((mount) => mount.boxId === volume.ownerBoxId);
  return boxNames.get(volume.ownerBoxId) ?? mounted?.boxName ?? null;
}

/** The strings a volume is searched by: its names and id, role, pool, owner box, and each mount as box:path. */
export function volumeSearchFields(volume, { boxNames, roleLabel }) {
  return [
    volume.name,
    volume.id,
    volume.engineName,
    volume.role,
    volume.role && roleLabel(volume.role),
    volume.pool,
    volume.backend,
    ownerBoxName(volume, boxNames),
    ...volume.mounts.map((mount) => `${mount.boxName}:${mount.path}`),
  ];
}

/** The group of one volume. An owned volume groups under its owner, any other under the first box that mounts it. */
function groupOf(volume, groupBy, boxNames) {
  if (groupBy === "box") {
    if (volume.ownerBoxId) {
      return { id: `box:${volume.ownerBoxId}`, kind: "box", name: ownerBoxName(volume, boxNames) ?? volume.ownerBoxId };
    }
    const [mount] = volume.mounts.toSorted((a, b) => a.boxName.localeCompare(b.boxName));
    if (mount) return { id: `box:${mount.boxId}`, kind: "box", name: mount.boxName };
    return { id: "unattached", kind: "unattached", name: null };
  }
  if (groupBy === "role") {
    if (volume.role) return { id: `role:${volume.role}`, kind: "role", name: volume.role };
    return { id: "role:other", kind: "other", name: null };
  }
  if (groupBy === "pool") return { id: `pool:${volume.pool}`, kind: "pool", name: volume.pool };
  return { id: `ownership:${volume.ownership}`, kind: volume.ownership, name: null };
}

function orderGroups(groups, groupBy) {
  if (groupBy === "role") return groups.toSorted((a, b) => ROLE_ORDER.indexOf(a.name) - ROLE_ORDER.indexOf(b.name));
  if (groupBy === "ownership") {
    return groups.toSorted((a, b) => OWNERSHIP_ORDER.indexOf(a.kind) - OWNERSHIP_ORDER.indexOf(b.kind));
  }
  return groups.toSorted(
    (a, b) =>
      Number(a.kind === "unattached") - Number(b.kind === "unattached") || (a.name ?? "").localeCompare(b.name ?? ""),
  );
}

/**
 * The groups of `volumes` under `groupBy`, each holding its rows sorted by name. `none` is one group, which the page draws
 * without a header. Box and pool groups are sorted by name, role and ownership groups keep a fixed order, and under the
 * box grouping the volumes that no box mounts come last.
 */
export function groupVolumes(volumes, groupBy, { boxNames }) {
  const mode = GROUP_BY.includes(groupBy) ? groupBy : "none";
  const sorted = volumes.toSorted((a, b) => a.name.localeCompare(b.name));
  if (mode === "none") return sorted.length ? [{ id: "all", kind: "all", name: null, rows: sorted }] : [];
  const groups = new Map();
  for (const volume of sorted) {
    const group = groupOf(volume, mode, boxNames);
    if (!groups.has(group.id)) groups.set(group.id, { ...group, rows: [] });
    groups.get(group.id).rows.push(volume);
  }
  return orderGroups([...groups.values()], mode);
}

/** The group-by choice saved in this browser, or `none` when nothing valid is saved or storage is unavailable. */
export function loadGroupBy() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return GROUP_BY.includes(saved) ? saved : "none";
  } catch {
    return "none";
  }
}

export function saveGroupBy(groupBy) {
  try {
    localStorage.setItem(STORAGE_KEY, groupBy);
  } catch {
    // Storage can be disabled. The page still keeps the choice for this visit.
  }
}
