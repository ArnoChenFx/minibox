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

/** Most symlinks followed while resolving one path (Linux uses 40 before ELOOP). */
export const SYMLINK_HOP_MAX = 40;

/**
 * Split a symlink target into components to push back onto a resolver's queue, without interpreting `..`.
 * Relative targets resolve against the link's physical parent (`relative: true`). Absolute targets must name the
 * mount root, or something under it, by literal components (`.` and duplicate slashes are dropped, since the kernel
 * ignores them); the components after the mount root are returned with `relative: false`, which restarts resolution
 * at the volume root. Any `..` stays in `parts` so the caller walks it against the physical path, which is what the
 * kernel does. Returns `null` for an empty target, NUL, or an absolute target outside the mount.
 */
export function splitLinkTarget(mountPath: string, target: string): { relative: boolean; parts: string[] } | null {
  if (target === "" || target.includes("\0")) return null;
  const parts = target.split("/").filter((part) => part !== "" && part !== ".");
  if (!target.startsWith("/")) return { relative: true, parts };
  const rootParts = mountPath.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length < rootParts.length) return null;
  for (let i = 0; i < rootParts.length; i++) {
    if (parts[i] !== rootParts[i]) return null;
  }
  return { relative: false, parts: parts.slice(rootParts.length) };
}
