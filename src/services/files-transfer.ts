import { randomBytes } from "node:crypto";
import { Readable, pipeline } from "node:stream";
import { createGzip } from "node:zlib";

import type { HostCtx } from "../host/registry";
import type { RawBody, ByteStream } from "../lib/body";
import { badRequest, AppError, conflict, notFound } from "../lib/errors";
import { msg } from "../lib/messages";
import { type FirstEntry, firstEntry } from "../lib/tar";
import { isRuntimeError } from "../runtime";
import type { VolumeRecord } from "../volumes/types";
import { decodeContent, ensureDir } from "./files-content";
import { childOf, entryType, resolveInVolume } from "./files-lookup";
import { type UploadResult, FILE_MOUNT, type ArchiveResult, FILE_CONTENT_MAX } from "./files-model";
import { jailPath, baseOf, parentOf, containerPath } from "./files-path";
import { fileHeader, DEV_UID, DEV_GID, fileTrailer, parseTar } from "./files-tar";
import { prepareDir } from "./files-tree";
import {
  requireVolume,
  requireHelperImage,
  withArchive,
  runVolumeHelper,
  type MountAccess,
  holdVolumeBoxes,
  closeMount,
  openMount,
} from "./files-volume";

/** A streamed upload lands under this prefix until it is renamed over its target, so the name stays inside a tar field. */
const UPLOAD_TEMP_PREFIX = ".minibox-upload-";

const MB = 1024 * 1024;

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
