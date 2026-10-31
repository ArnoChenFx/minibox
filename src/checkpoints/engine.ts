import type { HostCtx } from "../host/registry";
import type { ByteProgress } from "../lib/transfer";
import type { PackageDigest } from "./package";
import type { RemoteRepository } from "./remote";

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
 * A snapshot in a repository, with the tags it was taken with. A copy gets a new id but keeps its tags, and `original`
 * names the snapshot it was first taken as, at the root of its copy chain. Null for a snapshot taken in this repository.
 */
export interface SnapshotRef {
  id: string;
  tags: string[];
  original: string | null;
}

/**
 * A copy was asked for a snapshot whose chain the repository already holds. The copy would duplicate that data under the
 * same origin, so it is refused. `root` is the origin both snapshots name.
 */
export class SnapshotHeld extends Error {
  constructor(readonly root: string) {
    super(`the repository already holds snapshot ${root}`);
    this.name = "SnapshotHeld";
  }
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
  /**
   * Copies snapshots of the package into this host's repository, and returns the new id of each, keyed by the package's
   * id. A snapshot whose chain this repository already holds is refused with `SnapshotHeld` before anything is copied.
   */
  unpack(snapshotIds: string[]): Promise<Map<string, string>>;
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
   * Copies snapshots into `remote`, adding only the ones it does not hold yet, and creating the remote repository when
   * it does not exist. A remote repository is never written to in any other way: nothing is removed or changed there, so
   * a local forget or prune does not reach it. The copy is idempotent, because restic recognizes a snapshot by its origin.
   */
  copyToRemote(host: HostCtx, remote: RemoteRepository, snapshotIds: string[]): Promise<void>;
  /**
   * Writes a package for `input` to `file`, which must not exist yet. The stream is checked as it is written, and one
   * that is too long or refused leaves no file behind. `onBytes` reports the bytes written so far.
   */
  pack(
    host: HostCtx,
    input: PackageInput,
    file: string,
    maxBytes: number,
    onBytes?: ByteProgress,
  ): Promise<PackageDigest>;
  /**
   * Opens a package file with its passphrase. A passphrase that does not open the package, or a file that holds no
   * repository, is refused with `PackageRejected`. `onBytes` reports the bytes staged so far.
   */
  open(host: HostCtx, file: string, passphrase: string, onBytes?: ByteProgress): Promise<OpenedPackage>;
}
