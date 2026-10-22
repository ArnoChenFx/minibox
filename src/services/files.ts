import { randomBytes } from "node:crypto";
import { pipeline, Readable } from "node:stream";
import { createGzip } from "node:zlib";

import type { HostCtx } from "../host/registry";
import type { ByteStream, RawBody } from "../lib/body";
import { AppError, badRequest, conflict, notFound, toAppError } from "../lib/errors";
import { msg } from "../lib/messages";
import { type FirstEntry, firstEntry, readFirstEntry } from "../lib/tar";
import { type HelperResult, type HelperSpec, isRuntimeError, type PathStat, RuntimeError } from "../runtime";
import type { VolumeRecord } from "../volumes/types";
import { baseOf, containerPath, jailPath, parentOf, SYMLINK_HOP_MAX, splitLinkTarget } from "./files-path";
import { DEV_GID, DEV_UID, dirArchive, fileArchive, fileHeader, fileTrailer, parseTar } from "./files-tar";

/** Where helpers and archive containers mount the target volume. Matches the chown helper's mount style. */
export const FILE_MOUNT = "/minibox-volume";

/** Inline content cap for read/write JSON bodies (1 MiB). Larger trees use archive download/upload. */
export const FILE_CONTENT_MAX = 1024 * 1024;

/** Default and maximum entries returned by list_files. */
export const LIST_DEFAULT_LIMIT = 500;
export const LIST_MAX_LIMIT = 2000;
export const LIST_DEFAULT_DEPTH = 2;
export const LIST_MAX_DEPTH = 8;

/** A streamed upload lands under this prefix until it is renamed over its target, so the name stays inside a tar field. */
const UPLOAD_TEMP_PREFIX = ".minibox-upload-";

const MB = 1024 * 1024;

export type FileEncoding = "utf-8" | "base64";

export interface FileEntry {
  path: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number | null;
  /** Last modification, as an ISO 8601 time in UTC. */
  mtime: string | null;
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

export interface UploadResult {
  volume: string;
  path: string;
  bytesWritten: number;
  overwritten: boolean;
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

/** Buffers a stream, destroying it and refusing once more than `limit` bytes have arrived. */
async function collectStream(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.from(chunk);
      total += buf.length;
      if (total > limit) throw badRequest(msg("file_content_too_large", { max: limit }), { field: "path" });
      chunks.push(buf);
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks);
}

const symlinkLoop = () => badRequest(msg("file_symlink_loop", { max: SYMLINK_HOP_MAX }), { field: "path" });

/**
 * Metadata of one container path without reading a directory's (or a large file's) contents (B1f). A HEAD stat says
 * what the path is; only a symlink (for its raw target text, which the stat does not carry) or a file whose first
 * `maxData` bytes are wanted fetches the archive, and then only its first entry is read before the stream is
 * destroyed. The archive entry's own type wins over the stat, so a path swapped in between is still judged by what was
 * actually read. Fails with the runtime `not_found` when the path is missing.
 */
async function lookupPath(host: HostCtx, access: MountAccess, abs: string, maxData = 0): Promise<FirstEntry> {
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
async function entryType(host: HostCtx, access: MountAccess, abs: string): Promise<FirstEntry["type"] | null> {
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

/**
 * Holds each box on this host that mounts `volume` until the returned release is called, so work on the volume counts
 * as box activity (#12). It never starts a box: the file API works while boxes are stopped.
 */
export function holdVolumeBoxes(host: HostCtx, volume: VolumeRecord, opts: { quiet?: boolean } = {}): () => void {
  const releases = host.specs
    .list()
    .filter((spec) => spec.hostId === host.host.id && spec.mounts.some((mount) => mount.volume === volume.engineName))
    .map((spec) => host.pulse.hold(spec.id, opts));
  return () => {
    for (const release of releases) release();
  };
}

async function whileVolumeInUse<T>(host: HostCtx, volume: VolumeRecord, run: () => Promise<T>): Promise<T> {
  const release = holdVolumeBoxes(host, volume);
  try {
    return await run();
  } finally {
    release();
  }
}

function runVolumeHelper(host: HostCtx, volume: VolumeRecord, spec: HelperSpec): Promise<HelperResult> {
  return whileVolumeInUse(host, volume, () => host.runtime.runHelper(spec));
}

async function withArchive<T>(
  host: HostCtx,
  volume: VolumeRecord,
  mode: "rw" | "ro",
  run: (access: MountAccess) => Promise<T>,
): Promise<T> {
  return whileVolumeInUse(host, volume, async () => {
    const access = await openMount(host, volume, mode);
    try {
      return await run(access);
    } finally {
      await closeMount(host, access);
    }
  });
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

/**
 * Like ensureDir, but refuses a component that must be a directory and is not one, instead of letting the Engine fail
 * part way through the archive puts.
 */
async function prepareDir(host: HostCtx, access: MountAccess, relative: string): Promise<string> {
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

const childOf = (dir: string, name: string): string => (dir === "" ? name : `${dir}/${name}`);

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
function mtimeOf(seconds: string): string | null {
  const value = Number(seconds);
  return seconds !== "" && Number.isFinite(value) ? new Date(Math.floor(value * 1000)).toISOString() : null;
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

/**
 * Streams one file from the request body onto the volume. The bytes go into a tar with a single entry, put into the
 * parent directory under a temporary name, and the entry is then renamed over the target. So an upload that is refused,
 * cancelled or cut short leaves the target as it was, and only the temporary name is removed.
 */
export async function streamUpload(
  host: HostCtx,
  ref: string,
  input: { path: string; overwrite: boolean; body: RawBody; maxBytes: number },
): Promise<UploadResult> {
  const volume = requireVolume(host, ref);
  const relative = jailPath(input.path);
  if (relative === "") throw badRequest(msg("file_path_invalid"), { field: "path" });
  if (input.body.length > input.maxBytes) {
    throw new AppError(
      413,
      "payload_too_large",
      msg("file_upload_too_large", { limit: Math.round(input.maxBytes / MB) }),
    );
  }
  const image = await requireHelperImage(host);
  const temp = `${UPLOAD_TEMP_PREFIX}${randomBytes(8).toString("hex")}`;
  const name = baseOf(relative);
  return withArchive(host, volume, "rw", async (access) => {
    const parent = await prepareDir(host, access, parentOf(relative));
    const target = childOf(parent, name);
    const existing = await entryType(host, access, containerPath(access.mountPath, target));
    if (existing === "dir") throw conflict(msg("file_target_is_directory", { path: relative }));
    if (existing !== null && !input.overwrite) throw conflict(msg("file_exists", { path: relative }));

    const tempRel = childOf(parent, temp);
    const fault: { error: AppError | null } = { error: null };
    try {
      await host.runtime
        .putArchive(
          access.containerId,
          containerPath(access.mountPath, parent),
          Readable.from(uploadTar(temp, input.body, fault), { objectMode: false }),
        )
        .catch((e: unknown) => {
          throw fault.error ?? e;
        });
      const moved = await runVolumeHelper(host, volume, {
        image,
        user: "1000:1000",
        capAdd: ["DAC_READ_SEARCH"],
        cmd: [
          "mv",
          "-T",
          input.overwrite ? "-f" : "-n",
          "--",
          containerPath(FILE_MOUNT, tempRel),
          containerPath(FILE_MOUNT, target),
        ],
        mounts: [{ source: volume.engineName, target: FILE_MOUNT, mode: "rw" }],
        timeoutSec: 60,
        labels: { [host.keys.internal]: "true" },
      });
      if (moved.exitCode !== 0) {
        const detail = moved.logs.trim().slice(0, 400);
        throw badRequest(msg("file_upload_failed", { detail: detail || String(moved.exitCode) }));
      }
      // Without overwrite, mv leaves the temporary file behind when the name was taken after the check above.
      if ((await entryType(host, access, containerPath(access.mountPath, tempRel))) !== null) {
        throw conflict(msg("file_exists", { path: relative }));
      }
      return { volume: volume.name, path: relative, bytesWritten: input.body.length, overwritten: existing !== null };
    } finally {
      await discardUpload(host, volume, image, access, tempRel);
    }
  });
}

/**
 * The tar of one uploaded file. The body must be exactly the declared length; a longer or shorter one is recorded in
 * `fault` and fails the stream, so the Engine never completes the entry.
 */
async function* uploadTar(name: string, body: RawBody, fault: { error: AppError | null }): AsyncGenerator<Buffer> {
  yield fileHeader(name, body.length, { uid: DEV_UID, gid: DEV_GID });
  let received = 0;
  if (body.stream) {
    for await (const chunk of body.stream) {
      received += chunk.byteLength;
      if (received > body.length) {
        fault.error = badRequest(msg("file_upload_mismatch", { length: body.length }), { field: "body" });
        throw fault.error;
      }
      yield Buffer.from(chunk);
    }
  }
  if (received !== body.length) {
    fault.error = badRequest(msg("file_upload_mismatch", { length: body.length }), { field: "body" });
    throw fault.error;
  }
  yield fileTrailer(body.length);
}

/** Removes a temporary upload name that is still there, so a refused upload leaves nothing behind. Best effort. */
async function discardUpload(
  host: HostCtx,
  volume: VolumeRecord,
  image: string,
  access: MountAccess,
  tempRel: string,
): Promise<void> {
  try {
    if ((await entryType(host, access, containerPath(access.mountPath, tempRel))) === null) return;
    await runVolumeHelper(host, volume, {
      image,
      user: "1000:1000",
      capAdd: ["DAC_READ_SEARCH"],
      cmd: ["rm", "-f", "--", containerPath(FILE_MOUNT, tempRel)],
      mounts: [{ source: volume.engineName, target: FILE_MOUNT, mode: "rw" }],
      timeoutSec: 60,
      labels: { [host.keys.internal]: "true" },
    });
  } catch {
    // The error that stopped the upload is the one to report; a leftover hidden temporary name is harmless.
  }
}

function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

/** Reads a tar stream up to the first entry's body. The iterator is kept, so the body can be read from where it stops. */
async function headerOf(chunks: AsyncIterator<Uint8Array>): Promise<{ entry: FirstEntry; head: Buffer }> {
  let bytes = Buffer.alloc(0);
  for (;;) {
    const next = await chunks.next();
    if (next.done) throw new Error("the archive ends before its first entry");
    bytes = Buffer.concat([bytes, Buffer.from(next.value)]);
    const entry = firstEntry(bytes, 0);
    if (entry) return { entry, head: bytes.subarray(entry.bodyAt) };
  }
}

/** The bytes of one regular file from its archive, in `size` bytes, and then the source is released. */
function fileBody(
  chunks: AsyncIterator<Uint8Array>,
  head: Buffer,
  size: number,
  release: () => void,
): ReadableStream<Uint8Array> {
  let sent = 0;
  let pending = head;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (sent >= size) {
          controller.close();
          release();
          return;
        }
        if (pending.length === 0) {
          const next = await chunks.next();
          if (next.done) throw new Error("the archive ends before the file does");
          pending = Buffer.from(next.value);
        }
        const take = Math.min(pending.length, size - sent);
        controller.enqueue(pending.subarray(0, take));
        pending = pending.subarray(take);
        sent += take;
      } catch (e) {
        controller.error(e);
        release();
      }
    },
    cancel() {
      release();
    },
  });
}

/**
 * Opens one file or folder for download. A file streams its own bytes; a folder streams its archive as a gzip tar. The
 * box holds and the helper container stay until the body ends or is cancelled, so the mount outlives this call. A
 * symlink is followed, and the target must stay inside the volume.
 */
export async function streamDownload(host: HostCtx, ref: string, input: { path: string }): Promise<ByteStream> {
  const volume = requireVolume(host, ref);
  const relative = input.path === "" || input.path === "/" ? "" : jailPath(input.path);
  const release = holdVolumeBoxes(host, volume);
  let access: MountAccess | null = null;
  let tar: Readable | null = null;
  const finish = once(() => {
    tar?.destroy();
    release();
    if (access) void closeMount(host, access);
  });
  try {
    const mount = await openMount(host, volume, "ro");
    access = mount;
    const physical = await resolveInVolume(host, mount, relative, { followFinal: true });
    const abs = containerPath(mount.mountPath, physical.path);
    const type = physical.path === "" ? "dir" : await entryType(host, mount, abs);
    if (type !== "file" && type !== "dir") throw notFound(msg("file_not_found", { path: relative || "/" }));
    tar = await host.runtime.getArchive(mount.containerId, abs);
    const name = relative === "" ? volume.name : baseOf(relative);
    if (type === "dir") {
      const gzip = createGzip();
      const source = tar;
      pipeline(source, gzip, () => undefined);
      gzip.once("close", finish);
      return {
        kind: "bytes",
        filename: `${name}.tar.gz`,
        contentType: "application/gzip",
        length: null,
        body: Readable.toWeb(gzip) as ReadableStream<Uint8Array>,
      };
    }
    const chunks = tar[Symbol.asyncIterator]();
    const { entry, head } = await headerOf(chunks);
    if (entry.type !== "file") throw notFound(msg("file_not_found", { path: relative || "/" }));
    return {
      kind: "bytes",
      filename: name,
      contentType: "application/octet-stream",
      length: entry.size,
      body: fileBody(chunks, head, entry.size, finish),
    };
  } catch (e) {
    finish();
    throw e;
  }
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

export async function downloadArchive(host: HostCtx, ref: string, input: { path: string }): Promise<ArchiveResult> {
  const volume = requireVolume(host, ref);
  const relative = input.path === "" || input.path === "/" ? "" : jailPath(input.path);
  return withArchive(host, volume, "ro", async (access) => {
    const physical = await resolveInVolume(host, access, relative, { followFinal: false });
    const abs = containerPath(access.mountPath, physical.path);
    let tar: Buffer;
    try {
      // Stops reading (and destroys the stream) as soon as the archive passes the cap.
      tar = await collectStream(await host.runtime.getArchive(access.containerId, abs), FILE_CONTENT_MAX * 4);
    } catch (e) {
      if (isRuntimeError(e, "not_found")) throw notFound(msg("file_not_found", { path: relative || "/" }));
      throw e;
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
