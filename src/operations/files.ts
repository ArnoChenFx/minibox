import { z } from "zod";

import type { EventTarget } from "../events/types";
import { msg } from "../lib/messages";
import { accept, type Checked, reject } from "../lib/validation";
import {
  copyFiles,
  downloadArchive,
  FILE_CONTENT_MAX,
  type FileEncoding,
  LIST_DEFAULT_DEPTH,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_DEPTH,
  LIST_MAX_LIMIT,
  listFiles,
  readFile,
  resolveVolume,
  uploadArchive,
  writeFile,
} from "../services/files";
import { FILE_PATH_MAX } from "../services/files-path";
import { defineOperation } from "./define";
import { hostOfVolume } from "./routing";
import { addFailure, field } from "./validation";

const ENCODINGS = ["utf-8", "base64"] as const;

function checkPath(value: unknown): Checked<string> {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value) > FILE_PATH_MAX
  ) {
    return reject(msg("file_path_invalid"), "path");
  }
  return accept(value);
}

function checkOptionalPath(value: unknown): Checked<string | undefined> {
  if (value === undefined || value === null || value === "") return accept(undefined);
  return checkPath(value);
}

function checkEncoding(value: unknown): Checked<FileEncoding> {
  if (value === undefined || value === null || value === "") return accept("utf-8");
  if (value === "utf-8" || value === "base64") return accept(value);
  return reject(msg("file_encoding_invalid"), "encoding");
}

function checkContent(value: unknown): Checked<string> {
  if (typeof value !== "string" || Buffer.byteLength(value) > FILE_CONTENT_MAX * 2) {
    return reject(msg("file_content_invalid"), "content");
  }
  return accept(value);
}

function checkDepth(value: unknown): Checked<number> {
  if (value === undefined || value === null || value === "") return accept(LIST_DEFAULT_DEPTH);
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > LIST_MAX_DEPTH) {
    return reject(msg("file_depth_range", { max: LIST_MAX_DEPTH }), "maxDepth");
  }
  return accept(n);
}

function checkLimit(value: unknown): Checked<number> {
  if (value === undefined || value === null || value === "") return accept(LIST_DEFAULT_LIMIT);
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > LIST_MAX_LIMIT) {
    return reject(msg("file_limit_range", { max: LIST_MAX_LIMIT }), "limit");
  }
  return accept(n);
}

const volumeId = () =>
  field(
    (value: unknown): Checked<string> => {
      if (typeof value !== "string" || value.trim() === "")
        return reject(msg("volume_not_found", { volume: "" }), "id");
      return accept(value.trim());
    },
    { type: "string", description: "Volume id (vol_…) or volume name." },
  );

const pathField = (description: string) => field(checkPath, { type: "string", maxLength: FILE_PATH_MAX, description });

const EntrySchema = z.object({
  path: z.string(),
  type: z.enum(["file", "dir", "symlink", "other"]),
  size: z.number().int().nullable(),
});

const volumeTarget = (volume: { id: string; name: string }): EventTarget => ({
  kind: "volume",
  id: volume.id,
  name: volume.name,
});

const READ_DESCRIPTION =
  "Read a file from a volume. Works when no box is running: MiniBox uses a helper container and the Docker archive API. path is relative to the volume root (for example workspace/README.md or /workspace/README.md). encoding is utf-8 (default) or base64. Symlinks are not followed; a symlink returns type symlink and linkTarget. Directories must be listed or downloaded as an archive. exec implies read/write on every mount of a box the token may use, so files:read only matters without exec.";

const WRITE_DESCRIPTION =
  "Write a file on a volume. Creates parent directories. Tar headers use uid/gid 1000 (dev). Path is jailed inside the volume. encoding is utf-8 (default) or base64. Content is at most 1 MiB; for larger trees use upload_files with a tar. files:write (or exec) is required.";

const LIST_DESCRIPTION =
  "List files under a path on a volume via a short-lived helper running find -P -maxdepth. Does not follow symlinks. limit caps the number of entries (default 500, max 2000).";

const COPY_DESCRIPTION =
  "Copy a file or directory within a volume (cp -a) via a helper. Both paths are jailed inside the volume.";

export const filesRead = defineOperation({
  name: "files.read",
  tag: "files",
  summary: "Read a file from a volume",
  kind: "read",
  scope: "files:read",
  async: false,
  input: z.object({
    id: volumeId(),
    path: pathField("Path inside the volume. Absolute or relative; jailed to the volume root."),
    encoding: field(checkEncoding, {
      type: "string",
      enum: [...ENCODINGS],
      description: "utf-8 (default) or base64.",
    }).default("utf-8"),
  }),
  output: z.object({
    volume: z.string(),
    path: z.string(),
    encoding: z.enum(ENCODINGS),
    content: z.string(),
    size: z.number().int(),
    type: z.enum(["file", "dir", "symlink"]),
    linkTarget: z.string().nullable(),
    truncated: z.boolean(),
  }),
  rest: [{ method: "GET", path: "/api/volumes/:id/files/content", query: ["path", "encoding"] }],
  cli: "files read",
  mcp: { toolset: "core", name: "read_file", description: READ_DESCRIPTION },
  hostFor: (ctx, input) => hostOfVolume(ctx, input.id),
  resolve: ({ host }, input) => resolveVolume(host, input.id),
  audit: {
    target: (_input, volume) => volume && volumeTarget(volume),
    detail: (input) => ({ path: input.path, encoding: input.encoding }),
  },
  run: async ({ host }, input) => readFile(host, input.id, { path: input.path, encoding: input.encoding }),
});

export const filesWrite = defineOperation({
  name: "files.write",
  tag: "files",
  summary: "Write a file on a volume",
  kind: "write",
  scope: "files:write",
  async: false,
  input: z.object({
    id: volumeId(),
    path: pathField("Path inside the volume to write."),
    content: field(checkContent, {
      type: "string",
      description: "File bytes as text (utf-8) or base64, matching encoding.",
    }),
    encoding: field(checkEncoding, {
      type: "string",
      enum: [...ENCODINGS],
      description: "utf-8 (default) or base64.",
    }).default("utf-8"),
  }),
  output: z.object({
    volume: z.string(),
    path: z.string(),
    bytesWritten: z.number().int(),
  }),
  rest: [{ method: "PUT", path: "/api/volumes/:id/files/content", body: true }],
  cli: "files write",
  mcp: { toolset: "core", name: "write_file", description: WRITE_DESCRIPTION },
  hostFor: (ctx, input) => hostOfVolume(ctx, input.id),
  resolve: ({ host }, input) => resolveVolume(host, input.id),
  activity: { action: () => "files.write", target: (input) => `${input.id}:${input.path}` },
  audit: {
    target: (_input, volume) => volume && volumeTarget(volume),
    detail: (input) => ({
      path: input.path,
      encoding: input.encoding,
      bytes: Buffer.byteLength(input.content),
    }),
  },
  run: async ({ host }, input) =>
    writeFile(host, input.id, { path: input.path, content: input.content, encoding: input.encoding }),
});

export const filesList = defineOperation({
  name: "files.list",
  tag: "files",
  summary: "List files on a volume",
  kind: "read",
  scope: "files:read",
  async: false,
  input: z.object({
    id: volumeId(),
    path: field(checkOptionalPath, {
      type: "string",
      maxLength: FILE_PATH_MAX,
      description: "Directory to list. Defaults to the volume root.",
    }).optional(),
    maxDepth: field(checkDepth, {
      type: "integer",
      minimum: 0,
      maximum: LIST_MAX_DEPTH,
      description: `find -maxdepth. Defaults to ${LIST_DEFAULT_DEPTH}, max ${LIST_MAX_DEPTH}.`,
    }).default(LIST_DEFAULT_DEPTH),
    limit: field(checkLimit, {
      type: "integer",
      minimum: 1,
      maximum: LIST_MAX_LIMIT,
      description: `Max entries to return. Defaults to ${LIST_DEFAULT_LIMIT}, max ${LIST_MAX_LIMIT}.`,
    }).default(LIST_DEFAULT_LIMIT),
  }),
  output: z.object({
    volume: z.string(),
    path: z.string(),
    entries: z.array(EntrySchema),
    truncated: z.boolean(),
  }),
  rest: [{ method: "GET", path: "/api/volumes/:id/files", query: ["path", "maxDepth", "limit"] }],
  cli: "files ls",
  mcp: { toolset: "core", name: "list_files", description: LIST_DESCRIPTION },
  hostFor: (ctx, input) => hostOfVolume(ctx, input.id),
  resolve: ({ host }, input) => resolveVolume(host, input.id),
  audit: {
    target: (_input, volume) => volume && volumeTarget(volume),
    detail: (input) => ({ path: input.path ?? "/", maxDepth: input.maxDepth, limit: input.limit }),
  },
  run: async ({ host }, input) =>
    listFiles(host, input.id, { path: input.path, maxDepth: input.maxDepth, limit: input.limit }),
});

export const filesCopy = defineOperation({
  name: "files.copy",
  tag: "files",
  summary: "Copy files within a volume",
  kind: "write",
  scope: "files:write",
  async: false,
  input: z
    .object({
      id: volumeId(),
      from: pathField("Source path inside the volume."),
      to: pathField("Destination path inside the volume."),
    })
    .superRefine((input, ctx) => {
      if (input.from === input.to) {
        addFailure(ctx, { message: msg("file_copy_invalid"), field: "to" });
      }
    }),
  output: z.object({
    volume: z.string(),
    from: z.string(),
    to: z.string(),
  }),
  rest: [{ method: "POST", path: "/api/volumes/:id/files/copy", body: true }],
  cli: "files cp",
  mcp: { toolset: "core", name: "copy_files", description: COPY_DESCRIPTION },
  hostFor: (ctx, input) => hostOfVolume(ctx, input.id),
  resolve: ({ host }, input) => resolveVolume(host, input.id),
  activity: { action: () => "files.copy", target: (input) => `${input.id}:${input.from}` },
  audit: {
    target: (_input, volume) => volume && volumeTarget(volume),
    detail: (input) => ({ from: input.from, to: input.to }),
  },
  run: async ({ host }, input) => copyFiles(host, input.id, { from: input.from, to: input.to }),
});

export const filesDownload = defineOperation({
  name: "files.download",
  tag: "files",
  summary: "Download a volume path as tar",
  kind: "read",
  scope: "files:read",
  async: false,
  input: z.object({
    id: volumeId(),
    path: field(checkOptionalPath, {
      type: "string",
      maxLength: FILE_PATH_MAX,
      description: "File or directory to archive. Defaults to the volume root.",
    }).optional(),
  }),
  output: z.object({
    volume: z.string(),
    path: z.string(),
    encoding: z.literal("base64"),
    content: z.string(),
    bytes: z.number().int(),
  }),
  rest: [{ method: "GET", path: "/api/volumes/:id/files/archive", query: ["path"] }],
  cli: "files download",
  hostFor: (ctx, input) => hostOfVolume(ctx, input.id),
  resolve: ({ host }, input) => resolveVolume(host, input.id),
  audit: {
    target: (_input, volume) => volume && volumeTarget(volume),
    detail: (input) => ({ path: input.path ?? "/" }),
  },
  run: async ({ host }, input) => downloadArchive(host, input.id, { path: input.path ?? "/" }),
});

export const filesUpload = defineOperation({
  name: "files.upload",
  tag: "files",
  summary: "Upload a tar onto a volume path",
  kind: "write",
  scope: "files:write",
  async: false,
  input: z.object({
    id: volumeId(),
    path: field(checkOptionalPath, {
      type: "string",
      maxLength: FILE_PATH_MAX,
      description: "Directory to extract into. Defaults to the volume root.",
    }).optional(),
    content: field(checkContent, {
      type: "string",
      description: "Base64-encoded tar archive.",
    }),
    encoding: field(
      (value: unknown): Checked<"base64"> => {
        if (value === undefined || value === null || value === "" || value === "base64") return accept("base64");
        return reject(msg("file_encoding_invalid"), "encoding");
      },
      { type: "string", enum: ["base64"], description: "Must be base64." },
    ).default("base64"),
  }),
  output: z.object({
    volume: z.string(),
    path: z.string(),
    encoding: z.literal("base64"),
    content: z.string(),
    bytes: z.number().int(),
  }),
  rest: [{ method: "PUT", path: "/api/volumes/:id/files/archive", body: true }],
  cli: "files upload",
  hostFor: (ctx, input) => hostOfVolume(ctx, input.id),
  resolve: ({ host }, input) => resolveVolume(host, input.id),
  activity: { action: () => "files.upload", target: (input) => `${input.id}:${input.path ?? "/"}` },
  audit: {
    target: (_input, volume) => volume && volumeTarget(volume),
    detail: (input) => ({ path: input.path ?? "/", bytes: Buffer.byteLength(input.content) }),
  },
  run: async ({ host }, input) =>
    uploadArchive(host, input.id, { path: input.path ?? "/", content: input.content, encoding: "base64" }),
});

export const fileOperations = [filesRead, filesWrite, filesList, filesCopy, filesDownload, filesUpload];
