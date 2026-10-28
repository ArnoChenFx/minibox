import { z } from "zod";

import { AppError, notFound, toAppError } from "../lib/errors";
import { log } from "../lib/logger";
import { msg } from "../lib/messages";
import { accept, type Checked, NAME_RE, reject } from "../lib/validation";
import { deleteBoxToTrash } from "../services/trash";
import {
  type BoxScope,
  compileToken,
  type HostScope,
  isPreset,
  isScope,
  type PresetName,
  PRESET_NAMES,
  type Quotas,
  resolveBoxRefs,
  SCOPES,
  type Scope,
  specViews,
  type TokenCreateInput,
  type VolumeScope,
} from "../tokens/model";
import type { TokenInfo } from "../tokens/store";
import { defineOperation } from "./define";
import { addFailure, field } from "./validation";

const SCOPE_MAX = SCOPES.length;
const LIST_MAX = 100;
const TAG_MAX = 32;
const HOST_MAX = 32;
const TAG_VALUE_MAX = 256;
/** Ten years. A token with no expiry omits this. */
const EXPIRY_MAX = 315_360_000;
const QUOTA_BOXES_MAX = 10_000;
const QUOTA_CPUS_MAX = 10_000;
const QUOTA_MEMORY_MAX = 10_000_000;
const QUOTA_TTL_MAX = 31_536_000;
const RATE_MAX = 1_000_000;
const WINDOW_MAX = 86_400;
const QUOTA_CHECKPOINTS_MAX = 10_000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const CONTROL = /\p{Cc}/u;

const absent = (value: unknown): boolean => value === undefined || value === null;

function optional<T>(value: unknown, parse: (value: unknown) => Checked<T>, fieldName: string): Checked<T | undefined> {
  if (absent(value)) return accept(undefined);
  const parsed = parse(value);
  if (!parsed.ok) return reject(parsed.failure.message, parsed.failure.field ?? fieldName);
  return accept(parsed.value);
}

function checkScopes(value: unknown): Checked<Scope[] | undefined> {
  return optional(
    value,
    (raw) => {
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > SCOPE_MAX) {
        return reject(msg("token_scope_invalid", { max: SCOPE_MAX }), "scopes");
      }
      const scopes: Scope[] = [];
      for (const item of raw) {
        if (typeof item !== "string" || !isScope(item) || scopes.includes(item)) {
          return reject(msg("token_scope_invalid", { max: SCOPE_MAX }), "scopes");
        }
        scopes.push(item);
      }
      return accept(scopes);
    },
    "scopes",
  );
}

function checkPreset(value: unknown): Checked<PresetName | undefined> {
  return optional(
    value,
    (raw) => (typeof raw === "string" && isPreset(raw) ? accept(raw) : reject(msg("token_preset_invalid"), "preset")),
    "preset",
  );
}

function checkIdList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > LIST_MAX) return null;
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !ID_RE.test(item) || ids.includes(item)) return null;
    ids.push(item);
  }
  return ids;
}

function checkTag(value: string): boolean {
  const eq = value.indexOf("=");
  const key = eq === -1 ? value : value.slice(0, eq);
  const rest = eq === -1 ? "" : value.slice(eq + 1);
  if (!NAME_RE.test(key)) return false;
  return eq === -1 || (rest.length <= TAG_VALUE_MAX && !CONTROL.test(rest));
}

function checkBoxes(value: unknown): Checked<BoxScope | undefined> {
  return optional(
    value,
    (raw): Checked<BoxScope> => {
      if (
        raw === "created-by-me" ||
        (typeof raw === "object" && raw !== null && "type" in raw && raw.type === "created-by-me")
      ) {
        return accept({ type: "created-by-me" });
      }
      if (raw === "*") return accept({ type: "all" });
      if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        if ("ids" in raw) {
          const ids = checkIdList(raw.ids);
          if (ids) return accept({ type: "ids", ids });
        }
        if ("tags" in raw && Array.isArray(raw.tags) && raw.tags.length > 0 && raw.tags.length <= TAG_MAX) {
          const tags: string[] = [];
          for (const tag of raw.tags) {
            if (typeof tag !== "string" || !checkTag(tag) || tags.includes(tag)) {
              return reject(msg("token_boxes_invalid"), "boxes");
            }
            tags.push(tag);
          }
          return accept({ type: "tags", tags });
        }
        if ("type" in raw && raw.type === "all") return accept({ type: "all" });
      }
      return reject(msg("token_boxes_invalid"), "boxes");
    },
    "boxes",
  );
}

function checkNameList(value: unknown, max: number, pattern: RegExp): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !pattern.test(item) || ids.includes(item)) return null;
    ids.push(item);
  }
  return ids;
}

function checkVolumes(value: unknown): Checked<VolumeScope | undefined> {
  return optional(
    value,
    (raw): Checked<VolumeScope> => {
      if (raw === "*") return accept({ type: "all" });
      const ids = checkNameList(raw, LIST_MAX, ID_RE);
      if (ids) return accept({ type: "list", ids });
      return reject(msg("token_volumes_invalid"), "volumes");
    },
    "volumes",
  );
}

function checkHosts(value: unknown): Checked<HostScope | undefined> {
  return optional(
    value,
    (raw): Checked<HostScope> => {
      if (raw === "*") return accept({ type: "all" });
      const ids = checkNameList(raw, HOST_MAX, HOST_RE);
      if (ids && ids.length > 0) return accept({ type: "list", ids });
      return reject(msg("token_hosts_invalid"), "hosts");
    },
    "hosts",
  );
}

function checkQuotaNumber(value: unknown, max: number, integer: boolean): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > max) return Number.NaN;
  if (integer && !Number.isInteger(value)) return Number.NaN;
  return value;
}

function checkQuotas(value: unknown): Checked<Partial<Quotas> | undefined> {
  return optional(
    value,
    (raw) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return reject(msg("token_quota_invalid"), "quotas");
      }
      const source = raw as Record<string, unknown>;
      const maxBoxes = checkQuotaNumber(source.maxBoxes, QUOTA_BOXES_MAX, true);
      const maxCpus = checkQuotaNumber(source.maxCpus, QUOTA_CPUS_MAX, false);
      const maxMemoryMb = checkQuotaNumber(source.maxMemoryMb, QUOTA_MEMORY_MAX, true);
      const maxTtlSec = checkQuotaNumber(source.maxTtlSec, QUOTA_TTL_MAX, true);
      const rateLimit = checkQuotaNumber(source.rateLimit, RATE_MAX, true);
      const rateWindowSec = checkQuotaNumber(source.rateWindowSec, WINDOW_MAX, true);
      const maxCheckpoints = checkQuotaNumber(source.maxCheckpoints, QUOTA_CHECKPOINTS_MAX, true);
      const numbers = [maxBoxes, maxCpus, maxMemoryMb, maxTtlSec, rateLimit, rateWindowSec, maxCheckpoints];
      if (numbers.some((item) => Number.isNaN(item))) return reject(msg("token_quota_invalid"), "quotas");
      const quotas: Partial<Quotas> = {
        ...(maxBoxes !== undefined ? { maxBoxes } : {}),
        ...(maxCpus !== undefined ? { maxCpus } : {}),
        ...(maxMemoryMb !== undefined ? { maxMemoryMb } : {}),
        ...(maxTtlSec !== undefined ? { maxTtlSec } : {}),
        ...(rateLimit !== undefined ? { rateLimit } : {}),
        ...(rateWindowSec !== undefined ? { rateWindowSec } : {}),
        ...(maxCheckpoints !== undefined ? { maxCheckpoints } : {}),
      };
      return accept(quotas);
    },
    "quotas",
  );
}

function checkExpiry(value: unknown): Checked<number | null | undefined> {
  if (absent(value)) return accept(undefined);
  if (value === null) return accept(null);
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > EXPIRY_MAX) {
    return reject(msg("token_expiry_invalid", { max: EXPIRY_MAX }), "expiresInSec");
  }
  return accept(value);
}

function checkDeleteCreated(value: unknown): Checked<boolean> {
  if (absent(value)) return accept(false);
  if (typeof value === "boolean") return accept(value);
  if (value === "true" || value === "1") return accept(true);
  if (value === "false" || value === "0") return accept(false);
  return reject(msg("not_boolean", { field: "deleteCreated" }), "deleteCreated");
}

const BoxScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("created-by-me") }),
  z.object({ type: z.literal("ids"), ids: z.array(z.string()) }),
  z.object({ type: z.literal("tags"), tags: z.array(z.string()) }),
  z.object({ type: z.literal("all") }),
]);

const VolumeScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("list"), ids: z.array(z.string()) }),
  z.object({ type: z.literal("all") }),
]);

const HostScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("list"), ids: z.array(z.string()) }),
  z.object({ type: z.literal("all") }),
]);

const QuotasSchema = z.object({
  maxBoxes: z.number().nullable(),
  maxCpus: z.number().nullable(),
  maxMemoryMb: z.number().nullable(),
  maxTtlSec: z.number().nullable(),
  rateLimit: z.number().nullable(),
  rateWindowSec: z.number().nullable(),
  maxCheckpoints: z.number().nullable(),
});

export const TokenInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  preset: z.enum(PRESET_NAMES).nullable(),
  scopes: z.array(z.enum(SCOPES)),
  boxes: BoxScopeSchema,
  volumes: VolumeScopeSchema,
  hosts: HostScopeSchema,
  quotas: QuotasSchema,
  audit: z.enum(["all", "scoped"]),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  lastUsedIp: z.string().nullable(),
  createdBy: z.string(),
  revokedAt: z.string().nullable(),
});

const tokenCreateInput = z
  .object({
    name: field(
      (value) => {
        if (typeof value !== "string" || !value.trim())
          return reject(msg("field_required", { label: "tokenName" }), "name");
        const name = value.trim();
        if (!NAME_RE.test(name)) return reject(msg("name_invalid", { label: "tokenName" }), "name");
        return accept(name);
      },
      {
        type: "string",
        minLength: 1,
        maxLength: 63,
        pattern: NAME_RE.source,
        description: "Name shown in Settings. Letters, digits, dots, underscores and hyphens.",
      },
    ),
    preset: field(checkPreset, {
      type: "string",
      enum: [...PRESET_NAMES],
      description:
        "readonly, operator, sandboxed-agent or admin. Overrides below replace the preset's matching part. Omit it to send scopes yourself.",
    }).optional(),
    scopes: field(checkScopes, {
      type: "array",
      items: { type: "string", enum: [...SCOPES] },
      maxItems: SCOPE_MAX,
      description: `Replaces the preset's scopes. One or more of ${SCOPES.join(", ")}.`,
    }).optional(),
    boxes: field(checkBoxes, {
      description:
        'Which boxes this token may use. "created-by-me" (the default), "*" for every box, {"ids":["bx_…"]}, or {"tags":["env=prod"]}. A tag is a label key, or key=value.',
    }).optional(),
    volumes: field(checkVolumes, {
      description:
        'Volumes the token may attach, by volume id (vol_…). "*" or a list. Empty grants nothing. Naming a volume also grants volume:attach.',
    }).optional(),
    hosts: field(checkHosts, {
      description:
        'Host ids this token may use. "*" or a list. Omitted, a preset chooses: local, or every host for admin.',
    }).optional(),
    quotas: field(checkQuotas, {
      type: "object",
      description:
        "maxBoxes, maxCpus and maxMemoryMb cap what the token can create, as a total across its boxes. maxTtlSec caps the TTL stored on a box, and the box stops when that TTL elapses. maxCheckpoints caps the checkpoints the token takes, as a total across its boxes; automatic checkpoints are kept by the retention policy and not counted. rateLimit is requests per rateWindowSec (default 60). Null clears a preset's limit.",
      properties: {
        maxBoxes: { type: ["integer", "null"] },
        maxCpus: { type: ["number", "null"] },
        maxMemoryMb: { type: ["integer", "null"] },
        maxTtlSec: { type: ["integer", "null"] },
        rateLimit: { type: ["integer", "null"] },
        rateWindowSec: { type: ["integer", "null"] },
        maxCheckpoints: { type: ["integer", "null"] },
      },
    }).optional(),
    expiresInSec: field(checkExpiry, {
      description: `Seconds until the token stops working, up to ${EXPIRY_MAX}. Null or omitted means it does not expire.`,
      anyOf: [{ type: "integer", minimum: 1, maximum: EXPIRY_MAX }, { type: "null" }],
    }).optional(),
  })
  .superRefine((input, ctx) => {
    if (!input.preset && (!input.scopes || input.scopes.length === 0)) {
      addFailure(ctx, { message: msg("token_scope_required"), field: "scopes" });
    }
  });

function draftOf(input: z.output<typeof tokenCreateInput>): TokenCreateInput {
  return {
    name: input.name,
    preset: input.preset,
    scopes: input.scopes,
    boxes: input.boxes,
    volumes: input.volumes,
    hosts: input.hosts,
    quotas: input.quotas,
    expiresInSec: input.expiresInSec,
  };
}

export const tokenCreate = defineOperation({
  name: "token.create",
  tag: "tokens",
  summary: "Create an agent API token",
  kind: "write",
  scope: "token:manage",
  async: false,
  conflicts: true,
  input: tokenCreateInput,
  output: z.object({
    token: z
      .string()
      .meta({ description: "The bearer secret. Shown only in this response; the server stores its hash." }),
    record: TokenInfoSchema,
  }),
  rest: [{ method: "POST", path: "/api/tokens", body: true, status: 201 }],
  cli: "token create",
  activity: { action: () => "token.create", target: (input) => input.name },
  audit: {
    target: ({ name }, _resolved, result) => ({ kind: "token", id: result?.record.id, name }),
    detail: (input) => ({
      name: input.name,
      preset: input.preset ?? null,
      scopes: input.scopes ?? null,
      boxes: input.boxes ?? null,
      volumes: input.volumes ?? null,
      hosts: input.hosts ?? null,
      quotas: input.quotas ?? null,
      expiresInSec: input.expiresInSec ?? null,
    }),
  },
  run: async ({ tokens, principal, host, boxViews }, input) => {
    // A grant by id is stored and compared as stable box ids, so names and container ids resolve here, once.
    let boxes = input.boxes;
    if (boxes?.type === "ids") {
      boxes = { type: "ids", ids: resolveBoxRefs(boxes.ids, boxViews?.() ?? specViews(host.specs.list())) };
    }
    const created = tokens.create(compileToken({ ...draftOf(input), boxes }), principal.id);
    return { token: created.secret, record: created.record };
  },
});

export const tokenList = defineOperation({
  name: "token.list",
  tag: "tokens",
  summary: "List agent API tokens",
  kind: "read",
  scope: "token:manage",
  async: false,
  input: z.object({}),
  output: z.object({ tokens: z.array(TokenInfoSchema) }),
  rest: [{ method: "GET", path: "/api/tokens" }],
  run: async ({ tokens }) => ({ tokens: tokens.list() }),
});

const FailedBoxSchema = z.object({
  id: z.string(),
  name: z.string(),
  hostId: z.string(),
  message: z.string(),
});

type FailedBox = z.infer<typeof FailedBoxSchema>;

export const tokenRevoke = defineOperation({
  name: "token.revoke",
  tag: "tokens",
  summary: "Revoke an agent API token",
  kind: "destructive",
  scope: "token:manage",
  async: false,
  input: z.object({
    id: z.string().meta({ description: "Token id (tok_…), not the secret." }),
    deleteCreated: field(checkDeleteCreated, {
      type: "boolean",
      description:
        "Also delete boxes this token created, including their workspace volumes. Their data is kept in the recycle bin for the retention period.",
    }).default(false),
  }),
  output: z.object({
    token: TokenInfoSchema,
    deletedBoxes: z.array(z.string()).meta({ description: "Names of the boxes deleted with the token." }),
    failedBoxes: z.array(FailedBoxSchema).meta({
      description: "Boxes that could not be deleted. The token is revoked either way, and the other boxes still go.",
    }),
  }),
  rest: [{ method: "DELETE", path: "/api/tokens/:id", query: ["deleteCreated"] }],
  activity: { action: () => "token.revoke", target: (input) => input.id },
  audit: {
    target: ({ id }, _resolved, result) => ({ kind: "token", id, name: result?.token.name ?? id }),
    detail: (input) => ({ id: input.id, deleteCreated: input.deleteCreated }),
  },
  run: async ({ host, allHosts, tokens, principal, record }, input) => {
    const token = tokens.revoke(input.id);
    if (!token) throw notFound(msg("token_not_found"));
    const deletedBoxes: string[] = [];
    const failedBoxes: FailedBox[] = [];
    if (input.deleteCreated) {
      for (const target of allHosts?.() ?? [host]) {
        const specs = target.specs
          .list()
          .filter((spec) => spec.createdBy === input.id && spec.hostId === target.host.id);
        for (const spec of specs) {
          try {
            const removed = await deleteBoxToTrash(target, spec.id, true, {
              skipTrash: false,
              createdBy: principal.id,
              record,
            });
            deletedBoxes.push(removed.name);
          } catch (error) {
            const message = toAppError(error).message;
            log.warn("token.revoke_box_failed", {
              tokenId: input.id,
              boxId: spec.id,
              hostId: target.host.id,
              error: String(error),
            });
            failedBoxes.push({ id: spec.id, name: spec.name, hostId: target.host.id, message });
          }
        }
      }
    }
    return { token, deletedBoxes, failedBoxes };
  },
});

export const tokenDelete = defineOperation({
  name: "token.delete",
  tag: "tokens",
  summary: "Delete a revoked or expired agent API token",
  kind: "destructive",
  scope: "token:manage",
  async: false,
  conflicts: true,
  input: z.object({
    id: z.string().meta({ description: "Token id (tok_…), not the secret. The token must be revoked or expired." }),
  }),
  output: z.object({ token: TokenInfoSchema }),
  rest: [{ method: "DELETE", path: "/api/tokens/:id/record" }],
  cli: "token delete",
  activity: { action: () => "token.delete", target: (input) => input.id },
  audit: {
    target: ({ id }, _resolved, result) => ({ kind: "token", id, name: result?.token.name ?? id }),
    detail: (input, _resolved, result) => ({ id: input.id, name: result?.token.name ?? null }),
  },
  run: async ({ tokens }, input) => {
    const result = tokens.remove(input.id);
    if (result.status === "missing") throw notFound(msg("token_not_found"));
    if (result.status === "live") {
      throw new AppError(409, "conflict", msg("token_delete_live", { name: result.token.name }));
    }
    return { token: result.token };
  },
});

export const tokenPrune = defineOperation({
  name: "token.prune",
  tag: "tokens",
  summary: "Delete every revoked or expired agent API token",
  kind: "destructive",
  scope: "token:manage",
  async: false,
  input: z.object({}),
  output: z.object({
    deleted: z.array(z.object({ id: z.string(), name: z.string() })).meta({
      description: "The tokens whose records were deleted. Live tokens are never included.",
    }),
  }),
  rest: [{ method: "POST", path: "/api/tokens/prune" }],
  cli: "token prune",
  activity: { action: () => "token.prune", target: () => "tokens" },
  audit: {
    detail: (_input, _resolved, result) => ({
      count: result?.deleted.length ?? 0,
      deleted: result?.deleted ?? [],
    }),
  },
  run: async ({ tokens }) => ({ deleted: tokens.prune().map(({ id, name }) => ({ id, name })) }),
});

export const tokenOperations = [tokenList, tokenCreate, tokenRevoke, tokenDelete, tokenPrune];

export type { TokenInfo };
