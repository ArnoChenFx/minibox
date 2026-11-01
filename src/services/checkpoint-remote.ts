import type { RemoteRepository } from "../checkpoints/remote";
import type { CheckpointStore } from "../checkpoints/store";
import type { CheckpointRecord } from "../checkpoints/types";
import type { HostCtx } from "../host/registry";
import { conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import type { TargetService } from "./targets";

/** The fallback pass's interval. A checkpoint also asks for a copy as soon as it is written, so this only catches what a restart or a failure left behind. */
export const REMOTE_SYNC_EVERY_MS = 60 * 60 * 1000;
/**
 * How many copies in a row may fail before the overview lists the host. A successful copy clears the count, and the
 * count lives in memory only: a restart starts it again at zero. The remote repository's `lastError` is the durable
 * record of the last failure.
 */
export const REMOTE_SYNC_FAILURE_THRESHOLD = 3;
/** How long a written checkpoint waits before its copy starts, so a batch of writes makes one copy. */
const SYNC_REQUEST_DELAY_MS = 5 * 1000;
/** The first retry after a failed copy, doubled for each failure after it up to `RETRY_MAX_MS`. */
const RETRY_BASE_MS = 30 * 1000;
const RETRY_MAX_MS = 30 * 60 * 1000;
const MAX_ERROR = 500;

/**
 * Operations that write a checkpoint record holding snapshots, so a successful one asks for a copy to the remote
 * repository. The safety checkpoint a move, a rebuild or a rollback takes is written under its operation, so those are
 * here too. A pass that finds nothing to copy costs a record listing, so an operation that writes none only costs that.
 */
export const CHECKPOINT_WRITE_OPS: ReadonlySet<string> = new Set([
  "box.delete",
  "box.move",
  "box.rebuild",
  "checkpoint.copy",
  "checkpoint.create",
  "checkpoint.import",
  "checkpoint.rollback",
  "trash.restore",
  "volume.delete",
  "volume.prune",
  "volume.snapshot",
]);

/** What one copy did: the records it covers, and the snapshots it asked the remote repository to add. */
export interface RemoteSyncSummary {
  readonly hostId: string;
  readonly targetId: string;
  readonly checkpoints: number;
  readonly snapshots: number;
}

/** The last failed copy of one host's checkpoints, as the host's state reports it. */
interface RemoteSyncFailure {
  readonly targetId: string;
  readonly at: string;
  readonly message: string;
}

/** What one host's copies have done since the last success. */
interface RemoteSyncState {
  readonly failures: number;
  readonly lastFailure: RemoteSyncFailure | null;
}

interface Retry {
  readonly failures: number;
  readonly nextAt: number;
  readonly lastFailure: RemoteSyncFailure;
}

/**
 * Copies a host's checkpoint snapshots to the remote repository configured for it, and keeps the sync state on the
 * checkpoint records. A pass runs once an hour and after a checkpoint is written, and a failed copy is retried with a
 * backoff. The copy only adds: a local forget or prune is never sent to the remote, and a failed copy leaves the local
 * checkpoint as it was.
 *
 * Copies run inside the checkpoint engine, which serializes every operation on one host's repository, so a copy never
 * competes with a backup on the same host. A record is marked as held only after restic reports success, and the remote
 * repository is never unlocked here: a stale lock makes the copy fail after the bounded wait, and is reported instead of
 * being broken.
 */
export class CheckpointRemoteSync {
  private timer: ReturnType<typeof setInterval> | undefined;
  private passing = false;
  /** One pending copy per host, from a checkpoint written since. */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly syncing = new Set<string>();
  private readonly retries = new Map<string, Retry>();

  constructor(
    private readonly hosts: { list(): readonly HostCtx[] },
    private readonly checkpoints: CheckpointStore,
    private readonly targets: TargetService,
    private readonly everyMs = REMOTE_SYNC_EVERY_MS,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * How many copies in a row failed for one host, and why the last one did. A successful copy clears both, and the
   * count is kept in memory only: a restart starts it at zero. Read-only, so a caller that lists the hosts' state never
   * changes it.
   */
  stateOf(hostId: string): RemoteSyncState {
    const retry = this.retries.get(hostId);
    return retry ? { failures: retry.failures, lastFailure: retry.lastFailure } : { failures: 0, lastFailure: null };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /**
   * Asks for a copy of one host's pending snapshots soon. A host already waiting is left alone, and a host in its retry
   * delay waits for the next pass instead, so a failing target is not hammered by every checkpoint.
   */
  request(hostId: string): void {
    if (this.timers.has(hostId)) return;
    if (!this.targets.remoteOf(hostId)) return;
    const retry = this.retries.get(hostId);
    if (retry && this.clock().getTime() < retry.nextAt) return;
    const timer = setTimeout(() => {
      this.timers.delete(hostId);
      const host = this.hosts.list().find((candidate) => candidate.host.id === hostId);
      if (!host) return;
      void this.syncHost(host).catch((e: unknown) => {
        log.warn("checkpoint.remote_sync_failed", { host: hostId, error: messageOf(e) });
      });
    }, SYNC_REQUEST_DELAY_MS);
    timer.unref();
    this.timers.set(hostId, timer);
  }

  /** One pass at `now` over every host with a remote repository. A failed copy is logged once and retried later. */
  async run(now = this.clock()): Promise<RemoteSyncSummary[]> {
    if (this.passing) return [];
    this.passing = true;
    const synced: RemoteSyncSummary[] = [];
    try {
      for (const host of this.hosts.list()) {
        // An agent host cannot run a checkpoint helper, so it never has snapshots of its own to copy.
        if (host.host.transport === "agent") continue;
        if (this.syncing.has(host.host.id)) continue;
        const remote = this.targets.remoteOf(host.host.id);
        if (!remote) {
          this.retries.delete(host.host.id);
          continue;
        }
        const retry = this.retries.get(host.host.id);
        if (retry && now.getTime() < retry.nextAt) continue;
        try {
          synced.push(await this.syncHost(host, { now }));
        } catch (e) {
          log.warn("checkpoint.remote_sync_failed", {
            host: host.host.id,
            target: remote.targetId,
            error: messageOf(e),
          });
        }
      }
    } finally {
      this.passing = false;
    }
    return synced;
  }

  /**
   * Copies the snapshots of every pending checkpoint of one host to its remote repository, and marks those records as
   * held there. A call made by hand is not held back by the retry delay, and its failure reaches the caller. The summary
   * is empty when nothing was pending.
   */
  async syncHost(host: HostCtx, options: { now?: Date } = {}): Promise<RemoteSyncSummary> {
    const remote = this.targets.remoteOf(host.host.id);
    if (!remote) throw notFound(msg("checkpoint_remote_not_set", { host: host.host.id }));
    if (this.syncing.has(host.host.id)) throw conflict(msg("checkpoint_remote_busy", { host: host.host.id }));
    this.syncing.add(host.host.id);
    const now = options.now ?? this.clock();
    try {
      const pending = this.pending(host.host.id, remote.targetId);
      const summary = { hostId: host.host.id, targetId: remote.targetId, checkpoints: 0, snapshots: 0 };
      if (pending.length === 0) return summary;
      const snapshotIds = [...new Set(pending.flatMap((record) => record.data.map((layer) => layer.snapshotId)))];
      if (snapshotIds.length === 0) return summary;
      let repository: RemoteRepository;
      try {
        repository = await this.targets.remoteRepository(host.host.id);
      } catch (e) {
        this.failed(host.host.id, pending, remote.targetId, now, e);
        throw e;
      }
      try {
        await host.checkpointEngine.copyToRemote(host, repository, snapshotIds);
      } catch (e) {
        this.failed(host.host.id, pending, remote.targetId, now, e);
        throw e;
      }
      // The copy went to the position read above. When the operator moved or cleared the remote while it ran, the marks
      // would name a repository the snapshots are not in, so none are written and the next pass copies them again.
      const current = this.targets.remoteOf(host.host.id);
      if (!current || current.targetId !== remote.targetId || current.path !== remote.path) {
        log.info("checkpoint.remote_moved_during_copy", { host: host.host.id, target: remote.targetId });
        return summary;
      }
      const at = now.toISOString();
      for (const record of pending) this.markSynced(record.id, remote.targetId, at);
      this.targets.recordRemoteResult(host.host.id, { at, error: null });
      this.retries.delete(host.host.id);
      log.info("checkpoint.remote_synced", {
        host: host.host.id,
        target: remote.targetId,
        checkpoints: pending.length,
        snapshots: snapshotIds.length,
      });
      return { ...summary, checkpoints: pending.length, snapshots: snapshotIds.length };
    } finally {
      this.syncing.delete(host.host.id);
    }
  }

  /**
   * Forgets that a host's checkpoints were copied to one target, so the next pass copies them there again. A changed
   * folder or a cleared remote leaves the old marks naming a repository that may not hold the snapshots, and a copy
   * only adds: copying again is safe. The host's retry delay goes too, so a target that was failing is tried right
   * away instead of waiting out a backoff from the old position.
   */
  forgetMarks(hostId: string, targetId: string): void {
    for (const record of this.checkpoints.list()) {
      if (record.hostId !== hostId) continue;
      const patch: Partial<CheckpointRecord> = {};
      if (record.remoteSync?.[targetId] !== undefined) {
        const { [targetId]: _forgotten, ...rest } = record.remoteSync;
        patch.remoteSync = Object.keys(rest).length === 0 ? undefined : rest;
      }
      if (record.remoteFailure?.targetId === targetId) patch.remoteFailure = undefined;
      if (Object.keys(patch).length > 0) this.write(record.id, patch);
    }
    this.retries.delete(hostId);
  }

  private async tick(): Promise<void> {
    try {
      await this.run();
    } catch (e) {
      log.error("checkpoint.remote_pass_failed", { error: String(e) });
    }
  }

  /** The records of one host whose data has not been copied to this remote repository yet. A recycle bin entry counts. */
  private pending(hostId: string, targetId: string): CheckpointRecord[] {
    return this.checkpoints
      .list()
      .filter(
        (record) => record.hostId === hostId && record.data.length > 0 && record.remoteSync?.[targetId] === undefined,
      );
  }

  /** Marks one record as held by the remote, clearing a failure for that target but keeping one for another. */
  private markSynced(id: string, targetId: string, at: string): void {
    const record = this.checkpoints.read(id);
    if (!record) return;
    const failure = record.remoteFailure ?? null;
    const patch: Partial<CheckpointRecord> = { remoteSync: { ...record.remoteSync, [targetId]: at } };
    if (failure === null || failure.targetId === targetId) patch.remoteFailure = undefined;
    this.write(id, patch);
  }

  /** Records a failed copy on every pending record and on the host's remote, and sets the retry delay. */
  private failed(hostId: string, pending: CheckpointRecord[], targetId: string, now: Date, error: unknown): void {
    const message = messageOf(error).slice(0, MAX_ERROR);
    const at = now.toISOString();
    for (const record of pending) this.write(record.id, { remoteFailure: { targetId, at, message } });
    this.targets.recordRemoteResult(hostId, { at, error: message });
    const failures = (this.retries.get(hostId)?.failures ?? 0) + 1;
    const delay = Math.min(RETRY_BASE_MS * 2 ** Math.min(failures - 1, 10), RETRY_MAX_MS);
    const lastFailure = { targetId, at, message };
    // The line marks the moment the overview starts listing the host. A later failure in the same streak changes the
    // count but not the state, so it does not log again; a success clears the streak and lets a new one log once more.
    if (failures === REMOTE_SYNC_FAILURE_THRESHOLD) {
      log.warn("checkpoint.remote_sync_failing", { host: hostId, target: targetId, failures });
    }
    this.retries.set(hostId, { failures, nextAt: now.getTime() + delay, lastFailure });
  }

  /**
   * Writes a patch to one record, read again first so a change made while the copy ran is kept. A host removed during
   * the copy refuses the write, which only means the mark is missing.
   */
  private write(id: string, patch: Partial<CheckpointRecord>): void {
    const current = this.checkpoints.read(id);
    if (!current) return;
    try {
      this.checkpoints.write({ ...current, ...patch });
    } catch (e) {
      log.warn("checkpoint.remote_mark_failed", { id, error: String(e) });
    }
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
