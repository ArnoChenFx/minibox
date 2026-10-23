import { z } from "zod";

import { BOX_PROFILES } from "../box-profile";
import { getBox } from "../services/boxes";
import { applyStaged, discardStaged, previewStaged, readStaged, stageChanges } from "../services/staged";
import { requireRevision } from "../specs/revision";
import type { StagedFields } from "../specs/staged";
import { assertCanChangeMounts } from "./authz";
import { boxTarget } from "./boxes";
import { defineOperation } from "./define";
import { hostOfBox } from "./routing";
import { BoxEgressSchema, BoxEnvSchema, BoxSchema, OkSchema, SafetyCheckpointSchema } from "./schemas";
import type { OperationContext } from "./types";
import {
  boxId,
  boxProfile,
  egressInput,
  expectedRevision,
  rebuildEnv,
  rebuildMounts,
  rebuildNetwork,
  safetyCheckpointFlag,
  templateImage,
} from "./validation";

const STAGED_FIELD_NAMES = ["template", "mounts", "env", "network", "egress", "profile"] as const;

const StagedFieldsSchema = z.object({
  template: z.string().optional(),
  mounts: z.array(z.object({ volume: z.string(), path: z.string(), mode: z.enum(["rw", "ro"]) })).optional(),
  env: z.array(BoxEnvSchema).optional(),
  network: z.string().optional(),
  egress: BoxEgressSchema.optional(),
  profile: z.enum(BOX_PROFILES).nullable().optional(),
});

const RebuildChangeSchema = z.object({
  field: z.enum([...STAGED_FIELD_NAMES, "containerName"]),
  from: z.string(),
  to: z.string(),
});

const StagedSchema = z
  .object({
    fields: StagedFieldsSchema.meta({ description: "The staged values. A field left out stays as the box has it." }),
    pending: z.array(z.enum(STAGED_FIELD_NAMES)).meta({
      description: "The staged fields that still differ from the box. A field that matches the box again is dropped.",
    }),
    changes: z.array(RebuildChangeSchema).meta({ description: "What applying would change, field by field." }),
    problem: z.string().nullable().meta({
      description: "Why the staged changes cannot be applied as they stand, such as a secret that is no longer set.",
    }),
    baseRevision: z.number().int(),
    updatedAt: z.string(),
    updatedBy: z.string(),
  })
  .nullable()
  .meta({ description: "Null when nothing is staged." });

const StagedPreviewSchema = z.object({
  changes: z.array(RebuildChangeSchema),
  diff: z
    .array(z.object({ path: z.string(), kind: z.enum(["added", "modified", "deleted"]) }))
    .meta({ description: "Changes in the container's writable layer. The rebuild loses them." }),
  keeps: z.array(z.string()),
  loses: z.array(z.string()),
  containerName: z.object({ from: z.string(), to: z.string() }),
  revision: z.object({ current: z.number().int(), next: z.number().int() }),
  sessions: z.number().int().nullable().meta({
    description: "Terminal sessions that end with the old container. Null when they could not be read.",
  }),
  systemCheckpoint: z.boolean().meta({
    description: "Whether the checkpoint taken first can include the writable layer. Not when the env names a secret.",
  }),
  stagedAt: z.string().meta({ description: "When the staged changes were last changed. Pass it to apply." }),
});

const resolveBox = ({ host }: OperationContext, input: { id: string }) => getBox(host, input.id);

export const boxStagedGet = defineOperation({
  name: "box.staged.get",
  tag: "boxes",
  summary: "Read a box's staged changes",
  kind: "read",
  scope: "box:read",
  async: false,
  input: z.object({ id: boxId() }),
  output: z.object({ staged: StagedSchema }),
  rest: [{ method: "GET", path: "/api/boxes/:id/staged" }],
  cli: "box staged",
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: resolveBox,
  run: async ({ host }, _input, box) => ({ staged: await readStaged(host, box) }),
});

export const boxStagedSet = defineOperation({
  name: "box.staged.set",
  tag: "boxes",
  summary: "Stage changes that rebuild a box",
  kind: "write",
  scope: "box:write",
  async: false,
  input: z
    .object({
      id: boxId(),
      template: templateImage(),
      mounts: rebuildMounts(),
      env: rebuildEnv(),
      network: rebuildNetwork(),
      egress: egressInput(),
      profile: boxProfile(),
    })
    .superRefine((input, ctx) => {
      if (STAGED_FIELD_NAMES.some((field) => input[field] !== undefined)) return;
      ctx.addIssue({ code: "custom", message: "Pass at least one field to stage.", path: [] });
    }),
  output: z.object({ staged: StagedSchema }),
  rest: [{ method: "PUT", path: "/api/boxes/:id/staged", body: true }],
  cli: "box stage",
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: resolveBox,
  activity: { action: () => "box.staged.set", target: (_input, box) => box.name },
  audit: {
    target: (_input, box) => box && boxTarget(box),
    detail: (input) => ({
      template: input.template,
      profile: input.profile,
      network: input.network,
      egress: input.egress,
      mounts: input.mounts,
      env: input.env?.map((entry) => entry.name),
    }),
  },
  run: async (ctx, input, box) => {
    if (input.mounts) await assertCanChangeMounts(ctx, input.mounts, box.mounts);
    const fields: StagedFields = {};
    for (const field of STAGED_FIELD_NAMES) {
      if (input[field] !== undefined) Object.assign(fields, { [field]: input[field] });
    }
    return { staged: await stageChanges(ctx.host, box, fields, ctx.principal.id) };
  },
});

export const boxStagedDiscard = defineOperation({
  name: "box.staged.discard",
  tag: "boxes",
  summary: "Discard a box's staged changes",
  kind: "write",
  scope: "box:write",
  async: false,
  input: z.object({ id: boxId() }),
  output: OkSchema,
  rest: [{ method: "DELETE", path: "/api/boxes/:id/staged" }],
  cli: "box unstage",
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: resolveBox,
  activity: { action: () => "box.staged.discard", target: (_input, box) => box.name },
  audit: { target: (_input, box) => box && boxTarget(box) },
  run: async ({ host }, _input, box) => {
    discardStaged(host, box);
    return { ok: true as const };
  },
});

export const boxStagedPreview = defineOperation({
  name: "box.staged.preview",
  tag: "boxes",
  summary: "Preview applying a box's staged changes",
  kind: "read",
  scope: "box:read",
  async: false,
  input: z.object({ id: boxId() }),
  output: z.object({ preview: StagedPreviewSchema }),
  rest: [{ method: "GET", path: "/api/boxes/:id/staged/preview" }],
  cli: "box staged preview",
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: resolveBox,
  run: async ({ host, terminals }, _input, box) => {
    const preview = await previewStaged(host, box, terminals);
    return { preview: { ...preview, keeps: [...preview.keeps], loses: [...preview.loses] } };
  },
});

export const boxStagedApply = defineOperation({
  name: "box.staged.apply",
  tag: "boxes",
  summary: "Apply a box's staged changes",
  kind: "destructive",
  // Not a token scope, so only the owner may apply: an agent can propose a rebuild, not carry it out.
  scope: "box:apply",
  async: false,
  conflicts: true,
  longSync: true,
  input: z.object({
    id: boxId(),
    checkpoint: safetyCheckpointFlag(),
    expectedRevision: expectedRevision(),
    stagedAt: z.string().optional().meta({
      description: "The preview's `stagedAt`. When given, changes staged after that preview are refused with 412.",
    }),
  }),
  output: z.object({
    box: BoxSchema,
    safety: SafetyCheckpointSchema.nullable().meta({
      description: "The checkpoint taken before the rebuild, or null when none was taken.",
    }),
  }),
  rest: [{ method: "POST", path: "/api/boxes/:id/staged/apply", body: true, ifMatch: true }],
  cli: "box apply",
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: resolveBox,
  activity: { action: () => "box.staged.apply", target: (_input, box) => box.name },
  audit: {
    target: (_input, box) => box && boxTarget(box),
    detail: (input) => ({ checkpoint: input.checkpoint }),
  },
  run: async (ctx, input, box) =>
    applyStaged(
      ctx.host,
      box,
      requireRevision(input.expectedRevision),
      input.checkpoint,
      ctx.principal.id,
      ctx.record,
      input.stagedAt,
    ),
});

export const stagedOperations = [boxStagedGet, boxStagedSet, boxStagedDiscard, boxStagedPreview, boxStagedApply];
