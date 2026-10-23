import { z } from "zod";

import { BOX_PROFILES } from "../box-profile";
import { CONSISTENCY_MODES, TRASH_KINDS } from "../checkpoints/types";
import { EGRESS_MODES, EGRESS_PRESETS } from "../egress/policy";
import { BUILD_KINDS } from "../services/template-builds";
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

export const BoxEgressSchema = z.object({
  mode: z.enum(EGRESS_MODES),
  presets: z.array(z.enum(EGRESS_PRESETS)),
  domains: z.array(z.string()),
  allow: z.array(z.string()),
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
  /** Present only when the box is not `open`. An open box keeps the default network and reports no egress. */
  egress: BoxEgressSchema.optional(),
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
  stopReason: z.enum(["idle", "ttl", "manual", "volume_limit"]).nullable(),
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
  /** Desired tools from the box spec. */
  tools: z.array(z.object({ id: z.string(), version: z.string() })),
  /** `unreachable` when a pool behind a mount could not be probed. The engine state stays in `state`. */
  storage: StorageStatusSchema,
  /** The host the box runs on. Present only when the control plane holds more than one host. */
  hostId: z.string().optional(),
  /** Present and true when the box was created with a `self` token. The token itself is never shown. */
  selfToken: z.boolean().optional(),
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
  spec: z
    .object({
      template: z.object({ ref: z.string(), image: z.string(), digest: z.string().nullable() }),
      cpus: z.number().nullable(),
      memoryBytes: z.number().nullable(),
      profile: z.enum(BOX_PROFILES).nullable(),
    })
    .nullable(),
  data: z.array(CheckpointDataSchema),
  system: z.object({ image: z.string(), imageId: z.string() }).nullable(),
  bytes: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** A recycle bin entry: the data a deleted box or volume left, kept until `expiresAt`. */
export const TrashEntrySchema = z.object({
  id: z.string(),
  hostId: z.string(),
  kind: z.enum(TRASH_KINDS),
  sourceId: z.string(),
  sourceName: z.string(),
  deletedAt: z.string(),
  expiresAt: z.string(),
  bytes: z.number(),
  createdBy: z.string().nullable(),
});

/** The recycle bin entry a delete kept. A delete that kept none has null here. */
export const TrashRefSchema = z.object({ id: z.string(), expiresAt: z.string() });

/** The checkpoint a rebuild took before it changed the box. A rebuild that took none has null here. */
export const SafetyCheckpointSchema = z.object({ id: z.string(), label: z.string() });

/** The checkpoint repository's size against its limit. `limitBytes` is null when no limit is set. */
export const CheckpointUsageSchema = z.object({
  bytes: z.number(),
  limitBytes: z.number().nullable(),
  state: z.enum(["unlimited", "ok", "warning", "exceeded"]),
  policy: z.object({ keepLast: z.number(), keepDays: z.number() }),
});

/** A sealed package, from an export or an upload. It can be downloaded and imported until `expiresAt`. */
export const CheckpointPackageSchema = z.object({
  id: z.string(),
  checkpointId: z.string().nullable(),
  origin: z.enum(["export", "upload", "target"]),
  bytes: z.number().int(),
  sha256: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  url: z.string(),
});

/** A stored backup of DATA_DIR. The archive is downloaded from `url` until the backup is deleted. */
export const BackupSchema = z.object({
  id: z.string(),
  origin: z.enum(["create", "target"]),
  targetId: z.string().nullable(),
  createdBy: z.string().nullable(),
  bytes: z.number().int(),
  sha256: z.string(),
  entries: z.number().int(),
  createdAt: z.string(),
  url: z.string(),
});

/** The outcome of one scheduled run. `reason` says why a run was skipped, such as `sleeping` or `capacity`. */
export const ScheduleLastRunSchema = z.object({
  at: z.string(),
  status: z.enum(["ok", "skipped", "failed"]),
  reason: z.string().nullable(),
  checkpointId: z.string().nullable(),
  error: z.string().nullable(),
});

/** A box's checkpoint schedule. Exactly one of `everyHours` and `at` is set, as `mode` says. */
export const CheckpointScheduleSchema = z.object({
  version: z.number().int(),
  hostId: z.string(),
  boxId: z.string(),
  mode: z.enum(["interval", "daily"]),
  everyHours: z.number().int().nullable(),
  at: z.string().nullable(),
  /** IANA zone of the daily time. Null for an interval, and for a daily schedule saved before zones, which runs in UTC. */
  timezone: z.string().nullable(),
  /** True when the saved zone is not one this server knows. The schedule then runs in UTC until it is set again. */
  timezoneUnknown: z.boolean(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  nextRunAt: z.string(),
  lastRun: ScheduleLastRunSchema.nullable(),
});

/** A volume a rollback replaced or restored, and the path the box mounts it at. */
export const RollbackVolumeSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
});

/** A rollback waiting for its confirm or undo. `null` in the response when the box has none. */
export const PendingRollbackSchema = z.object({
  boxId: z.string(),
  checkpoint: z.object({ id: z.string(), label: z.string() }),
  safetyCheckpointId: z.string(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  replaced: z.array(RollbackVolumeSchema),
  restored: z.array(RollbackVolumeSchema),
});

/** A snapshot or template image, as the image list shows it. `hostId` is the host whose engine holds the image. */
export const ImageSchema = z.object({
  id: z.string(),
  hostId: z.string(),
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

/** A template as the list reports it. `buildKind` is present only on a template built from a declared source. */
export const TemplateSchema = ImageSchema.extend({
  buildKind: z.enum(BUILD_KINDS).optional(),
});

/** An official template as the catalog lists it. `base` is the pinned image its Dockerfile starts from. */
export const OfficialTemplateSchema = z.object({
  name: z.string(),
  ref: z.string(),
  description: z.string(),
  base: z.string(),
});

export const ImagePulledSchema = z.object({
  ref: z.string(),
  id: z.string(),
});

/** A template copied to a host. `sent` is false when the host already held the same image, so nothing was copied. */
export const TemplateSyncedSchema = z.object({
  ref: z.string(),
  host: z.string(),
  sent: z.boolean(),
});

/** The task that clones a new box's repository into its workspace. */
export const CloneStartedSchema = z.object({
  taskId: z.string(),
});

/** The task that sets up a new box: its repository clone, forwarded ports and postCreateCommand. */
export const SetupStartedSchema = z.object({
  taskId: z.string(),
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
  subject: z.string().optional(),
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

/** A question a box's agent asked a person. `answer` is null until one answers it. */
export const QuestionSchema = z.object({
  id: z.string(),
  boxId: z.string(),
  message: z.string(),
  options: z.array(z.string()),
  askedAt: z.string(),
  answer: z.string().nullable(),
  answeredAt: z.string().nullable(),
  answeredBy: z.string().nullable(),
});

/** What a box's own agent learns about its box. Sizes are the spec's, not the engine's. */
export const SelfInfoSchema = z.object({
  boxId: z.string(),
  name: z.string(),
  state: z.string(),
  running: z.boolean(),
  template: z.string(),
  profile: z.enum(BOX_PROFILES).nullable(),
  cpus: z.number().nullable(),
  memoryMb: z.number().nullable(),
  createdAt: z.string(),
  ttlEndsAt: z.string().nullable(),
  remainingTtlSec: z.number().nullable(),
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
  source: z.enum(["ui", "rest", "mcp", "cli", "ssh", "scheduler", "system"]),
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
