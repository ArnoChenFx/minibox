import type { HostCtx } from "../host/registry";
import { badRequest, notFound } from "../lib/errors";
import { msg } from "../lib/messages";
import { type FirstEntry, readFirstEntry } from "../lib/tar";
import { type PathStat, isRuntimeError } from "../runtime";
import { SYMLINK_HOP_MAX, containerPath, splitLinkTarget } from "./files-path";
import type { MountAccess } from "./files-volume";

const symlinkLoop = () => badRequest(msg("file_symlink_loop", { max: SYMLINK_HOP_MAX }), { field: "path" });

/**
 * Metadata of one container path without reading a directory's (or a large file's) contents (B1f). A HEAD stat says
 * what the path is; only a symlink (for its raw target text, which the stat does not carry) or a file whose first
 * `maxData` bytes are wanted fetches the archive, and then only its first entry is read before the stream is
 * destroyed. The archive entry's own type wins over the stat, so a path swapped in between is still judged by what was
 * actually read. Fails with the runtime `not_found` when the path is missing.
 */
export async function lookupPath(host: HostCtx, access: MountAccess, abs: string, maxData = 0): Promise<FirstEntry> {
  let stat: PathStat | null = null;
  try {
    stat = await host.runtime.statPath(access.containerId, abs);
  } catch (e) {
    if (isRuntimeError(e, "not_found")) throw e;
    // A HEAD reply carries no error text (e.g. ELOOP on a final link); the archive call below reports it.
  }
  if (stat && (stat.type === "dir" || stat.type === "other" || (stat.type === "file" && maxData === 0))) {
    return { name: stat.name, type: stat.type, size: stat.size, linkname: "", data: Buffer.alloc(0), bodyAt: 0 };
  }
  try {
    return await readFirstEntry(await host.runtime.getArchive(access.containerId, abs), maxData);
  } catch (e) {
    // The Engine evaluates a final link's target for its stat header and fails a loop with a 500 (ELOOP).
    if (e instanceof Error && /too many links/i.test(e.message)) throw symlinkLoop();
    throw e;
  }
}

/** The type of one container path, or null when nothing is there. */
export async function entryType(host: HostCtx, access: MountAccess, abs: string): Promise<FirstEntry["type"] | null> {
  try {
    return (await lookupPath(host, access, abs)).type;
  } catch (e) {
    if (isRuntimeError(e, "not_found")) return null;
    throw e;
  }
}

interface ResolvedPath {
  /** Physical mount-relative path: every symlink in it has been followed, so it contains none (bar the final
   * component when it was left unfollowed) and no `.`/`..`. */
  path: string;
  /** How many leading components of `path` were seen to exist. The rest did not exist yet and were appended as-is. */
  existing: number;
}

/**
 * In-volume realpath. Docker getArchive/putArchive and `cp` follow every intermediate symlink (and the kernel walks
 * `..` against the physical path), so a lexical jail is not enough. Walk the path one component at a time with
 * lookupPath: a HEAD stat, plus the first archive header only when the component is a symlink, so a lookup never
 * reads a directory's subtree (B1f). When a component is a symlink, push its target's components back onto the queue,
 * so every hop of a chain is itself checked, and walk `..` against the physical path resolved so far. Refuse anything
 * that climbs above the volume root or names an absolute path outside the mount, and stop after SYMLINK_HOP_MAX links
 * (ELOOP). Callers must then operate on the returned physical path, never on the lexical one, so the Engine has no
 * symlinks left to resolve differently.
 *
 * Once a component is missing, nothing after it can be a symlink, so the remaining components are appended unchecked
 * (a `..` there is refused, since the kernel would fail with ENOENT anyway).
 *
 * With `followFinal: false` the last component of the input is not followed (lstat semantics), which is what reads
 * of a symlink and copy sources need.
 */
export async function resolveInVolume(
  host: HostCtx,
  access: MountAccess,
  relative: string,
  opts: { followFinal: boolean },
): Promise<ResolvedPath> {
  const queue = relative === "" ? [] : relative.split("/");
  const resolved: string[] = [];
  let existing = 0;
  let missing = false;
  let hops = 0;
  while (queue.length > 0) {
    const part = queue.shift() as string;
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (missing) throw notFound(msg("file_not_found", { path: relative || "/" }));
      if (resolved.length === 0) throw badRequest(msg("file_path_escape"), { field: "path" });
      resolved.pop();
      existing = resolved.length;
      continue;
    }
    if (missing || (queue.length === 0 && !opts.followFinal)) {
      resolved.push(part);
      continue;
    }
    const candidate = resolved.length === 0 ? part : `${resolved.join("/")}/${part}`;
    let entry: FirstEntry;
    try {
      entry = await lookupPath(host, access, containerPath(access.mountPath, candidate));
    } catch (e) {
      if (!isRuntimeError(e, "not_found")) throw e;
      missing = true;
      resolved.push(part);
      continue;
    }
    if (entry.type === "symlink") {
      hops += 1;
      if (hops > SYMLINK_HOP_MAX) throw symlinkLoop();
      const target = splitLinkTarget(access.mountPath, entry.linkname);
      if (!target) throw badRequest(msg("file_path_escape"), { field: "path" });
      if (!target.relative) {
        resolved.length = 0;
        existing = 0;
      }
      queue.unshift(...target.parts);
      continue;
    }
    resolved.push(part);
    existing = resolved.length;
  }
  return { path: resolved.join("/"), existing };
}

export const childOf = (dir: string, name: string): string => (dir === "" ? name : `${dir}/${name}`);
