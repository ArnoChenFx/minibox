import type { HostCtx } from "../host/registry";
import { badRequest, notFound } from "../lib/errors";
import { msg } from "../lib/messages";
import type { FirstEntry } from "../lib/tar";
import { isRuntimeError } from "../runtime";
import { resolveInVolume, lookupPath } from "./files-lookup";
import {
  type FileEncoding,
  type ReadFileResult,
  clampInt,
  FILE_CONTENT_MAX,
  type WriteFileResult,
} from "./files-model";
import { containerPath, jailPath, parentOf, baseOf } from "./files-path";
import { dirArchive, fileArchive, DEV_UID, DEV_GID } from "./files-tar";
import { type MountAccess, requireVolume, withArchive } from "./files-volume";

export function decodeContent(content: string, encoding: FileEncoding): Buffer {
  if (encoding === "base64") {
    try {
      return Buffer.from(content, "base64");
    } catch {
      throw badRequest(msg("file_content_invalid"), { field: "content" });
    }
  }
  return Buffer.from(content, "utf8");
}

function encodeContent(data: Buffer, encoding: FileEncoding): string {
  return encoding === "base64" ? data.toString("base64") : data.toString("utf8");
}

/**
 * Resolves `relative` (a directory path) to its physical location and creates the missing tail one directory at a
 * time with empty dir archives, each put into an already-resolved physical parent. Returns the physical path.
 */
export async function ensureDir(host: HostCtx, access: MountAccess, relative: string): Promise<string> {
  const resolved = await resolveInVolume(host, access, relative, { followFinal: true });
  if (resolved.path === "") return "";
  const parts = resolved.path.split("/");
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

export async function readFile(
  host: HostCtx,
  ref: string,
  input: { path: string; encoding?: FileEncoding; maxBytes?: number },
): Promise<ReadFileResult> {
  const volume = requireVolume(host, ref);
  const relative = jailPath(input.path);
  const encoding = input.encoding ?? "utf-8";
  const maxBytes = clampInt(input.maxBytes, 0, FILE_CONTENT_MAX, FILE_CONTENT_MAX);
  return withArchive(host, volume, "ro", async (access) => {
    const physical = await resolveInVolume(host, access, relative, { followFinal: false });
    let first: FirstEntry;
    try {
      // Only the first maxBytes of a file are read; a directory is judged from its stat alone (B1f).
      first = await lookupPath(host, access, containerPath(access.mountPath, physical.path), maxBytes);
    } catch (e) {
      if (isRuntimeError(e, "not_found")) throw notFound(msg("file_not_found", { path: relative || "/" }));
      throw e;
    }
    if (first.type === "other") throw notFound(msg("file_not_found", { path: relative || "/" }));
    if (first.type === "symlink") {
      return {
        volume: volume.name,
        path: relative || "/",
        encoding,
        content: "",
        size: 0,
        type: "symlink",
        linkTarget: first.linkname || null,
        truncated: false,
      };
    }
    if (first.type === "dir") {
      throw badRequest(
        msg("file_is_directory", { path: relative || "/" }),
        { field: "path" },
        {
          hint: msg("file_is_directory_hint"),
        },
      );
    }
    const truncated = first.size > maxBytes;
    const slice = first.data.subarray(0, maxBytes);
    if (encoding === "utf-8") {
      const text = slice.toString("utf8");
      if (text.includes("\uFFFD") && slice.includes(0)) {
        throw badRequest(msg("file_not_text"), { field: "encoding" }, { hint: msg("file_not_text_hint") });
      }
    }
    return {
      volume: volume.name,
      path: relative || "/",
      encoding,
      content: encodeContent(slice, encoding),
      size: first.size,
      type: "file",
      linkTarget: null,
      truncated,
    };
  });
}

export async function writeFile(
  host: HostCtx,
  ref: string,
  input: { path: string; content: string; encoding?: FileEncoding },
): Promise<WriteFileResult> {
  const volume = requireVolume(host, ref);
  const relative = jailPath(input.path);
  if (relative === "") throw badRequest(msg("file_path_invalid"), { field: "path" });
  const encoding = input.encoding ?? "utf-8";
  const data = decodeContent(input.content, encoding);
  if (data.length > FILE_CONTENT_MAX) {
    throw badRequest(msg("file_content_too_large", { max: FILE_CONTENT_MAX }), { field: "content" });
  }
  return withArchive(host, volume, "rw", async (access) => {
    // The final name is not followed: the Engine replaces an existing non-directory entry when extracting.
    const parent = await ensureDir(host, access, parentOf(relative));
    const parentAbs = containerPath(access.mountPath, parent);
    await host.runtime.putArchive(
      access.containerId,
      parentAbs,
      fileArchive(baseOf(relative), data, { uid: DEV_UID, gid: DEV_GID }),
    );
    return { volume: volume.name, path: relative, bytesWritten: data.length };
  });
}

/** `mtime` from `find`'s `%T@` (seconds since the epoch, with a fraction), as ISO 8601 UTC. */
export function mtimeOf(seconds: string): string | null {
  const value = Number(seconds);
  return seconds !== "" && Number.isFinite(value) ? new Date(Math.floor(value * 1000)).toISOString() : null;
}
