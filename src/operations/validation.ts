import { z } from "zod";

import { BOX_PROFILES, type BoxProfile, isBoxProfile } from "../box-profile";
import { AppError } from "../lib/errors";
import { msg } from "../lib/messages";
import { accept, asObject, type Checked, checkName, type Failure, LIMITS, NAME_RE, reject } from "../lib/validation";

const IMAGE_REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]*$/;
const IMAGE_REF_MAX_LENGTH = 255;
const DEFAULT_TAIL = 300;

type Meta = z.core.GlobalMeta;

const toNumber = (value: unknown): number | undefined => {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

function checkCpus(value: unknown): Checked<number> {
  const n = toNumber(value);
  if (n === undefined) return reject(msg("not_a_number", { label: "cpus" }), "cpus");
  if (n < LIMITS.minCpus || n > LIMITS.maxCpus) {
    return reject(msg("cpus_range", { min: LIMITS.minCpus, max: LIMITS.maxCpus }), "cpus");
  }
  return accept(Math.round(n * 100) / 100);
}

function checkMemoryMb(value: unknown): Checked<number> {
  const n = toNumber(value);
  if (n === undefined) return reject(msg("not_a_number", { label: "memory" }), "memoryMb");
  if (!Number.isInteger(n) || n < LIMITS.minMemoryMb || n > LIMITS.maxMemoryMb) {
    return reject(msg("memory_range", { min: LIMITS.minMemoryMb, max: LIMITS.maxMemoryMb }), "memoryMb");
  }
  return accept(n);
}

function checkTail(value: unknown): Checked<number> {
  if (value === undefined || value === null || value === "") return accept(DEFAULT_TAIL);
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > LIMITS.maxLogTail) {
    return reject(msg("tail_range", { max: LIMITS.maxLogTail }), "tail");
  }
  return accept(n);
}

function checkDeleteVolume(value: unknown): Checked<boolean> {
  if (value === undefined || value === null) return accept(false);
  if (typeof value === "boolean") return accept(value);
  if (value === "true" || value === "1") return accept(true);
  if (value === "false" || value === "0") return accept(false);
  return reject(msg("not_boolean", { field: "deleteVolume" }), "deleteVolume");
}

function checkImageRef(value: unknown): Checked<string> {
  if (typeof value !== "string" || !value.trim()) return reject(msg("template_required"), "template");
  const v = value.trim();
  if (v.length > IMAGE_REF_MAX_LENGTH || !IMAGE_REF_RE.test(v)) return reject(msg("image_ref_invalid"), "template");
  return accept(v);
}

const NAME_META: Meta = { type: "string", minLength: 1, maxLength: 63, pattern: NAME_RE.source };
const CPUS_HELP = "CPU cores, between 0.1 and 64, rounded to two decimals.";
const MEMORY_HELP = "Memory in MB, an integer between 128 and 262144.";
const CPUS_META: Meta = { type: "number", minimum: LIMITS.minCpus, maximum: LIMITS.maxCpus, description: CPUS_HELP };
const MEMORY_META: Meta = {
  type: "integer",
  minimum: LIMITS.minMemoryMb,
  maximum: LIMITS.maxMemoryMb,
  description: MEMORY_HELP,
};

/**
 * zod leaves `default` out of the input schema of a transform, so the default is written into the description,
 * where both OpenAPI readers and MCP clients see it.
 */
const withDefault = (help: string, value: string | number | boolean): string => `${help} Defaults to ${value}.`;

/** Records a failure as a zod issue. The message travels in `params`, so the first failure can be reported verbatim. */
export function addFailure(ctx: z.RefinementCtx, failure: Failure): void {
  ctx.addIssue({ code: "custom", message: failure.message.text, params: { failure } });
}

/**
 * One legacy check as a zod schema. The input side accepts anything, so that every problem surfaces as the legacy
 * message rather than as a zod message; the meta describes the accepted shape for OpenAPI and MCP.
 */
function field<T>(check: (value: unknown) => Checked<T>, meta: Meta) {
  return z
    .unknown()
    .transform((value, ctx) => {
      const checked = check(value);
      if (checked.ok) return checked.value;
      addFailure(ctx, checked.failure);
      return z.NEVER;
    })
    .meta(meta);
}

/** A box as the path or the body names it: its container id, or its name. */
export const boxId = () => z.string().meta({ description: "Box id: the container id, or the container name." });

export const boxName = () =>
  field((value) => checkName(value, "boxName"), {
    ...NAME_META,
    description:
      "Box name: letters, digits, dots, underscores and hyphens, starting with a letter or digit. Surrounding spaces are trimmed.",
  });

export const snapshotName = () =>
  field(
    (value): Checked<string | undefined> =>
      value === undefined || value === null || value === "" ? accept(undefined) : checkName(value, "snapshotName"),
    { ...NAME_META, description: "Snapshot name, with the same rules as a box name. Defaults to the box name." },
  ).optional();

export const templateImage = () =>
  field(
    (value): Checked<string | undefined> =>
      value === undefined || value === "" ? accept(undefined) : checkImageRef(value),
    {
      type: "string",
      maxLength: IMAGE_REF_MAX_LENGTH,
      description: "Template image: repository[:tag] or a sha256 digest. Omitted, the bundled base template is used.",
    },
  ).optional();

const PROFILE_HELP = "Security profile: standard, strict or relaxed. Omitted, the host's default profile is used.";

function checkProfile(value: unknown): Checked<BoxProfile | undefined> {
  if (value === undefined || value === null || value === "") return accept(undefined);
  return isBoxProfile(value) ? accept(value) : reject(msg("profile_invalid"), "profile");
}

export const boxProfile = () =>
  field(checkProfile, { type: "string", enum: [...BOX_PROFILES], description: PROFILE_HELP }).optional();

/** A snapshot reference from the path. The raw text is kept, because the box label records what the client sent. */
export const snapshotRef = () =>
  field(
    (value): Checked<string> => {
      const checked = checkImageRef(value);
      return checked.ok ? accept(value as string) : checked;
    },
    { type: "string", description: "Snapshot image reference, URL-encoded." },
  );

export const cpusWithDefault = (defaultValue: number) =>
  field(checkCpus, { ...CPUS_META, description: withDefault(CPUS_HELP, defaultValue) }).default(defaultValue);

export const optionalCpus = () =>
  field(
    (value): Checked<number | undefined> => (value === null ? accept(undefined) : checkCpus(value)),
    CPUS_META,
  ).optional();

export const memoryWithDefault = (defaultValue: number) =>
  field(checkMemoryMb, { ...MEMORY_META, description: withDefault(MEMORY_HELP, defaultValue) }).default(defaultValue);

export const optionalMemoryMb = () =>
  field(
    (value): Checked<number | undefined> => (value === null ? accept(undefined) : checkMemoryMb(value)),
    MEMORY_META,
  ).optional();

export const tail = () =>
  field(checkTail, {
    type: "integer",
    minimum: 1,
    maximum: LIMITS.maxLogTail,
    description: withDefault("Number of log lines from the end, between 1 and 5000.", DEFAULT_TAIL),
  }).default(DEFAULT_TAIL);

export const deleteVolumeFlag = () =>
  field(checkDeleteVolume, {
    type: "boolean",
    description: withDefault("Also delete the box's workspace volume. Accepts true, false, 1 or 0.", false),
  }).default(false);

export const statsFlag = () =>
  field((value) => accept(value !== "false"), {
    type: "boolean",
    description: withDefault("Include current resource usage of running boxes. Send false to skip it.", true),
  }).default(true);

/** Names neither CPU nor memory. Like the legacy check, it runs only once every field has passed. */
export function requireResources(ctx: z.RefinementCtx, input: { cpus?: unknown; memoryMb?: unknown }): void {
  if (input.cpus === undefined && input.memoryMb === undefined) {
    addFailure(ctx, { message: msg("resources_required") });
  }
}

/** Validates one input and reports the first failing field, in the order the handwritten validators checked them. */
export function parseInput<T extends z.ZodObject>(schema: T, raw: unknown): z.output<T> {
  const result = schema.safeParse(asObject(raw));
  if (result.success) return result.data;
  const [first] = result.error.issues;
  const failure = first && failureOf(first);
  if (!failure) throw new AppError(400, "validation_failed", first?.message ?? "Invalid input.");
  throw new AppError(
    400,
    "validation_failed",
    failure.message,
    failure.field === undefined ? undefined : { field: failure.field },
  );
}

function failureOf(issue: z.core.$ZodIssue): Failure | undefined {
  if (!("params" in issue) || typeof issue.params !== "object" || issue.params === null) return undefined;
  const failure: unknown = issue.params.failure;
  return isFailure(failure) ? failure : undefined;
}

function isFailure(value: unknown): value is Failure {
  return typeof value === "object" && value !== null && "message" in value;
}
