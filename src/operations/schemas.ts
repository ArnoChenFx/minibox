import { z } from "zod";

export const StatsSchema = z.object({
  cpuPercent: z.number(),
  memUsage: z.number(),
  memLimit: z.number(),
  memPercent: z.number(),
});

export const BoxSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  status: z.string(),
  running: z.boolean(),
  image: z.string(),
  template: z.string(),
  cpus: z.number().nullable(),
  memory: z.number().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  volume: z.string(),
});

export const BoxWithStatsSchema = BoxSchema.extend({
  stats: StatsSchema.nullable().optional(),
});

export const SnapshotSchema = z.object({
  ref: z.string(),
  source: z.string(),
});

/** A snapshot or template image, as the image list shows it. */
export const ImageSchema = z.object({
  id: z.string(),
  ref: z.string(),
  tags: z.array(z.string()),
  name: z.string(),
  description: z.string().nullable(),
  source: z.string().nullable(),
  createdAt: z.string(),
  size: z.number(),
});

export const PromotedTemplateSchema = z.object({
  ref: z.string(),
  name: z.string(),
});

export const BuildResultSchema = z.object({
  ref: z.string(),
  output: z.string(),
});

export const OkSchema = z.object({
  ok: z.literal(true),
});

/** The body of every error response, see `errorResponse()` in lib/http.ts. */
export const ErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    key: z.string().optional(),
    params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
