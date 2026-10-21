import { z } from "zod";

import { BOX_PROFILES } from "../box-profile";
import { CONSISTENCY_MODES } from "../checkpoints/types";
import { VOLUME_ROLES } from "../volumes/types";

export const StatsSchema = z.object({
  cpuPercent: z.number(),
  memUsage: z.number(),
  memLimit: z.number(),
  memPercent: z.number(),
});

export const BoxMountSchema = z.object({
  volume: z.string(),
  path: z.string(),
  mode: z.enum(["rw", "ro"]),
  volumeId: z.string().nullable(),
  volumeName: z.string().nullable(),
  role: z.enum(["workspace", "home", "tools", "cache"]).nullable(),
  pool: z.string().nullable(),
});

export const StorageStatusSchema = z.object({
  status: z.enum(["ok", "unreachable", "unknown"]),
  pools: z.array(
    z.object({
      name: z.string(),
      status: z.enum(["reachable", "unreachable", "unknown"]),
    }),
  ),
});

export const BoxEnvSchema = z.object({
  name: z.string(),
  value: z.string().optional(),
  secretRef: z.string().optional(),
});

export const BoxDriftSchema = z.object({
  field: z.string(),
  expected: z.string(),
  actual: z.string(),
});

export const BoxRecoverySchema = z.object({
  source: z.enum(["claim", "degraded"]),
  at: z.string(),
  needsReset: z.array(z.string()),
  observedRestart: z.string(),
});

export const BoxSchema = z.object({
  id: z.string(),
  boxId: z.string(),
  name: z.string(),
  state: z.string(),
  status: z.string(),
  running: z.boolean(),
  image: z.string(),
  template: z.string(),
  /** Null for boxes created before profiles existed. */
  profile: z.enum(BOX_PROFILES).nullable(),
  /** Boxes created before profiles stay on the engine's default `bridge` network. */
  network: z.string(),
  cpus: z.number().nullable(),
  memory: z.number().nullable(),
  pids: z.number().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  volume: z.string(),
  revision: z.number(),
  desired: z.enum(["running", "stopped"]),
  idleTimeoutSec: z.number().nullable(),
  ttlSec: z.number().nullable(),
  stopReason: z.enum(["idle", "ttl", "manual"]).nullable(),
  sleeping: z.boolean(),
  lastActivityAt: z.string().nullable(),
  labels: z.record(z.string(), z.string()),
  createdBy: z.string().nullable(),
  containerName: z.string(),
  drift: z.array(BoxDriftSchema),
  recovery: BoxRecoverySchema.nullable(),
  mounts: z.array(BoxMountSchema),
  /** Plain values and secret references. A secret reference is stored and not injected. */
  env: z.array(BoxEnvSchema),
  /** Desired Agent CLIs from the box spec. */
  tools: z.array(z.object({ id: z.string(), version: z.string() })),
  /** `unreachable` when a pool behind a mount could not be probed. The engine state stays in `state`. */
  storage: StorageStatusSchema,
});

/** One sample of a box's usage. `t` is epoch milliseconds. */
export const StatSampleSchema = StatsSchema.extend({
  t: z.number().int(),
});

export const BoxWithStatsSchema = BoxSchema.extend({
  stats: StatsSchema.nullable().optional(),
});

export const SnapshotSchema = z.object({
  ref: z.string(),
  source: z.string(),
});

const CheckpointDataSchema = z.object({
  volumeId: z.string(),
  path: z.string(),
  mode: z.enum(["rw", "ro"]),
  role: z.enum(VOLUME_ROLES).nullable(),
  ownership: z.enum(["owned", "independent"]),
  owner: z.object({ uid: z.number().int(), gid: z.number().int() }),
  snapshotId: z.string(),
  bytes: z.number(),
});

/** A checkpoint as the API shows it. A snapshot from before checkpoints is listed with `legacy` true and no data layers. */
export const CheckpointSchema = z.object({
  id: z.string(),
  legacy: z.boolean(),
  hostId: z.string(),
  boxId: z.string().nullable(),
  boxName: z.string().nullable(),
  label: z.string(),
  reason: z.string(),
  createdBy: z.string().nullable(),
  pinned: z.boolean(),
  auto: z.boolean(),
  consistency: z.enum(CONSISTENCY_MODES),
  specRevision: z.number().nullable(),
  spec: z.object({
    template: z.object({ ref: z.string(), image: z.string(), digest: z.string().nullable() }),
    cpus: z.number().nullable(),
    memoryBytes: z.number().nullable(),
    profile: z.enum(BOX_PROFILES).nullable(),
  }),
  data: z.array(CheckpointDataSchema),
  system: z.object({ image: z.string(), imageId: z.string() }).nullable(),
  bytes: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** A snapshot or template image, as the image list shows it. */
export const ImageSchema = z.object({
  id: z.string(),
  ref: z.string(),
  tags: z.array(z.string()),
  name: z.string(),
  description: z.string().nullable(),
  source: z.string().nullable(),
  sourceId: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  size: z.number(),
});

export const PromotedTemplateSchema = z.object({
  ref: z.string(),
  name: z.string(),
});

/** The image the build produced. The build log is kept on the task, not in this result. */
export const BuildResultSchema = z.object({
  ref: z.string(),
});

export const TaskStatusSchema = z.enum(["running", "succeeded", "failed", "cancelled", "interrupted"]);

export const TaskErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  status: z.number().int(),
  key: z.string().optional(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

export const TaskTargetSchema = z.object({
  kind: z.string(),
  id: z.string().optional(),
  name: z.string(),
});

/** One long-running operation. `output` is omitted from lists. `result` is the operation's own output. */
export const TaskSchema = z.object({
  id: z.string(),
  op: z.string(),
  status: TaskStatusSchema,
  summary: z.string(),
  hostId: z.string(),
  target: TaskTargetSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().optional(),
  error: TaskErrorSchema.optional(),
  result: z.unknown().optional(),
  output: z.string().optional(),
  truncated: z.boolean(),
  logSeq: z.number().int(),
});

/** The body of a 202 response. The operation's own output is stored on the task as `result`. */
export const TaskAcceptedSchema = z.object({
  taskId: z.string(),
});

export const OkSchema = z.object({
  ok: z.literal(true),
});

/** One recorded event. `seq` is the cursor: pass it back as `cursor` to read the page before it. */
export const EventSchema = z.object({
  seq: z.number().int(),
  id: z.string(),
  ts: z.number().int(),
  durationMs: z.number(),
  status: z.enum(["started", "ok", "error", "denied"]),
  op: z.string(),
  kind: z.enum(["read", "write", "destructive"]),
  tier: z.enum(["audit", "activity"]),
  count: z.number().int(),
  principal: z.object({ type: z.string(), id: z.string(), name: z.string() }),
  source: z.enum(["ui", "rest", "mcp", "cli", "scheduler", "system"]),
  hostId: z.string(),
  summary: z.string(),
  target: z.object({ kind: z.string(), id: z.string().optional(), name: z.string() }).optional(),
  detail: z.unknown().optional(),
  run: z.string().optional(),
  parentId: z.string().optional(),
  ref: z
    .object({ execId: z.string().optional(), outputRef: z.string().optional(), taskId: z.string().optional() })
    .optional(),
  error: z.object({ code: z.string(), status: z.number().int() }).optional(),
});

export const EventPageSchema = z.object({
  events: z.array(EventSchema),
  nextCursor: z.number().int().nullable(),
});

/** The body of every error response, see `errorResponse()` in lib/http.ts. */
export const ErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    hint: z.string().optional(),
    retryable: z.boolean(),
    key: z.string().optional(),
    params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    hintKey: z.string().optional(),
    hintParams: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
