import { z } from "zod";

import { BOX_PROFILES } from "../box-profile";
import { untilAborted } from "../lib/abort";
import { log } from "../lib/logger";
import { getBox } from "../services/boxes";
import {
  applyStaged,
  discardStaged,
  previewStaged,
  readStaged,
  type StagedView,
  stagedOfSpec,
  stageChanges,
} from "../services/staged";
import { requireRevision } from "../specs/revision";
import { STAGED_FIELDS, type StagedFields } from "../specs/staged";
import { boxVisible, viewOfSpec } from "../tokens/model";
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

const STAGED_FIELD_NAMES = STAGED_FIELDS;

/** The staged values a request may name. Every field of `STAGED_FIELDS` has an entry here, and a test pins that. */
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

/** One box's staged changes, as every endpoint that returns them holds them. */
const StagedRecordSchema = z.object({
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
});

/** The staged changes of a box that may have none. `null` is a box with nothing staged. */
const StagedSchema = StagedRecordSchema.nullable().meta({ description: "Null when nothing is staged." });

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

/** A box a list names: the ids the console keys it by, and the name it shows. */
const StagedBoxRefSchema = z.object({
  id: z.string().meta({ description: "The box's container id, the id the console's box pages use." }),
  boxId: z.string().meta({ description: "The box's stable id, `bx_…`." }),
  name: z.string(),
  hostId: z.string().meta({ description: "The host the box runs on." }),
});

/**
 * Every box's staged changes in one read, so the storage page does not ask box by box. Only boxes with something staged
 * are listed: a box that has none is left out. A box that cannot be read is logged and skipped, so one failing box does
 * not fail the list. A token sees only the boxes its grants cover.
 */
export const boxStagedList = defineOperation({
  name: "box.staged.list",
  tag: "boxes",
  summary: "Read the staged changes of every box",
  kind: "read",
  scope: "box:read",
  async: false,
  input: z.object({}),
  output: z.object({
    staged: z.array(
      z.object({
        box: StagedBoxRefSchema,
        staged: StagedRecordSchema.meta({
          description: "The box's staged changes, as `GET /api/boxes/:id/staged` returns them.",
        }),
      }),
    ),
  }),
  rest: [{ method: "GET", path: "/api/staged" }],
  run: async ({ host: requestHost, allHosts, principal }) => {
    const hosts = allHosts?.() ?? [requestHost];
    const entries = await Promise.all(
      hosts.flatMap((host) => {
        if (host.host.status === "offline") return [];
        return host.specs
          .list()
          .filter((spec) => spec.hostId === host.host.id && boxVisible(principal, viewOfSpec(spec)))
          .map(async (spec): Promise<{ box: z.input<typeof StagedBoxRefSchema>; staged: StagedView } | null> => {
            const deadline = AbortSignal.timeout(host.readTimeoutMs);
            try {
              const staged = await untilAborted(stagedOfSpec(host, spec, deadline), deadline);
              if (!staged) return null;
              return { box: { id: spec.containerId, boxId: spec.id, name: spec.name, hostId: spec.hostId }, staged };
            } catch (e) {
              log.warn("box.staged_unreadable", { box: spec.name, host: host.host.id, error: String(e) });
              return null;
            }
          });
      }),
    );
    return { staged: entries.filter((entry) => entry !== null) };
  },
});

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

export const stagedOperations = [
  boxStagedGet,
  boxStagedList,
  boxStagedSet,
  boxStagedDiscard,
  boxStagedPreview,
  boxStagedApply,
];
