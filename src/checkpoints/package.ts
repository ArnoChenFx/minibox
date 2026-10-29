import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, unlink } from "node:fs/promises";

import { z } from "zod";

import { BOX_PROFILES } from "../box-profile";
import { EGRESS_MODES, EGRESS_PRESETS, MAX_EGRESS_DOMAINS } from "../egress/policy";
import { AppError } from "../lib/errors";
import { msg } from "../lib/messages";
import { cString, MAX_RECORD, numeric, parsePax } from "../lib/tar";
import { MAX_OWNER_ID } from "../runtime";
import { VOLUME_ROLES } from "../volumes/types";
import { isCheckpointId } from "./id";
import { CONSISTENCY_MODES } from "./types";

/** A package is a restic repository in a tar archive, sealed with the user's passphrase. */
export const PACKAGE_EXTENSION = ".mbckpt";
export const PACKAGE_VERSION = 1;
export const PACKAGE_TTL_MS = 24 * 60 * 60 * 1000;
/** The restic snapshot that carries the manifest. Only the manifest snapshot has this tag. */
export const MANIFEST_TAG = "minibox-package";
/** Where the manifest is read from inside the helper that backs it up, and where restic reports it. */
export const MANIFEST_FILE = "manifest.json";
export const MANIFEST_VERSION = 1;

/** Longest body of one file in a package. A restic pack is a few tens of MB, so this is a backstop. */
export const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 200_000;

const BLOCK = 512;
const TRAILER_MIN_BYTES = 2 * BLOCK;
const MB = 1024 * 1024;

const PACKAGE_ID_RE = /^pk_[0-9a-z]{8,32}$/;
const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** A stable id for an exported or uploaded package. It names no box, so it outlives the box and the checkpoint. */
export function newPackageId(): string {
  let id = "pk_";
  for (const byte of randomBytes(16)) id += ID_ALPHABET[byte % ID_ALPHABET.length] ?? "0";
  return id;
}

export function isPackageId(value: string): boolean {
  return PACKAGE_ID_RE.test(value);
}

export type PackageRejection = "invalid" | "passphrase" | "not_package";

/**
 * A package the scanner or the engine refuses. The reason decides the response: a wrong passphrase is its own answer,
 * and the detail is for the logs and the task, never for a passphrase.
 */
export class PackageRejected extends Error {
  constructor(
    readonly reason: PackageRejection,
    detail: string,
  ) {
    super(detail);
    this.name = "PackageRejected";
  }
}

export interface PackageDigest {
  bytes: number;
  sha256: string;
}

export interface ScanLimits {
  readonly maxEntryBytes: number;
  readonly maxEntries: number;
}

const DEFAULT_LIMITS: ScanLimits = { maxEntryBytes: MAX_ENTRY_BYTES, maxEntries: MAX_ENTRIES };

/** The only directories a package may hold: the repository and its fixed subdirectories, and the two-digit pack buckets. */
const DIR_NAMES: readonly RegExp[] = [
  /^repo$/,
  /^repo\/(?:keys|index|snapshots|locks|data)$/,
  /^repo\/data\/[0-9a-f]{2}$/,
];

/** The only files a package may hold. A pack's bucket must match the first two hex digits of its name. */
const FILE_NAMES: readonly RegExp[] = [
  /^repo\/config$/,
  /^repo\/(?:keys|index|snapshots|locks)\/[0-9a-f]{64}$/,
  /^repo\/data\/([0-9a-f]{2})\/\1[0-9a-f]{62}$/,
];

/** PAX keys a restic repository needs: timestamps and ownership. Paths, sizes and extended attributes are refused. */
const PAX_KEYS = new Set(["mtime", "atime", "ctime", "uid", "gid", "uname", "gname"]);
const PAX_PREFIXES = ["SCHILY.", "LIBARCHIVE."];

const USTAR_POSIX = Buffer.from("ustar\u000000", "latin1");
const USTAR_GNU = Buffer.from("ustar  \u0000", "latin1");

type Expect = "header" | "body" | "paxbody" | "pad" | "trailer";

const invalid = (detail: string): PackageRejected => new PackageRejected("invalid", detail);

function asBuffer(chunk: Uint8Array): Buffer {
  return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

/**
 * Checks a package as it arrives, one chunk at a time, and rejects anything a restic repository does not produce. Only
 * regular files and directories are allowed, with fixed names, no links, no special mode bits and no extended paths.
 * The archive must end with a zero trailer and contain `repo/config`. A refusal throws `PackageRejected`, and nothing is
 * extracted, so a crafted package cannot write outside the staging volume.
 */
export class PackageScanner {
  private readonly digest = createHash("sha256");
  private readonly names = new Set<string>();
  private readonly limits: ScanLimits;
  private bytes = 0;
  private entries = 0;
  private expect: Expect = "header";
  private pending = Buffer.alloc(0);
  private remaining = 0;
  private padding = 0;
  private paxChunks: Buffer[] = [];
  private paxExpected = false;
  private trailerBytes = 0;
  private sawConfig = false;

  constructor(limits: Partial<ScanLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  push(chunk: Uint8Array): void {
    this.bytes += chunk.byteLength;
    this.digest.update(chunk);
    try {
      this.consume(chunk);
    } catch (e) {
      if (e instanceof PackageRejected) throw e;
      throw invalid(e instanceof Error ? e.message : String(e));
    }
  }

  /** The package's size and sha256, once the trailer is seen and `repo/config` was among the entries. */
  end(): PackageDigest {
    if (this.pending.length > 0 || this.expect === "body" || this.expect === "paxbody" || this.expect === "pad") {
      throw invalid("the package ends inside an entry");
    }
    if (this.paxExpected) throw invalid("a PAX header is not followed by an entry");
    if (this.expect !== "trailer" || this.trailerBytes < TRAILER_MIN_BYTES)
      throw invalid("the package has no end marker");
    if (!this.sawConfig) throw new PackageRejected("not_package", "the package holds no repository config");
    return { bytes: this.bytes, sha256: this.digest.digest("hex") };
  }

  private consume(chunk: Uint8Array): void {
    const incoming = asBuffer(chunk);
    const data = this.pending.length === 0 ? incoming : Buffer.concat([this.pending, incoming]);
    this.pending = Buffer.alloc(0);
    let offset = 0;
    while (offset < data.length) {
      if (this.expect === "body") {
        const take = Math.min(this.remaining, data.length - offset);
        this.remaining -= take;
        offset += take;
        if (this.remaining === 0) this.leaveBody();
      } else if (this.expect === "paxbody") {
        const take = Math.min(this.remaining, data.length - offset);
        this.paxChunks.push(Buffer.from(data.subarray(offset, offset + take)));
        this.remaining -= take;
        offset += take;
        if (this.remaining === 0) {
          this.checkPax(Buffer.concat(this.paxChunks));
          this.paxChunks = [];
          this.leaveBody();
        }
      } else if (this.expect === "pad") {
        const take = Math.min(this.padding, data.length - offset);
        for (let i = offset; i < offset + take; i++) {
          if (data[i] !== 0) throw invalid("an entry is padded with non-zero bytes");
        }
        this.padding -= take;
        offset += take;
        if (this.padding === 0) this.expect = "header";
      } else if (this.expect === "trailer") {
        for (let i = offset; i < data.length; i++) {
          if (data[i] !== 0) throw invalid("the package holds data after its end marker");
        }
        this.trailerBytes += data.length - offset;
        offset = data.length;
      } else {
        if (data.length - offset < BLOCK) {
          this.pending = Buffer.from(data.subarray(offset));
          offset = data.length;
        } else {
          this.header(data.subarray(offset, offset + BLOCK));
          offset += BLOCK;
        }
      }
    }
  }

  private leaveBody(): void {
    this.expect = this.padding > 0 ? "pad" : "header";
  }

  private startBody(size: number, kind: "file" | "pax"): void {
    this.remaining = size;
    this.padding = (BLOCK - (size % BLOCK)) % BLOCK;
    if (size > 0) {
      this.expect = kind === "pax" ? "paxbody" : "body";
      return;
    }
    if (kind === "pax") this.checkPax(Buffer.alloc(0));
    this.leaveBody();
  }

  private header(block: Buffer): void {
    if (block.every((byte) => byte === 0)) {
      if (this.paxExpected) throw invalid("a PAX header is not followed by an entry");
      this.expect = "trailer";
      this.trailerBytes += BLOCK;
      return;
    }
    const stored = numeric(block.subarray(148, 156));
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (block[i] ?? 0);
    if (sum !== stored) throw invalid("an entry header checksum does not match");

    const magic = block.subarray(257, 265);
    const posix = magic.equals(USTAR_POSIX);
    if (!posix && !magic.equals(USTAR_GNU)) throw invalid("an entry is not in USTAR format");

    const flag = String.fromCharCode(block[156] ?? 0);
    if (flag === "x") {
      if (this.paxExpected) throw invalid("two PAX headers follow each other");
      const size = numeric(block.subarray(124, 136));
      if (size > MAX_RECORD) throw invalid("a PAX header is too large");
      this.paxExpected = true;
      this.startBody(size, "pax");
      return;
    }
    if (flag !== "0" && flag !== "\0" && flag !== "5")
      throw invalid(`an entry of type ${JSON.stringify(flag)} is not allowed`);
    if (cString(block.subarray(157, 257)) !== "") throw invalid("an entry carries a link target");
    if (numeric(block.subarray(100, 108)) & 0o7000) throw invalid("an entry sets setuid, setgid or sticky bits");

    const size = numeric(block.subarray(124, 136));
    const prefix = posix ? cString(block.subarray(345, 500)) : "";
    const short = cString(block.subarray(0, 100));
    const raw = prefix ? `${prefix}/${short}` : short;
    const isDir = flag === "5";
    const name = isDir && raw.endsWith("/") ? raw.slice(0, -1) : raw;
    if (!allowedName(name, isDir)) throw invalid(`the entry ${JSON.stringify(raw)} is not part of a repository`);
    if (this.names.has(name)) throw invalid(`the entry ${name} appears twice`);
    this.names.add(name);
    this.entries += 1;
    if (this.entries > this.limits.maxEntries) throw invalid("the package holds too many entries");
    this.paxExpected = false;

    if (isDir) {
      if (size !== 0) throw invalid(`the directory ${name} has a body`);
      this.startBody(0, "file");
      return;
    }
    if (size > this.limits.maxEntryBytes) throw invalid(`the entry ${name} is larger than the limit`);
    if (name === "repo/config") this.sawConfig = true;
    this.startBody(size, "file");
  }

  private checkPax(data: Buffer): void {
    for (const key of parsePax(data).keys()) {
      const allowed =
        PAX_KEYS.has(key) || (PAX_PREFIXES.some((prefix) => key.startsWith(prefix)) && !key.includes("xattr"));
      if (!allowed) throw invalid(`the PAX key ${key} is not allowed`);
    }
  }
}

function allowedName(name: string, isDir: boolean): boolean {
  return (isDir ? DIR_NAMES : FILE_NAMES).some((pattern) => pattern.test(name));
}

/**
 * Writes a package stream to `file` while it is checked, and returns its size and sha256. The file is created exclusively
 * and mode 600. A stream that is too long or is refused leaves no file behind.
 */
export async function writePackageFile(
  source: AsyncIterable<Uint8Array>,
  file: string,
  maxBytes: number,
): Promise<PackageDigest> {
  const scanner = new PackageScanner();
  const handle = await open(file, "wx", 0o600);
  let written = 0;
  try {
    for await (const chunk of source) {
      written += chunk.byteLength;
      if (written > maxBytes) throw packageTooLarge(maxBytes);
      scanner.push(chunk);
      for (let offset = 0; offset < chunk.byteLength;) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
        offset += bytesWritten;
      }
    }
    const digest = scanner.end();
    await handle.close();
    return digest;
  } catch (e) {
    await handle.close().catch(() => undefined);
    await unlink(file).catch(() => undefined);
    throw e;
  }
}

/** Checks a stored package again, so an import never trusts a file it has not read. */
export async function scanPackageFile(file: string): Promise<PackageDigest> {
  const scanner = new PackageScanner();
  for await (const chunk of createReadStream(file)) scanner.push(chunk);
  return scanner.end();
}

export function packageTooLarge(limitBytes: number): AppError {
  return new AppError(413, "payload_too_large", msg("package_too_large", { limit: Math.round(limitBytes / MB) }));
}

const LayerSchema = z.strictObject({
  volumeId: z.string().min(1).max(128),
  path: z
    .string()
    .min(1)
    .max(256)
    .refine((path) => path.startsWith("/") && !path.split("/").includes(".."), "not an absolute mount path"),
  mode: z.enum(["rw", "ro"]),
  role: z.enum(VOLUME_ROLES).nullable(),
  ownership: z.enum(["owned", "independent"]),
  owner: z.strictObject({
    uid: z.number().int().min(0).max(MAX_OWNER_ID),
    gid: z.number().int().min(0).max(MAX_OWNER_ID),
  }),
  bytes: z.number().int().min(0),
});

/**
 * What a package records beside its data: the checkpoint's record fields that a new instance needs, and nothing about
 * the source host. Snapshot ids are left out, since each instance assigns its own.
 */
const ManifestSchema = z
  .strictObject({
    version: z.literal(MANIFEST_VERSION),
    id: z.string().refine(isCheckpointId, "not a checkpoint id"),
    boxId: z.string().min(1).max(128),
    boxName: z.string().max(256),
    label: z.string().max(512),
    reason: z.string().max(1024),
    pinned: z.boolean(),
    consistency: z.enum(CONSISTENCY_MODES),
    specRevision: z.number().int().min(0),
    spec: z.strictObject({
      template: z.strictObject({
        ref: z.string().max(512),
        image: z.string().max(512),
        digest: z.string().max(256).nullable(),
      }),
      cpus: z.number().nullable(),
      memoryBytes: z.number().int().min(0).nullable(),
      profile: z.enum(BOX_PROFILES).nullable(),
      egress: z
        .strictObject({
          mode: z.enum(EGRESS_MODES),
          presets: z.array(z.enum(EGRESS_PRESETS)).max(EGRESS_PRESETS.length),
          domains: z.array(z.string().max(253)).max(MAX_EGRESS_DOMAINS),
          allow: z.array(z.string().max(255)).max(MAX_EGRESS_DOMAINS),
        })
        .optional(),
    }),
    data: z.array(LayerSchema).min(1).max(256),
    createdAt: z.iso.datetime(),
  })
  .refine((manifest) => new Set(manifest.data.map((layer) => layer.volumeId)).size === manifest.data.length, {
    message: "a volume appears twice",
    path: ["data"],
  });

export type PackageManifest = z.infer<typeof ManifestSchema>;

export function parseManifest(text: string): PackageManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid("the manifest is not JSON");
  }
  const result = ManifestSchema.safeParse(value);
  if (!result.success) throw invalid(`the manifest is not valid: ${result.error.issues[0]?.message ?? "unknown"}`);
  return result.data;
}
