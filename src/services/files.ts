import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";

import type { HostCtx } from "../host/registry";
import { AppError, badRequest, notFound, toAppError } from "../lib/errors";
import { msg } from "../lib/messages";
import { isRuntimeError, RuntimeError } from "../runtime";
import type { VolumeRecord } from "../volumes/types";
import { baseOf, containerPath, jailPath, parentOf } from "./files-path";
import { DEV_GID, DEV_UID, dirArchive, fileArchive, firstFileData, parseTar } from "./files-tar";

/** Where helpers and archive containers mount the target volume. Matches the chown helper's mount style. */
export const FILE_MOUNT = "/minibox-volume";

/** Inline content cap for read/write JSON bodies (1 MiB). Larger trees use archive download/upload. */
export const FILE_CONTENT_MAX = 1024 * 1024;

/** Default and maximum entries returned by list_files. */
export const LIST_DEFAULT_LIMIT = 500;
export const LIST_MAX_LIMIT = 2000;
export const LIST_DEFAULT_DEPTH = 2;
export const LIST_MAX_DEPTH = 8;

export type FileEncoding = "utf-8" | "base64";

export interface FileEntry {
  path: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number | null;
}

export interface ReadFileResult {
  volume: string;
  path: string;
  encoding: FileEncoding;
  content: string;
  size: number;
  type: "file" | "dir" | "symlink";
  linkTarget: string | null;
  truncated: boolean;
}

export interface WriteFileResult {
  volume: string;
  path: string;
  bytesWritten: number;
}

export interface ListFilesResult {
  volume: string;
  path: string;
  entries: FileEntry[];
  truncated: boolean;
}

export interface CopyFilesResult {
  volume: string;
  from: string;
  to: string;
}

export interface ArchiveResult {
  volume: string;
  path: string;
  encoding: "base64";
  content: string;
  bytes: number;
}

function requireVolume(host: HostCtx, ref: string): VolumeRecord {
  const volume = host.volumes.resolve(ref, host.host.id);
  if (!volume || volume.hostId !== host.host.id) throw notFound(msg("volume_not_found", { volume: ref }));
  return volume;
}

async function requireHelperImage(host: HostCtx): Promise<string> {
  try {
    await host.runtime.inspectImage(host.baseTemplateTag);
    return host.baseTemplateTag;
  } catch (e) {
    if (e instanceof RuntimeError && e.kind === "not_found") {
      throw badRequest(msg("helper_image_missing", { image: host.baseTemplateTag }));
    }
    throw e;
  }
}

interface MountAccess {
  containerId: string;
  /** Absolute path of the volume root inside the container. */
  mountPath: string;
  /** Whether this service created the container and must remove it. */
  ephemeral: boolean;
}

/**
 * A container that already mounts the volume (a box, running or stopped), or a freshly created helper that is not
 * started. Archive APIs work on created containers.
 */
async function openMount(host: HostCtx, volume: VolumeRecord, mode: "rw" | "ro"): Promise<MountAccess> {
  for (const spec of host.specs.list()) {
    if (spec.hostId !== host.host.id || !spec.containerId) continue;
    const mount = spec.mounts.find((item) => item.volume === volume.engineName);
    if (!mount) continue;
    if (mode === "rw" && mount.mode === "ro") continue;
    try {
      await host.runtime.inspectContainer(spec.containerId);
      return { containerId: spec.containerId, mountPath: mount.path, ephemeral: false };
    } catch (e) {
      if (isRuntimeError(e, "not_found")) continue;
      throw e;
    }
  }

  const image = await requireHelperImage(host);
  const name = `${host.prefix}-file-${randomBytes(4).toString("hex")}`;
  const created = await host.runtime.createContainer({
    image,
    name,
    cmd: ["true"],
    mounts: [{ source: volume.engineName, target: FILE_MOUNT, mode }],
    network: "none",
    labels: { [host.keys.internal]: "true" },
    hardening: { capDrop: ["ALL"], noNewPrivileges: true, pidsLimit: 64 },
  });
  return { containerId: created.id, mountPath: FILE_MOUNT, ephemeral: true };
}

async function closeMount(host: HostCtx, access: MountAccess): Promise<void> {
  if (!access.ephemeral) return;
  try {
    await host.runtime.removeContainer(access.containerId, { force: true });
  } catch {
    // Best-effort cleanup; a leftover internal helper is harmless and labelled.
  }
}

async function collectStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function withArchive<T>(
  host: HostCtx,
  volume: VolumeRecord,
  mode: "rw" | "ro",
  run: (access: MountAccess) => Promise<T>,
): Promise<T> {
  const access = await openMount(host, volume, mode);
  try {
    return await run(access);
  } finally {
    await closeMount(host, access);
  }
}

function decodeContent(content: string, encoding: FileEncoding): Buffer {
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

/** Ensures each directory along `relative` (a file or dir path) exists by putting empty dir archives. */
async function ensureDir(host: HostCtx, access: MountAccess, relative: string): Promise<void> {
  if (relative === "") return;
  const parts = relative.split("/");
  let built = "";
  for (const part of parts) {
    built = built === "" ? part : `${built}/${part}`;
    const abs = containerPath(access.mountPath, built);
    try {
      const stream = await host.runtime.getArchive(access.containerId, abs);
      stream.destroy();
      continue;
    } catch (e) {
      if (!isRuntimeError(e, "not_found")) throw e;
    }
    const parentAbs = containerPath(access.mountPath, parentOf(built));
    await host.runtime.putArchive(access.containerId, parentAbs, dirArchive(baseOf(built)));
  }
}

export async function readFile(
  host: HostCtx,
  ref: string,
  input: { path: string; encoding?: FileEncoding; maxBytes?: number },
): Promise<ReadFileResult> {
  const volume = requireVolume(host, ref);
  const relative = jailPath(input.path);
  const encoding = input.encoding ?? "utf-8";
  const maxBytes = input.maxBytes ?? FILE_CONTENT_MAX;
  return withArchive(host, volume, "ro", async (access) => {
    const abs = containerPath(access.mountPath, relative);
    let tar: Buffer;
    try {
      tar = await collectStream(await host.runtime.getArchive(access.containerId, abs));
    } catch (e) {
      if (isRuntimeError(e, "not_found")) throw notFound(msg("file_not_found", { path: relative || "/" }));
      throw e;
    }
    const first = firstFileData(tar);
    if (!first) throw notFound(msg("file_not_found", { path: relative || "/" }));
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
    const truncated = first.data.length > maxBytes;
    const slice = truncated ? first.data.subarray(0, maxBytes) : first.data;
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
      size: first.data.length,
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
    await ensureDir(host, access, parentOf(relative));
    const parentAbs = containerPath(access.mountPath, parentOf(relative));
    await host.runtime.putArchive(
      access.containerId,
      parentAbs,
      fileArchive(baseOf(relative), data, { uid: DEV_UID, gid: DEV_GID }),
    );
    return { volume: volume.name, path: relative, bytesWritten: data.length };
  });
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
  const image = await requireHelperImage(host);
  const search = relative === "" ? FILE_MOUNT : `${FILE_MOUNT}/${relative}`;

  const result = await host.runtime.runHelper({
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
      "%y\t%s\t%p\n",
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
  for (const line of result.logs.split("\n")) {
    if (!line) continue;
    const [kind, sizeText, fullPath] = line.split("\t");
    if (!kind || fullPath === undefined) continue;
    if (!fullPath.startsWith(FILE_MOUNT)) {
      throw new AppError(500, "internal", msg("file_path_escape"));
    }
    let rel = fullPath.slice(FILE_MOUNT.length).replace(/^\//, "");
    // Refuse anything that would leave the mount after lexical normalize (symlink targets are not followed: -P).
    try {
      if (rel !== "") rel = jailPath(rel);
    } catch {
      continue;
    }
    if (relative !== "" && rel !== relative && !rel.startsWith(`${relative}/`)) continue;
    const type: FileEntry["type"] = kind === "f" ? "file" : kind === "d" ? "dir" : kind === "l" ? "symlink" : "other";
    const size = type === "file" ? Number(sizeText) : null;
    entries.push({ path: rel === "" ? "/" : rel, type, size: Number.isFinite(size) ? size : null });
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

  const image = await requireHelperImage(host);
  const fromAbs = containerPath(FILE_MOUNT, from);
  const toAbs = containerPath(FILE_MOUNT, to);
  const result = await host.runtime.runHelper({
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

export async function downloadArchive(host: HostCtx, ref: string, input: { path: string }): Promise<ArchiveResult> {
  const volume = requireVolume(host, ref);
  const relative = input.path === "" || input.path === "/" ? "" : jailPath(input.path);
  return withArchive(host, volume, "ro", async (access) => {
    const abs = containerPath(access.mountPath, relative);
    let tar: Buffer;
    try {
      tar = await collectStream(await host.runtime.getArchive(access.containerId, abs));
    } catch (e) {
      if (isRuntimeError(e, "not_found")) throw notFound(msg("file_not_found", { path: relative || "/" }));
      throw e;
    }
    if (tar.length > FILE_CONTENT_MAX * 4) {
      throw badRequest(msg("file_content_too_large", { max: FILE_CONTENT_MAX * 4 }), { field: "path" });
    }
    return {
      volume: volume.name,
      path: relative || "/",
      encoding: "base64",
      content: tar.toString("base64"),
      bytes: tar.length,
    };
  });
}

export async function uploadArchive(
  host: HostCtx,
  ref: string,
  input: { path: string; content: string; encoding?: "base64" },
): Promise<ArchiveResult> {
  const volume = requireVolume(host, ref);
  const relative = input.path === "" || input.path === "/" ? "" : jailPath(input.path);
  const tar = decodeContent(input.content, input.encoding ?? "base64");
  if (tar.length > FILE_CONTENT_MAX * 4) {
    throw badRequest(msg("file_content_too_large", { max: FILE_CONTENT_MAX * 4 }), { field: "content" });
  }
  // Refuse archive members that escape via absolute or `..` names.
  for (const entry of parseTar(tar)) {
    if (entry.name.startsWith("/") || entry.name.split("/").includes("..")) {
      throw badRequest(msg("file_path_escape"), { field: "content" });
    }
  }
  await withArchive(host, volume, "rw", async (access) => {
    await ensureDir(host, access, relative);
    const dest = containerPath(access.mountPath, relative);
    await host.runtime.putArchive(access.containerId, dest, rewriteOwners(tar));
  });
  return {
    volume: volume.name,
    path: relative || "/",
    encoding: "base64",
    content: "",
    bytes: tar.length,
  };
}

/** Re-stamp file/dir headers as uid/gid 1000 without changing payload bytes. */
function rewriteOwners(tar: Buffer): Buffer {
  const out = Buffer.from(tar);
  let offset = 0;
  while (offset + 512 <= out.length) {
    const block = out.subarray(offset, offset + 512);
    if (block.every((b) => b === 0)) break;
    const typeFlag = String.fromCharCode(block[156] ?? 0);
    const sizeField = block.subarray(124, 136);
    let size = 0;
    const text = (sizeField.toString("ascii").split("\0")[0] ?? "").trim();
    if (/^[0-7]+$/.test(text)) size = Number.parseInt(text, 8);
    if (typeFlag !== "x" && typeFlag !== "g" && typeFlag !== "L" && typeFlag !== "K") {
      block.write(`${DEV_UID.toString(8).padStart(7, "0")}\0`, 108, "ascii");
      block.write(`${DEV_GID.toString(8).padStart(7, "0")}\0`, 116, "ascii");
      block.fill(0x20, 148, 156);
      const sum = block.reduce((s, b) => s + b, 0);
      block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null || Number.isNaN(value)) return fallback;
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Resolve a volume for authz before the handler runs. */
export async function resolveVolume(
  host: HostCtx,
  ref: string,
): Promise<{ id: string; name: string; record: VolumeRecord }> {
  const record = requireVolume(host, ref);
  return { id: record.id, name: record.name, record };
}

export function mapFileError(e: unknown): never {
  throw toAppError(e);
}
