import { z } from "zod";

import { BOX_PROFILES, type BoxProfile, isBoxProfile } from "../box-profile";
import { SCHEDULE_HOURS_MAX, SCHEDULE_HOURS_MIN, SCHEDULE_TIME_RE } from "../checkpoints/schedule";
import { AUTO_HOST, HOST_ID_RE } from "../host/store";
import { AppError } from "../lib/errors";
import { msg } from "../lib/messages";
import {
  accept,
  asObject,
  type Checked,
  checkDescription,
  checkName,
  DESCRIPTION_MAX,
  type Failure,
  IDENT_RE,
  LIMITS,
  NAME_RE,
  reject,
} from "../lib/validation";
import type { BoxEnv, BoxMount } from "../specs/types";

const IMAGE_REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]*$/;
const IMAGE_REF_MAX_LENGTH = 255;
const DEFAULT_TAIL = 300;
const PIDS_MIN = 1;
const PIDS_MAX = 1_000_000;
/** 365 days. Idle timeout and TTL share the cap. */
const MAX_LIFETIME_SEC = 31_536_000;
const LABEL_COUNT_MAX = 32;
const LABEL_VALUE_MAX = 256;

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
export function field<T>(check: (value: unknown) => Checked<T>, meta: Meta) {
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

/** A box as the path or the body names it: container id, container name, stable id, or box name. */
export const boxId = () =>
  z.string().meta({
    description: "Box id: a container id, a container name, a stable box id (bx_…), or the box name.",
  });

/** A host id: `local`, or the id of a host added in Settings. Which hosts exist is checked where the id is used. */
export const hostId = () =>
  z.string().regex(HOST_ID_RE).meta({ description: "Host id: local, or the id of a host added under Settings." });

/** A host id, or `auto`, which a box create uses to pick the host itself. */
export const hostOrAuto = () => z.union([z.literal(AUTO_HOST), hostId()]);

export const boxName = () =>
  field((value) => checkName(value, "boxName"), {
    ...NAME_META,
    description:
      "Box name: letters, digits, dots, underscores and hyphens, starting with a letter or digit. Surrounding spaces are trimmed.",
  });

export const volumeName = () =>
  field((value) => checkName(value, "name"), {
    ...NAME_META,
    description:
      "Volume name: letters, digits, dots, underscores and hyphens, starting with a letter or digit. Surrounding spaces are trimmed.",
  });

function checkRefresh(value: unknown): Checked<boolean> {
  if (value === undefined || value === null || value === "") return accept(false);
  if (value === true || value === "true" || value === "1") return accept(true);
  if (value === false || value === "false" || value === "0") return accept(false);
  return reject(msg("not_boolean", { field: "refresh" }), "refresh");
}

/** Query flag. `true` or `1` probes pools again instead of using the short cache. */
export const refreshFlag = () =>
  field(checkRefresh, {
    type: "boolean",
    description: withDefault("Probe storage pools again instead of using the cached result.", false),
  }).default(false);

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

/** An image reference from the path. The raw text is kept, because the box label records what the client sent. */
const imageRef = (description: string) =>
  field(
    (value): Checked<string> => {
      const checked = checkImageRef(value);
      return checked.ok ? accept(value as string) : checked;
    },
    { type: "string", description },
  );

export const snapshotRef = () => imageRef("Snapshot image reference, URL-encoded.");

export const templateRef = () => imageRef("Template image reference, URL-encoded.");

export const templateName = () =>
  field((value) => checkName(value, "templateName"), {
    ...NAME_META,
    description: "Template name, with the same rules as a box name.",
  });

export const templateDescription = () =>
  field(checkDescription, {
    type: "string",
    maxLength: DESCRIPTION_MAX,
    description: `One line, at most ${DESCRIPTION_MAX} characters. Line breaks and other control characters are refused.`,
  }).optional();

const oneLine = (description: string) =>
  field(checkDescription, { type: "string", maxLength: DESCRIPTION_MAX, description }).optional();

export const checkpointLabel = () =>
  oneLine(
    `Label shown in the checkpoint list, one line, at most ${DESCRIPTION_MAX} characters. Defaults to the box name.`,
  );

export const checkpointReason = () =>
  oneLine(`Why the checkpoint is taken, one line, at most ${DESCRIPTION_MAX} characters.`);

const PASSPHRASE_MIN = 12;
const PASSPHRASE_MAX = 1024;

const passphraseInvalid = (): Checked<string> => reject(msg("package_passphrase_invalid"), "passphrase");

function checkPassphrase(value: unknown): Checked<string> {
  if (typeof value !== "string") return passphraseInvalid();
  const length = [...value].length;
  if (length < PASSPHRASE_MIN || length > PASSPHRASE_MAX) return passphraseInvalid();
  if (value !== value.trim() || /[\r\n\0]/.test(value)) return passphraseInvalid();
  return accept(value);
}

/** Seals a package. The value is never stored, logged or echoed back, so only the sealed file keeps anything of it. */
export const passphrase = () =>
  field(checkPassphrase, {
    type: "string",
    minLength: PASSPHRASE_MIN,
    maxLength: PASSPHRASE_MAX,
    description:
      "Passphrase that seals the package: 12 to 1024 characters, no leading or trailing spaces, no line breaks. MiniBox never stores it, so a package cannot be opened without it.",
  });

export const packageRef = () =>
  z.string().meta({ description: "Package id (pk_…), as the export or the upload returned it." });

function checkScheduleHours(value: unknown): Checked<number | undefined> {
  if (value === undefined || value === null) return accept(undefined);
  const n = toNumber(value);
  if (n === undefined || !Number.isInteger(n) || n < SCHEDULE_HOURS_MIN || n > SCHEDULE_HOURS_MAX) {
    return reject(msg("schedule_rule_invalid"), "everyHours");
  }
  return accept(n);
}

function checkScheduleTime(value: unknown): Checked<string | undefined> {
  if (value === undefined || value === null) return accept(undefined);
  if (typeof value === "string" && SCHEDULE_TIME_RE.test(value)) return accept(value);
  return reject(msg("schedule_rule_invalid"), "at");
}

export const scheduleEveryHours = () =>
  field(checkScheduleHours, {
    type: "integer",
    minimum: SCHEDULE_HOURS_MIN,
    maximum: SCHEDULE_HOURS_MAX,
    description: `Take a checkpoint every this many hours, an integer from ${SCHEDULE_HOURS_MIN} to ${SCHEDULE_HOURS_MAX}. Send either this or at.`,
  }).optional();

export const scheduleAt = () =>
  field(checkScheduleTime, {
    type: "string",
    pattern: SCHEDULE_TIME_RE.source,
    description:
      "Take a checkpoint once a day at this time, HH:MM on the server's clock, such as 02:30. Send either this or everyHours.",
  }).optional();

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

function checkHistory(value: unknown): Checked<boolean> {
  if (value === undefined || value === null) return accept(false);
  if (typeof value === "boolean") return accept(value);
  if (value === "true" || value === "1") return accept(true);
  if (value === "false" || value === "0") return accept(false);
  return reject(msg("not_boolean", { field: "history" }), "history");
}

export const historyFlag = () =>
  field(checkHistory, {
    type: "boolean",
    description: withDefault(
      "Also return the recent samples of the box, oldest first. Accepts true, false, 1 or 0.",
      false,
    ),
  }).default(false);

function checkPids(value: unknown): Checked<number> {
  const n = toNumber(value);
  if (n === undefined || !Number.isInteger(n)) return reject(msg("not_a_number", { label: "pids" }), "pids");
  if (n < PIDS_MIN || n > PIDS_MAX) return reject(msg("pids_range", { min: PIDS_MIN, max: PIDS_MAX }), "pids");
  return accept(n);
}

function checkLifetime(value: unknown, field: "idleTimeoutSec" | "ttlSec"): Checked<number | null | undefined> {
  if (value === undefined) return accept(undefined);
  if (value === null) return accept(null);
  const n = toNumber(value);
  const key = field === "idleTimeoutSec" ? "idle_timeout_invalid" : "ttl_invalid";
  // Idle timeout may be 0 (never sleep). TTL must be a positive lifetime.
  const min = field === "idleTimeoutSec" ? 0 : 1;
  if (n === undefined || !Number.isInteger(n) || n < min || n > MAX_LIFETIME_SEC) {
    return reject(msg(key, { max: MAX_LIFETIME_SEC }), field);
  }
  return accept(n);
}

function checkLabels(value: unknown): Checked<Record<string, string> | undefined> {
  if (value === undefined) return accept(undefined);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return reject(msg("label_invalid"), "labels");
  const entries = Object.entries(value);
  if (entries.length > LABEL_COUNT_MAX) return reject(msg("label_invalid"), "labels");
  const labels: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (!NAME_RE.test(key) || typeof raw !== "string" || raw.length > LABEL_VALUE_MAX || /\p{Cc}/u.test(raw)) {
      return reject(msg("label_invalid"), "labels");
    }
    labels[key] = raw;
  }
  return accept(labels);
}

const PIDS_META: Meta = {
  type: "integer",
  minimum: PIDS_MIN,
  maximum: PIDS_MAX,
  description: "Process limit, an integer between 1 and 1000000.",
};

const LIFETIME_HELP =
  "A positive number of seconds, at most 365 days, or null to clear. Omitted, the current value stays.";

/** Names neither CPU, memory nor a process limit. It runs only once every field has passed. */
export function requireResources(
  ctx: z.RefinementCtx,
  input: { cpus?: unknown; memoryMb?: unknown; pids?: unknown },
): void {
  if (input.cpus === undefined && input.memoryMb === undefined && input.pids === undefined) {
    addFailure(ctx, { message: msg("resources_required") });
  }
}

const UPDATE_FIELDS = ["name", "cpus", "memoryMb", "pids", "labels", "idleTimeoutSec", "ttlSec"] as const;
const REBUILD_INPUTS = ["template", "mounts", "env", "network", "profile"] as const;

/** An update has to change an in-place field or name a rebuild field. The handler rejects rebuild fields without confirm. */
export function requireUpdate(
  ctx: z.RefinementCtx,
  input: {
    name?: unknown;
    cpus?: unknown;
    memoryMb?: unknown;
    pids?: unknown;
    labels?: unknown;
    idleTimeoutSec?: unknown;
    ttlSec?: unknown;
    template?: unknown;
    mounts?: unknown;
    env?: unknown;
    network?: unknown;
    profile?: unknown;
  },
): void {
  const present = (key: string) => input[key as keyof typeof input] !== undefined;
  if (![...UPDATE_FIELDS, ...REBUILD_INPUTS].some(present)) addFailure(ctx, { message: msg("box_update_empty") });
}

export const optionalBoxName = () =>
  field(
    (value): Checked<string | undefined> =>
      value === undefined || value === null || value === "" ? accept(undefined) : checkName(value, "boxName"),
    {
      ...NAME_META,
      description: "New box name. The container is renamed to prefix-name. The workspace volume is not renamed.",
    },
  ).optional();

export const optionalPids = () =>
  field(
    (value): Checked<number | undefined> => (value === null ? accept(undefined) : checkPids(value)),
    PIDS_META,
  ).optional();

export const idleTimeout = () =>
  field((value) => checkLifetime(value, "idleTimeoutSec"), {
    description: `Idle timeout in seconds. 0 disables idle sleep for this box; null inherits the global default (BOX_IDLE_TIMEOUT_SEC). ${LIFETIME_HELP}`,
    anyOf: [{ type: "integer", minimum: 0, maximum: MAX_LIFETIME_SEC }, { type: "null" }],
  }).optional();

const TTL_CREATE =
  "Time to live in seconds. A positive integer, at most 365 days, or null for none. Omitted or null stores no TTL, except for an agent token with a max TTL, which stores that cap. A value above the cap is refused. When the time elapses the box stops, and its container is kept.";

/** `create` is box create and snapshot fork. `update` changes a box that already has a value. */
export const ttl = (mode: "create" | "update" = "update") =>
  field((value) => checkLifetime(value, "ttlSec"), {
    description: mode === "create" ? TTL_CREATE : `Time to live in seconds. ${LIFETIME_HELP}`,
    anyOf: [{ type: "integer", minimum: 1, maximum: MAX_LIFETIME_SEC }, { type: "null" }],
  }).optional();

export const userLabels = () =>
  field(checkLabels, {
    type: "object",
    description:
      "User labels stored in the spec. At most 32 entries. Keys follow box name rules. Values are a single line of at most 256 characters. Replaces the current set. Never copied onto the container.",
    maxProperties: LABEL_COUNT_MAX,
    additionalProperties: { type: "string", maxLength: LABEL_VALUE_MAX },
  }).optional();

const MOUNT_MAX = 16;
const ENV_MAX = 64;
/** Also the longest secret value: a secret is injected through the same env entry a plain value would be. */
export const ENV_VALUE_MAX = 8192;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function checkMounts(value: unknown): Checked<BoxMount[] | undefined> {
  if (value === undefined) return accept(undefined);
  if (!Array.isArray(value) || value.length > MOUNT_MAX)
    return reject(msg("mount_invalid", { max: MOUNT_MAX }), "mounts");
  const mounts: BoxMount[] = [];
  const paths = new Set<string>();
  for (const item of value) {
    if (typeof item !== "object" || item === null) return reject(msg("mount_invalid", { max: MOUNT_MAX }), "mounts");
    const mount = item as Partial<BoxMount>;
    const path = mount.path;
    if (typeof mount.volume !== "string" || !IDENT_RE.test(mount.volume)) {
      return reject(msg("mount_invalid", { max: MOUNT_MAX }), "mounts");
    }
    if (
      typeof path !== "string" ||
      !path.startsWith("/") ||
      path.length > 256 ||
      /\s/u.test(path) ||
      /\p{Cc}/u.test(path)
    ) {
      return reject(msg("mount_invalid", { max: MOUNT_MAX }), "mounts");
    }
    if (path.split("/").includes("..")) return reject(msg("mount_invalid", { max: MOUNT_MAX }), "mounts");
    if (mount.mode !== "rw" && mount.mode !== "ro") return reject(msg("mount_invalid", { max: MOUNT_MAX }), "mounts");
    if (paths.has(path)) return reject(msg("mount_invalid", { max: MOUNT_MAX }), "mounts");
    paths.add(path);
    mounts.push({ volume: mount.volume, path, mode: mount.mode });
  }
  return accept(mounts);
}

function checkEnv(value: unknown): Checked<BoxEnv[] | undefined> {
  if (value === undefined) return accept(undefined);
  const invalid = () => reject(msg("env_invalid", { max: ENV_MAX }), "env");
  if (!Array.isArray(value) || value.length > ENV_MAX) return invalid();
  const env: BoxEnv[] = [];
  const names = new Set<string>();
  for (const item of value) {
    if (typeof item !== "object" || item === null) return invalid();
    const entry = item as Partial<BoxEnv>;
    if (typeof entry.name !== "string" || !ENV_NAME_RE.test(entry.name) || names.has(entry.name)) return invalid();
    if ((entry.value === undefined) === (entry.secretRef === undefined)) return invalid();
    const next: BoxEnv = { name: entry.name };
    if (entry.value !== undefined) {
      if (typeof entry.value !== "string" || entry.value.length > ENV_VALUE_MAX || /\p{Cc}/u.test(entry.value)) {
        return invalid();
      }
      next.value = entry.value;
    } else {
      if (typeof entry.secretRef !== "string" || !IDENT_RE.test(entry.secretRef)) return invalid();
      next.secretRef = entry.secretRef;
    }
    names.add(entry.name);
    env.push(next);
  }
  return accept(env);
}

const ENV_ITEM_META: Meta = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", pattern: ENV_NAME_RE.source, maxLength: 128 },
    value: { type: "string", maxLength: ENV_VALUE_MAX },
    secretRef: { type: "string", pattern: IDENT_RE.source, maxLength: 128 },
  },
};

const ENV_HELP_CREATE =
  "Environment variables of the new box. Each entry is { name, value } for a plain value or { name, secretRef } for a secret set with secret.set. Give one or the other. A secret's value goes into the container when it is created and is never returned. A secret that is not set is refused with 400.";
const ENV_HELP_CHANGE =
  "Environment entries that replace the box's env list. Each entry is { name, value } for a plain value or { name, secretRef } for a secret set with secret.set. Give one or the other. Omitted, the current env stays. A secret's value goes into the new container when the box is rebuilt, so a changed secret takes effect on the next rebuild. A secret that is not set is refused with 400. Values are not written to container labels.";

/** The env list of a create (`create`) or of a rebuild or update (`change`). Both check each entry the same way. */
export const boxEnv = (mode: "create" | "change") =>
  field(checkEnv, {
    type: "array",
    maxItems: ENV_MAX,
    items: ENV_ITEM_META,
    description: mode === "create" ? ENV_HELP_CREATE : ENV_HELP_CHANGE,
  }).optional();

const SECRET_NAME_META: Meta = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: IDENT_RE.source,
  description: "Secret name: letters, digits, dots, underscores and hyphens, starting with a letter or digit.",
};

function checkSecretName(value: unknown): Checked<string> {
  if (typeof value !== "string" || !IDENT_RE.test(value)) return reject(msg("secret_name_invalid"), "name");
  return accept(value);
}

export const secretName = () => field(checkSecretName, SECRET_NAME_META);

function checkSecretValue(value: unknown): Checked<string> {
  if (typeof value !== "string" || value.length === 0 || value.length > ENV_VALUE_MAX || /\p{Cc}/u.test(value)) {
    return reject(msg("secret_value_invalid", { max: ENV_VALUE_MAX }), "value");
  }
  return accept(value);
}

export const secretValue = () =>
  field(checkSecretValue, {
    type: "string",
    minLength: 1,
    maxLength: ENV_VALUE_MAX,
    description:
      "The value to store. It is written to the secret store and is never returned. A box that uses the secret gets the new value when it is next rebuilt.",
  });

function checkForce(value: unknown): Checked<boolean> {
  if (value === undefined || value === null || value === "") return accept(false);
  if (value === true || value === "true" || value === "1") return accept(true);
  if (value === false || value === "false" || value === "0") return accept(false);
  return reject(msg("not_boolean", { field: "force" }), "force");
}

export const forceFlag = () =>
  field(checkForce, {
    type: "boolean",
    description: withDefault(
      "Delete the secret even when boxes still refer to it. Those boxes cannot be rebuilt or started until the secret is set again.",
      false,
    ),
  }).default(false);

function checkNetwork(value: unknown): Checked<string | undefined> {
  if (value === undefined || value === null || value === "") return accept(undefined);
  if (typeof value !== "string" || !IDENT_RE.test(value)) return reject(msg("network_invalid"), "network");
  return accept(value);
}

function checkConfirm(value: unknown): Checked<boolean> {
  if (value === undefined || value === null || value === "") return accept(false);
  if (value === true || value === "true") return accept(true);
  if (value === false || value === "false") return accept(false);
  return reject(msg("not_boolean", { field: "confirm" }), "confirm");
}

export const rebuildMounts = () =>
  field(checkMounts, {
    type: "array",
    maxItems: MOUNT_MAX,
    description:
      "Mounts that replace the box's mount list. Each entry is { volume, path, mode } with mode rw or ro. Omitted, the current mounts stay. Adding or removing a mount rebuilds the box. A recorded volume can be mounted by several boxes unless another box owns it. A new or changed mount needs volume:attach on its volume, and a read-write one also needs volume:write. A name that does not exist yet creates a standalone volume, which needs volume:write. Refused: minibox-data, volumes without the MiniBox label, internal helper volumes, pool roots, volumes another box owns, and names that start with the label prefix followed by -ws- or -pool-.",
  }).optional();

export const rebuildEnv = () => boxEnv("change");

export const rebuildNetwork = () =>
  field(checkNetwork, {
    type: "string",
    maxLength: 128,
    description:
      "Docker network the rebuilt container joins: the host's box network (created when missing) or the network the box already uses. Host, none and container networks, and any other network, are refused.",
  }).optional();

export const confirmFlag = () =>
  field(checkConfirm, {
    type: "boolean",
    description:
      "Apply the rebuild. Without true, the call is rejected with 409 confirmation_required and a preview of the docker diff and the planned changes. Defaults to false.",
  }).default(false);

export const storageConfirmFlag = () =>
  field(checkConfirm, {
    type: "boolean",
    description:
      "Apply the change. Without true, the call is rejected with 409 confirmation_required and a preview of what would change, and nothing changes. Defaults to false.",
  }).default(false);

/**
 * Present so MCP and direct callers can pass the revision. REST overwrites it with the If-Match header.
 * Empty means the caller did not send one; the handler rejects that with 428 after the other checks.
 */
export const expectedRevision = () =>
  z.string().default("").meta({
    description:
      "The box's current revision. REST sends it as the If-Match header (a bare number, a quoted tag or a weak tag). MCP and the CLI pass this argument. Omitting it is rejected with 428; a stale value is rejected with 412.",
  });

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
    failure.hint ? { hint: failure.hint } : undefined,
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
