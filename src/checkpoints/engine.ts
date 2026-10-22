import type { HostCtx } from "../host/registry";

/** What one backup produced: the snapshot id the engine assigned, and the bytes it read from the volume. */
export interface BackupResult {
  snapshotId: string;
  bytes: number;
}

/** What the repository stores across all its snapshots, in bytes after deduplication and compression. */
export interface EngineUsage {
  bytes: number;
}

/**
 * Stores volume contents as snapshots and writes them back. A checkpoint keeps only snapshot ids, so another engine
 * that accepts these calls can replace the restic one.
 */
export interface SnapshotEngine {
  /** Snapshots the volume named `volume` (an engine name), with `tags` attached. Fails when the volume is missing. */
  backup(host: HostCtx, volume: string, tags: string[]): Promise<BackupResult>;
  /** Writes the snapshot into `volume`, which must already exist. Files in the snapshot replace files of the same path. */
  restore(host: HostCtx, snapshotId: string, volume: string): Promise<void>;
  /** Removes the snapshot and frees the space that only it used. */
  forget(host: HostCtx, snapshotId: string): Promise<void>;
  /** The repository's stored size. A repository that does not exist yet reports zero. */
  usage(host: HostCtx): Promise<EngineUsage>;
}
