import { z } from "zod";

import { DEFAULT_TIMEZONE, ruleOf } from "../checkpoints/schedule";
import { LOCAL_HOST_ID } from "../host/registry";
import { badRequest } from "../lib/errors";
import { msg } from "../lib/messages";
import { getBox } from "../services/boxes";
import { clearSchedule, scheduleOf, setSchedule } from "../services/checkpoint-schedule";
import { assertExportable, exportCheckpoint, importPackage, packageView } from "../services/checkpoint-transfer";
import { getCheckpoint } from "../services/checkpoints";
import { assertHostDiskRoom } from "../volumes/disk";
import { boxTarget } from "./boxes";
import { checkpointId, checkpointTarget } from "./checkpoints";
import { defineOperation } from "./define";
import { hostById, hostOfBox, hostOfCheckpoint } from "./routing";
import { CheckpointPackageSchema, CheckpointScheduleSchema, CheckpointSchema, OkSchema } from "./schemas";
import {
  addFailure,
  boxId,
  hostId,
  packageRef,
  passphrase,
  scheduleAt,
  scheduleEveryHours,
  scheduleTimezone,
} from "./validation";

const scheduleInput = z
  .object({
    id: boxId(),
    everyHours: scheduleEveryHours(),
    at: scheduleAt(),
    timezone: scheduleTimezone(),
  })
  .superRefine((input, ctx) => {
    if (!ruleOf(input)) addFailure(ctx, { message: msg("schedule_rule_invalid") });
  });

export const checkpointExport = defineOperation({
  name: "checkpoint.export",
  tag: "checkpoints",
  summary: "Export a checkpoint as a sealed package",
  kind: "write",
  scope: "checkpoint:export",
  async: true,
  conflicts: true,
  input: z.object({
    id: checkpointId(),
    passphrase: passphrase(),
  }),
  output: z.object({ package: CheckpointPackageSchema }),
  rest: [{ method: "POST", path: "/api/checkpoints/:id/export", body: true, status: 202 }],
  cli: "checkpoint export",
  mcp: {
    toolset: "storage",
    name: "export_checkpoint",
    description:
      "Export a checkpoint as a sealed package that only its passphrase opens. MiniBox never stores the passphrase. Returns a task id; the finished task holds the package id, and the package is downloaded from /api/packages/<id>/download and kept for a day. Owner only.",
  },
  hostFor: (ctx, input) => hostOfCheckpoint(ctx, input.id),
  resolve: ({ host }, input) => getCheckpoint(host, input.id),
  beforeTask: async (_ctx, _input, checkpoint) => assertExportable(checkpoint),
  exclusive: ({ host }, _input, checkpoint) => `checkpoint.item:${host.host.id}:${checkpoint.id}`,
  activity: { action: () => "checkpoint.export", target: (_input, checkpoint) => checkpoint.label },
  audit: {
    target: (_input, checkpoint) => checkpoint && checkpointTarget(checkpoint),
    detail: (input, _checkpoint, result) => ({
      checkpointId: input.id,
      package: result?.package.id ?? null,
      bytes: result?.package.bytes ?? null,
    }),
  },
  run: async ({ host, principal, task }, input, checkpoint) => ({
    package: packageView(await exportCheckpoint(host, checkpoint.id, input.passphrase, principal.id, task)),
  }),
});

export const checkpointImport = defineOperation({
  name: "checkpoint.import",
  tag: "checkpoints",
  summary: "Import a sealed package as a checkpoint",
  kind: "write",
  scope: "checkpoint:import",
  async: true,
  conflicts: true,
  input: z.object({
    id: packageRef(),
    passphrase: passphrase(),
    host: hostId()
      .optional()
      .meta({ description: "Host to import the checkpoint on. Omitted, the package goes on the local host." }),
  }),
  output: z.object({ checkpoint: CheckpointSchema }),
  rest: [{ method: "POST", path: "/api/packages/:id/import", body: true, status: 202 }],
  cli: "checkpoint import",
  mcp: {
    toolset: "storage",
    name: "import_checkpoint",
    description:
      "Import a package on this instance as a checkpoint, once its bytes are here: upload them with POST /api/packages, then pass the returned package id and the passphrase it was sealed with. Optional host names the machine to import on (default local, see list_hosts). Returns a task id; the finished task holds the checkpoint, which can then be forked. Owner only.",
  },
  hostFor: (ctx, input) => hostById(ctx, input.host ?? LOCAL_HOST_ID),
  beforeTask: async ({ host }) => {
    await assertHostDiskRoom(host);
  },
  // Checkpoint records are shared by every host, so two imports of one checkpoint must not run on two hosts at once.
  exclusive: () => "checkpoint.import",
  activity: { action: () => "checkpoint.import", target: (input) => input.id },
  audit: {
    target: (_input, _resolved, result) => (result ? checkpointTarget(result.checkpoint) : undefined),
    detail: (input, _resolved, result) => ({
      package: input.id,
      checkpointId: result?.checkpoint.id ?? null,
    }),
  },
  run: async ({ host, principal, task }, input) => ({
    checkpoint: await importPackage(host, input.id, input.passphrase, principal.id, task),
  }),
});

export const checkpointScheduleGet = defineOperation({
  name: "checkpoint.schedule.get",
  tag: "checkpoints",
  summary: "Read a box's checkpoint schedule",
  kind: "read",
  scope: "checkpoint:schedule",
  async: false,
  input: z.object({ id: boxId() }),
  output: z.object({ schedule: CheckpointScheduleSchema.nullable() }),
  rest: [{ method: "GET", path: "/api/boxes/:id/checkpoint-schedule" }],
  cli: "checkpoint schedule",
  mcp: {
    toolset: "storage",
    name: "get_checkpoint_schedule",
    description:
      "Read a box's checkpoint schedule, with the next and the last scheduled run. A null schedule means none is set, which is the default. Owner only.",
  },
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: ({ host }, input) => getBox(host, input.id),
  run: async ({ host }, _input, box) => ({ schedule: await scheduleOf(host, box.boxId) }),
});

export const checkpointScheduleSet = defineOperation({
  name: "checkpoint.schedule.set",
  tag: "checkpoints",
  summary: "Set a box's checkpoint schedule",
  kind: "write",
  scope: "checkpoint:schedule",
  async: false,
  input: scheduleInput,
  output: z.object({ schedule: CheckpointScheduleSchema }),
  rest: [{ method: "PUT", path: "/api/boxes/:id/checkpoint-schedule", body: true }],
  cli: "checkpoint schedule-set",
  mcp: {
    toolset: "storage",
    name: "set_checkpoint_schedule",
    description:
      "Set a box's checkpoint schedule. Send everyHours (1 to 720) or at (HH:MM), not both. With at, send timezone, an IANA zone such as Asia/Shanghai; without it the time is UTC. A scheduled checkpoint is taken in the background and follows the retention policy and the repository limit. A stopped or sleeping box is skipped and never woken. Replaces any schedule the box has. Owner only.",
  },
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: ({ host }, input) => getBox(host, input.id),
  activity: { action: () => "checkpoint.schedule", target: (_input, box) => box.name },
  audit: {
    target: (_input, box) => box && boxTarget(box),
    detail: (input, box) => ({
      boxId: box?.boxId ?? null,
      everyHours: input.everyHours ?? null,
      at: input.at ?? null,
      timezone: input.at ? (input.timezone ?? DEFAULT_TIMEZONE) : null,
    }),
  },
  run: async ({ host, principal }, input, box) => {
    const rule = ruleOf(input);
    if (!rule) throw badRequest(msg("schedule_rule_invalid"));
    return { schedule: await setSchedule(host, box.boxId, rule, principal.id) };
  },
});

export const checkpointScheduleClear = defineOperation({
  name: "checkpoint.schedule.clear",
  tag: "checkpoints",
  summary: "Remove a box's checkpoint schedule",
  kind: "write",
  scope: "checkpoint:schedule",
  async: false,
  input: z.object({ id: boxId() }),
  output: OkSchema,
  rest: [{ method: "DELETE", path: "/api/boxes/:id/checkpoint-schedule" }],
  cli: "checkpoint schedule-clear",
  mcp: {
    toolset: "storage",
    name: "clear_checkpoint_schedule",
    description:
      "Remove a box's checkpoint schedule. Checkpoints already taken are kept. Clearing a box with no schedule is not an error. Owner only.",
  },
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: ({ host }, input) => getBox(host, input.id),
  activity: { action: () => "checkpoint.schedule.clear", target: (_input, box) => box.name },
  audit: { target: (_input, box) => box && boxTarget(box) },
  run: async ({ host }, _input, box) => {
    await clearSchedule(host, box.boxId);
    return { ok: true as const };
  },
});

export const checkpointPackageOperations = [
  checkpointExport,
  checkpointImport,
  checkpointScheduleGet,
  checkpointScheduleSet,
  checkpointScheduleClear,
];
