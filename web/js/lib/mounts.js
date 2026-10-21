/** Mount-list helpers for the create and rebuild dialogs. No DOM and no imports, so the tests load them directly. */

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
