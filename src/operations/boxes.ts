import { z } from "zod";

import type { EventTarget } from "../events/types";
import type { HostCtx } from "../host/registry";
import {
  type Box,
  createBox,
  deleteBox,
  getBox,
  getLogs,
  getStats,
  listBoxes,
  restartBox,
  startBox,
  stopBox,
  updateResources,
} from "../services/boxes";
import { assertCapacity } from "../services/capacity";
import { defineOperation } from "./define";
import { BoxSchema, BoxWithStatsSchema, StatsSchema } from "./schemas";
import {
  boxId,
  boxName,
  cpusWithDefault,
  deleteVolumeFlag,
  memoryWithDefault,
  optionalCpus,
  optionalMemoryMb,
  requireResources,
  statsFlag,
  tail,
  templateImage,
} from "./validation";

export const DEFAULT_RESOURCES = { cpus: 2, memoryMb: 4096 } as const;

export const boxTarget = (box: Pick<Box, "id" | "name">): EventTarget => ({ kind: "box", id: box.id, name: box.name });

const ACTIONS: Record<"start" | "stop" | "restart", (host: HostCtx, id: string) => Promise<Box>> = {
  start: startBox,
  stop: stopBox,
  restart: restartBox,
};

export const boxList = defineOperation({
  name: "box.list",
  tag: "boxes",
  summary: "List boxes",
  kind: "read",
  scope: "box:read",
  async: false,
  input: z.object({ stats: statsFlag() }),
  output: z.object({ boxes: z.array(BoxWithStatsSchema) }),
  rest: [{ method: "GET", path: "/api/boxes", query: ["stats"] }],
  cli: "box list",
  mcp: {
    toolset: "core",
    name: "list_boxes",
    description: "List the boxes on this host, with the current resource usage of running boxes.",
  },
  run: async ({ host }, input) => ({ boxes: await listBoxes(host, { withStats: input.stats }) }),
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
    description: "Get one box by id or container name, with its current resource usage.",
  },
  resolve: ({ host }, input) => getBox(host, input.id),
  audit: { target: (_input, box) => box && boxTarget(box) },
  run: async ({ host }, _input, box) => ({ box: { ...box, stats: await getStats(host, box.id).catch(() => null) } }),
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
  }),
  output: z.object({ box: BoxSchema }),
  rest: [{ method: "POST", path: "/api/boxes", body: true, status: 201 }],
  cli: "box create",
  mcp: {
    toolset: "core",
    name: "create_box",
    description: "Create and start a box from a template with the given CPU and memory limits.",
  },
  precondition: ({ host }, input) => assertCapacity(host, input),
  activity: { action: () => "box.create", target: (input) => input.name },
  audit: { target: ({ name }, _box, result) => ({ kind: "box", id: result?.box.id, name }) },
  run: async ({ host }, input) => ({
    box: await createBox(host, { name: input.name, image: input.template, cpus: input.cpus, memoryMb: input.memoryMb }),
  }),
});

export const boxDelete = defineOperation({
  name: "box.delete",
  tag: "boxes",
  summary: "Delete a box",
  kind: "destructive",
  scope: "box:delete",
  async: false,
  input: z.object({ id: boxId(), deleteVolume: deleteVolumeFlag() }),
  output: z.object({ name: z.string(), volumeDeleted: z.boolean() }),
  rest: [{ method: "DELETE", path: "/api/boxes/:id", query: ["deleteVolume"] }],
  cli: "box rm",
  mcp: {
    toolset: "core",
    name: "delete_box",
    description: "Delete a box and its container. Pass deleteVolume to remove its workspace volume as well.",
  },
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
  resolve: ({ host }, input) => getBox(host, input.id),
  activity: { action: (input) => `box.${input.action}`, target: (_input, box) => box.name },
  audit: { target: (_input, box) => box && boxTarget(box) },
  run: async ({ host }, input) => ({ box: await ACTIONS[input.action](host, input.id) }),
});

export const boxResources = defineOperation({
  name: "box.resources",
  tag: "boxes",
  summary: "Change the CPU or memory limit of a box",
  kind: "write",
  scope: "box:write",
  async: false,
  input: z
    .object({ id: boxId(), cpus: optionalCpus(), memoryMb: optionalMemoryMb() })
    .superRefine((input, ctx) => requireResources(ctx, input)),
  output: z.object({ box: BoxSchema }),
  rest: [{ method: "PATCH", path: "/api/boxes/:id/resources", body: true }],
  cli: "box resize",
  mcp: {
    toolset: "core",
    name: "update_box",
    description: "Change the CPU or memory limit of a box. Only the limits that are passed change.",
  },
  precondition: ({ host }, input) => assertCapacity(host, input),
  resolve: ({ host }, input) => getBox(host, input.id),
  activity: { action: () => "box.resources", target: (_input, box) => box.name },
  audit: { target: (_input, box) => box && boxTarget(box) },
  run: async ({ host }, input) => {
    const limits: { cpus?: number; memoryMb?: number } = {};
    if (input.cpus !== undefined) limits.cpus = input.cpus;
    if (input.memoryMb !== undefined) limits.memoryMb = input.memoryMb;
    return { box: await updateResources(host, input.id, limits) };
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
  input: z.object({ id: boxId() }),
  output: z.object({ stats: StatsSchema.nullable() }),
  rest: [{ method: "GET", path: "/api/boxes/:id/stats" }],
  cli: "box stats",
  audit: { target: ({ id }) => ({ kind: "box", name: id }) },
  run: async ({ host }, input) => ({ stats: await getStats(host, input.id) }),
});

export const boxOperations = [boxList, boxGet, boxCreate, boxDelete, boxAction, boxResources, boxLogs, boxStats];
