import { z } from "zod";

import { checkSshKey, SshKeyError } from "../host/ssh";
import { msg } from "../lib/messages";
import { accept, type Checked, reject } from "../lib/validation";
import { type TargetDraft, type TargetService } from "../services/targets";
import { OBJECT_KINDS, objectKindOf, TARGET_KINDS, type TargetKind } from "../targets/types";
import { remotePath, s3Bucket, s3Endpoint, sftpHost, sftpUser, webdavUrl, webdavUser } from "../targets/validate";
import { defineOperation } from "./define";
import { OkSchema } from "./schemas";
import { addFailure, field } from "./validation";

/** Targets and the credentials they hold are the owner's alone: no token holds this scope. */
const TARGET_SCOPE = "target:manage";
const NAME_MAX = 64;
const SFTP_PORT = 22;
const REGION_RE = /^[A-Za-z0-9-]{1,64}$/;
const PRINTABLE_RE = /^[\x21-\x7e]+$/;
const FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;
const CONTROL_RE = /\p{Cc}/u;
const PASSWORD_MAX = 1024;

const LastSyncSchema = z.object({
  at: z.string(),
  direction: z.enum(["push", "pull"]),
  kind: z.enum(OBJECT_KINDS),
  object: z.string(),
  bytes: z.number().int().min(0),
  error: z.string().nullable(),
});

const TargetSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(TARGET_KINDS),
  address: z.string().meta({
    description:
      "The endpoint and bucket of an S3 target, the host and port of an SFTP server, or the collection URL of a WebDAV target.",
  }),
  path: z.string().meta({
    description:
      "The folder on the target the objects live in. Empty is the bucket root, the login folder or the collection root.",
  }),
  hostKeyFingerprint: z.string().nullable().meta({
    description: "The SFTP server's host key, pinned when the target was added. Null for an S3 or WebDAV target.",
  }),
  credentials: z.boolean().meta({
    description: "Whether the target's credentials are stored. The values are never returned.",
  }),
  lastSync: LastSyncSchema.nullable().meta({
    description: "The last push or pull, or null when there has been none.",
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const TargetObjectSchema = z.object({
  kind: z.enum(OBJECT_KINDS),
  id: z.string(),
  bytes: z.number().int().min(0),
  sha256: z.string(),
  createdAt: z.string(),
});

const SyncResultSchema = z.object({
  target: TargetSchema,
  object: z.string(),
  kind: z.enum(OBJECT_KINDS),
  bytes: z.number().int().min(0),
  skipped: z.boolean().meta({
    description: "True when the target already held the same object, so nothing was sent or stored.",
  }),
});

const TARGET_FIELDS = {
  kind: z
    .enum(TARGET_KINDS)
    .meta({ description: "s3 for an S3-compatible bucket, sftp for an SFTP server, webdav for a WebDAV collection." }),
  path: z.string().max(512).optional().meta({
    description:
      "The folder the objects live in, relative to the target's root. Omitted, they go in the bucket root, the login folder or the collection root.",
  }),
  endpoint: z.string().max(512).optional().meta({
    description:
      "S3 only. The https address of the service, such as https://s3.example.com. Plain http is accepted only for localhost, 127.0.0.1 and [::1].",
  }),
  region: z
    .string()
    .max(64)
    .optional()
    .meta({ description: "S3 only. The region the bucket is in, such as us-east-1." }),
  bucket: z.string().max(63).optional().meta({ description: "S3 only. The bucket that holds the objects." }),
  accessKeyId: z.string().max(256).optional().meta({
    description: "S3 only. The access key id. It is stored as a secret and never returned.",
  }),
  secretAccessKey: z.string().max(1024).optional().meta({
    description: "S3 only. The secret access key. It is stored as a secret and never returned.",
  }),
  host: z.string().max(255).optional().meta({ description: "SFTP only. The host name or address of the server." }),
  port: z.number().int().min(1).max(65535).optional().meta({ description: "SFTP only. The port. Defaults to 22." }),
  user: z.string().max(128).optional().meta({ description: "SFTP and WebDAV only. The user the login is for." }),
  privateKey: z.string().max(16384).optional().meta({
    description:
      "SFTP only. The private key that logs in, in OpenSSH or PEM form without a passphrase. It is stored as a secret and never returned.",
  }),
  hostKeyFingerprint: z.string().max(128).optional().meta({
    description:
      "SFTP only. The server's host key, SHA256:…, as a test reported it. Adding a target needs it, and nothing is sent to a server that presents another key.",
  }),
  url: z.string().max(512).optional().meta({
    description:
      "WebDAV only. The https address of the collection the objects live under, such as https://host/remote.php/dav/files/USER. It may carry a path, and is stored without a trailing slash. Plain http is accepted only for localhost, 127.0.0.1 and [::1].",
  }),
  password: z.string().max(PASSWORD_MAX).optional().meta({
    description: "WebDAV only. The password or app password of the login. It is stored as a secret and never returned.",
  }),
};

const fieldsSchema = z.object(TARGET_FIELDS);
type TargetFields = z.output<typeof fieldsSchema>;

function checkTargetName(value: unknown): Checked<string> {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "" || [...text].length > NAME_MAX || CONTROL_RE.test(text)) {
    return reject(msg("target_name_invalid"), "name");
  }
  return accept(text);
}

const targetName = () =>
  field(checkTargetName, {
    type: "string",
    minLength: 1,
    maxLength: NAME_MAX,
    description: "Name of the target, shown in the console. One line of 1 to 64 characters.",
  });

const targetId = () => z.string().meta({ description: "Target id (tgt_…), as the target list shows it." });

function requireValue(
  ctx: z.RefinementCtx,
  key: string,
  value: string | undefined,
  valid: (text: string) => boolean,
  invalid = msg("target_field_invalid", { label: key }),
): void {
  if (value === undefined || value === "") {
    addFailure(ctx, { message: msg("field_required", { label: key }), field: key });
  } else if (!valid(value)) {
    addFailure(ctx, { message: invalid, field: key });
  }
}

function checkPrivateKey(privateKey: string | undefined, ctx: z.RefinementCtx): void {
  if (privateKey === undefined || privateKey === "") {
    addFailure(ctx, { message: msg("field_required", { label: "privateKey" }), field: "privateKey" });
    return;
  }
  try {
    checkSshKey(privateKey);
  } catch (e) {
    if (!(e instanceof SshKeyError)) throw e;
    addFailure(ctx, { message: msg("target_key_invalid", { reason: e.message }), field: "privateKey" });
  }
}

function checkS3(input: TargetFields, ctx: z.RefinementCtx): void {
  requireValue(ctx, "endpoint", input.endpoint, (text) => s3Endpoint(text) !== null, msg("target_endpoint_invalid"));
  requireValue(ctx, "region", input.region, (text) => REGION_RE.test(text));
  requireValue(ctx, "bucket", input.bucket, s3Bucket);
  requireValue(ctx, "accessKeyId", input.accessKeyId, (text) => PRINTABLE_RE.test(text));
  requireValue(ctx, "secretAccessKey", input.secretAccessKey, (text) => PRINTABLE_RE.test(text));
}

function checkWebdav(input: TargetFields, ctx: z.RefinementCtx): void {
  requireValue(ctx, "url", input.url, (text) => webdavUrl(text) !== null, msg("target_url_invalid"));
  requireValue(ctx, "user", input.user, webdavUser);
  requireValue(ctx, "password", input.password, (text) => text.length <= PASSWORD_MAX && !CONTROL_RE.test(text));
}

function checkSftp(input: TargetFields, ctx: z.RefinementCtx, adding: boolean): void {
  requireValue(ctx, "host", input.host, sftpHost);
  requireValue(ctx, "user", input.user, sftpUser);
  checkPrivateKey(input.privateKey, ctx);
  if (input.hostKeyFingerprint === undefined) {
    if (adding) addFailure(ctx, { message: msg("target_host_key_required"), field: "hostKeyFingerprint" });
  } else if (!FINGERPRINT_RE.test(input.hostKeyFingerprint)) {
    addFailure(ctx, {
      message: msg("target_field_invalid", { label: "hostKeyFingerprint" }),
      field: "hostKeyFingerprint",
    });
  }
}

/** The fields each kind keeps. `user` is shared by SFTP and WebDAV, and `path` by every kind. */
const FIELDS_OF_KIND: Readonly<Record<TargetKind, readonly (keyof TargetFields)[]>> = {
  s3: ["endpoint", "region", "bucket", "accessKeyId", "secretAccessKey"],
  sftp: ["host", "port", "user", "privateKey", "hostKeyFingerprint"],
  webdav: ["url", "user", "password"],
};
const KIND_SPECIFIC = [
  "endpoint",
  "region",
  "bucket",
  "accessKeyId",
  "secretAccessKey",
  "host",
  "port",
  "user",
  "privateKey",
  "hostKeyFingerprint",
  "url",
  "password",
] as const;

/** Each kind takes its own fields, and refuses the other kinds', so a field that would be ignored is an error. */
function checkFields(input: TargetFields, ctx: z.RefinementCtx, adding: boolean): void {
  const allowed: ReadonlySet<string> = new Set(FIELDS_OF_KIND[input.kind]);
  for (const key of KIND_SPECIFIC) {
    if (allowed.has(key)) continue;
    if (input[key] !== undefined) {
      addFailure(ctx, { message: msg("target_field_not_allowed", { label: key }), field: key });
    }
  }
  if (input.path !== undefined && remotePath(input.path, input.kind) === null) {
    addFailure(ctx, { message: msg("target_path_invalid"), field: "path" });
  }
  if (input.kind === "s3") checkS3(input, ctx);
  else if (input.kind === "webdav") checkWebdav(input, ctx);
  else checkSftp(input, ctx, adding);
}

const testInput = fieldsSchema.superRefine((input, ctx) => checkFields(input, ctx, false));

const addInput = z
  .object({ name: targetName(), ...TARGET_FIELDS })
  .superRefine((input, ctx) => checkFields(input, ctx, true));

const transferInput = z
  .object({
    id: targetId(),
    object: z.string().max(64).meta({ description: "The object to move: a package id (pk_…) or a backup id (bk_…)." }),
  })
  .superRefine((input, ctx) => {
    if (objectKindOf(input.object) === null) {
      addFailure(ctx, {
        message: msg("target_object_invalid", { reason: `${input.object} is not a package or backup id` }),
        field: "object",
      });
    }
  });

/** The place a target is reached at, with no credential in it. It is the only part of a target the audit log names. */
function addressOf(input: TargetFields): string {
  if (input.kind === "s3") return `${s3Endpoint(input.endpoint ?? "") ?? ""}/${input.bucket ?? ""}`;
  if (input.kind === "webdav") return webdavUrl(input.url ?? "") ?? "";
  return `${input.host ?? ""}:${input.port ?? SFTP_PORT}`;
}

/** The target as the service reaches it. The fields were checked by the input schema, so each one is present here. */
function draftOf(input: TargetFields): TargetDraft {
  const path = remotePath(input.path ?? "", input.kind) ?? "";
  if (input.kind === "s3") {
    return {
      kind: "s3",
      path,
      endpoint: s3Endpoint(input.endpoint ?? "") ?? "",
      region: input.region ?? "",
      bucket: input.bucket ?? "",
      accessKeyId: input.accessKeyId ?? "",
      secretAccessKey: input.secretAccessKey ?? "",
    };
  }
  if (input.kind === "webdav") {
    return {
      kind: "webdav",
      path,
      url: webdavUrl(input.url ?? "") ?? "",
      user: input.user ?? "",
      password: input.password ?? "",
    };
  }
  return {
    kind: "sftp",
    path,
    host: input.host ?? "",
    port: input.port ?? SFTP_PORT,
    user: input.user ?? "",
    privateKey: input.privateKey ?? "",
    hostKeyFingerprint: input.hostKeyFingerprint ?? null,
  };
}

function targetsOf(targets: TargetService | undefined): TargetService {
  if (!targets) throw new Error("the target service is not running");
  return targets;
}

const targetList = defineOperation({
  name: "target.list",
  tag: "targets",
  summary: "List off-site targets",
  kind: "read",
  scope: TARGET_SCOPE,
  async: false,
  input: z.object({}),
  output: z.object({ targets: z.array(TargetSchema) }),
  rest: [{ method: "GET", path: "/api/targets" }],
  mcp: {
    toolset: "storage",
    name: "list_targets",
    description:
      "List the off-site targets that checkpoint packages and backups are pushed to: S3-compatible buckets, SFTP folders and WebDAV collections. Each shows its last sync. Credentials are never returned. Owner only.",
  },
  run: async ({ targets }) => ({ targets: targetsOf(targets).list() }),
});

const targetTest = defineOperation({
  name: "target.test",
  tag: "targets",
  summary: "Test an off-site target",
  kind: "write",
  scope: TARGET_SCOPE,
  async: false,
  conflicts: true,
  input: testInput,
  output: OkSchema,
  rest: [{ method: "POST", path: "/api/targets/test", body: true }],
  mcp: {
    toolset: "storage",
    name: "test_target",
    description:
      "Reach a target with the given details and store nothing. For an SFTP server whose host key is not yet known, the call fails with the fingerprint the server presented, so the operator can confirm it and then add the target with that fingerprint. Owner only.",
  },
  activity: { action: () => "target.test", target: (input) => input.kind },
  audit: {
    target: (input) => ({ kind: "target", name: addressOf(input) }),
    detail: (input) => ({ kind: input.kind, address: addressOf(input) }),
  },
  run: async ({ targets }, input) => {
    await targetsOf(targets).test(draftOf(input));
    return { ok: true as const };
  },
});

const targetAdd = defineOperation({
  name: "target.add",
  tag: "targets",
  summary: "Add an off-site target",
  kind: "write",
  scope: TARGET_SCOPE,
  async: false,
  conflicts: true,
  input: addInput,
  output: z.object({ target: TargetSchema }),
  rest: [{ method: "POST", path: "/api/targets", body: true, status: 201 }],
  mcp: {
    toolset: "storage",
    name: "add_target",
    description:
      "Add an off-site target. kind s3 takes endpoint, region, bucket, accessKeyId and secretAccessKey. kind sftp takes host, user, privateKey and hostKeyFingerprint, and the fingerprint comes from a test_target call that reported the server's key. kind webdav takes url, user and password, where url is the https address of the collection the objects live under. Credentials are stored as secrets and never returned. Owner only.",
  },
  activity: { action: () => "target.add", target: (input) => input.name },
  audit: {
    target: (input, _resolved, result) => ({ kind: "target", id: result?.target.id, name: input.name }),
    detail: (input, _resolved, result) => ({
      name: input.name,
      kind: input.kind,
      address: result?.target.address ?? addressOf(input),
    }),
  },
  run: async ({ targets }, input) => ({ target: targetsOf(targets).add(input.name, draftOf(input)) }),
});

const targetCheck = defineOperation({
  name: "target.check",
  tag: "targets",
  summary: "Check that an off-site target answers",
  kind: "read",
  scope: TARGET_SCOPE,
  async: false,
  input: z.object({ id: targetId() }),
  output: OkSchema,
  rest: [{ method: "GET", path: "/api/targets/:id/check" }],
  mcp: {
    toolset: "storage",
    name: "check_target",
    description:
      "Reach a stored target with its own credentials and report whether it answers. Nothing is written, and the last sync is left as it was. Owner only.",
  },
  run: async ({ targets }, input) => {
    await targetsOf(targets).check(input.id);
    return { ok: true as const };
  },
});

const targetObjects = defineOperation({
  name: "target.objects",
  tag: "targets",
  summary: "List the packages and backups on an off-site target",
  kind: "read",
  scope: TARGET_SCOPE,
  async: false,
  input: z.object({ id: targetId() }),
  output: z.object({ objects: z.array(TargetObjectSchema) }),
  rest: [{ method: "GET", path: "/api/targets/:id/objects" }],
  mcp: {
    toolset: "storage",
    name: "list_target_objects",
    description:
      "List the complete packages and backups on a target, newest first. An object whose record is missing or does not match its archive is left out. Owner only.",
  },
  run: async ({ targets }, input) => ({ objects: await targetsOf(targets).objects(input.id) }),
});

const targetRemove = defineOperation({
  name: "target.remove",
  tag: "targets",
  summary: "Remove an off-site target",
  kind: "destructive",
  scope: TARGET_SCOPE,
  async: false,
  conflicts: true,
  input: z.object({ id: targetId() }),
  output: OkSchema,
  rest: [{ method: "DELETE", path: "/api/targets/:id" }],
  mcp: {
    toolset: "storage",
    name: "remove_target",
    description:
      "Remove a target and its stored credentials from this instance. Objects already on the target are not deleted. Owner only.",
  },
  resolve: async ({ targets }, input) => targetsOf(targets).get(input.id),
  activity: { action: () => "target.remove", target: (input) => input.id },
  audit: {
    target: ({ id }, resolved) => ({ kind: "target", id, name: resolved?.name ?? id }),
  },
  run: async ({ targets }, input) => {
    targetsOf(targets).remove(input.id);
    return { ok: true as const };
  },
});

const targetPush = defineOperation({
  name: "target.push",
  tag: "targets",
  summary: "Push a package or backup to an off-site target",
  kind: "write",
  scope: TARGET_SCOPE,
  async: true,
  conflicts: true,
  input: transferInput,
  output: SyncResultSchema,
  rest: [{ method: "POST", path: "/api/targets/:id/push", body: true, status: 202 }],
  mcp: {
    toolset: "storage",
    name: "push_to_target",
    description:
      "Push a checkpoint package (pk_…) or a backup (bk_…) to a target. The archive is written first and its record after it, so the target lists the object only once it is whole. An object the target already holds is skipped, and one it holds with other contents is refused. Returns a task id. Owner only.",
  },
  resolve: async ({ targets }, input) => targetsOf(targets).get(input.id),
  exclusive: (_ctx, input) => `target:${input.id}`,
  subject: (_input, target) => target.name,
  activity: { action: () => "target.push", target: (input) => input.object },
  audit: {
    target: (input, target) => ({ kind: "target", id: input.id, name: target?.name ?? input.id }),
    detail: (input, _target, result) => ({
      object: input.object,
      kind: result?.kind ?? null,
      bytes: result?.bytes ?? null,
      skipped: result?.skipped ?? null,
    }),
  },
  run: async ({ targets, task }, input) => targetsOf(targets).push(input.id, input.object, (line) => task?.log(line)),
});

const targetPull = defineOperation({
  name: "target.pull",
  tag: "targets",
  summary: "Pull a package or backup from an off-site target",
  kind: "write",
  scope: TARGET_SCOPE,
  async: true,
  conflicts: true,
  input: transferInput,
  output: SyncResultSchema,
  rest: [{ method: "POST", path: "/api/targets/:id/pull", body: true, status: 202 }],
  mcp: {
    toolset: "storage",
    name: "pull_from_target",
    description:
      "Pull a checkpoint package (pk_…) or a backup (bk_…) from a target onto this instance. The archive is stored only when its size and checksum match the record kept beside it. A pulled package can be imported, and a pulled backup can be restored offline. Returns a task id. Owner only.",
  },
  resolve: async ({ targets }, input) => targetsOf(targets).get(input.id),
  exclusive: (_ctx, input) => `target:${input.id}`,
  subject: (_input, target) => target.name,
  activity: { action: () => "target.pull", target: (input) => input.object },
  audit: {
    target: (input, target) => ({ kind: "target", id: input.id, name: target?.name ?? input.id }),
    detail: (input, _target, result) => ({
      object: input.object,
      kind: result?.kind ?? null,
      bytes: result?.bytes ?? null,
      skipped: result?.skipped ?? null,
    }),
  },
  run: async ({ targets, task }, input) => targetsOf(targets).pull(input.id, input.object, (line) => task?.log(line)),
});

export const targetOperations = [
  targetList,
  targetTest,
  targetAdd,
  targetCheck,
  targetObjects,
  targetRemove,
  targetPush,
  targetPull,
];
