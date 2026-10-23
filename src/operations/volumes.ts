import { z } from "zod";

import type { EventTarget } from "../events/types";
import type { HostCtx } from "../host/registry";
import { preRebuildSafety } from "../services/safety";
import { pruneVolumes } from "../services/volume-prune";
import type { OutcomeError } from "../services/volume-refs";
import {
  attachVolume,
  confirmationRequired,
  createVolume,
  deleteVolume,
  deleteVolumes,
  detachVolume,
  getPools,
  getVolume,
  listVolumes,
  measureVolume,
  planDeletes,
  previewCreateVolume,
  previewDeleteVolume,
  previewDeleteVolumes,
  previewPools,
  savePools,
  setVolumeLimits,
  type VolumeView,
} from "../services/volumes";
import { requireRevision } from "../specs/revision";
import { hostAllowed, refusal, specViews, volumeVisible } from "../tokens/model";
import { ageMs } from "../volumes/age";
import type { PoolDraft, RoleDraft } from "../volumes/pools";
import {
  assertCanAdministerPools,
  assertCanAttach,
  assertCanSkipTrash,
  assertCanWrite,
  canDeleteVolume,
} from "./authz";
import { defineOperation } from "./define";
import { fromEveryHost, hostOfVolume } from "./routing";
import { BoxSchema, SafetyCheckpointSchema, TrashRefSchema } from "./schemas";
import type { OperationContext } from "./types";
import {
  boxId,
  confirmFlag,
  dryRunFlag,
  expectedRevision,
  olderThanOption,
  refreshFlag,
  safetyCheckpointFlag,
  skipTrashFlag,
  storageConfirmFlag,
  volumeName,
} from "./validation";

const ROLES = ["workspace", "home", "tools", "cache"] as const;

const PoolDraftSchema = z.object({
  name: z.string(),
  backend: z.enum(["local", "nfs", "path"]),
  default: z.boolean().optional(),
  server: z.string().optional(),
  export: z.string().optional(),
  options: z.array(z.string()).optional(),
  root: z.string().optional(),
  marker: z.string().optional(),
});

const RoleSchema = z.object({
  workspace: z.string().nullable().optional(),
  home: z.string().nullable().optional(),
  tools: z.string().nullable().optional(),
  cache: z.string().nullable().optional(),
});

const CapabilitiesSchema = z.object({
  shareable: z.boolean(),
  snapshots: z.boolean(),
  quota: z.boolean(),
  clone: z.boolean(),
  crossHost: z.boolean(),
});

const PoolSchema = z.object({
  name: z.string(),
  backend: z.enum(["local", "nfs", "path"]),
  default: z.boolean(),
  server: z.string().nullable(),
  export: z.string().nullable(),
  options: z.array(z.string()),
  root: z.string().nullable(),
  marker: z.string().nullable(),
  capabilities: CapabilitiesSchema,
});

const RolePoolsSchema = z.object({
  workspace: z.string().nullable(),
  home: z.string().nullable(),
  tools: z.string().nullable(),
  cache: z.string().nullable(),
});

const PoolHealthSchema = z.object({
  pool: z.string(),
  hostId: z.string(),
  status: z.enum(["reachable", "unreachable", "unknown"]),
  message: z.string().nullable(),
  checkedAt: z.string().nullable(),
  totalBytes: z.number().nullable(),
  freeBytes: z.number().nullable(),
  usedBytes: z.number().nullable(),
  lowSpace: z.boolean(),
});

const PoolsSchema = z.object({
  pools: z.array(PoolSchema),
  roles: RolePoolsSchema,
  health: z.array(PoolHealthSchema),
});

const VolumeMountSchema = z.object({
  boxId: z.string(),
  boxName: z.string(),
  path: z.string(),
  mode: z.enum(["rw", "ro"]),
});

const LimitsSchema = z.object({
  softBytes: z.number().nullable(),
  hardBytes: z.number().nullable(),
  action: z.enum(["warn", "stop"]),
});

const UsageSchema = z.object({
  scope: z.enum(["volume", "share"]),
  level: z.enum(["unknown", "ok", "soft", "hard"]),
  history: z.array(z.object({ at: z.string(), bytes: z.number() })),
  lastError: z.string().nullable(),
});

export const VolumeSchema = z.object({
  id: z.string(),
  name: z.string(),
  hostId: z.string(),
  pool: z.string(),
  backend: z.string(),
  role: z.enum(ROLES).nullable(),
  ownership: z.enum(["owned", "independent"]),
  ownerBoxId: z.string().nullable(),
  sensitive: z.boolean(),
  checkpoint: z.boolean(),
  engineName: z.string(),
  bytes: z.number().nullable(),
  bytesAt: z.string().nullable(),
  limits: LimitsSchema,
  usage: UsageSchema,
  createdAt: z.string(),
  mounts: z.array(VolumeMountSchema),
  unattached: z.boolean(),
  rwMounts: z.number(),
});

const volumeTarget = (volume: VolumeView): EventTarget => ({ kind: "volume", id: volume.id, name: volume.name });

const volumeList = defineOperation({
  name: "volume.list",
  tag: "volumes",
  summary: "List volumes",
  kind: "read",
  scope: "volume:read",
  async: false,
  input: z.object({}),
  output: z.object({ volumes: z.array(VolumeSchema) }),
  rest: [{ method: "GET", path: "/api/volumes" }],
  cli: "volume ls",
  mcp: {
    toolset: "storage",
    name: "list_volumes",
    description:
      "List volumes on every host, including mounts. Existing minibox-ws-* volumes are recognized as volumes.",
  },
  run: async ({ host, principal, allHosts }) => {
    const volumes = await fromEveryHost(allHosts?.() ?? [host], listVolumes);
    if (principal.type === "owner") return { volumes };
    const boxes = specViews(host.specs.list());
    return {
      volumes: volumes.filter((volume) => {
        const record = host.volumes.read(volume.id);
        return record !== null && volumeVisible(principal, record, boxes);
      }),
    };
  },
});

const volumeGet = defineOperation({
  name: "volume.get",
  tag: "volumes",
  summary: "Get a volume",
  kind: "read",
  scope: "volume:read",
  async: false,
  input: z.object({
    id: z.string().meta({ description: "Volume id (vol_…) or volume name." }),
  }),
  output: z.object({ volume: VolumeSchema }),
  rest: [{ method: "GET", path: "/api/volumes/:id" }],
  cli: "volume get",
  mcp: {
    toolset: "storage",
    name: "get_volume",
    description: "Get one volume by id or name, including which boxes mount it.",
  },
  hostFor: (ctx, input) => hostOfVolume(ctx, input.id),
  resolve: ({ host }, input) => getVolume(host, input.id),
  audit: { target: (_input, volume) => volume && volumeTarget(volume) },
  run: async (_ctx, _input, volume) => ({ volume }),
});

const volumeCreate = defineOperation({
  name: "volume.create",
  tag: "volumes",
  summary: "Create an independent volume",
  kind: "write",
  scope: "volume:write",
  async: false,
  conflicts: true,
  input: z.object({
    name: volumeName(),
    pool: z
      .string()
      .optional()
      .meta({ description: "Storage pool. Omitted, the role rule or the default pool is used." }),
    role: z.enum(ROLES).nullable().optional().meta({ description: "Optional role. Null is a general volume." }),
    confirm: storageConfirmFlag(),
  }),
  output: z.object({ volume: VolumeSchema }),
  rest: [{ method: "POST", path: "/api/volumes", body: true, status: 201 }],
  cli: "volume create",
  mcp: {
    toolset: "storage",
    name: "create_volume",
    description:
      "Create an independent volume. It is not deleted when a box is deleted. New local volumes are chowned to uid 1000 when the base template image exists. Send confirm true; without it the call changes nothing and returns confirmation_required with details.preview.",
  },
  activity: { action: () => "volume.create", target: (input) => input.name },
  audit: { target: ({ name }, _resolved, result) => ({ kind: "volume", id: result?.volume.id, name }) },
  run: async ({ host, principal }, input) => {
    const request = { name: input.name, pool: input.pool, role: input.role ?? null, createdBy: principal.id };
    if (principal.type === "token" && request.role === "tools") throw refusal("volume_create_forbidden");
    if (!input.confirm) throw confirmationRequired(previewCreateVolume(host, request));
    return { volume: await createVolume(host, request) };
  },
});

const volumeDelete = defineOperation({
  name: "volume.delete",
  tag: "volumes",
  summary: "Delete a volume",
  kind: "destructive",
  scope: "volume:write",
  async: false,
  conflicts: true,
  longSync: true,
  input: z.object({
    id: z.string().meta({ description: "Volume id (vol_…) or volume name." }),
    confirm: storageConfirmFlag(),
    skipTrash: skipTrashFlag(),
  }),
  output: z.object({
    name: z.string(),
    trash: TrashRefSchema.nullable().meta({
      description: "The recycle bin entry that kept the volume's data until expiresAt, or null when none was kept.",
    }),
  }),
  rest: [{ method: "DELETE", path: "/api/volumes/:id", query: ["confirm", "skipTrash"] }],
  cli: "volume rm",
  mcp: {
    toolset: "storage",
    name: "delete_volume",
    description:
      "Delete a volume and its engine data. The data is first kept in the recycle bin for the retention period, and restore_trash brings it back as a new volume. Cache and tools volumes keep nothing. A volume that a box mounts is refused. Pass skipTrash true to delete without keeping a copy; that needs the owner, or a token with the trash:skip scope. Send confirm true; without it the call changes nothing and returns confirmation_required with details.preview.",
  },
  hostFor: (ctx, input) => hostOfVolume(ctx, input.id),
  resolve: ({ host }, input) => getVolume(host, input.id),
  precondition: async (ctx, input) => {
    if (input.skipTrash) await assertCanSkipTrash(ctx);
  },
  activity: { action: () => "volume.delete", target: (_input, volume) => volume.name },
  audit: { target: (_input, volume) => volume && volumeTarget(volume) },
  run: async ({ host, principal, record }, input, volume) => {
    if (!input.confirm) throw confirmationRequired(previewDeleteVolume(volume, input.skipTrash));
    return deleteVolume(host, input.id, { skipTrash: input.skipTrash, createdBy: principal.id, record });
  },
});

/** A batch delete names at most this many volumes, so one request stays bounded. */
const DELETE_BATCH_MAX = 100;

const OutcomeSchema = z.object({
  message: z.string(),
  key: z.string().nullable().meta({ description: "The message key a translated client shows instead of the message." }),
  params: z.record(z.string(), z.union([z.string(), z.number()])).nullable(),
});

const DeletedVolumeSchema = z.object({
  id: z.string(),
  name: z.string(),
  hostId: z.string().nullable(),
  status: z.enum(["removed", "refused", "failed"]),
  trash: TrashRefSchema.nullable(),
  error: OutcomeSchema.nullable(),
});

const PrunedVolumeSchema = z.object({
  id: z.string(),
  name: z.string(),
  hostId: z.string(),
  pool: z.string(),
  bytes: z.number().nullable(),
  lastUsedAt: z.string(),
  formerBox: z.string().nullable(),
  status: z.enum(["candidate", "removed", "refused", "failed"]),
  trash: TrashRefSchema.nullable(),
  error: OutcomeSchema.nullable(),
});

const PrunedHostSchema = z.object({
  hostId: z.string(),
  name: z.string(),
  status: z.enum(["checked", "offline", "failed"]),
  error: OutcomeSchema.nullable(),
});

/** The hosts a batch delete or a prune reads: every host, or for a token only the hosts its grant covers. */
function grantedHosts(ctx: OperationContext): HostCtx[] {
  const { principal } = ctx;
  const hosts = ctx.allHosts?.() ?? [ctx.host];
  if (principal.type !== "token") return [...hosts];
  return hosts.filter((host) => hostAllowed(principal.grants.hosts, host.host.id));
}

/** One activity entry for each volume a batch delete or a prune removed, or tried to remove. */
function recordChange(
  ctx: OperationContext,
  action: string,
  row: { name: string; status: string; error: OutcomeError | null },
): void {
  ctx.recordActivity?.({
    action,
    target: row.name,
    ok: row.status === "removed",
    ...(row.error ? { message: row.error.message } : {}),
  });
}

const volumeDeleteBatch = defineOperation({
  name: "volume.delete.batch",
  tag: "volumes",
  summary: "Delete several volumes",
  kind: "destructive",
  scope: "volume:delete",
  async: false,
  conflicts: true,
  longSync: true,
  input: z.object({
    ids: z
      .array(z.string().min(1))
      .min(1)
      .max(DELETE_BATCH_MAX)
      .meta({ description: `Volume ids (vol_…) or names, on any host. At most ${DELETE_BATCH_MAX}.` }),
    confirm: storageConfirmFlag(),
    skipTrash: skipTrashFlag(),
  }),
  output: z.object({
    volumes: z.array(DeletedVolumeSchema).meta({
      description: "One result per volume named, in the order the request named them.",
    }),
  }),
  rest: [{ method: "POST", path: "/api/volumes/delete", body: true }],
  cli: "volume delete",
  mcp: {
    toolset: "storage",
    name: "delete_volumes",
    description:
      "Delete several volumes, on any host, in one call. Each is deleted as delete_volume deletes it: its data is kept in the recycle bin unless skipTrash is true, and a volume that a box or container uses is refused. Each volume gets its own result, and one failure does not stop the others. A token deletes only the volumes it created. Send confirm true; without it the call changes nothing and returns confirmation_required with details.preview.",
  },
  precondition: async (ctx, input) => {
    if (input.skipTrash) await assertCanSkipTrash(ctx);
  },
  activity: {
    action: () => "volume.delete",
    target: (input) => `${input.ids.length} volumes`,
    when: (input) => input.confirm,
  },
  run: async (ctx, input) => {
    const plans = await planDeletes(ctx.host, grantedHosts(ctx), input.ids, (volume) => canDeleteVolume(ctx, volume));
    if (!input.confirm) throw confirmationRequired(previewDeleteVolumes(plans, input.skipTrash));
    const volumes = await deleteVolumes(plans, {
      skipTrash: input.skipTrash,
      createdBy: ctx.principal.id,
      record: ctx.record,
    });
    for (const row of volumes) recordChange(ctx, "volume.delete", row);
    return { volumes };
  },
});

const volumePrune = defineOperation({
  name: "volume.prune",
  tag: "volumes",
  summary: "Prune orphaned volumes",
  kind: "destructive",
  scope: "volume:delete",
  async: false,
  conflicts: true,
  longSync: true,
  input: z.object({
    dryRun: dryRunFlag(),
    olderThan: olderThanOption(),
  }),
  output: z.object({
    dryRun: z.boolean(),
    olderThan: z.string().nullable(),
    volumes: z.array(PrunedVolumeSchema),
    hosts: z.array(PrunedHostSchema).meta({
      description: "One entry per host. An offline or failing host is reported, and its volumes are skipped.",
    }),
  }),
  rest: [{ method: "POST", path: "/api/volumes/prune", body: true }],
  cli: "volume prune",
  mcp: {
    toolset: "storage",
    name: "prune_volumes",
    description:
      "Find or remove orphaned volumes: volumes MiniBox made that no box spec or container mounts. The shared tools volume and template volumes are never orphans, and a volume created or last used within the last five minutes is left alone. dryRun defaults to true and only lists the orphans; send dryRun false to remove them. olderThan such as 30d keeps the volumes used more recently. A removed volume's data is kept in the recycle bin, as delete_volume keeps it. A token prunes only the volumes it created.",
  },
  activity: { action: () => "volume.prune", target: () => "volumes", when: (input) => !input.dryRun },
  run: async (ctx, input) => {
    const olderThan = input.olderThan ?? null;
    const result = await pruneVolumes(grantedHosts(ctx), {
      dryRun: input.dryRun,
      olderThanMs: olderThan === null ? null : ageMs(olderThan),
      principal: ctx.principal.id,
      may: (volume) => canDeleteVolume(ctx, volume),
      tasks: ctx.tasks,
      record: ctx.record,
      onRemoval: (row) => recordChange(ctx, "volume.prune", row),
    });
    return { dryRun: input.dryRun, olderThan, ...result };
  },
});

const volumeAttach = defineOperation({
  name: "volume.attach",
  tag: "volumes",
  summary: "Mount a volume on a box",
  kind: "write",
  scope: "volume:attach",
  async: false,
  conflicts: true,
  input: z.object({
    id: z.string().meta({ description: "Volume id (vol_…) or volume name." }),
    box: boxId(),
    path: z.string().meta({ description: "Absolute path inside the box." }),
    mode: z
      .enum(["rw", "ro"])
      .meta({ description: "Read-write or read-only. A second read-write mount is the operator's risk." }),
    confirm: confirmFlag(),
    safetyCheckpoint: safetyCheckpointFlag(),
    expectedRevision: expectedRevision(),
  }),
  output: z.object({
    box: BoxSchema,
    warning: z.enum(["shared_rw"]).nullable(),
    safety: SafetyCheckpointSchema.nullable().meta({
      description: "The checkpoint taken before the rebuild, or null when none was taken.",
    }),
  }),
  rest: [{ method: "POST", path: "/api/volumes/:id/attach", body: true, ifMatch: true }],
  cli: "volume attach",
  mcp: {
    toolset: "storage",
    name: "attach_volume",
    description:
      "Mount a volume into a box. Docker cannot add a mount in place, so the container is rebuilt and renamed to prefix-<box id>. Send expectedRevision and confirm true. Without confirm the call changes nothing and returns confirmation_required with the rebuild preview. A confirmed mount takes a safety checkpoint of the box first unless safetyCheckpoint is false, as box rebuild does. A read-write mount also needs volume:write. warning is shared_rw when another box already mounts this volume read-write.",
  },
  longSync: true,
  hostFor: (ctx, input) => hostOfVolume(ctx, input.id),
  resolve: ({ host }, input) => getVolume(host, input.id),
  activity: { action: () => "volume.attach", target: (_input, volume) => volume.name },
  audit: { target: (_input, volume) => volume && volumeTarget(volume) },
  run: async (ctx, input, volume) => {
    await assertCanAttach(ctx, volume);
    if (input.mode === "rw") await assertCanWrite(ctx, volume);
    return attachVolume(
      ctx.host,
      volume.id,
      {
        box: input.box,
        path: input.path,
        mode: input.mode,
        revision: requireRevision(input.expectedRevision),
        confirm: input.confirm,
      },
      input.safetyCheckpoint ? preRebuildSafety(ctx.host, ctx.principal.id) : null,
      ctx.record,
    );
  },
});

const volumeDetach = defineOperation({
  name: "volume.detach",
  tag: "volumes",
  summary: "Unmount a volume from a box",
  kind: "write",
  scope: "volume:attach",
  async: false,
  conflicts: true,
  input: z.object({
    id: z.string().meta({ description: "Volume id (vol_…) or volume name." }),
    box: boxId(),
    path: z.string().meta({ description: "Mount path to remove." }),
    confirm: confirmFlag(),
    safetyCheckpoint: safetyCheckpointFlag(),
    expectedRevision: expectedRevision(),
  }),
  output: z.object({
    box: BoxSchema,
    safety: SafetyCheckpointSchema.nullable().meta({
      description: "The checkpoint taken before the rebuild, or null when none was taken.",
    }),
  }),
  rest: [{ method: "POST", path: "/api/volumes/:id/detach", body: true, ifMatch: true }],
  cli: "volume detach",
  mcp: {
    toolset: "storage",
    name: "detach_volume",
    description:
      "Remove one mount of a volume from a box. The container is rebuilt and renamed to prefix-<box id>. Send expectedRevision and confirm true. Without confirm the call changes nothing and returns the rebuild preview. A confirmed detach takes a safety checkpoint of the box first unless safetyCheckpoint is false, as box rebuild does.",
  },
  longSync: true,
  hostFor: (ctx, input) => hostOfVolume(ctx, input.id),
  resolve: ({ host }, input) => getVolume(host, input.id),
  activity: { action: () => "volume.detach", target: (_input, volume) => volume.name },
  audit: { target: (_input, volume) => volume && volumeTarget(volume) },
  run: async (ctx, input, volume) => {
    await assertCanAttach(ctx, volume);
    return detachVolume(
      ctx.host,
      volume.id,
      {
        box: input.box,
        path: input.path,
        revision: requireRevision(input.expectedRevision),
        confirm: input.confirm,
      },
      input.safetyCheckpoint ? preRebuildSafety(ctx.host, ctx.principal.id) : null,
      ctx.record,
    );
  },
});

const volumeUsage = defineOperation({
  name: "volume.usage",
  tag: "volumes",
  summary: "Measure a volume",
  kind: "write",
  scope: "volume:read",
  async: false,
  input: z.object({
    id: z.string().meta({ description: "Volume id (vol_…) or volume name." }),
  }),
  output: z.object({ volume: VolumeSchema }),
  rest: [{ method: "POST", path: "/api/volumes/:id/usage" }],
  cli: "volume usage",
  mcp: {
    toolset: "storage",
    name: "measure_volume",
    description:
      "Measure a volume now. A local or path volume is measured with du over its own tree. An NFS volume reports the usage of its whole share, from df, and its scope is share. The result is kept on the volume and is what its limits compare with.",
  },
  hostFor: (ctx, input) => hostOfVolume(ctx, input.id),
  resolve: ({ host }, input) => getVolume(host, input.id),
  activity: { action: () => "volume.usage", target: (_input, volume) => volume.name },
  audit: { target: (_input, volume) => volume && volumeTarget(volume) },
  run: ({ host }, input) => measureVolume(host, input.id).then((volume) => ({ volume })),
});

const poolList = defineOperation({
  name: "pool.list",
  tag: "volumes",
  summary: "List storage pools",
  kind: "read",
  scope: "pool:read",
  async: false,
  input: z.object({ refresh: refreshFlag() }),
  output: PoolsSchema,
  rest: [{ method: "GET", path: "/api/pools", query: ["refresh"] }],
  cli: "pool ls",
  mcp: {
    toolset: "storage",
    name: "list_pools",
    description:
      "List storage pools, role defaults and reachability. refresh probes again. An unreachable pool is reported instead of failing the list.",
  },
  run: ({ host }, input) => getPools(host, { force: input.refresh }),
});

const poolReplace = defineOperation({
  name: "pool.replace",
  tag: "volumes",
  summary: "Replace storage pool configuration",
  kind: "write",
  scope: "pool:admin",
  async: false,
  conflicts: true,
  input: z.object({
    pools: z.array(PoolDraftSchema).meta({
      description: "The full pool list. The local pool is restored if it is omitted. Exactly one pool is default.",
    }),
    roles: RoleSchema.optional().meta({
      description:
        "Role to pool name. Null or omitted uses the rule: cache on the local pool, other roles on the default pool.",
    }),
    confirm: storageConfirmFlag(),
  }),
  output: PoolsSchema,
  rest: [{ method: "PUT", path: "/api/pools", body: true }],
  cli: "pool apply",
  mcp: {
    toolset: "storage",
    name: "replace_pools",
    description:
      "Replace pool configuration. Send confirm true; without it the call changes nothing and returns confirmation_required with details.preview. A pool that still has volumes cannot be removed or change backend. New volumes use the new defaults; existing engine volumes keep the options they were created with.",
  },
  activity: { action: () => "pool.replace", target: () => "pools" },
  audit: { target: () => ({ kind: "pool", name: "pools" }) },
  run: async (ctx, input) => {
    await assertCanAdministerPools(ctx);
    const pools = input.pools as PoolDraft[];
    const roles = input.roles as RoleDraft | undefined;
    if (!input.confirm) throw confirmationRequired(previewPools(ctx.host, pools, roles));
    return savePools(ctx.host, pools, roles);
  },
});

const volumeLimitsSet = defineOperation({
  name: "volume.limits.set",
  tag: "volumes",
  summary: "Set a volume's usage limits",
  kind: "write",
  scope: "volume:limit",
  async: false,
  input: z.object({
    id: z.string().meta({ description: "Volume id (vol_…) or volume name." }),
    softBytes: z.number().int().positive().nullable().optional().meta({
      description: "Soft limit in bytes. Null clears it. A soft alert is best effort, not a quota.",
    }),
    hardBytes: z.number().int().positive().nullable().optional().meta({
      description: "Hard limit in bytes. Null clears it.",
    }),
    action: z.enum(["warn", "stop"]).optional().meta({
      description: "What the hard limit does: warn only, or stop the running boxes that mount the volume.",
    }),
  }),
  output: z.object({ volume: VolumeSchema }),
  rest: [{ method: "PUT", path: "/api/volumes/:id/limits", body: true }],
  cli: "volume limits",
  mcp: {
    toolset: "storage",
    name: "set_volume_limits",
    description:
      "Set a volume's soft and hard usage limits in bytes, and the action at the hard limit. A field left out keeps its value, and null clears a limit. Soft limits are best effort, not a quota. An NFS volume is refused, since its usage is the whole share's: set a quota on the NAS export instead. Owner only.",
  },
  hostFor: (ctx, input) => hostOfVolume(ctx, input.id),
  resolve: ({ host }, input) => getVolume(host, input.id),
  activity: { action: () => "volume.limits", target: (_input, volume) => volume.name },
  audit: { target: (_input, volume) => volume && volumeTarget(volume) },
  run: async ({ host }, input) => ({
    volume: setVolumeLimits(host, input.id, {
      softBytes: input.softBytes,
      hardBytes: input.hardBytes,
      action: input.action,
    }),
  }),
});

export const volumeOperations = [
  volumeList,
  volumeGet,
  volumeCreate,
  volumeDelete,
  volumeDeleteBatch,
  volumePrune,
  volumeAttach,
  volumeDetach,
  volumeUsage,
  volumeLimitsSet,
  poolList,
  poolReplace,
];
