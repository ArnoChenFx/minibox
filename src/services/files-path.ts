import { badRequest } from "../lib/errors";
import { msg } from "../lib/messages";

/** Longest relative path accepted inside a volume, in bytes. */
export const FILE_PATH_MAX = 512;

/**
 * Lexical path jail for volume-relative paths. Accepts `foo/bar`, `/foo/bar`, or `.`. Rejects NUL, empty segments,
 * escapes via `..`, and overly long strings. The result never starts with `/` and never contains `.` or `..` segments;
 * the volume root is the empty string.
 */
export function jailPath(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw badRequest(msg("file_path_invalid"), { field: "path" });
  }
  if (raw.includes("\0") || /[\r\n]/.test(raw) || Buffer.byteLength(raw) > FILE_PATH_MAX) {
    throw badRequest(msg("file_path_invalid"), { field: "path" });
  }
  const trimmed = raw.replace(/\/+$/, "");
  const parts = (trimmed.startsWith("/") ? trimmed.slice(1) : trimmed).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") throw badRequest(msg("file_path_escape"), { field: "path" });
    out.push(part);
  }
  return out.join("/");
}

/** Absolute path inside a container mount root (`/minibox-volume` + jailed relative path). */
export function containerPath(mountRoot: string, relative: string): string {
  const root = mountRoot.replace(/\/+$/, "") || "/";
  return relative === "" ? root : `${root}/${relative}`;
}

/** Parent directory of a jailed relative path, or `""` for the volume root. */
export function parentOf(relative: string): string {
  const i = relative.lastIndexOf("/");
  return i < 0 ? "" : relative.slice(0, i);
}

/** Basename of a jailed relative path, or `"."` for the volume root. */
export function baseOf(relative: string): string {
  if (relative === "") return ".";
  const i = relative.lastIndexOf("/");
  return i < 0 ? relative : relative.slice(i + 1);
}

/**
 * Resolve a symlink at `symlinkRelative` (mount-relative physical path of the link) to a mount-relative path.
 * Returns `null` when the target would leave the volume mount root.
 */
export function resolveSymlinkInVolume(mountPath: string, symlinkRelative: string, target: string): string | null {
  if (target === "" || target.includes("\0")) return null;
  const root = mountPath.replace(/\/+$/, "") || "/";
  if (target.startsWith("/")) {
    if (target === root) return "";
    if (!target.startsWith(`${root}/`)) return null;
    return target.slice(root.length + 1);
  }
  const base = symlinkRelative === "" ? [] : parentOf(symlinkRelative).split("/").filter(Boolean);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (base.length === 0) return null;
      base.pop();
      continue;
    }
    base.push(part);
  }
  return base.join("/");
}

/**
 * Whether a symlink at `symlinkRelative` (volume-relative) whose target is `target` would leave the volume.
 * Absolute targets escape unless they stay under `mountPath`. Relative targets escape when `..` walks above the root.
 * `symlinkRelative` must be the **physical** location of the link (after following earlier in-volume symlinks).
 */
export function symlinkTargetEscapes(mountPath: string, symlinkRelative: string, target: string): boolean {
  return resolveSymlinkInVolume(mountPath, symlinkRelative, target) === null;
}
