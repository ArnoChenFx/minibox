/** Mount-list helpers for the create and rebuild dialogs. No DOM and no imports, so the tests load them directly. */

/** Most mounts one box takes. Mirrors `MOUNT_MAX` in src/operations/validation.ts. */
export const MOUNT_MAX = 16;

/** The mounts a box gets when a create names none. Mirrors `ROLE_MOUNT` in src/volumes/types.ts. */
export const DEFAULT_MOUNTS = [
  { role: "workspace", path: "/workspace", mode: "rw" },
  { role: "home", path: "/home/dev", mode: "rw" },
  { role: "tools", path: "/opt/minibox/tools", mode: "ro" },
  { role: "cache", path: "/home/dev/.cache", mode: "rw" },
];

/**
 * The value a create row holds for a role whose volume MiniBox creates for this box. The server reads the same entry as
 * `{ role }`, and takes the role's own path and mode, which the row shows and does not let you change.
 */
export const ROLE_PREFIX = "role:";

/** The role a row would create, or null when the row mounts a volume that already exists. */
export function roleOfValue(value) {
  if (typeof value !== "string" || !value.startsWith(ROLE_PREFIX)) return null;
  const role = value.slice(ROLE_PREFIX.length);
  return DEFAULT_MOUNTS.some((mount) => mount.role === role) ? role : null;
}

/** The value a row holds to create `role`. */
export function roleValue(role) {
  return `${ROLE_PREFIX}${role}`;
}

/** The role mount `role` describes, as the default list holds it. Null for a name that is not a role. */
export function roleMount(role) {
  return DEFAULT_MOUNTS.find((mount) => mount.role === role) ?? null;
}

/**
 * The choices a create row offers: one per role, which MiniBox creates for the box, then the volumes that exist. The
 * tools role mounts the host's shared tools volume when there is one, so its label says so, and its own volume when
 * there is none.
 */
export function createMountChoices(volumes, sharedTools) {
  const roles = DEFAULT_MOUNTS.map((mount) => ({
    value: roleValue(mount.role),
    role: mount.role,
    shared: mount.role === "tools" && sharedTools,
    noShared: mount.role === "tools" && !sharedTools,
  }));
  return [...roles, ...volumes.map((volume) => ({ value: volume.id, role: null, shared: false, volume }))];
}

/** Mirrors `validMountPath` in src/volumes/mounts.ts, the rule the server applies to every mount path. */
export function validMountPath(path) {
  if (!path.startsWith("/") || path.length < 2 || path.length > 200) return false;
  if (path.includes("//") || /[\s\0]/.test(path)) return false;
  return path.split("/").every((part, index) => index === 0 || (part !== "." && part !== ".."));
}

/** Order-independent JSON of a mount list. A rebuild sends its mounts only when they differ from the box's. */
export function canonicalMounts(mounts) {
  return JSON.stringify(
    [...(mounts ?? [])]
      .map((mount) => ({ volume: mount.volume, path: mount.path, mode: mount.mode }))
      .toSorted((a, b) => `${a.path}\0${a.volume}`.localeCompare(`${b.path}\0${b.volume}`)),
  );
}

/** Whether a server error key concerns volumes or mounts. The create dialog shows those in its Volumes section. */
export function isVolumeErrorKey(key) {
  return typeof key === "string" && (key.startsWith("mount_") || key.startsWith("volume_"));
}

/**
 * The volumes a mount row offers. A volume another box owns is listed but disabled, because the server refuses to mount
 * it while that box exists (`ownedByAnotherBox` in src/volumes/engine.ts).
 */
export function volumeChoices(volumes, liveBoxIds) {
  return volumes.map((volume) => ({
    id: volume.id,
    name: volume.name,
    role: volume.role ?? null,
    rwMounts: volume.rwMounts,
    disabled: volume.ownership === "owned" && volume.ownerBoxId !== null && liveBoxIds.has(volume.ownerBoxId),
  }));
}

/**
 * The shared tools volume of the host, if it has one. The tools role mounts it instead of creating a second one, so the
 * dialog says which volume that is and whether it already exists.
 */
export function sharedToolsChoice(choices) {
  return choices.find((choice) => choice.role === "tools" && !choice.disabled) ?? null;
}

/**
 * Checks the rows of a custom mount list before it is sent. Returns the mounts, or the first row the server would
 * refuse: a row with no volume and no role, a role listed twice, or a path that is invalid or repeated. Those use the
 * server's own message keys. A row that creates a role is sent as `{ role }`, because the server takes that role's own
 * path and mode.
 */
export function checkMountRows(rows) {
  const paths = new Set();
  const roles = new Set();
  const mounts = [];
  for (const row of rows) {
    const role = roleOfValue(row.volume);
    if (role) {
      if (roles.has(role)) return { problem: { code: "mount_create_role_duplicate", role } };
      roles.add(role);
      const fixed = roleMount(role);
      if (!fixed) return { problem: { code: "volume" } };
      if (row.path !== fixed.path) {
        return { problem: { code: "mount_create_role_path", role, path: row.path, expected: fixed.path } };
      }
      if (paths.has(fixed.path)) return { problem: { code: "mount_duplicate", path: fixed.path } };
      paths.add(fixed.path);
      mounts.push({ role });
      continue;
    }
    if (!row.volume) return { problem: { code: "volume" } };
    if (!validMountPath(row.path)) return { problem: { code: "mount_path_invalid", path: row.path } };
    if (paths.has(row.path)) return { problem: { code: "mount_duplicate", path: row.path } };
    paths.add(row.path);
    mounts.push({ volume: row.volume, path: row.path, mode: row.mode });
  }
  return { mounts };
}
