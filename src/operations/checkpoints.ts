import { z } from "zod";

import { CONSISTENCY_MODES } from "../checkpoints/types";
import type { EventTarget } from "../events/types";
import { conflict } from "../lib/errors";
import { msg } from "../lib/messages";
import { getBox } from "../services/boxes";
import { assertCapacity } from "../services/capacity";
import { assertAutomaticAllowed, usageOf } from "../services/checkpoint-capacity";
import {
  assertForkable,
  assertNotHeld,
  assertTakeable,
  type CheckpointView,
  deleteCheckpoint,
  forkCheckpoint,
  getCheckpoint,
  listCheckpoints,
  planRollback,
  previewRollback,
  rollbackBox,
  rollbackConfirmation,
  takeCheckpoint,
  type TakeCheckpointInput,
  updateCheckpoint,
} from "../services/checkpoints";
import {
  assertUndoable,
  cleanupConfirmation,
  cleanupPreview,
  confirmRollback,
  pendingRollbackView,
  undoConfirmation,
  undoPreview,
  undoRollback,
} from "../services/rollback";
import { requireRevision } from "../specs/revision";
import { snapshotVisible, specViews, ttlFor } from "../tokens/model";
import { assertCheckpointQuota, assertWithinQuota, underCheckpointQuota, underQuota } from "../tokens/quota";
import { assertCanCreateDefaultMounts, assertCanWrite } from "./authz";
import { boxTarget, DEFAULT_RESOURCES } from "./boxes";
import { defineOperation } from "./define";
import { BoxSchema, CheckpointSchema, CheckpointUsageSchema, OkSchema, PendingRollbackSchema } from "./schemas";
import {
  boxId,
  boxName,
  boxProfile,
  checkpointLabel,
  checkpointReason,
  cpusWithDefault,
  expectedRevision,
  memoryWithDefault,
  storageConfirmFlag,
  ttl,
} from "./validation";

const checkpointId = () => z.string().meta({ description: "Checkpoint id (ck_…), as the checkpoint list shows it." });

const checkpointTarget = (checkpoint: Pick<CheckpointView, "id" | "label">): EventTarget => ({
  kind: "checkpoint",
  id: checkpoint.id,
  name: checkpoint.label,
});

const checkpointCreateInput = z.object({
  id: boxId(),
  label: checkpointLabel(),
  reason: checkpointReason(),
  pinned: z
    .boolean()
    .default(false)
    .meta({ description: "Keep the checkpoint until it is unpinned. A pinned checkpoint cannot be deleted." }),
  include: z
    .object({
      system: z.boolean().default(false).meta({
        description:
          "Commit the writable layer as a system image, so a fork starts from it. Off by default; the image is kept with the checkpoint.",
      }),
      volumes: z.array(z.string()).default([]).meta({
        description:
          "Shared volumes the box mounts to include, by id or name. The box's owned volumes (workspace and home) are always included; cache and tools never are.",
      }),
    })
    .default({ system: false, volumes: [] })
    .meta({ description: "What to take beyond the default set: the box's owned workspace and home." }),
  consistency: z.enum(CONSISTENCY_MODES).default("live").meta({
    description:
      "How the box is held for the backup. live (default) reads the volumes while the box runs, crash-consistent. pause freezes a running box for the backup. stop stops a running box and starts it again afterwards.",
  }),
});

type CheckpointCreateInput = z.output<typeof checkpointCreateInput>;

function takeInput(input: CheckpointCreateInput): TakeCheckpointInput {
  return {
    label: input.label,
    reason: input.reason,
    pinned: input.pinned,
    include: input.include,
    consistency: input.consistency,
  };
}

export const checkpointList = defineOperation({
  name: "checkpoint.list",
  tag: "checkpoints",
  summary: "List checkpoints",
  kind: "read",
  scope: "checkpoint:read",
  async: false,
  input: z.object({}),
  output: z.object({ checkpoints: z.array(CheckpointSchema) }),
  rest: [{ method: "GET", path: "/api/checkpoints" }],
  cli: "checkpoint list",
  run: async ({ host, principal }) => {
    const checkpoints = await listCheckpoints(host);
    if (principal.type === "owner") return { checkpoints };
    const boxes = specViews(host.specs.list());
    return {
      checkpoints: checkpoints.filter((checkpoint) =>
        snapshotVisible(principal, { createdBy: checkpoint.createdBy, sourceId: checkpoint.boxId }, boxes),
      ),
    };
  },
});

/**
 * Owner-only: the repository's size is a host figure, like the host metrics. The scope is one no token holds, so the
 * route and the executor both refuse a token.
 */
export const checkpointUsage = defineOperation({
  name: "checkpoint.usage",
  tag: "checkpoints",
  summary: "Read the checkpoint repository's size against its limit",
  kind: "read",
  scope: "checkpoint:usage",
  async: false,
  input: z.object({}),
  output: CheckpointUsageSchema,
  rest: [{ method: "GET", path: "/api/checkpoints/usage" }],
  cli: "checkpoint usage",
  run: async ({ host }) => usageOf(host),
});

export const checkpointGet = defineOperation({
  name: "checkpoint.get",
  tag: "checkpoints",
  summary: "Get one checkpoint",
  kind: "read",
  scope: "checkpoint:read",
  async: false,
  input: z.object({ id: checkpointId() }),
  output: z.object({ checkpoint: CheckpointSchema }),
  rest: [{ method: "GET", path: "/api/checkpoints/:id" }],
  cli: "checkpoint get",
  resolve: ({ host }, input) => getCheckpoint(host, input.id),
  run: async (_ctx, _input, checkpoint) => ({ checkpoint }),
});

export const checkpointCreate = defineOperation({
  name: "checkpoint.create",
  tag: "checkpoints",
  summary: "Take a checkpoint of a box",
  kind: "write",
  scope: "checkpoint:create",
  async: true,
  conflicts: true,
  input: checkpointCreateInput,
  output: z.object({ checkpoint: CheckpointSchema }),
  rest: [{ method: "POST", path: "/api/boxes/:id/checkpoints", body: true, status: 202 }],
  cli: "checkpoint create",
  resolve: ({ host }, input) => getBox(host, input.id),
  beforeTask: async (ctx, input, box) => {
    assertTakeable(ctx.host, box, takeInput(input));
    assertCheckpointQuota(ctx);
  },
  exclusive: ({ host }, _input, box) => `checkpoint.box:${host.host.id}:${box.boxId}`,
  activity: { action: () => "checkpoint.create", target: (_input, box) => box.name },
  audit: { target: (_input, box) => box && boxTarget(box) },
  run: async (ctx, input) => ({
    checkpoint: await underCheckpointQuota(ctx, () =>
      takeCheckpoint(ctx.host, input.id, takeInput(input), ctx.principal.id, ctx.task),
    ),
  }),
});

export const checkpointFork = defineOperation({
  name: "checkpoint.fork",
  tag: "checkpoints",
  summary: "Create a box from a checkpoint",
  kind: "write",
  scope: "box:write",
  async: true,
  conflicts: true,
  input: z.object({
    id: checkpointId(),
    name: boxName(),
    cpus: cpusWithDefault(DEFAULT_RESOURCES.cpus),
    memoryMb: memoryWithDefault(DEFAULT_RESOURCES.memoryMb),
    profile: boxProfile(),
    copyHome: z.boolean().default(false).meta({
      description:
        "Copy the checkpoint's home content into the new box. Off by default, so the new box starts with an empty home.",
    }),
    ttlSec: ttl("create"),
  }),
  output: z.object({ box: BoxSchema }),
  rest: [{ method: "POST", path: "/api/checkpoints/:id/fork", body: true, status: 202 }],
  cli: "checkpoint fork",
  precondition: ({ host }, input) => assertCapacity(host, input),
  resolve: ({ host }, input) => getCheckpoint(host, input.id),
  beforeTask: async (ctx, input, checkpoint) => {
    assertForkable(checkpoint, input.copyHome);
    if (ctx.host.specs.findByName(input.name)) throw conflict(msg("box_exists", { name: input.name }));
    await assertCanCreateDefaultMounts(ctx, input.name);
    assertWithinQuota(ctx, { kind: "create", cpus: input.cpus, memoryMb: input.memoryMb });
  },
  activity: { action: () => "box.create", target: (input) => input.name },
  audit: { target: (input, _checkpoint, result) => ({ kind: "box", id: result?.box.id, name: input.name }) },
  run: async (ctx, input) => {
    const { host, principal, task } = ctx;
    return underQuota(ctx, { kind: "create", cpus: input.cpus, memoryMb: input.memoryMb }, async () => ({
      box: await forkCheckpoint(
        host,
        input.id,
        {
          name: input.name,
          cpus: input.cpus,
          memoryMb: input.memoryMb,
          profile: input.profile,
          copyHome: input.copyHome,
          ttlSec: ttlFor(principal, input.ttlSec),
        },
        principal.id,
        task,
      ),
    }));
  },
});

export const checkpointUpdate = defineOperation({
  name: "checkpoint.update",
  tag: "checkpoints",
  summary: "Pin or relabel a checkpoint",
  kind: "write",
  scope: "checkpoint:write",
  async: true,
  conflicts: true,
  input: z.object({
    id: checkpointId(),
    pinned: z.boolean().optional().meta({
      description: "Pin the checkpoint (true), or unpin it (false). A pinned checkpoint cannot be deleted.",
    }),
    label: checkpointLabel(),
  }),
  output: z.object({ checkpoint: CheckpointSchema }),
  rest: [{ method: "PATCH", path: "/api/checkpoints/:id", body: true, status: 202 }],
  cli: "checkpoint update",
  resolve: ({ host }, input) => getCheckpoint(host, input.id),
  beforeTask: async (_ctx, _input, checkpoint) => {
    if (checkpoint.legacy) throw conflict(msg("checkpoint_legacy_read_only", { id: checkpoint.id }));
  },
  exclusive: ({ host }, _input, checkpoint) => `checkpoint.item:${host.host.id}:${checkpoint.id}`,
  activity: { action: () => "checkpoint.update", target: (_input, checkpoint) => checkpoint.label },
  audit: { target: (_input, checkpoint) => checkpoint && checkpointTarget(checkpoint) },
  run: async ({ host }, input, checkpoint) => ({
    checkpoint: await updateCheckpoint(host, checkpoint.id, { pinned: input.pinned, label: input.label }),
  }),
});

export const checkpointDelete = defineOperation({
  name: "checkpoint.delete",
  tag: "checkpoints",
  summary: "Delete a checkpoint",
  kind: "destructive",
  scope: "checkpoint:delete",
  async: true,
  conflicts: true,
  input: z.object({ id: checkpointId() }),
  output: OkSchema,
  rest: [{ method: "DELETE", path: "/api/checkpoints/:id", status: 202 }],
  cli: "checkpoint rm",
  resolve: ({ host }, input) => getCheckpoint(host, input.id),
  beforeTask: async ({ host }, _input, checkpoint) => {
    if (checkpoint.pinned) throw conflict(msg("checkpoint_pinned", { id: checkpoint.id }));
    assertNotHeld(host, checkpoint.id);
  },
  exclusive: ({ host }, _input, checkpoint) => `checkpoint.item:${host.host.id}:${checkpoint.id}`,
  activity: { action: () => "checkpoint.delete", target: (_input, checkpoint) => checkpoint.label },
  audit: { target: (_input, checkpoint) => checkpoint && checkpointTarget(checkpoint) },
  run: async ({ host }, input) => {
    await deleteCheckpoint(host, input.id);
    return { ok: true as const };
  },
});

export const boxRollback = defineOperation({
  name: "box.rollback",
  tag: "checkpoints",
  summary: "Roll a box back to one of its checkpoints",
  kind: "destructive",
  scope: "checkpoint:restore",
  async: true,
  conflicts: true,
  input: z.object({
    id: boxId(),
    checkpoint: z.string().meta({ description: "Checkpoint id (ck_…) taken from this box." }),
    confirm: storageConfirmFlag(),
    expectedRevision: expectedRevision(),
  }),
  output: z.object({
    box: BoxSchema,
    replaced: z.array(z.object({ id: z.string(), name: z.string() })),
    safety: z.object({ id: z.string(), label: z.string() }).meta({
      description: "The checkpoint taken before the rollback. It holds the data the replaced volumes held.",
    }),
  }),
  rest: [{ method: "POST", path: "/api/boxes/:id/rollback", body: true, ifMatch: true, status: 202 }],
  cli: "box rollback",
  precondition: (ctx) => assertCanWrite(ctx),
  resolve: ({ host }, input) => getBox(host, input.id),
  beforeTask: async ({ host }, input) => {
    const revision = requireRevision(input.expectedRevision);
    if (!input.confirm) throw rollbackConfirmation(await previewRollback(host, input.id, input.checkpoint, revision));
    await planRollback(host, input.id, input.checkpoint, revision);
    await assertAutomaticAllowed(host);
  },
  exclusive: ({ host }, _input, box) => `checkpoint.box:${host.host.id}:${box.boxId}`,
  activity: { action: () => "box.rollback", target: (_input, box) => box.name },
  audit: { target: (_input, box) => box && boxTarget(box) },
  run: async (ctx, input) => {
    const result = await rollbackBox(
      ctx.host,
      input.id,
      { checkpoint: input.checkpoint, confirm: true, revision: requireRevision(input.expectedRevision) },
      ctx.principal.id,
      ctx.task,
    );
    return { box: result.box, replaced: result.replaced, safety: result.safety };
  },
});

const replacedVolumes = z.array(z.object({ id: z.string(), name: z.string() }));

export const boxRollbackGet = defineOperation({
  name: "box.rollback.get",
  tag: "checkpoints",
  summary: "Read the rollback of a box that waits for its confirm or undo",
  kind: "read",
  scope: "checkpoint:read",
  async: false,
  input: z.object({ id: boxId() }),
  output: z.object({ rollback: PendingRollbackSchema.nullable() }),
  rest: [{ method: "GET", path: "/api/boxes/:id/rollback" }],
  cli: "box rollback-status",
  resolve: ({ host }, input) => getBox(host, input.id),
  run: async ({ host }, _input, box) => ({ rollback: pendingRollbackView(host, box.boxId) }),
});

/**
 * Deletes the volumes a rollback replaced. Those volumes are no longer mounted, and the safety checkpoint still holds
 * their data, so this step is the only one that removes them.
 */
export const boxRollbackConfirm = defineOperation({
  name: "box.rollback.confirm",
  tag: "checkpoints",
  summary: "Confirm a rollback: delete the volumes it replaced",
  kind: "destructive",
  scope: "volume:write",
  async: true,
  conflicts: true,
  input: z.object({
    id: boxId(),
    confirm: storageConfirmFlag(),
  }),
  output: z.object({ removed: replacedVolumes }),
  rest: [{ method: "POST", path: "/api/boxes/:id/rollback/confirm", body: true, status: 202 }],
  cli: "box rollback-confirm",
  resolve: ({ host }, input) => getBox(host, input.id),
  beforeTask: async ({ host }, input, box) => {
    const preview = cleanupPreview(host, box);
    if (!input.confirm) throw cleanupConfirmation(preview);
  },
  exclusive: ({ host }, _input, box) => `checkpoint.box:${host.host.id}:${box.boxId}`,
  activity: { action: () => "box.rollback.confirm", target: (_input, box) => box.name },
  audit: { target: (_input, box) => box && boxTarget(box) },
  run: async ({ host, task }, input) => confirmRollback(host, input.id, task),
});

/**
 * Mounts the volumes a rollback replaced again, and deletes the ones it restored. The box is rebuilt, so the revision
 * rules of a rebuild apply, and so does the power lock. Data written since the rollback is lost.
 */
export const boxRollbackUndo = defineOperation({
  name: "box.rollback.undo",
  tag: "checkpoints",
  summary: "Undo a rollback: mount the volumes it replaced again",
  kind: "destructive",
  scope: "checkpoint:restore",
  async: true,
  conflicts: true,
  input: z.object({
    id: boxId(),
    confirm: storageConfirmFlag(),
    expectedRevision: expectedRevision(),
  }),
  output: z.object({ box: BoxSchema }),
  rest: [{ method: "POST", path: "/api/boxes/:id/rollback/undo", body: true, ifMatch: true, status: 202 }],
  cli: "box rollback-undo",
  precondition: (ctx) => assertCanWrite(ctx),
  resolve: ({ host }, input) => getBox(host, input.id),
  beforeTask: async ({ host }, input, box) => {
    const revision = requireRevision(input.expectedRevision);
    if (!input.confirm) throw undoConfirmation(undoPreview(host, box, revision));
    assertUndoable(host, box, revision);
  },
  exclusive: ({ host }, _input, box) => `checkpoint.box:${host.host.id}:${box.boxId}`,
  activity: { action: () => "box.rollback.undo", target: (_input, box) => box.name },
  audit: { target: (_input, box) => box && boxTarget(box) },
  run: async (ctx, input) => ({
    box: await undoRollback(ctx.host, input.id, { revision: requireRevision(input.expectedRevision) }, ctx.task),
  }),
});

/** `checkpointUsage` precedes `checkpointGet`: the router takes the first path that matches, and `usage` is not an id. */
export const checkpointOperations = [
  checkpointList,
  checkpointUsage,
  checkpointGet,
  checkpointCreate,
  checkpointFork,
  checkpointUpdate,
  checkpointDelete,
  boxRollback,
  boxRollbackGet,
  boxRollbackConfirm,
  boxRollbackUndo,
];
