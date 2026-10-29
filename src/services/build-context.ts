import { chmod, lstat, mkdir, open, realpath, stat, symlink, unlink } from "node:fs/promises";
import { join, sep } from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

import { badRequest } from "../lib/errors";
import { type Msg, msg } from "../lib/messages";
import { contextUrlProblem } from "../lib/source";
import { cString, MAX_RECORD, numeric, parsePax } from "../lib/tar";

/** Largest build context, measured on the archive it arrives in and on what it unpacks to. */
export const CONTEXT_MAX_BYTES = 256 * 1024 * 1024;
const CONTEXT_MAX_ENTRIES = 20_000;
const FETCH_TIMEOUT_MS = 120_000;
const BLOCK = 512;
const COPY_CHUNK = 64 * 1024;
const SKIP_CHUNK = 1024 * 1024;

const refused = (detail: string) => badRequest(msg("context_invalid", { detail }));

/**
 * The parts of a path inside a build context or a repository. `.` and empty parts are dropped. An absolute path, a NUL
 * byte or a `..` part is refused, so nothing can be named outside the directory it is joined to.
 */
export function pathParts(name: string): string[] {
  if (name.includes("\0")) throw refused(`${JSON.stringify(name)} contains a NUL byte`);
  if (name.startsWith("/")) throw refused(`${name} is an absolute path`);
  const parts = name.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) throw refused(`${name} leaves the build context`);
  return parts;
}

/** Whether a symlink's target, resolved by the file system, stays inside `root`. */
async function resolvesInside(root: string, path: string): Promise<boolean> {
  const rootReal = await realpath(root);
  const target = await realpath(path).catch(() => null);
  return target !== null && (target === rootReal || target.startsWith(rootReal + sep));
}

/** Makes every directory of `parts` under `root`, refusing a symlink or a file where one is needed. */
async function ensureDirs(root: string, parts: readonly string[], name: string): Promise<string> {
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const info = await lstat(current).catch(() => null);
    if (!info) await mkdir(current);
    else if (info.isSymbolicLink()) throw refused(`${name} is inside a symbolic link`);
    else if (!info.isDirectory()) throw refused(`${name} is inside a file`);
  }
  return current;
}

/** Removes what an earlier entry left at `path`, so the entry being written is never redirected through it. */
async function clearPath(path: string, name: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info) return;
  if (info.isDirectory()) throw refused(`${name} replaces a directory`);
  await unlink(path);
}

/**
 * Reads a byte stream in exact pieces. `take` returns null once the stream ends before the piece is complete, and
 * `exhausted` tells a clean end of the archive from a truncated header.
 */
class ByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private buffer = Buffer.alloc(0);
  private ended = false;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  private async fill(n: number): Promise<void> {
    while (this.buffer.length < n && !this.ended) {
      const next = await this.iterator.next();
      if (next.done) this.ended = true;
      else this.buffer = this.buffer.length === 0 ? Buffer.from(next.value) : Buffer.concat([this.buffer, next.value]);
    }
  }

  async take(n: number): Promise<Buffer | null> {
    await this.fill(n);
    if (this.buffer.length < n) return null;
    const piece = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return Buffer.from(piece);
  }

  exhausted(): boolean {
    return this.ended && this.buffer.length === 0;
  }

  async skip(n: number): Promise<void> {
    let left = n;
    while (left > 0) {
      const piece = await this.take(Math.min(left, SKIP_CHUNK));
      if (!piece) throw refused("the archive is truncated");
      left -= piece.length;
    }
  }
}

const padding = (size: number): number => (BLOCK - (size % BLOCK)) % BLOCK;

/** The header checksum counts its own eight bytes as spaces. Anything else is not a tar header. */
function checksumOk(header: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
  return sum === numeric(header.subarray(148, 156));
}

export interface ExtractOptions {
  /** Top-level names to leave out, such as `.git`. */
  skip?: (top: string) => boolean;
  maxBytes?: number;
  maxEntries?: number;
}

/**
 * Unpacks a tar stream into `root`, which must exist and be empty. Regular files, directories and symbolic links are
 * written. A hard link, a device, a FIFO or any other special entry is refused. A path that is absolute or contains `..`
 * is refused, and so is a write that would pass through a symbolic link. A symbolic link is kept only when, once the
 * whole archive is in place, it resolves inside `root`.
 */
export async function extractTar(
  source: AsyncIterable<Uint8Array>,
  root: string,
  opts: ExtractOptions = {},
): Promise<void> {
  const reader = new ByteReader(source);
  const maxBytes = opts.maxBytes ?? CONTEXT_MAX_BYTES;
  const maxEntries = opts.maxEntries ?? CONTEXT_MAX_ENTRIES;
  const links: { name: string; path: string }[] = [];
  let global = new Map<string, string>();
  let pending = new Map<string, string>();
  let longName: string | undefined;
  let longLink: string | undefined;
  let bytes = 0;
  let entries = 0;

  for (;;) {
    const header = await reader.take(BLOCK);
    if (!header) {
      if (reader.exhausted()) break;
      throw refused("the archive is truncated");
    }
    if (header.every((byte) => byte === 0)) break;
    if (!checksumOk(header)) throw refused("the archive is not a tar file");

    const kind = String.fromCharCode(header[156] ?? 0);
    const size = numeric(header.subarray(124, 136));

    if (kind === "x" || kind === "g" || kind === "L" || kind === "K") {
      if (size > MAX_RECORD) throw refused("a tar record is too large");
      const data = await reader.take(size);
      if (!data) throw refused("the archive is truncated");
      await reader.skip(padding(size));
      if (kind === "x") pending = parsePax(data);
      else if (kind === "g") global = new Map([...global, ...parsePax(data)]);
      else if (kind === "L") longName = cString(data);
      else longLink = cString(data);
      continue;
    }

    const paxValue = (key: string) => pending.get(key) ?? global.get(key);
    const paxSize = paxValue("size");
    const fileSize = paxSize !== undefined && /^\d+$/.test(paxSize) ? Number(paxSize) : size;
    const shortName = cString(header.subarray(0, 100));
    const prefix = header.subarray(257, 263).toString("ascii") === "ustar\0" ? cString(header.subarray(345, 500)) : "";
    const name = paxValue("path") ?? longName ?? (prefix ? `${prefix}/${shortName}` : shortName);
    const linkname = paxValue("linkpath") ?? longLink ?? cString(header.subarray(157, 257));
    const mode = numeric(header.subarray(100, 108));
    pending = new Map();
    longName = undefined;
    longLink = undefined;

    entries += 1;
    if (entries > maxEntries) throw refused(`the archive has more than ${maxEntries} entries`);
    const parts = pathParts(name);
    const dropped = parts.length === 0 || (opts.skip?.(parts[0] ?? "") ?? false);

    if (kind === "5") {
      if (!dropped) await ensureDirs(root, parts, name);
      await reader.skip(fileSize);
      await reader.skip(padding(fileSize));
    } else if (kind === "2") {
      if (!dropped) {
        if (linkname === "" || linkname.startsWith("/") || linkname.includes("\0")) {
          throw refused(`${name} links to ${JSON.stringify(linkname)}`);
        }
        const dir = await ensureDirs(root, parts.slice(0, -1), name);
        const path = join(dir, parts.at(-1) ?? "");
        await clearPath(path, name);
        await symlink(linkname, path);
        links.push({ name, path });
      }
    } else if (kind === "0" || kind === "\0" || kind === "7" || kind === "V") {
      if (kind === "V" || dropped) {
        await reader.skip(fileSize);
      } else {
        if (fileSize > maxBytes - bytes) throw refused(`the build context is larger than ${maxBytes / 1024 / 1024} MB`);
        const dir = await ensureDirs(root, parts.slice(0, -1), name);
        const path = join(dir, parts.at(-1) ?? "");
        await clearPath(path, name);
        const handle = await open(path, "wx", 0o644);
        try {
          let left = fileSize;
          while (left > 0) {
            const piece = await reader.take(Math.min(left, COPY_CHUNK));
            if (!piece) throw refused("the archive is truncated");
            let written = 0;
            while (written < piece.length) {
              const step = await handle.write(piece, written, piece.length - written);
              written += step.bytesWritten;
            }
            left -= piece.length;
            bytes += piece.length;
          }
        } finally {
          await handle.close();
        }
        await chmod(path, ((mode & 0o755) | 0o644) >>> 0);
      }
      await reader.skip(padding(fileSize));
    } else {
      throw refused(`${name} is a hard link, a device or another special file`);
    }
  }

  for (const link of links) {
    if (!(await resolvesInside(root, link.path))) {
      throw refused(`${link.name} does not point inside the build context`);
    }
  }
}

/** Fails once more than `max` bytes have been read. The check is on the bytes as they arrive, not after the body. */
async function* limitBytes(source: AsyncIterable<Uint8Array>, max: number): AsyncGenerator<Uint8Array> {
  let total = 0;
  for await (const chunk of source) {
    total += chunk.byteLength;
    if (total > max) throw refused(`the build context is larger than ${max / 1024 / 1024} MB`);
    yield chunk;
  }
}

/** Gunzips the stream when it starts with the gzip magic bytes, and passes it through otherwise. */
async function plainOrGzip(source: AsyncIterable<Uint8Array>): Promise<AsyncIterable<Uint8Array>> {
  const iterator = source[Symbol.asyncIterator]();
  const first = await iterator.next();
  const head = first.done ? Buffer.alloc(0) : Buffer.from(first.value);
  const rest = (async function* () {
    if (head.length > 0) yield head;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  })();
  if (head[0] !== 0x1f || head[1] !== 0x8b) return rest;
  const input = Readable.from(rest);
  const gunzip = createGunzip();
  input.on("error", (e) => gunzip.destroy(e));
  return input.pipe(gunzip);
}

/**
 * Downloads a build context archive (`.tar` or `.tar.gz`) and unpacks it into `root`. The download is limited to
 * CONTEXT_MAX_BYTES and FETCH_TIMEOUT_MS, and the server follows at most the redirects fetch allows.
 */
export async function extractContextUrl(url: string, root: string, signal?: AbortSignal): Promise<void> {
  const problem = contextUrlProblem(url);
  if (problem) throw badRequest(msg("context_url_invalid"));
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const response = await fetch(url, {
    redirect: "follow",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  }).catch((e: unknown) => {
    throw badRequest(msg("context_fetch_failed", { detail: e instanceof Error ? e.message : String(e) }));
  });
  if (!response.ok || !response.body) {
    throw badRequest(msg("context_fetch_failed", { detail: `HTTP ${response.status}` }));
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > CONTEXT_MAX_BYTES)
    throw refused(`the build context is larger than ${CONTEXT_MAX_BYTES / 1024 / 1024} MB`);
  const body = limitBytes(response.body, CONTEXT_MAX_BYTES);
  await extractTar(await plainOrGzip(body), root);
}

/** A file under `dir` named by a relative path, which must exist as a regular file or a symlink to one. */
export async function assertFileIn(dir: string, relative: string, missing?: Msg): Promise<void> {
  const parts = pathParts(relative);
  const path = join(dir, ...parts);
  const info = await lstat(path).catch(() => null);
  const exists = info !== null && (info.isFile() || info.isSymbolicLink());
  if (!exists || (info?.isSymbolicLink() && !(await resolvesInside(dir, path)))) {
    throw badRequest(missing ?? msg("dockerfile_not_found", { path: relative }), { field: "source" });
  }
}

/** Throws unless `dir` is an existing directory whose real location lies inside `root`. */
export async function assertDirIn(root: string, dir: string): Promise<void> {
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory() || !(await resolvesInside(root, dir))) {
    throw refused("the build context directory does not exist");
  }
}
