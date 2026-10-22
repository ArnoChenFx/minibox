import { z } from "zod";

import type { EventTarget } from "../events/types";
import { type HostCtx, LOCAL_HOST_ID } from "../host/registry";
import { AppError, badRequest } from "../lib/errors";
import { msg } from "../lib/messages";
import {
  type Box,
  type BoxUpdate,
  createBox,
  deleteBox,
  getBox,
  getLogs,
  getStats,
  getStatsWithHistory,
  listAllBoxes,
  readBox,
  restartBox,
  startBox,
  statsOf,
  stopBox,
  updateBox,
} from "../services/boxes";
import { assertCapacity } from "../services/capacity";
import { rebuildBox } from "../services/rebuild";
import { hasRebuildFields } from "../specs/plan";
import { requireRevision } from "../specs/revision";
import { boxVisible, ttlFor, viewOfBox } from "../tokens/model";
import { underQuota } from "../tokens/quota";
import { assertCanChangeMounts, assertCanCreateDefaultMounts } from "./authz";
import { defineOperation } from "./define";
import { hostById, hostOfBox } from "./routing";
import { BoxSchema, BoxWithStatsSchema, StatSampleSchema, StatsSchema } from "./schemas";
import {
  boxId,
  boxName,
  boxProfile,
  confirmFlag,
  cpusWithDefault,
  deleteVolumeFlag,
  expectedRevision,
  idleTimeout,
  memoryWithDefault,
  optionalBoxName,
  optionalCpus,
  optionalMemoryMb,
  optionalPids,
  rebuildEnv,
  rebuildMounts,
  rebuildNetwork,
  requireResources,
  requireUpdate,
  historyFlag,
  hostId,
  statsFlag,
  tail,
  templateImage,
  ttl,
  userLabels,
} from "./validation";

export const DEFAULT_RESOURCES = { cpus: 2, memoryMb: 4096 } as const;

export const boxTarget = (box: Pick<Box, "id" | "name">): EventTarget => ({ kind: "box", id: box.id, name: box.name });

const ACTIONS: Record<"start" | "stop" | "restart", (host: HostCtx, id: string) => Promise<Box>> = {
  start: startBox,
  stop: (host, id) => stopBox(host, id, "manual"),
  restart: restartBox,
};

export const boxList = defineOperation({
  name: "box.list",
  tag: "boxes",
  summary: "List boxes",
  kind: "read",
  scope: "box:read",
  async: false,
  input: z.object({ stats: statsFlag(), host: hostId().optional() }),
  output: z.object({ boxes: z.array(BoxWithStatsSchema) }),
  rest: [{ method: "GET", path: "/api/boxes", query: ["stats", "host"] }],
  cli: "box list",
  mcp: {
    toolset: "core",
    name: "list_boxes",
    description:
      "List the boxes with the current resource usage of running boxes. Boxes on every host are listed; pass host to list one host. A box on a host that cannot be reached is listed with state unreachable.",
  },
  run: async (ctx, input) => {
    const { principal } = ctx;
    if (input.host !== undefined) hostById(ctx, input.host);
    const boxes = await listAllBoxes(ctx.allHosts?.() ?? [ctx.host], { withStats: input.stats, host: input.host });
    if (principal.type === "owner") return { boxes };
    return { boxes: boxes.filter((box) => boxVisible(principal, viewOfBox(box, box.hostId ?? LOCAL_HOST_ID))) };
  },
});

export const boxGet = defineOperation({
  name: "box.get",
  tag: "boxes",
  summary: "Get one box",
  kind: "read",
  scope: "box:read",
  async: false,
  input: z.object({ id: boxId() }),
  output: z.object({ box: BoxSchema.extend({ stats: StatsSchema.nullable() }) }),
  rest: [{ method: "GET", path: "/api/boxes/:id" }],
  cli: "box get",
  mcp: {
    toolset: "core",
    name: "get_box",
    description: "Get one box by container id, container name, stable id or box name, with its current resource usage.",
  },
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: ({ host }, input) => readBox(host, input.id),
  audit: { target: (_input, box) => box && boxTarget(box) },
  run: async ({ host }, _input, box) => ({ box: { ...box, stats: await statsOf(host, box).catch(() => null) } }),
});

export const boxCreate = defineOperation({
  name: "box.create",
  tag: "boxes",
  summary: "Create and start a box",
  kind: "write",
  scope: "box:write",
  async: false,
  conflicts: true,
  input: z.object({
    name: boxName(),
    template: templateImage(),
    cpus: cpusWithDefault(DEFAULT_RESOURCES.cpus),
    memoryMb: memoryWithDefault(DEFAULT_RESOURCES.memoryMb),
    profile: boxProfile(),
    mounts: z
      .array(
        z.object({
          volume: z.string().meta({ description: "Volume id (vol_…) or volume name." }),
          path: z.string().meta({ description: "Absolute path inside the box." }),
          mode: z.enum(["rw", "ro"]),
        }),
      )
      .optional()
      .meta({
        description:
          "Mounts to use instead of the four role volumes. An empty list creates a box with no mounts. Omitted, MiniBox creates workspace, home, tools and cache.",
      }),
    idleTimeoutSec: idleTimeout(),
    ttlSec: ttl("create"),
    host: hostId()
      .optional()
      .meta({ description: "Host to create the box on. Omitted, the box goes on the local host." }),
    tools: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(63)
          .regex(/^[a-z][a-z0-9-]*$/),
      )
      .max(32)
      .optional()
      .meta({
        description:
          "Catalog tool ids to record on the box spec (version latest). After create, call reconcile_tools (or install_tool) to install them onto the shared tools volume.",
      }),
  }),
  output: z.object({ box: BoxSchema }),
  rest: [{ method: "POST", path: "/api/boxes", body: true, status: 201 }],
  cli: "box create",
  mcp: {
    toolset: "core",
    name: "create_box",
    description:
      "Create and start a box from a template with the given CPU and memory limits and security profile. Optional host names the machine to create it on (default local, see list_hosts). Omitting the profile uses the host default. Omitting mounts creates workspace, home, tools and cache volumes. An empty mounts list creates a box with no mounts. Optional idleTimeoutSec (0 disables sleep) and ttlSec set lifecycle. Optional tools is a list of catalog ids recorded on the spec; call reconcile_tools afterwards to install them. Mounting an existing volume requires volume:attach. A read-write mount, and the workspace, home and cache volumes a new box creates, also require volume:write.",
  },
  hostFor: (ctx, input) => hostById(ctx, input.host ?? LOCAL_HOST_ID),
  precondition: ({ host }, input) => assertCapacity(host, input),
  activity: { action: () => "box.create", target: (input) => input.name },
  audit: { target: ({ name }, _box, result) => ({ kind: "box", id: result?.box.id, name }) },
  run: async (ctx, input) => {
    const { host, principal, record } = ctx;
    if (input.mounts) {
      await assertCanChangeMounts(ctx, input.mounts, []);
    } else {
      await assertCanCreateDefaultMounts(ctx, input.name);
    }
    return underQuota(ctx, { kind: "create", cpus: input.cpus, memoryMb: input.memoryMb }, async () => ({
      box: await createBox(
        host,
        {
          name: input.name,
          image: input.template,
          cpus: input.cpus,
          memoryMb: input.memoryMb,
          profile: input.profile,
          createdBy: principal.id,
          mounts: input.mounts,
          idleTimeoutSec: input.idleTimeoutSec,
          ttlSec: ttlFor(principal, input.ttlSec),
          tools: input.tools,
        },
        record,
      ),
    }));
  },
});

export const boxDelete = defineOperation({
  name: "box.delete",
  tag: "boxes",
  summary: "Delete a box",
  kind: "destructive",
  scope: "box:delete",
  async: false,
  input: z.object({ id: boxId(), deleteVolume: deleteVolumeFlag() }),
  output: z.object({ name: z.string(), volumeDeleted: z.boolean(), volumeError: z.string().optional() }),
  rest: [{ method: "DELETE", path: "/api/boxes/:id", query: ["deleteVolume"] }],
  cli: "box rm",
  mcp: {
    toolset: "core",
    name: "delete_box",
    description:
      "Delete a box and its container. Pass deleteVolume to remove volumes that this box owns and that no other box mounts. Independent volumes, including the shared tools volume, are kept.",
  },
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: ({ host }, input) => getBox(host, input.id),
  activity: { action: () => "box.delete", target: (_input, box) => box.name },
  audit: { target: (_input, box) => box && boxTarget(box) },
  run: ({ host }, input) => deleteBox(host, input.id, input.deleteVolume),
});

export const boxAction = defineOperation({
  name: "box.action",
  tag: "boxes",
  summary: "Start, stop or restart a box",
  kind: "write",
  scope: "box:write",
  async: false,
  input: z.object({ id: boxId(), action: z.enum(["start", "stop", "restart"]) }),
  output: z.object({ box: BoxSchema }),
  rest: [
    { method: "POST", path: "/api/boxes/:id/start", fixed: { action: "start" } },
    { method: "POST", path: "/api/boxes/:id/stop", fixed: { action: "stop" } },
    { method: "POST", path: "/api/boxes/:id/restart", fixed: { action: "restart" } },
  ],
  cli: "box action",
  mcp: {
    toolset: "core",
    name: "box_action",
    description: "Start, stop or restart a box. Stopping keeps the workspace volume.",
  },
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: ({ host }, input) => getBox(host, input.id),
  activity: { action: (input) => `box.${input.action}`, target: (_input, box) => box.name },
  audit: { target: (_input, box) => box && boxTarget(box) },
  run: async ({ host }, input) => ({ box: await ACTIONS[input.action](host, input.id) }),
});

export const boxResources = defineOperation({
  name: "box.resources",
  tag: "boxes",
  summary: "Change the CPU, memory or process limit of a box",
  kind: "write",
  scope: "box:write",
  async: false,
  input: z
    .object({
      id: boxId(),
      cpus: optionalCpus(),
      memoryMb: optionalMemoryMb(),
      pids: optionalPids(),
      expectedRevision: expectedRevision(),
    })
    .superRefine((input, ctx) => requireResources(ctx, input)),
  output: z.object({ box: BoxSchema }),
  rest: [{ method: "PATCH", path: "/api/boxes/:id/resources", body: true, ifMatch: true }],
  cli: "box resize",
  precondition: ({ host }, input) => assertCapacity(host, input),
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: ({ host }, input) => getBox(host, input.id),
  activity: { action: () => "box.resources", target: (_input, box) => box.name },
  audit: { target: (_input, box) => box && boxTarget(box) },
  run: async (ctx, input, box) =>
    underQuota(ctx, { kind: "resize", boxId: box.boxId, cpus: input.cpus, memoryMb: input.memoryMb }, async () => ({
      box: await updateBox(ctx.host, input.id, requireRevision(input.expectedRevision), {
        cpus: input.cpus,
        memoryMb: input.memoryMb,
        pids: input.pids,
      }),
    })),
});

function inPlacePatch(input: {
  name?: string;
  cpus?: number;
  memoryMb?: number;
  pids?: number;
  labels?: Record<string, string>;
  idleTimeoutSec?: number | null;
  ttlSec?: number | null;
}): BoxUpdate | undefined {
  const patch: BoxUpdate = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.cpus !== undefined) patch.cpus = input.cpus;
  if (input.memoryMb !== undefined) patch.memoryMb = input.memoryMb;
  if (input.pids !== undefined) patch.pids = input.pids;
  if (input.labels !== undefined) patch.labels = input.labels;
  if (input.idleTimeoutSec !== undefined) patch.idleTimeoutSec = input.idleTimeoutSec;
  if (input.ttlSec !== undefined) patch.ttlSec = input.ttlSec;
  return Object.keys(patch).length > 0 ? patch : undefined;
}

export const boxUpdate = defineOperation({
  name: "box.update",
  tag: "boxes",
  summary: "Update a box in place",
  kind: "write",
  scope: "box:write",
  async: false,
  conflicts: true,
  input: z
    .object({
      id: boxId(),
      name: optionalBoxName(),
      cpus: optionalCpus(),
      memoryMb: optionalMemoryMb(),
      pids: optionalPids(),
      labels: userLabels(),
      idleTimeoutSec: idleTimeout(),
      ttlSec: ttl(),
      template: templateImage(),
      mounts: rebuildMounts(),
      env: rebuildEnv(),
      network: rebuildNetwork(),
      profile: boxProfile(),
      expectedRevision: expectedRevision(),
    })
    .superRefine((input, ctx) => requireUpdate(ctx, input)),
  output: z.object({ box: BoxSchema }),
  rest: [{ method: "PATCH", path: "/api/boxes/:id", body: true, ifMatch: true }],
  cli: "box update",
  mcp: {
    toolset: "core",
    name: "update_box",
    description:
      "Change a box in place: name, CPU, memory, process limit, labels, idle timeout or TTL. Pass expectedRevision, the box's current revision. Container labels are not changed. Template, mounts, env, network and profile are not applied in place: a difference returns 409 confirmation_required with a preview. Apply those with rebuild_box and confirm true. Attaching or detaching a volume rebuilds the box the same way, through attach_volume and detach_volume.",
  },
  precondition: ({ host }, input) => assertCapacity(host, input),
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: ({ host }, input) => getBox(host, input.id),
  activity: { action: () => "box.update", target: (_input, box) => box.name },
  audit: { target: (_input, box) => box && boxTarget(box) },
  run: async (ctx, input, box) => {
    const { host, principal } = ctx;
    if (input.mounts) await assertCanChangeMounts(ctx, input.mounts, box.mounts);
    const request = {
      template: input.template,
      mounts: input.mounts,
      env: input.env,
      network: input.network,
      profile: input.profile,
    };
    const patch = inPlacePatch({
      ...input,
      ttlSec: input.ttlSec === undefined ? undefined : ttlFor(principal, input.ttlSec),
    });
    return underQuota(
      ctx,
      { kind: "resize", boxId: box.boxId, cpus: input.cpus, memoryMb: input.memoryMb },
      async () => {
        if (hasRebuildFields(request)) {
          try {
            await rebuildBox(host, input.id, requireRevision(input.expectedRevision), request, false);
          } catch (e) {
            if (!(e instanceof AppError && e.key === "rebuild_empty" && patch)) throw e;
          }
        }
        if (!patch) throw badRequest(msg("rebuild_empty"));
        return { box: await updateBox(host, input.id, requireRevision(input.expectedRevision), patch) };
      },
    );
  },
});

export const boxRebuild = defineOperation({
  name: "box.rebuild",
  tag: "boxes",
  summary: "Rebuild a box from its spec",
  kind: "destructive",
  scope: "box:write",
  async: false,
  conflicts: true,
  input: z.object({
    id: boxId(),
    template: templateImage(),
    mounts: rebuildMounts(),
    env: rebuildEnv(),
    network: rebuildNetwork(),
    profile: boxProfile(),
    confirm: confirmFlag(),
    expectedRevision: expectedRevision(),
  }),
  output: z.object({ box: BoxSchema }),
  rest: [{ method: "POST", path: "/api/boxes/:id/rebuild", body: true, ifMatch: true }],
  cli: "box rebuild",
  mcp: {
    toolset: "rebuild",
    name: "rebuild_box",
    description:
      "Rebuild a box when the template, mounts, env, network or security profile must change. Without confirm true, the call is refused and the result includes a preview of the docker diff and the planned changes. The writable layer, running processes and the container IP are lost. Volumes, the stable id, the name and revision history are kept. A confirmed rebuild renames the container to <prefix>-<id> (decision D6: claim does not rename). A box whose template is a tag follows the tag: when the tag names another image, the preview lists it as a template change, and a confirmed rebuild runs the box on that image. Pass expectedRevision, the box's current revision.",
  },
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: ({ host }, input) => getBox(host, input.id),
  activity: { action: () => "box.rebuild", target: (_input, box) => box.name },
  audit: {
    target: (_input, box) => box && boxTarget(box),
    detail: (input) => ({
      confirm: input.confirm,
      template: input.template,
      profile: input.profile,
      network: input.network,
      mounts: input.mounts,
      env: input.env?.map((entry) => entry.name),
    }),
  },
  run: async (ctx, input, box) => {
    if (input.mounts) await assertCanChangeMounts(ctx, input.mounts, box.mounts);
    return {
      box: await rebuildBox(
        ctx.host,
        input.id,
        requireRevision(input.expectedRevision),
        {
          template: input.template,
          mounts: input.mounts,
          env: input.env,
          network: input.network,
          profile: input.profile,
        },
        input.confirm,
        ctx.record,
      ),
    };
  },
});

export const boxLogs = defineOperation({
  name: "box.logs",
  tag: "boxes",
  summary: "Read the recent log output of a box",
  kind: "read",
  scope: "box:read",
  async: false,
  input: z.object({ id: boxId(), tail: tail() }),
  output: z.object({ logs: z.string() }),
  rest: [{ method: "GET", path: "/api/boxes/:id/logs", query: ["tail"] }],
  cli: "box logs",
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: ({ host }, input) => readBox(host, input.id),
  audit: { target: ({ id }) => ({ kind: "box", name: id }) },
  run: async ({ host }, input) => ({ logs: await getLogs(host, input.id, input.tail) }),
});

export const boxStats = defineOperation({
  name: "box.stats",
  tag: "boxes",
  summary: "Read the current resource usage of a box",
  kind: "read",
  scope: "box:read",
  async: false,
  input: z.object({ id: boxId(), history: historyFlag() }),
  output: z.object({ stats: StatsSchema.nullable(), history: z.array(StatSampleSchema).optional() }),
  rest: [{ method: "GET", path: "/api/boxes/:id/stats", query: ["history"] }],
  cli: "box stats",
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: ({ host }, input) => readBox(host, input.id),
  audit: { target: ({ id }) => ({ kind: "box", name: id }) },
  run: async ({ host }, input) => {
    if (!input.history) return { stats: await getStats(host, input.id) };
    return getStatsWithHistory(host, input.id);
  },
});

export const boxOperations = [
  boxList,
  boxGet,
  boxCreate,
  boxDelete,
  boxAction,
  boxResources,
  boxUpdate,
  boxRebuild,
  boxLogs,
  boxStats,
];
