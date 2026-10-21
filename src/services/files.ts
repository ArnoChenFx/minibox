import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";

import type { HostCtx } from "../host/registry";
import { AppError, badRequest, notFound, toAppError } from "../lib/errors";
import { msg } from "../lib/messages";
import { isRuntimeError, RuntimeError } from "../runtime";
import type { VolumeRecord } from "../volumes/types";
import { baseOf, containerPath, jailPath, parentOf, SYMLINK_HOP_MAX, splitLinkTarget } from "./files-path";
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
  // Mirror runHelper hardening (NoCopy, ReadonlyRootfs, /tmp tmpfs, memory/pids, CapDrop, no network).
  // AutoRemove is omitted on purpose: archive helpers are created but never started, so the engine would never
  // remove them; closeMount deletes the container explicitly instead.
  const created = await host.runtime.createContainer({
    image,
    name,
    cmd: ["true"],
    mounts: [{ source: volume.engineName, target: FILE_MOUNT, mode, noCopy: true }],
    network: "none",
    labels: { [host.keys.internal]: "true" },
    memoryBytes: 256 * 1024 * 1024,
    swapBytes: 256 * 1024 * 1024,
    readonlyRootfs: true,
    tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=16m" },
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
 * getArchive, which reports a symlink as metadata when the path ends on it. When a component is a symlink, push its
 * target's components back onto the queue, so every hop of a chain is itself checked, and walk `..` against the
 * physical path resolved so far. Refuse anything that climbs above the volume root or names an absolute path outside
 * the mount, and stop after SYMLINK_HOP_MAX links (ELOOP). Callers must then operate on the returned physical path,
 * never on the lexical one, so the Engine has no symlinks left to resolve differently.
 *
 * Once a component is missing, nothing after it can be a symlink, so the remaining components are appended unchecked
 * (a `..` there is refused, since the kernel would fail with ENOENT anyway).
 *
 * With `followFinal: false` the last component of the input is not followed (lstat semantics), which is what reads
 * of a symlink and copy sources need.
 */
async function resolveInVolume(
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
    let tar: Buffer;
    try {
      tar = await collectStream(
        await host.runtime.getArchive(access.containerId, containerPath(access.mountPath, candidate)),
      );
    } catch (e) {
      // The Engine evaluates a final link's target for its stat header and fails a loop with a 500 (ELOOP).
      if (e instanceof Error && /too many links/i.test(e.message)) {
        throw badRequest(msg("file_symlink_loop", { max: SYMLINK_HOP_MAX }), { field: "path" });
      }
      if (!isRuntimeError(e, "not_found")) throw e;
      missing = true;
      resolved.push(part);
      continue;
    }
    const first = firstFileData(tar);
    if (first?.type === "symlink") {
      hops += 1;
      if (hops > SYMLINK_HOP_MAX)
        throw badRequest(msg("file_symlink_loop", { max: SYMLINK_HOP_MAX }), { field: "path" });
      const target = splitLinkTarget(access.mountPath, first.linkname || "");
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

/**
 * Resolves `relative` (a directory path) to its physical location and creates the missing tail one directory at a
 * time with empty dir archives, each put into an already-resolved physical parent. Returns the physical path.
 */
async function ensureDir(host: HostCtx, access: MountAccess, relative: string): Promise<string> {
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
  const maxBytes = input.maxBytes ?? FILE_CONTENT_MAX;
  return withArchive(host, volume, "ro", async (access) => {
    const physical = await resolveInVolume(host, access, relative, { followFinal: false });
    const abs = containerPath(access.mountPath, physical.path);
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
    const physical = await resolveInVolume(host, access, relative, { followFinal: false });
    const abs = containerPath(access.mountPath, physical.path);
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
    const dest = containerPath(access.mountPath, await ensureDir(host, access, relative));
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
