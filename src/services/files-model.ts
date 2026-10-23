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

export function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null || Number.isNaN(value)) return fallback;
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
