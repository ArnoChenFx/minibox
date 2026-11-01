import { type BackupRecord, BackupRecordSchema } from "../backup/store";
import { writePackageFile } from "../checkpoints/package";
import { expiresAtFor, isExpired, type PackageMeta, PackageMetaSchema } from "../checkpoints/packages";
import {
  knownHostsLine,
  type RemoteRepository,
  remotePathFor,
  remoteRepoPassword,
  s3Repository,
  sftpRepository,
} from "../checkpoints/remote";
import type { CheckpointStore } from "../checkpoints/store";
import { probePublicKey } from "../host/ssh";
import { AppError, badRequest, conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { type Msg, msg } from "../lib/messages";
import type { SecretStore } from "../secrets/store";
import { classifyFailure, TargetFailure } from "../targets/errors";
import { openSession } from "../targets/open";
import type { TargetConnection, TargetSession } from "../targets/session";
import { TargetStore } from "../targets/store";
import {
  isTargetSecretName,
  type LastSync,
  newTargetId,
  OBJECT_KINDS,
  type ObjectKind,
  objectIdOf,
  objectKindOf,
  REMOTE_FOLDER,
  type RemoteMode,
  type RemoteRepo,
  remoteNames,
  SECRET_FIELDS,
  type SftpTargetRecord,
  type TargetKind,
  type TargetRecord,
  type TargetSecretField,
  targetIdOfSecret,
  targetSecretName,
} from "../targets/types";
import { remotePath } from "../targets/validate";
import type { BackupService } from "./backup";
import { rejected } from "./checkpoint-transfer";

/** A record read from a target is trusted only up to this size. A real record is a few hundred bytes. */
const MAX_RECORD_BYTES = 64 * 1024;

interface S3Draft {
  readonly kind: "s3";
  readonly path: string;
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** A null fingerprint asks the server to present its key, which a test returns so the operator can confirm it. */
interface SftpDraft {
  readonly kind: "sftp";
  readonly path: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly privateKey: string;
  readonly hostKeyFingerprint: string | null;
}

/** A WebDAV collection. The password is kept as a secret, like the other kinds' credentials. */
interface WebdavDraft {
  readonly kind: "webdav";
  readonly path: string;
  readonly url: string;
  readonly user: string;
  readonly password: string;
}

/** What a target is reached with, before it is stored. Its paths and endpoints are already normalized. */
export type TargetDraft = S3Draft | SftpDraft | WebdavDraft;

/** A target as the API and the console see it. Credentials are never part of it, only whether they are held. */
export interface TargetView {
  readonly id: string;
  readonly name: string;
  readonly kind: TargetKind;
  readonly address: string;
  readonly path: string;
  readonly hostKeyFingerprint: string | null;
  readonly credentials: boolean;
  readonly lastSync: LastSync | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** An object a target holds whole: its archive is there, and its record matches the archive. */
export interface TargetObject {
  readonly kind: ObjectKind;
  readonly id: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly createdAt: string;
}

/**
 * The remote repository a host's checkpoints are copied to, as the API shows it. The folder is the base the operator
 * chose; the host id is appended to it when the repository string is built, so two hosts never share one.
 */
export interface RemoteRepoView {
  readonly hostId: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly kind: "s3" | "sftp";
  /** `sync` keeps the local repository and copies to this one; `only` has no local repository. */
  readonly mode: RemoteMode;
  readonly path: string;
  readonly lastSyncAt: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TargetSyncResult {
  readonly target: TargetView;
  readonly object: string;
  readonly kind: ObjectKind;
  readonly bytes: number;
  /** True when the other side already held the same object, so nothing was sent or stored. */
  readonly skipped: boolean;
}

/** What a host's remote checkpoint repository is set to, before it is stored. */
export interface SetRemoteInput {
  readonly targetId: string;
  readonly path?: string;
  /** Defaults to the mode already stored, or `sync` for a host that has none. */
  readonly mode?: RemoteMode;
}

export interface TargetServiceOptions {
  readonly dataDir: string;
  /** The env secret store. Target credentials are named `target.<id>.<field>`, which no box can reference. */
  readonly secrets: SecretStore;
  readonly checkpoints: CheckpointStore;
  readonly backups: BackupService;
  /** Hands a credential to the redactor, so it never reaches a log, an event or a task line. */
  readonly onSecret: (value: string) => void;
}

export type Progress = (line: string) => void;

interface Held {
  readonly bytes: number;
  readonly sha256: string;
}

interface Local extends Held {
  readonly record: string;
  body(): AsyncIterable<Uint8Array>;
}

function targetView(record: TargetRecord, credentials: boolean): TargetView {
  const address =
    record.kind === "s3"
      ? `${record.endpoint}/${record.bucket}`
      : record.kind === "webdav"
        ? record.url
        : `${record.user}@${record.host}:${record.port}`;
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    address,
    path: record.path,
    hostKeyFingerprint: record.kind === "sftp" ? record.hostKeyFingerprint : null,
    credentials,
    lastSync: record.lastSync,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Maps a target failure to the response the caller gets. Anything else is not a target failure and passes through. */
function toTargetError(e: unknown): unknown {
  if (!(e instanceof TargetFailure)) return e;
  switch (e.reason) {
    case "unreachable":
      return new AppError(502, "bad_gateway", msg("target_unreachable"), { reason: e.reason });
    case "auth":
      return new AppError(502, "bad_gateway", msg("target_auth_failed"), { reason: e.reason });
    case "forbidden":
      return new AppError(502, "bad_gateway", msg("target_forbidden"), { reason: e.reason });
    case "missing":
      return notFound(msg("target_object_missing", { object: e.message }));
    case "host_key_unconfirmed":
      return new AppError(409, "conflict", msg("target_host_key_unconfirmed", { fingerprint: e.fingerprint ?? "" }), {
        fingerprint: e.fingerprint,
      });
    case "host_key_mismatch":
      return new AppError(409, "conflict", msg("target_host_key_mismatch", { fingerprint: e.fingerprint ?? "" }), {
        fingerprint: e.fingerprint,
      });
    case "failed":
      return new AppError(502, "bad_gateway", msg("target_failed", { reason: e.message }), { reason: e.reason });
  }
}

function credentialsOf(draft: TargetDraft): { field: TargetSecretField; value: string }[] {
  if (draft.kind === "s3") {
    return [
      { field: "access-key", value: draft.accessKeyId },
      { field: "secret-key", value: draft.secretAccessKey },
    ];
  }
  if (draft.kind === "webdav") return [{ field: "password", value: draft.password }];
  return [{ field: "private-key", value: draft.privateKey }];
}

function connectionOfDraft(draft: TargetDraft): TargetConnection {
  if (draft.kind === "s3") {
    return {
      kind: "s3",
      endpoint: draft.endpoint,
      region: draft.region,
      bucket: draft.bucket,
      path: draft.path,
      accessKeyId: draft.accessKeyId,
      secretAccessKey: draft.secretAccessKey,
    };
  }
  if (draft.kind === "webdav") {
    return { kind: "webdav", url: draft.url, user: draft.user, password: draft.password, path: draft.path };
  }
  return {
    kind: "sftp",
    host: draft.host,
    port: draft.port,
    user: draft.user,
    path: draft.path,
    privateKey: draft.privateKey,
    hostKeyFingerprint: draft.hostKeyFingerprint,
  };
}

function recordOf(id: string, name: string, draft: TargetDraft, now: string): TargetRecord {
  const base = { id, name, path: draft.path, createdAt: now, updatedAt: now, lastSync: null };
  if (draft.kind === "s3") {
    return { ...base, kind: "s3", endpoint: draft.endpoint, region: draft.region, bucket: draft.bucket };
  }
  if (draft.kind === "webdav") {
    return { ...base, kind: "webdav", url: draft.url, user: draft.user };
  }
  return {
    ...base,
    kind: "sftp",
    host: draft.host,
    port: draft.port,
    user: draft.user,
    hostKeyFingerprint: draft.hostKeyFingerprint ?? "",
  };
}

function invalidObject(object: string, reason: string): AppError {
  return badRequest(msg("target_object_invalid", { reason: `${object}: ${reason}` }));
}

function kindOf(object: string): ObjectKind {
  const kind = objectKindOf(object);
  if (kind === null)
    throw badRequest(msg("target_object_invalid", { reason: `${object} is not a package or backup id` }));
  return kind;
}

function packageRecordOf(text: string, object: string): PackageMeta {
  const parsed = PackageMetaSchema.safeParse(parseJson(text, object));
  if (!parsed.success || parsed.data.id !== object) throw invalidObject(object, "not a package record");
  return parsed.data;
}

function backupRecordOf(text: string, object: string): BackupRecord {
  const parsed = BackupRecordSchema.safeParse(parseJson(text, object));
  if (!parsed.success || parsed.data.id !== object) throw invalidObject(object, "not a backup record");
  return parsed.data;
}

function parseJson(text: string, object: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw invalidObject(object, "the record is not JSON");
  }
}

/**
 * The text of a small object, read only as far as `limit` bytes. A server that reports a small size and then sends more
 * cannot make the host read an archive into memory under the name of a record.
 */
async function collectLimited(source: AsyncIterable<Uint8Array>, object: string, limit: number): Promise<string> {
  const parts: Uint8Array[] = [];
  let read = 0;
  for await (const chunk of source) {
    read += chunk.byteLength;
    if (read > limit) throw invalidObject(object, `the record is larger than ${limit} bytes`);
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString("utf8");
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

/**
 * Off-site targets: S3-compatible buckets, SFTP folders and WebDAV collections that checkpoint packages and backups are
 * pushed to and pulled from. A push writes the archive and then its record, so a target lists an object only when its record is there. A pull
 * stores an archive only once it matches its record. Both are idempotent: an object the other side already holds is
 * skipped, and an object held with other contents is refused rather than replaced.
 */
export class TargetService {
  private readonly store: TargetStore;
  private readonly busy = new Set<string>();
  private readonly pulling = new Set<string>();

  constructor(private readonly options: TargetServiceOptions) {
    this.store = new TargetStore(options.dataDir);
  }

  /**
   * Reads the targets and hands every credential to the redactor. A credential that no target owns is left behind by an
   * interrupted add or remove, and is swept here. Runs once at startup, before any request is served.
   */
  start(): void {
    this.store.load();
    const owners = new Set(this.store.list().map((record) => record.id));
    for (const meta of this.options.secrets.list()) {
      if (!isTargetSecretName(meta.name)) continue;
      const owner = targetIdOfSecret(meta.name);
      if (owner === null || !owners.has(owner)) {
        this.options.secrets.remove(meta.name);
        log.info("target.secret_swept", { name: meta.name });
        continue;
      }
      const value = this.options.secrets.value(meta.name);
      if (value !== null) this.options.onSecret(value);
    }
  }

  list(): TargetView[] {
    return this.store.list().map((record) => this.viewOf(record));
  }

  get(id: string): TargetView {
    return this.viewOf(this.recordOf(id));
  }

  /** The remote repository a host's checkpoints are copied to, or null when it has none. */
  remoteOf(hostId: string): RemoteRepoView | null {
    const remote = this.store.remoteOf(hostId);
    return remote ? this.remoteView(remote) : null;
  }

  /**
   * Sets the remote repository of a host to a folder on one of its targets. Changing the target clears the sync state,
   * since the new repository has not taken the snapshots yet. The credentials are not copied here: they stay the
   * target's, and are read when a copy runs. A host in remote-only mode can only be moved or switched when it holds no
   * checkpoint records, since a record names a snapshot in the repository it was taken in.
   */
  setRemote(hostId: string, input: SetRemoteInput): RemoteRepoView {
    const remote = this.remoteCandidate(hostId, input);
    this.store.putRemote(remote);
    log.info("target.remote_set", {
      host: hostId,
      target: remote.targetId,
      kind: remote.kind,
      mode: remote.mode ?? "sync",
    });
    return this.remoteView(remote);
  }

  /**
   * What a copy to the position a `setRemote` would store needs, credentials included, without storing anything. The set
   * operation opens the repository with it before it saves a remote-only host.
   */
  previewRemoteRepository(hostId: string, input: SetRemoteInput): Promise<RemoteRepository> {
    return this.attempt(async () => {
      const remote = this.remoteCandidate(hostId, input);
      return await this.repositoryOf(hostId, remote);
    });
  }

  /**
   * Removes a host's remote repository. The snapshots already copied stay where they are. In remote-only mode the
   * repository is the host's only copy, so it can only be cleared when the host holds no checkpoint records.
   */
  clearRemote(hostId: string): void {
    const existing = this.store.remoteOf(hostId);
    if (!existing) return;
    if ((existing.mode ?? "sync") === "only") this.assertNoCheckpoints(hostId);
    if (!this.store.deleteRemote(hostId)) return;
    log.info("target.remote_cleared", { host: hostId });
  }

  /**
   * Drops the remote repository record of a host that is gone. No checkpoint check runs: a forced removal has already
   * dropped the host's records, and an ordinary removal could not have run while it held any. Only the record goes; the
   * snapshots on the remote and the repository's password file stay there, so a host added again under the same id and
   * set back to the same position opens the same repository.
   */
  forgetHost(hostId: string): void {
    const remote = this.store.remoteOf(hostId);
    if (!remote) return;
    if (!this.store.deleteRemote(hostId)) return;
    log.info("target.remote_dropped_with_host", {
      host: hostId,
      target: remote.targetId,
      mode: remote.mode ?? "sync",
      path: remotePathFor(remote.path, hostId),
    });
  }

  /** Records how the last copy to a host's remote repository ended. A null error marks a successful copy. */
  recordRemoteResult(hostId: string, result: { at: string; error: string | null }): void {
    const remote = this.store.remoteOf(hostId);
    if (!remote) return;
    try {
      this.store.putRemote({
        ...remote,
        lastSyncAt: result.error === null ? result.at : remote.lastSyncAt,
        lastError: result.error,
      });
    } catch (e) {
      log.warn("target.remote_result_not_recorded", { host: hostId, error: String(e) });
    }
  }

  /**
   * What a copy to the host's remote repository needs, credentials included. An SFTP target needs the server's whole
   * public key for known_hosts, so one is captured from the pinned key exchange when the record does not hold it yet.
   * Nothing is copied here, and no password is created for a host that has no remote.
   */
  remoteRepository(hostId: string): Promise<RemoteRepository> {
    return this.attempt(async () => {
      const remote = this.store.remoteOf(hostId);
      if (!remote) throw notFound(msg("checkpoint_remote_not_set", { host: hostId }));
      return await this.repositoryOf(hostId, remote);
    });
  }

  private async repositoryOf(hostId: string, remote: RemoteRepo): Promise<RemoteRepository> {
    const target = this.store.get(remote.targetId);
    if (!target) throw notFound(msg("target_not_found", { id: remote.targetId }));
    const path = remotePathFor(remote.path, hostId);
    const password = remoteRepoPassword(this.options.dataDir, hostId);
    const secret = (field: TargetSecretField) => this.options.secrets.value(targetSecretName(target.id, field));
    if (target.kind === "s3") {
      const accessKeyId = secret("access-key");
      const secretAccessKey = secret("secret-key");
      if (accessKeyId === null || secretAccessKey === null) {
        throw conflict(msg("target_credentials_missing", { name: target.name }));
      }
      return {
        targetId: target.id,
        targetName: target.name,
        repository: s3Repository(target.endpoint, target.bucket, path),
        password,
        credentials: { kind: "s3" as const, region: target.region, accessKeyId, secretAccessKey },
      };
    }
    if (target.kind === "webdav") throw badRequest(msg("checkpoint_remote_unsupported"));
    const privateKey = secret("private-key");
    if (privateKey === null) throw conflict(msg("target_credentials_missing", { name: target.name }));
    const key = await this.hostKeyLineOf(target);
    return {
      targetId: target.id,
      targetName: target.name,
      repository: sftpRepository(target.user, target.host, target.port, path),
      password,
      credentials: {
        kind: "sftp" as const,
        port: target.port,
        privateKey,
        knownHosts: knownHostsLine(target.host, target.port, key),
      },
    };
  }

  /**
   * What a `setRemote` with `input` would change, without storing anything. A caller can use it to take a relocation
   * gate only when the change involves `only` and actually moves the position.
   */
  remoteMove(hostId: string, input: SetRemoteInput): { changed: boolean; mode: RemoteMode; involvesOnly: boolean } {
    const plan = this.remotePlan(hostId, input);
    return { changed: plan.changed, mode: plan.remote.mode ?? "sync", involvesOnly: plan.involvesOnly };
  }

  /** The remote a set would store, with its mode resolved. Refuses a move that would orphan the host's checkpoint records. */
  private remoteCandidate(hostId: string, input: SetRemoteInput): RemoteRepo {
    const plan = this.remotePlan(hostId, input);
    // A record names a snapshot in the repository it was taken in. Moving or switching a remote-only host would leave
    // those records pointing at a repository the snapshots are not in, so a host with any record (a recycle bin entry is
    // a record too) stays where it is until they are deleted.
    if (plan.changed && plan.involvesOnly) this.assertNoCheckpoints(hostId);
    return plan.remote;
  }

  private remotePlan(
    hostId: string,
    input: SetRemoteInput,
  ): { remote: RemoteRepo; changed: boolean; involvesOnly: boolean } {
    const target = this.store.get(input.targetId);
    if (!target) throw notFound(msg("target_not_found", { id: input.targetId }));
    if (target.kind === "webdav") throw badRequest(msg("checkpoint_remote_unsupported"), { field: "targetId" });
    const path = remotePath(input.path ?? "", target.kind);
    if (path === null) throw badRequest(msg("target_path_invalid"), { field: "path" });
    const existing = this.store.remoteOf(hostId);
    const currentMode = existing?.mode ?? "sync";
    const mode = input.mode ?? currentMode;
    const changed = !existing || existing.targetId !== target.id || existing.path !== path || currentMode !== mode;
    const sameTarget = existing?.targetId === target.id;
    const sameMode = currentMode === mode;
    const now = new Date().toISOString();
    return {
      changed,
      involvesOnly: currentMode === "only" || mode === "only",
      remote: {
        hostId,
        mode,
        targetId: target.id,
        kind: target.kind,
        path,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        lastSyncAt: sameTarget && sameMode ? (existing?.lastSyncAt ?? null) : null,
        lastError: sameTarget && sameMode ? (existing?.lastError ?? null) : null,
      },
    };
  }

  /** A host in remote-only mode can only move or be cleared while every checkpoint record has been deleted. */
  private assertNoCheckpoints(hostId: string): void {
    const count = this.options.checkpoints.list().filter((record) => record.hostId === hostId).length;
    if (count > 0) throw conflict(msg("checkpoint_remote_has_checkpoints", { host: hostId, count }));
  }

  /** Reaches the target with the draft's credentials and stores nothing. */
  async test(draft: TargetDraft): Promise<void> {
    await this.attempt(async () => {
      const session = await openSession(connectionOfDraft(draft));
      try {
        await session.probe();
      } finally {
        await session.close();
      }
    });
  }

  /** Stores a new target. Credentials are written before the record, so a stored target always has what it needs. */
  add(name: string, draft: TargetDraft): TargetView {
    if (this.store.list().some((record) => record.name === name)) {
      throw conflict(msg("target_name_taken", { name }));
    }
    if (draft.kind === "sftp" && draft.hostKeyFingerprint === null) {
      throw badRequest(msg("target_host_key_required"), { field: "hostKeyFingerprint" });
    }
    const id = newTargetId();
    const now = new Date().toISOString();
    try {
      for (const { field, value } of credentialsOf(draft)) {
        this.options.secrets.set(targetSecretName(id, field), value, now);
        this.options.onSecret(value);
      }
      const record = recordOf(id, name, draft, now);
      this.store.put(record);
      log.info("target.added", { id, kind: record.kind });
      return this.viewOf(record);
    } catch (e) {
      this.dropSecrets(id);
      throw e;
    }
  }

  remove(id: string): void {
    const record = this.recordOf(id);
    if (this.busy.has(id)) throw conflict(msg("target_busy", { name: record.name }));
    const used = this.store.remotesFor(id);
    if (used.length > 0) {
      throw conflict(msg("target_in_use", { name: record.name, host: used[0]?.hostId ?? "" }));
    }
    this.store.delete(id);
    this.dropSecrets(id);
    log.info("target.removed", { id });
  }

  /** Reaches a stored target with its own credentials. Its objects and its last sync are left as they are. */
  async check(id: string): Promise<void> {
    const record = this.recordOf(id);
    await this.attempt(async () => {
      const capture = record.kind === "sftp" ? (key: string) => this.storeHostKeyLine(record, key) : undefined;
      const session = await this.sessionOf(record, capture);
      try {
        await session.probe();
      } finally {
        await session.close();
      }
    });
  }

  /** The complete objects on a target, newest first. An object whose record is not valid is left out. */
  async objects(id: string): Promise<TargetObject[]> {
    const record = this.recordOf(id);
    return this.attempt(async () => {
      const session = await this.sessionOf(record);
      try {
        const found: TargetObject[] = [];
        for (const kind of OBJECT_KINDS) {
          const folder = REMOTE_FOLDER[kind];
          for (const archive of await session.list(folder)) {
            const object = objectIdOf(kind, archive.name.slice(folder.length + 1));
            if (object === null) continue;
            const remote = await this.completeRecord(session, kind, object, archive.bytes);
            if (remote !== null) {
              found.push({ kind, id: object, bytes: remote.bytes, sha256: remote.sha256, createdAt: remote.createdAt });
            }
          }
        }
        return found.toSorted((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
      } finally {
        await session.close();
      }
    });
  }

  push(id: string, object: string, progress?: Progress): Promise<TargetSyncResult> {
    return this.sync(id, "push", object, progress, async (session, kind) => {
      const local = this.localObject(kind, object);
      const names = remoteNames(kind, object);
      const text = await this.recordTextOf(session, names.record, object);
      if (text !== null) {
        const remote = kind === "package" ? packageRecordOf(text, object) : backupRecordOf(text, object);
        if (remote.bytes !== local.bytes || remote.sha256 !== local.sha256) {
          throw conflict(msg("target_object_differs", { object }));
        }
        if ((await session.stat(names.archive))?.bytes === local.bytes) return { bytes: local.bytes, skipped: true };
      }
      progress?.(`Uploading ${names.archive}\n`);
      await session.write(names.archive, local.body(), local.bytes);
      const record = new TextEncoder().encode(local.record);
      await session.write(names.record, once(record), record.byteLength);
      return { bytes: local.bytes, skipped: false };
    });
  }

  /**
   * Stores an object from a target. Two pulls of one object run one at a time, even from different targets, since both
   * would write the same file.
   */
  async pull(id: string, object: string, progress?: Progress): Promise<TargetSyncResult> {
    if (this.pulling.has(object)) throw conflict(msg("target_object_busy", { object }));
    this.pulling.add(object);
    try {
      return await this.sync(id, "pull", object, progress, async (session, kind, record) => {
        const names = remoteNames(kind, object);
        const text = await this.recordTextOf(session, names.record, object);
        if (text === null) throw notFound(msg("target_object_missing", { object }));
        if (kind === "package") {
          const remote = packageRecordOf(text, object);
          const held = this.heldPackage(object);
          if (held !== null) {
            this.assertSame(held, remote, msg("target_object_held", { object }));
            return { bytes: remote.bytes, skipped: true };
          }
          progress?.(`Downloading ${names.archive}\n`);
          await this.storePackage(object, remote, await session.read(names.archive));
          return { bytes: remote.bytes, skipped: false };
        }
        const remote = backupRecordOf(text, object);
        const held = this.options.backups.whole(object);
        if (held !== null) {
          this.assertSame(held, remote, msg("target_object_held", { object }));
          return { bytes: remote.bytes, skipped: true };
        }
        progress?.(`Downloading ${names.archive}\n`);
        const pulled: BackupRecord = { ...remote, origin: "target", targetId: record.id };
        await this.options.backups.receive(pulled, await session.read(names.archive));
        return { bytes: remote.bytes, skipped: false };
      });
    } finally {
      this.pulling.delete(object);
    }
  }

  private async sync(
    id: string,
    direction: "push" | "pull",
    object: string,
    progress: Progress | undefined,
    run: (session: TargetSession, kind: ObjectKind, record: TargetRecord) => Promise<Outcome>,
  ): Promise<TargetSyncResult> {
    const record = this.recordOf(id);
    const kind = kindOf(object);
    if (this.busy.has(id)) throw conflict(msg("target_busy", { name: record.name }));
    this.busy.add(id);
    const at = new Date().toISOString();
    try {
      const outcome = await this.attempt(async () => {
        const session = await this.sessionOf(record);
        try {
          return await run(session, kind, record);
        } finally {
          await session.close();
        }
      });
      this.recordSync(id, { at, direction, kind, object, bytes: outcome.bytes, error: null });
      progress?.(`${direction === "push" ? "Pushed" : "Pulled"} ${object}\n`);
      return {
        target: this.get(id),
        object,
        kind,
        bytes: outcome.bytes,
        skipped: outcome.skipped,
      };
    } catch (e) {
      const error = toTargetError(e);
      this.recordSync(id, {
        at,
        direction,
        kind,
        object,
        bytes: 0,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.busy.delete(id);
    }
  }

  private async attempt<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      throw toTargetError(e);
    }
  }

  private recordOf(id: string): TargetRecord {
    const record = this.store.get(id);
    if (!record) throw notFound(msg("target_not_found", { id }));
    return record;
  }

  private viewOf(record: TargetRecord): TargetView {
    const credentials = SECRET_FIELDS[record.kind].every(
      (field) => this.options.secrets.meta(targetSecretName(record.id, field)) !== null,
    );
    return targetView(record, credentials);
  }

  private connectionOf(record: TargetRecord): TargetConnection {
    const secret = (field: TargetSecretField) => this.options.secrets.value(targetSecretName(record.id, field));
    if (record.kind === "s3") {
      const accessKeyId = secret("access-key");
      const secretAccessKey = secret("secret-key");
      if (accessKeyId === null || secretAccessKey === null) {
        throw conflict(msg("target_credentials_missing", { name: record.name }));
      }
      return {
        kind: "s3",
        endpoint: record.endpoint,
        region: record.region,
        bucket: record.bucket,
        path: record.path,
        accessKeyId,
        secretAccessKey,
      };
    }
    if (record.kind === "webdav") {
      const password = secret("password");
      if (password === null) throw conflict(msg("target_credentials_missing", { name: record.name }));
      return { kind: "webdav", url: record.url, user: record.user, password, path: record.path };
    }
    const privateKey = secret("private-key");
    if (privateKey === null) throw conflict(msg("target_credentials_missing", { name: record.name }));
    return {
      kind: "sftp",
      host: record.host,
      port: record.port,
      user: record.user,
      path: record.path,
      privateKey,
      hostKeyFingerprint: record.hostKeyFingerprint,
    };
  }

  private sessionOf(record: TargetRecord, onHostKey?: (key: string) => void): Promise<TargetSession> {
    const connection = this.connectionOf(record);
    return openSession(connection.kind === "sftp" && onHostKey ? { ...connection, onHostKey } : connection);
  }

  /**
   * The server's public key as `type base64`, or the one the record already holds. A key only comes from a connection
   * whose fingerprint matches the pinned one; a server that presents another key is refused, never trusted on first use.
   */
  private async hostKeyLineOf(record: SftpTargetRecord): Promise<string> {
    if (record.hostKeyLine) return record.hostKeyLine;
    const presented = await probePublicKey(record.host, record.port).catch((e: unknown) => {
      throw classifyFailure(e);
    });
    if (presented.fingerprint !== record.hostKeyFingerprint) {
      throw new TargetFailure(
        "host_key_mismatch",
        `host key ${presented.fingerprint} does not match ${record.hostKeyFingerprint}`,
        presented.fingerprint,
      );
    }
    this.storeHostKeyLine(record, presented.text);
    return presented.text;
  }

  /** Keeps the public key a pinned connection presented. A write that fails only costs another capture later. */
  private storeHostKeyLine(record: TargetRecord, key: string): void {
    if (record.kind !== "sftp") return;
    const current = this.store.get(record.id);
    if (!current || current.kind !== "sftp" || current.hostKeyLine === key) return;
    try {
      this.store.put({ ...current, hostKeyLine: key });
    } catch (e) {
      log.warn("target.host_key_not_stored", { id: record.id, error: String(e) });
    }
  }

  private remoteView(record: RemoteRepo): RemoteRepoView {
    const target = this.store.get(record.targetId);
    return {
      hostId: record.hostId,
      targetId: record.targetId,
      targetName: target?.name ?? record.targetId,
      kind: record.kind,
      mode: record.mode ?? "sync",
      path: remotePathFor(record.path, record.hostId),
      lastSyncAt: record.lastSyncAt,
      lastError: record.lastError,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private dropSecrets(id: string): void {
    for (const meta of this.options.secrets.list()) {
      if (targetIdOfSecret(meta.name) === id) this.options.secrets.remove(meta.name);
    }
  }

  private recordSync(id: string, sync: LastSync): void {
    const record = this.store.get(id);
    if (!record) return;
    try {
      this.store.put({ ...record, lastSync: sync });
    } catch (e) {
      log.warn("target.sync_not_recorded", { id, error: String(e) });
    }
  }

  private localObject(kind: ObjectKind, object: string): Local {
    if (kind === "package") {
      const packages = this.options.checkpoints.packages;
      const meta = packages.read(object);
      if (!meta || isExpired(meta, Date.now()) || packages.fileBytes(object) !== meta.bytes) {
        throw notFound(msg("package_not_found", { id: object }));
      }
      return {
        bytes: meta.bytes,
        sha256: meta.sha256,
        record: `${JSON.stringify(meta, null, 2)}\n`,
        body: () => Bun.file(packages.pathFor(object)).stream(),
      };
    }
    const backup = this.options.backups.stored(object);
    return {
      bytes: backup.bytes,
      sha256: backup.sha256,
      record: `${JSON.stringify(backup, null, 2)}\n`,
      body: () => Bun.file(this.options.backups.store.pathFor(object)).stream(),
    };
  }

  /**
   * A stored package that is whole and not expired, or null. A copy that is expired or whose file is gone is removed
   * first, so a pull can store a fresh one.
   */
  private heldPackage(object: string): PackageMeta | null {
    const packages = this.options.checkpoints.packages;
    const meta = packages.read(object);
    if (meta === null) return null;
    if (isExpired(meta, Date.now()) || packages.fileBytes(object) !== meta.bytes) {
      packages.remove(object);
      return null;
    }
    return meta;
  }

  private assertSame(held: Held, remote: Held, conflictMessage: Msg): void {
    if (held.bytes !== remote.bytes || held.sha256 !== remote.sha256) throw conflict(conflictMessage);
  }

  private async storePackage(object: string, remote: PackageMeta, body: AsyncIterable<Uint8Array>): Promise<void> {
    const packages = this.options.checkpoints.packages;
    packages.begin(object);
    try {
      packages.remove(object);
      const digest = await writePackageFile(body, packages.pathFor(object), packages.maxBytes).catch(rejected);
      if (digest.bytes !== remote.bytes || digest.sha256 !== remote.sha256) {
        throw invalidObject(object, "the archive does not match its record");
      }
      packages.write({ ...remote, origin: "target", expiresAt: expiresAtFor(Date.now()) });
    } catch (e) {
      packages.remove(object);
      throw e;
    } finally {
      packages.end(object);
    }
  }

  /** The text of a record, or null when the target holds none. A record larger than any real one is refused. */
  private async recordTextOf(session: TargetSession, name: string, object: string): Promise<string | null> {
    const found = await session.stat(name);
    if (found === null) return null;
    if (found.bytes > MAX_RECORD_BYTES) throw invalidObject(object, "the record is too large");
    return await collectLimited(await session.read(name), object, MAX_RECORD_BYTES);
  }

  /**
   * The record of an object the target holds whole, or null. A record that is not valid, or that does not match the
   * archive, leaves the object out of the listing. A failure of the connection itself is not swallowed.
   */
  private async completeRecord(
    session: TargetSession,
    kind: ObjectKind,
    object: string,
    archiveBytes: number,
  ): Promise<(Held & { createdAt: string }) | null> {
    try {
      const text = await this.recordTextOf(session, remoteNames(kind, object).record, object);
      if (text === null) return null;
      const remote = kind === "package" ? packageRecordOf(text, object) : backupRecordOf(text, object);
      return remote.bytes === archiveBytes ? remote : null;
    } catch (e) {
      if (e instanceof AppError && e.status === 400) return null;
      throw e;
    }
  }
}

interface Outcome {
  readonly bytes: number;
  readonly skipped: boolean;
}
