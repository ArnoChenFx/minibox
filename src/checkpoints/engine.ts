import type { HostCtx } from "../host/registry";
import type { PackageDigest } from "./package";

/** What one backup produced: the snapshot id the engine assigned, and the bytes it read from the volume. */
export interface BackupResult {
  snapshotId: string;
  bytes: number;
}

/** What the repository stores across all its snapshots, in bytes after deduplication and compression. */
export interface EngineUsage {
  bytes: number;
}

/** A snapshot in a repository, with the tags it was taken with. */
export interface SnapshotRef {
  id: string;
  tags: string[];
}

/**
 * What a package carries: the checkpoint's snapshots, copied with their tags, and the manifest that describes them. The
 * passphrase seals the package. It reaches the engine as a secret, and nothing logs or stores it.
 */
export interface PackageInput {
  /** Snapshots of this host's repository that the package carries. */
  snapshotIds: string[];
  /** The manifest text, stored in the package as its own snapshot. */
  manifest: string;
  passphrase: string;
}

/** A package opened for reading or import. Its contents are staged in the engine until `close`. */
export interface OpenedPackage {
  /** Every snapshot the package holds, with its tags. */
  readonly snapshots: SnapshotRef[];
  /** The manifest text of one of the package's snapshots. */
  readManifest(snapshotId: string): Promise<string>;
  /** Copies snapshots of the package into this host's repository. Tags are kept, so `tagged` finds the new ids. */
  unpack(snapshotIds: string[]): Promise<void>;
  /** Releases what the package staged. Calling it again does nothing. */
  close(): Promise<void>;
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
  /** The snapshots of this host's repository that carry `tag`. A repository that does not exist has none. */
  tagged(host: HostCtx, tag: string): Promise<SnapshotRef[]>;
  /**
   * Writes a package for `input` to `file`, which must not exist yet. The stream is checked as it is written, and one
   * that is too long or refused leaves no file behind.
   */
  pack(host: HostCtx, input: PackageInput, file: string, maxBytes: number): Promise<PackageDigest>;
  /**
   * Opens a package file with its passphrase. A passphrase that does not open the package, or a file that holds no
   * repository, is refused with `PackageRejected`.
   */
  open(host: HostCtx, file: string, passphrase: string): Promise<OpenedPackage>;
}
