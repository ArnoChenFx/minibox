import { z } from "zod";

import type { EventTarget } from "../events/types";
import {
  attachVolume,
  confirmationRequired,
  createVolume,
  deleteVolume,
  detachVolume,
  getPools,
  getVolume,
  listVolumes,
  measureVolume,
  previewCreateVolume,
  previewDeleteVolume,
  previewPools,
  savePools,
  type VolumeView,
} from "../services/volumes";
import { requireRevision } from "../specs/revision";
import type { PoolDraft, RoleDraft } from "../volumes/pools";
import { assertCanAdministerPools, assertCanAttach, assertCanWrite } from "./authz";
import { defineOperation } from "./define";
import { BoxSchema } from "./schemas";
import { boxId, confirmFlag, expectedRevision, refreshFlag, storageConfirmFlag, volumeName } from "./validation";

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

const VolumeSchema = z.object({
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
      "List volumes on this host, including mounts. Existing minibox-ws-* volumes are recognized as volumes.",
  },
  run: async ({ host }) => ({ volumes: await listVolumes(host) }),
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
    const request = { name: input.name, pool: input.pool, role: input.role ?? null, createdBy: principal.type };
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
  input: z.object({
    id: z.string().meta({ description: "Volume id (vol_…) or volume name." }),
    confirm: storageConfirmFlag(),
  }),
  output: z.object({ name: z.string() }),
  rest: [{ method: "DELETE", path: "/api/volumes/:id", query: ["confirm"] }],
  cli: "volume rm",
  mcp: {
    toolset: "storage",
    name: "delete_volume",
    description:
      "Delete a volume and its engine data. A volume that a box mounts is refused. Send confirm true; without it the call changes nothing and returns confirmation_required with details.preview.",
  },
  resolve: ({ host }, input) => getVolume(host, input.id),
  activity: { action: () => "volume.delete", target: (_input, volume) => volume.name },
  audit: { target: (_input, volume) => volume && volumeTarget(volume) },
  run: async ({ host }, input, volume) => {
    if (!input.confirm) throw confirmationRequired(previewDeleteVolume(volume));
    return deleteVolume(host, input.id);
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
    expectedRevision: expectedRevision(),
  }),
  output: z.object({
    box: BoxSchema,
    warning: z.enum(["shared_rw"]).nullable(),
  }),
  rest: [{ method: "POST", path: "/api/volumes/:id/attach", body: true, ifMatch: true }],
  cli: "volume attach",
  mcp: {
    toolset: "storage",
    name: "attach_volume",
    description:
      "Mount a volume into a box. Docker cannot add a mount in place, so the container is rebuilt and renamed to prefix-<box id>. Send expectedRevision and confirm true. Without confirm the call changes nothing and returns confirmation_required with the rebuild preview. A read-write mount also needs volume:write. warning is shared_rw when another box already mounts this volume read-write.",
  },
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
    expectedRevision: expectedRevision(),
  }),
  output: z.object({ box: BoxSchema }),
  rest: [{ method: "POST", path: "/api/volumes/:id/detach", body: true, ifMatch: true }],
  cli: "volume detach",
  mcp: {
    toolset: "storage",
    name: "detach_volume",
    description:
      "Remove one mount of a volume from a box. The container is rebuilt and renamed to prefix-<box id>. Send expectedRevision and confirm true. Without confirm the call changes nothing and returns the rebuild preview.",
  },
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
    description: "Measure used bytes with a helper container and cache the result on the volume.",
  },
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
  scope: "volume:read",
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

export const volumeOperations = [
  volumeList,
  volumeGet,
  volumeCreate,
  volumeDelete,
  volumeAttach,
  volumeDetach,
  volumeUsage,
  poolList,
  poolReplace,
];
