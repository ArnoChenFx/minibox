import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type {
  BackupResult,
  OpenedPackage,
  PackageInput,
  SnapshotEngine,
  SnapshotRef,
} from "../../src/checkpoints/engine";
import { SnapshotHeld } from "../../src/checkpoints/engine";
import {
  MANIFEST_FILE,
  MANIFEST_TAG,
  PackageRejected,
  type PackageDigest,
  writePackageFile,
} from "../../src/checkpoints/package";
import type { HostCtx } from "../../src/host/registry";
import { type ByteProgress, countingChunks } from "../../src/lib/transfer";
import { RuntimeError } from "../../src/runtime";
import type { FakeFsEntry, FakeRuntime } from "./fake-runtime";
import { readTarFiles, type TarEntry, tarBytes } from "./tar";

/** What a snapshot holds, apart from the repository it sits in. */
interface Contents {
  files: Map<string, FakeFsEntry>;
  tags: string[];
  original: string | null;
}

export interface FakeSnapshot extends Contents {
  /** The host whose repository holds the snapshot. Each host has a repository of its own. */
  host: string;
}

type EngineCall = "backup" | "restore";

const clone = (entry: FakeFsEntry): FakeFsEntry => ({
  ...entry,
  content: entry.content ? Buffer.from(entry.content) : undefined,
});

const keyOf = (passphrase: string): string => createHash("sha256").update(passphrase).digest("hex");

/** A snapshot inside a package: its tags, origin and entries, as JSON, so the package stays a plain tar of files. */
function encodeSnapshot(snapshot: Contents): Buffer {
  const files = [...snapshot.files].map(([path, entry]) => ({
    path,
    type: entry.type,
    mode: entry.mode,
    uid: entry.uid,
    gid: entry.gid,
    content: entry.content?.toString("base64"),
  }));
  return Buffer.from(JSON.stringify({ tags: snapshot.tags, original: snapshot.original, files }));
}

function decodeSnapshot(body: Buffer): Contents {
  const value = JSON.parse(body.toString("utf8")) as {
    tags: string[];
    original: string | null;
    files: { path: string; type: FakeFsEntry["type"]; mode?: number; uid?: number; gid?: number; content?: string }[];
  };
  const files = new Map<string, FakeFsEntry>();
  for (const item of value.files) {
    files.set(item.path, {
      type: item.type,
      mode: item.mode,
      uid: item.uid,
      gid: item.gid,
      content: item.content === undefined ? undefined : Buffer.from(item.content, "base64"),
    });
  }
  return { files, tags: value.tags, original: value.original };
}

async function* oneChunk(bytes: Buffer): AsyncIterable<Uint8Array> {
  yield bytes;
}

/**
 * The checkpoint engine over the fake runtime's volume files. A snapshot holds a copy of every file but the root, and a
 * restore writes those files back over the target's, as restic does. Each host has its own repository: a snapshot is
 * found, forgotten and copied only on the host that holds it. `failBackupOf` makes the next backups of a volume fail, to
 * exercise the cleanup of a checkpoint that cannot finish.
 *
 * Packages are real tar files, checked by the same scanner the engine uses. Their passphrase is stored as a digest, so a
 * wrong passphrase is refused as one. Like restic's copy, packing and unpacking give each snapshot a new id and keep its
 * tags and origin, and an unpack into a repository that already holds the origin is refused with `SnapshotHeld`.
 */
export class FakeCheckpointEngine implements SnapshotEngine {
  /** Every host's snapshots by id. Ids are unique across hosts, so a test can read any of them here. */
  readonly snapshots = new Map<string, FakeSnapshot>();
  readonly failBackupOf = new Set<string>();
  /** Backups and restores that have begun, held or not. A test waits on this to know a call reached the engine. */
  started = 0;
  /** The size `usage` reports. Null reports the bytes of the snapshots held. */
  reportedBytes: number | null = null;
  /** Makes `usage` fail, as an engine that cannot be reached does. */
  usageFails = false;
  private sequence = 0;
  private gate: { promise: Promise<void>; kind: EngineCall | null; blocked: number } | null = null;

  constructor(private readonly runtime: FakeRuntime) {}

  /**
   * Holds every backup and restore from now until the returned `release`, or only those of `kind`, so a test can have one
   * in progress. `blocked` counts the calls waiting at the gate, so a test knows one has arrived.
   */
  hold(kind: EngineCall | null = null): { release(): void; blocked(): number } {
    let openGate: (() => void) | undefined;
    const gate = {
      promise: new Promise<void>((resolve) => {
        openGate = resolve;
      }),
      kind,
      blocked: 0,
    };
    this.gate = gate;
    return {
      release: () => {
        if (this.gate === gate) this.gate = null;
        openGate?.();
      },
      blocked: () => gate.blocked,
    };
  }

  private async enter(kind: EngineCall): Promise<void> {
    this.started += 1;
    const gate = this.gate;
    if (!gate || (gate.kind !== null && gate.kind !== kind)) return;
    gate.blocked += 1;
    await gate.promise;
  }

  private nextId(): string {
    this.sequence += 1;
    return this.sequence.toString(16).padStart(64, "0");
  }

  /** The snapshot `snapshotId` on this host's repository. A snapshot of another host is not found here. */
  private heldBy(host: HostCtx, snapshotId: string, action: string): FakeSnapshot {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot || snapshot.host !== host.host.id) {
      throw new RuntimeError("engine", `restic ${action} exited with status 1: no snapshot ${snapshotId}`);
    }
    return snapshot;
  }

  private snapshotsOn(host: HostCtx): [string, FakeSnapshot][] {
    return [...this.snapshots].filter(([, snapshot]) => snapshot.host === host.host.id);
  }

  async backup(host: HostCtx, volume: string, tags: string[]): Promise<BackupResult> {
    await this.enter("backup");
    if (!this.runtime.volumes.has(volume)) throw new RuntimeError("not_found", `no such volume ${volume}`);
    if (this.failBackupOf.has(volume)) throw new RuntimeError("engine", `backup of ${volume} failed`);
    const files = new Map<string, FakeFsEntry>();
    for (const [path, entry] of this.runtime.filesOf(volume)) {
      if (path !== "") files.set(path, clone(entry));
    }
    const snapshotId = this.nextId();
    this.snapshots.set(snapshotId, { files, tags, host: host.host.id, original: null });
    const bytes = [...files.values()].reduce((sum, entry) => sum + (entry.content?.length ?? 0), 0);
    return { snapshotId, bytes };
  }

  async restore(host: HostCtx, snapshotId: string, volume: string): Promise<void> {
    await this.enter("restore");
    const snapshot = this.heldBy(host, snapshotId, "restore");
    if (!this.runtime.volumes.has(volume)) throw new RuntimeError("not_found", `no such volume ${volume}`);
    const files = this.runtime.filesOf(volume);
    for (const [path, entry] of snapshot.files) files.set(path, clone(entry));
  }

  async forget(host: HostCtx, snapshotId: string): Promise<void> {
    this.heldBy(host, snapshotId, "forget");
    this.snapshots.delete(snapshotId);
  }

  async usage(host: HostCtx): Promise<{ bytes: number }> {
    if (this.usageFails) throw new RuntimeError("engine", "restic stats exited with status 1");
    if (this.reportedBytes !== null) return { bytes: this.reportedBytes };
    let bytes = 0;
    for (const [, snapshot] of this.snapshotsOn(host)) {
      for (const entry of snapshot.files.values()) bytes += entry.content?.length ?? 0;
    }
    return { bytes };
  }

  async tagged(host: HostCtx, tag: string): Promise<SnapshotRef[]> {
    return this.snapshotsOn(host)
      .filter(([, snapshot]) => snapshot.tags.includes(tag))
      .map(([id, snapshot]) => ({ id, tags: [...snapshot.tags], original: snapshot.original }));
  }

  async pack(
    host: HostCtx,
    input: PackageInput,
    file: string,
    maxBytes: number,
    onBytes?: ByteProgress,
  ): Promise<PackageDigest> {
    const entries: TarEntry[] = [
      { name: "repo/config", body: Buffer.from(JSON.stringify({ key: keyOf(input.passphrase) })) },
    ];
    for (const snapshotId of input.snapshotIds) {
      const snapshot = this.heldBy(host, snapshotId, "copy");
      const packagedId = this.nextId();
      const original = snapshot.original ?? snapshotId;
      entries.push({ name: `repo/snapshots/${packagedId}`, body: encodeSnapshot({ ...snapshot, original }) });
    }
    const manifest: Contents = {
      files: new Map([[MANIFEST_FILE, { type: "file", content: Buffer.from(input.manifest) }]]),
      tags: [MANIFEST_TAG],
      original: null,
    };
    entries.push({ name: `repo/snapshots/${this.nextId()}`, body: encodeSnapshot(manifest) });
    const bytes = tarBytes(entries);
    return writePackageFile(onBytes ? countingChunks(oneChunk(bytes), onBytes) : oneChunk(bytes), file, maxBytes);
  }

  async open(host: HostCtx, file: string, passphrase: string, onBytes?: ByteProgress): Promise<OpenedPackage> {
    const raw = readFileSync(file);
    onBytes?.(raw.length);
    const files = readTarFiles(raw);
    const config = files.get("repo/config");
    if (!config) throw new PackageRejected("not_package", "the package holds no repository config");
    const parsed = JSON.parse(config.toString("utf8")) as { key?: unknown };
    if (parsed.key !== keyOf(passphrase)) throw new PackageRejected("passphrase", "the passphrase does not match");
    const stored = new Map<string, Contents>();
    for (const [name, body] of files) {
      const match = /^repo\/snapshots\/([0-9a-f]{64})$/.exec(name);
      if (match) stored.set(match[1] ?? "", decodeSnapshot(body));
    }
    return {
      snapshots: [...stored].map(([id, snapshot]) => ({ id, tags: [...snapshot.tags], original: snapshot.original })),
      readManifest: async (snapshotId) => {
        const content = stored.get(snapshotId)?.files.get(MANIFEST_FILE)?.content;
        if (!content) throw new PackageRejected("invalid", "the package's manifest is missing");
        return content.toString("utf8");
      },
      unpack: async (snapshotIds) => this.unpackInto(host, stored, snapshotIds),
      close: async () => {},
    };
  }

  private unpackInto(host: HostCtx, stored: Map<string, Contents>, snapshotIds: string[]): Map<string, string> {
    const roots = new Map<string, string>();
    for (const id of snapshotIds) {
      const snapshot = stored.get(id);
      if (!snapshot) throw new RuntimeError("engine", `restic copy exited with status 1: no snapshot ${id}`);
      roots.set(id, snapshot.original ?? id);
    }
    if (new Set(roots.values()).size !== roots.size)
      throw new PackageRejected("invalid", "the package holds one snapshot twice");
    for (const root of roots.values()) {
      if (this.snapshotsOn(host).some(([id, snapshot]) => id === root || snapshot.original === root)) {
        throw new SnapshotHeld(root);
      }
    }
    const copied = new Map<string, string>();
    for (const [id, snapshot] of stored) {
      if (!roots.has(id)) continue;
      const newId = this.nextId();
      const files = new Map([...snapshot.files].map(([path, entry]) => [path, clone(entry)]));
      this.snapshots.set(newId, {
        files,
        tags: [...snapshot.tags],
        host: host.host.id,
        original: roots.get(id) ?? null,
      });
      copied.set(id, newId);
    }
    return copied;
  }
}
