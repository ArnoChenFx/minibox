import type { BackupResult, SnapshotEngine } from "../../src/checkpoints/engine";
import type { HostCtx } from "../../src/host/registry";
import { RuntimeError } from "../../src/runtime";
import type { FakeFsEntry, FakeRuntime } from "./fake-runtime";

export interface FakeSnapshot {
  files: Map<string, FakeFsEntry>;
  tags: string[];
}

const clone = (entry: FakeFsEntry): FakeFsEntry => ({
  ...entry,
  content: entry.content ? Buffer.from(entry.content) : undefined,
});

/**
 * The checkpoint engine over the fake runtime's volume files. A snapshot holds a copy of every file but the root, and a
 * restore writes those files back over the target's, as restic does. `failBackupOf` makes the next backups of a volume
 * fail, to exercise the cleanup of a checkpoint that cannot finish.
 */
export class FakeCheckpointEngine implements SnapshotEngine {
  readonly snapshots = new Map<string, FakeSnapshot>();
  readonly failBackupOf = new Set<string>();
  private sequence = 0;

  constructor(private readonly runtime: FakeRuntime) {}

  async backup(_host: HostCtx, volume: string, tags: string[]): Promise<BackupResult> {
    if (!this.runtime.volumes.has(volume)) throw new RuntimeError("not_found", `no such volume ${volume}`);
    if (this.failBackupOf.has(volume)) throw new RuntimeError("engine", `backup of ${volume} failed`);
    const files = new Map<string, FakeFsEntry>();
    for (const [path, entry] of this.runtime.filesOf(volume)) {
      if (path !== "") files.set(path, clone(entry));
    }
    this.sequence += 1;
    const snapshotId = this.sequence.toString(16).padStart(64, "0");
    this.snapshots.set(snapshotId, { files, tags });
    const bytes = [...files.values()].reduce((sum, entry) => sum + (entry.content?.length ?? 0), 0);
    return { snapshotId, bytes };
  }

  async restore(_host: HostCtx, snapshotId: string, volume: string): Promise<void> {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) throw new RuntimeError("engine", `restic restore exited with status 1: no snapshot ${snapshotId}`);
    if (!this.runtime.volumes.has(volume)) throw new RuntimeError("not_found", `no such volume ${volume}`);
    const files = this.runtime.filesOf(volume);
    for (const [path, entry] of snapshot.files) files.set(path, clone(entry));
  }

  async forget(_host: HostCtx, snapshotId: string): Promise<void> {
    if (!this.snapshots.delete(snapshotId)) {
      throw new RuntimeError("engine", `restic forget exited with status 1: no snapshot ${snapshotId}`);
    }
  }
}
