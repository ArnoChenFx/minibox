import type { HostCtx } from "../host/registry";
import { conflict, notFound, badRequest, AppError } from "../lib/errors";
import { msg } from "../lib/messages";
import type { FirstEntry } from "../lib/tar";
import { isRuntimeError } from "../runtime";
import { mtimeOf } from "./files-content";
import { resolveInVolume, entryType, childOf, lookupPath } from "./files-lookup";
import {
  type ListFilesResult,
  clampInt,
  LIST_MAX_DEPTH,
  LIST_DEFAULT_DEPTH,
  LIST_MAX_LIMIT,
  LIST_DEFAULT_LIMIT,
  FILE_MOUNT,
  type FileEntry,
  type CopyFilesResult,
} from "./files-model";
import { containerPath, jailPath, parentOf, baseOf } from "./files-path";
import { dirArchive } from "./files-tar";
import { type MountAccess, requireVolume, withArchive, requireHelperImage, runVolumeHelper } from "./files-volume";

/**
 * Like ensureDir, but refuses a component that must be a directory and is not one, instead of letting the Engine fail
 * part way through the archive puts.
 */
export async function prepareDir(host: HostCtx, access: MountAccess, relative: string): Promise<string> {
  const resolved = await resolveInVolume(host, access, relative, { followFinal: true });
  if (resolved.existing > 0) {
    const last = resolved.path.split("/").slice(0, resolved.existing).join("/");
    const type = await entryType(host, access, containerPath(access.mountPath, last));
    if (type !== "dir") throw conflict(msg("file_parent_not_directory", { path: last }));
  }
  const parts = resolved.path === "" ? [] : resolved.path.split("/");
  for (let i = resolved.existing; i < parts.length; i++) {
    const parent = parts.slice(0, i).join("/");
    await host.runtime.putArchive(
      access.containerId,
      containerPath(access.mountPath, parent),
      dirArchive(parts[i] as string),
    );
  }
  return resolved.path;
}

export async function listFiles(
  host: HostCtx,
  ref: string,
  input: { path?: string; maxDepth?: number; limit?: number },
): Promise<ListFilesResult> {
  const volume = requireVolume(host, ref);
  const relative = input.path === undefined || input.path === "" || input.path === "/" ? "" : jailPath(input.path);
  const maxDepth = clampInt(input.maxDepth, 0, LIST_MAX_DEPTH, LIST_DEFAULT_DEPTH);
  const limit = clampInt(input.limit, 1, LIST_MAX_LIMIT, LIST_DEFAULT_LIMIT);
  // find -P does not follow links, so a symlinked directory must be resolved first. The listing runs on the physical
  // path and its output is mapped back under the logical path the caller asked for.
  const physical = await withArchive(host, volume, "ro", async (access) =>
    resolveInVolume(host, access, relative, { followFinal: true }),
  );
  const image = await requireHelperImage(host);
  const search = physical.path === "" ? FILE_MOUNT : `${FILE_MOUNT}/${physical.path}`;

  const result = await runVolumeHelper(host, volume, {
    image,
    user: "1000:1000",
    capAdd: ["DAC_READ_SEARCH"],
    cmd: [
      "find",
      "-P",
      search,
      "-maxdepth",
      String(maxDepth),
      "(",
      "-type",
      "f",
      "-o",
      "-type",
      "d",
      "-o",
      "-type",
      "l",
      ")",
      "-printf",
      // The escapes are find's: a NUL cannot sit in an argv string, and a NUL ends each record, so a name may hold a tab.
      "%y\\t%s\\t%T@\\t%p\\0",
    ],
    mounts: [{ source: volume.engineName, target: FILE_MOUNT, mode: "ro" }],
    timeoutSec: 30,
    labels: { [host.keys.internal]: "true" },
  });
  if (result.exitCode !== 0) {
    const detail = result.logs.trim().slice(0, 400);
    if (/No such file|cannot find|No such/i.test(detail)) {
      throw notFound(msg("file_not_found", { path: relative || "/" }));
    }
    throw badRequest(msg("file_list_failed", { detail: detail || String(result.exitCode) }));
  }

  const entries: FileEntry[] = [];
  let truncated = false;
  for (const chunk of result.logs.split("\0")) {
    // The helper's stderr is merged into its output and a warning has no NUL after it, so it runs into the record that
    // follows. A record starts after the last newline before its first tab.
    const first = chunk.indexOf("\t");
    if (first < 0) continue;
    const record = chunk.slice(chunk.lastIndexOf("\n", first) + 1);
    const tab = record.indexOf("\t");
    const second = tab < 0 ? -1 : record.indexOf("\t", tab + 1);
    const third = second < 0 ? -1 : record.indexOf("\t", second + 1);
    if (third < 0) continue;
    const kind = record.slice(0, tab);
    const sizeText = record.slice(tab + 1, second);
    const mtimeText = record.slice(second + 1, third);
    const full = record.slice(third + 1);
    // find -P reports only paths under the search root, and a file type is one character; anything else is skipped.
    if (kind.length !== 1 || (full !== search && !full.startsWith(`${search}/`))) continue;
    const type: FileEntry["type"] = kind === "f" ? "file" : kind === "d" ? "dir" : kind === "l" ? "symlink" : "other";
    const within = full === search ? "" : full.slice(search.length + 1);
    const logical = within === "" ? relative : childOf(relative, within);
    const size = type === "file" ? Number(sizeText) : null;
    entries.push({
      path: logical === "" ? "/" : logical,
      type,
      size: size !== null && Number.isFinite(size) ? size : null,
      mtime: mtimeOf(mtimeText),
    });
    if (entries.length >= limit) {
      truncated = true;
      break;
    }
  }
  return { volume: volume.name, path: relative || "/", entries, truncated };
}

export async function copyFiles(
  host: HostCtx,
  ref: string,
  input: { from: string; to: string },
): Promise<CopyFilesResult> {
  const volume = requireVolume(host, ref);
  const from = jailPath(input.from);
  const to = jailPath(input.to);
  if (to === "" || from === to) throw badRequest(msg("file_copy_invalid"), { field: "to" });
  if (to.startsWith(`${from}/`)) throw badRequest(msg("file_copy_into_self"), { field: "to" });

  // cp follows symlinks like the archive API. Resolve both ends to physical in-volume paths and hand cp those, so it
  // has no symlinks of ours left to follow. The source is copied as-is (cp -a does not dereference it); an existing
  // destination link is followed by cp, so it is resolved and jailed too.
  const physical = await withArchive(host, volume, "ro", async (access) => ({
    from: (await resolveInVolume(host, access, from, { followFinal: false })).path,
    to: (await resolveInVolume(host, access, to, { followFinal: true })).path,
  }));
  if (physical.to === "" || physical.from === physical.to) throw badRequest(msg("file_copy_invalid"), { field: "to" });
  if (physical.from === "" || physical.to.startsWith(`${physical.from}/`)) {
    throw badRequest(msg("file_copy_into_self"), { field: "to" });
  }

  const image = await requireHelperImage(host);
  const fromAbs = containerPath(FILE_MOUNT, physical.from);
  const toAbs = containerPath(FILE_MOUNT, physical.to);
  const result = await runVolumeHelper(host, volume, {
    image,
    user: "1000:1000",
    capAdd: ["DAC_READ_SEARCH"],
    cmd: ["sh", "-c", 'mkdir -p -- "$(dirname -- "$2")" && cp -a -- "$1" "$2"', "minibox-cp", fromAbs, toAbs],
    mounts: [{ source: volume.engineName, target: FILE_MOUNT, mode: "rw" }],
    timeoutSec: 60,
    labels: { [host.keys.internal]: "true" },
  });
  if (result.exitCode !== 0) {
    const detail = result.logs.trim().slice(0, 400);
    if (/No such file|cannot stat/i.test(detail)) throw notFound(msg("file_not_found", { path: from }));
    throw badRequest(msg("file_copy_failed", { detail: detail || String(result.exitCode) }));
  }
  return { volume: volume.name, from, to };
}

/** Creates a directory and any missing parents. An existing directory is not an error; a file at the path is. */
export async function makeDirectory(
  host: HostCtx,
  ref: string,
  input: { path: string },
): Promise<{ volume: string; path: string; created: boolean }> {
  const volume = requireVolume(host, ref);
  const relative = jailPath(input.path);
  return withArchive(host, volume, "rw", async (access) => {
    const physical = await resolveInVolume(host, access, relative, { followFinal: true });
    const type =
      physical.path === "" ? "dir" : await entryType(host, access, containerPath(access.mountPath, physical.path));
    if (type === "dir") return { volume: volume.name, path: relative, created: false };
    if (type !== null) throw conflict(msg("file_exists", { path: relative }));
    await prepareDir(host, access, relative);
    return { volume: volume.name, path: relative, created: true };
  });
}

/**
 * Renames a file, a folder or a link to a new path inside the volume. The destination must be free; its missing parent
 * directories are created. Both ends are resolved first, so a link is moved itself, never the file it points at.
 */
export async function movePath(
  host: HostCtx,
  ref: string,
  input: { from: string; to: string },
): Promise<{ volume: string; from: string; to: string }> {
  const volume = requireVolume(host, ref);
  const from = jailPath(input.from);
  const to = jailPath(input.to);
  if (from === "" || to === "") throw badRequest(msg("file_root_protected"), { field: from === "" ? "from" : "to" });
  if (from === to) throw badRequest(msg("file_move_invalid"), { field: "to" });
  if (to.startsWith(`${from}/`)) throw badRequest(msg("file_move_into_self"), { field: "to" });
  const image = await requireHelperImage(host);
  const physical = await withArchive(host, volume, "rw", async (access) => {
    const source = await resolveInVolume(host, access, from, { followFinal: false });
    if (source.path === "") throw badRequest(msg("file_root_protected"), { field: "from" });
    if ((await entryType(host, access, containerPath(access.mountPath, source.path))) === null) {
      throw notFound(msg("file_not_found", { path: from }));
    }
    const parent = await prepareDir(host, access, parentOf(to));
    const target = childOf(parent, baseOf(to));
    if (target === source.path || target.startsWith(`${source.path}/`)) {
      throw badRequest(msg("file_move_into_self"), { field: "to" });
    }
    if ((await entryType(host, access, containerPath(access.mountPath, target))) !== null) {
      throw conflict(msg("file_exists", { path: to }));
    }
    return { from: source.path, to: target };
  });
  const moved = await runVolumeHelper(host, volume, {
    image,
    user: "1000:1000",
    capAdd: ["DAC_READ_SEARCH"],
    cmd: ["mv", "-T", "-n", "--", containerPath(FILE_MOUNT, physical.from), containerPath(FILE_MOUNT, physical.to)],
    mounts: [{ source: volume.engineName, target: FILE_MOUNT, mode: "rw" }],
    timeoutSec: 60,
    labels: { [host.keys.internal]: "true" },
  });
  if (moved.exitCode !== 0) {
    const detail = moved.logs.trim().slice(0, 400);
    if (/No such file/i.test(detail)) throw notFound(msg("file_not_found", { path: from }));
    if (/not replacing|exists/i.test(detail)) throw conflict(msg("file_exists", { path: to }));
    throw badRequest(msg("file_move_failed", { detail: detail || String(moved.exitCode) }));
  }
  // Older coreutils exit 0 when -n skips a destination that appeared after the check, so the source is looked at again.
  const skipped = await withArchive(host, volume, "ro", async (access) =>
    entryType(host, access, containerPath(access.mountPath, physical.from)),
  );
  if (skipped !== null) throw conflict(msg("file_exists", { path: to }));
  return { volume: volume.name, from, to };
}

/**
 * Removes a file, a folder tree or a link. A link is removed itself, never the file it points at. The volume root
 * cannot be removed. Without `confirm` nothing changes: the call answers 409 with a preview of what would go.
 */
export async function deletePath(
  host: HostCtx,
  ref: string,
  input: { path: string; confirm: boolean },
): Promise<{ volume: string; path: string }> {
  const volume = requireVolume(host, ref);
  const relative = jailPath(input.path);
  if (relative === "") throw badRequest(msg("file_root_protected"), { field: "path" });
  const image = await requireHelperImage(host);
  const physical = await withArchive(host, volume, "rw", async (access) => {
    const resolved = await resolveInVolume(host, access, relative, { followFinal: false });
    if (resolved.path === "") throw badRequest(msg("file_root_protected"), { field: "path" });
    let found: FirstEntry;
    try {
      found = await lookupPath(host, access, containerPath(access.mountPath, resolved.path));
    } catch (e) {
      if (isRuntimeError(e, "not_found")) throw notFound(msg("file_not_found", { path: relative }));
      throw e;
    }
    if (!input.confirm) {
      throw new AppError(409, "confirmation_required", msg("storage_confirm_required"), {
        preview: {
          action: "delete_file",
          volume: volume.name,
          path: relative,
          type: found.type,
          size: found.type === "file" ? found.size : null,
        },
      });
    }
    return resolved.path;
  });
  const removed = await runVolumeHelper(host, volume, {
    image,
    user: "1000:1000",
    capAdd: ["DAC_READ_SEARCH"],
    cmd: ["rm", "-rf", "--", containerPath(FILE_MOUNT, physical)],
    mounts: [{ source: volume.engineName, target: FILE_MOUNT, mode: "rw" }],
    timeoutSec: 120,
    labels: { [host.keys.internal]: "true" },
  });
  if (removed.exitCode !== 0) {
    const detail = removed.logs.trim().slice(0, 400);
    if (/No such file/i.test(detail)) throw notFound(msg("file_not_found", { path: relative }));
    throw badRequest(msg("file_delete_failed", { detail: detail || String(removed.exitCode) }));
  }
  return { volume: volume.name, path: relative };
}
