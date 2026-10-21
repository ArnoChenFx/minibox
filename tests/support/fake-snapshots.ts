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
  /** Backups and restores that have begun, held or not. A test waits on this to know a call reached the engine. */
  started = 0;
  private sequence = 0;
  private gate: Promise<void> | null = null;

  constructor(private readonly runtime: FakeRuntime) {}

  /** Holds every backup and restore from now until the returned `release`, so a test can have one in progress. */
  hold(): { release(): void } {
    let openGate: (() => void) | undefined;
    this.gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    return {
      release: () => {
        this.gate = null;
        openGate?.();
      },
    };
  }

  private async enter(): Promise<void> {
    this.started += 1;
    if (this.gate) await this.gate;
  }

  async backup(_host: HostCtx, volume: string, tags: string[]): Promise<BackupResult> {
    await this.enter();
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
    await this.enter();
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
