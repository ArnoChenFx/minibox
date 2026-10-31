import { randomBytes } from "node:crypto";

import { z } from "zod";

import { BACKUP_EXTENSION, isBackupId } from "../backup/store";
import { isPackageId, PACKAGE_EXTENSION } from "../checkpoints/package";

export const TARGET_VERSION = 1;
export const TARGET_KINDS = ["s3", "sftp", "webdav"] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];
export const OBJECT_KINDS = ["package", "backup"] as const;
export type ObjectKind = (typeof OBJECT_KINDS)[number];

/**
 * Secrets whose names start with this prefix hold a target's credentials. A box, a clone and the secret API never read
 * or write them, so a credential for a target cannot reach a container.
 */
const TARGET_SECRET_PREFIX = "target.";
const TARGET_ID_RE = /^tgt_[0-9a-z]{8,32}$/;
const TARGET_SECRET_RE = /^target\.(tgt_[0-9a-z]{8,32})\.(access-key|secret-key|private-key|password)$/;
const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function isTargetId(value: string): boolean {
  return TARGET_ID_RE.test(value);
}

/** A stable id for a target. It names no place, so the name and the endpoint can change without a new id. */
export function newTargetId(): string {
  let id = "tgt_";
  for (const byte of randomBytes(16)) id += ID_ALPHABET[byte % ID_ALPHABET.length] ?? "0";
  return id;
}

export type TargetSecretField = "access-key" | "secret-key" | "private-key" | "password";

export const SECRET_FIELDS: Readonly<Record<TargetKind, readonly TargetSecretField[]>> = {
  s3: ["access-key", "secret-key"],
  sftp: ["private-key"],
  webdav: ["password"],
};

export function targetSecretName(id: string, field: TargetSecretField): string {
  return `${TARGET_SECRET_PREFIX}${id}.${field}`;
}

export function isTargetSecretName(name: string): boolean {
  return name.startsWith(TARGET_SECRET_PREFIX);
}

/** The target a credential belongs to, when the secret name is one of a target's credentials. */
export function targetIdOfSecret(name: string): string | null {
  return TARGET_SECRET_RE.exec(name)?.[1] ?? null;
}

/** The kind of object an id names. A package and a backup have their own prefixes, so the id alone says which. */
export function objectKindOf(object: string): ObjectKind | null {
  if (isPackageId(object)) return "package";
  if (isBackupId(object)) return "backup";
  return null;
}

/** The folder a kind of object lives in on a target, and the names of its archive and its record. */
export const REMOTE_FOLDER: Record<ObjectKind, string> = { package: "packages", backup: "backups" };
const REMOTE_EXTENSION: Record<ObjectKind, string> = { package: PACKAGE_EXTENSION, backup: BACKUP_EXTENSION };

export function remoteNames(kind: ObjectKind, object: string): { folder: string; archive: string; record: string } {
  const folder = REMOTE_FOLDER[kind];
  return {
    folder,
    archive: `${folder}/${object}${REMOTE_EXTENSION[kind]}`,
    record: `${folder}/${object}.json`,
  };
}

/** The object id an archive's file name carries, when the name is one of the kind's archives and the id is well formed. */
export function objectIdOf(kind: ObjectKind, fileName: string): string | null {
  const suffix = REMOTE_EXTENSION[kind];
  if (!fileName.endsWith(suffix)) return null;
  const object = fileName.slice(0, -suffix.length);
  return objectKindOf(object) === kind ? object : null;
}

const SyncSchema = z.strictObject({
  at: z.iso.datetime(),
  direction: z.enum(["push", "pull"]),
  kind: z.enum(OBJECT_KINDS),
  object: z.string(),
  bytes: z.number().int().min(0),
  error: z.string().nullable(),
});

export type LastSync = z.infer<typeof SyncSchema>;

const TargetBase = {
  id: z.string().refine(isTargetId, "not a target id"),
  name: z.string().min(1).max(64),
  path: z.string().max(512),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  lastSync: SyncSchema.nullable(),
};

/**
 * A target as stored in `DATA_DIR/targets.json`. It holds the place to reach and never a credential: those are secrets
 * named `target.<id>.<field>`. The file is mode 600 all the same, because the host key pin and the last sync are kept
 * there too.
 */
const S3TargetSchema = z.strictObject({
  ...TargetBase,
  kind: z.literal("s3"),
  endpoint: z.string().min(1).max(512),
  region: z.string().min(1).max(64),
  bucket: z.string().min(1).max(63),
});

const SftpTargetSchema = z.strictObject({
  ...TargetBase,
  kind: z.literal("sftp"),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  user: z.string().min(1).max(64),
  hostKeyFingerprint: z.string().min(1).max(128),
});

const WebdavTargetSchema = z.strictObject({
  ...TargetBase,
  kind: z.literal("webdav"),
  url: z.string().min(1).max(512),
  user: z.string().min(1).max(128),
});

const TargetRecordSchema = z.discriminatedUnion("kind", [S3TargetSchema, SftpTargetSchema, WebdavTargetSchema]);

export type TargetRecord = z.infer<typeof TargetRecordSchema>;
export type S3TargetRecord = z.infer<typeof S3TargetSchema>;
export type SftpTargetRecord = z.infer<typeof SftpTargetSchema>;
export type WebdavTargetRecord = z.infer<typeof WebdavTargetSchema>;

export const TargetFileSchema = z.strictObject({
  version: z.literal(TARGET_VERSION),
  targets: z.array(TargetRecordSchema),
});
