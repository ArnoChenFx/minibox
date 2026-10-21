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
    rwMounts: volume.rwMounts,
    disabled: volume.ownership === "owned" && volume.ownerBoxId !== null && liveBoxIds.has(volume.ownerBoxId),
  }));
}

/**
 * Checks the rows of a custom mount list before it is sent. Returns the mounts, or the first row the server would refuse:
 * a row with no volume, or a path that is invalid or repeated. Those two use the server's own message keys.
 */
export function checkMountRows(rows) {
  const paths = new Set();
  for (const row of rows) {
    if (!row.volume) return { problem: { code: "volume" } };
    if (!validMountPath(row.path)) return { problem: { code: "mount_path_invalid", path: row.path } };
    if (paths.has(row.path)) return { problem: { code: "mount_duplicate", path: row.path } };
    paths.add(row.path);
  }
  return { mounts: rows.map(({ volume, path, mode }) => ({ volume, path, mode })) };
}
