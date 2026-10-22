import { type BackupRecord, BackupRecordSchema } from "../backup/store";
import { writePackageFile } from "../checkpoints/package";
import { expiresAtFor, isExpired, type PackageMeta, PackageMetaSchema } from "../checkpoints/packages";
import type { CheckpointStore } from "../checkpoints/store";
import { AppError, badRequest, conflict, notFound } from "../lib/errors";
import { log } from "../lib/logger";
import { type Msg, msg } from "../lib/messages";
import type { SecretStore } from "../secrets/store";
import { TargetFailure } from "../targets/errors";
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
  remoteNames,
  SECRET_FIELDS,
  type TargetKind,
  type TargetRecord,
  type TargetSecretField,
  targetIdOfSecret,
  targetSecretName,
} from "../targets/types";
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

/** What a target is reached with, before it is stored. Its paths and endpoints are already normalized. */
export type TargetDraft = S3Draft | SftpDraft;

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

export interface TargetSyncResult {
  readonly target: TargetView;
  readonly object: string;
  readonly kind: ObjectKind;
  readonly bytes: number;
  /** True when the other side already held the same object, so nothing was sent or stored. */
  readonly skipped: boolean;
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

export function targetView(record: TargetRecord, credentials: boolean): TargetView {
  const address =
    record.kind === "s3" ? `${record.endpoint}/${record.bucket}` : `${record.user}@${record.host}:${record.port}`;
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
export function toTargetError(e: unknown): unknown {
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

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const chunk of source) parts.push(chunk);
  return Buffer.concat(parts);
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

/**
 * Off-site targets: S3-compatible buckets and SFTP folders that checkpoint packages and backups are pushed to and pulled
 * from. A push writes the archive and then its record, so a target lists an object only when its record is there. A pull
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
    this.store.delete(id);
    this.dropSecrets(id);
    log.info("target.removed", { id });
  }

  /** Reaches a stored target with its own credentials. Its objects and its last sync are left as they are. */
  async check(id: string): Promise<void> {
    const record = this.recordOf(id);
    await this.attempt(async () => {
      const session = await this.sessionOf(record);
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
      await session.write(names.archive, local.body());
      await session.write(names.record, once(new TextEncoder().encode(local.record)));
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

  private sessionOf(record: TargetRecord): Promise<TargetSession> {
    return openSession(this.connectionOf(record));
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
    return (await collect(await session.read(name))).toString("utf8");
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
