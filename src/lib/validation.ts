import { type BoxProfile, isBoxProfile } from "../box-profile";
import { badRequest } from "./errors";
import { type LabelKey, msg } from "./messages";

/** Docker-safe resource name: starts alphanumeric, then [A-Za-z0-9_.-], max 63 chars. */
export const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

export const LIMITS = {
  minCpus: 0.1,
  maxCpus: 64,
  minMemoryMb: 128,
  maxMemoryMb: 262144,
  maxLogTail: 5000,
} as const;

type Obj = Record<string, unknown>;

export function asObject(body: unknown): Obj {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest(msg("invalid_json_object"));
  }
  return body as Obj;
}

export function validateName(value: unknown, field = "name", label: LabelKey = "name"): string {
  if (typeof value !== "string" || !value.trim()) throw badRequest(msg("field_required", { label }), { field });
  const v = value.trim();
  if (!NAME_RE.test(v)) {
    throw badRequest(msg("name_invalid", { label }), { field });
  }
  return v;
}

export function optionalName(value: unknown, field: string, label: LabelKey): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return validateName(value, field, label);
}

export function validateProfile(value: unknown): BoxProfile {
  if (!isBoxProfile(value)) throw badRequest(msg("profile_invalid"), { field: "profile" });
  return value;
}

export function optionalProfile(value: unknown): BoxProfile | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return validateProfile(value);
}

function toNumber(value: unknown, field: string, label: LabelKey): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) throw badRequest(msg("not_a_number", { label }), { field });
  return n;
}

export function validateCpus(value: unknown): number {
  const n = toNumber(value, "cpus", "cpus");
  if (n < LIMITS.minCpus || n > LIMITS.maxCpus) {
    throw badRequest(msg("cpus_range", { min: LIMITS.minCpus, max: LIMITS.maxCpus }), { field: "cpus" });
  }
  return Math.round(n * 100) / 100;
}

export function validateMemoryMb(value: unknown): number {
  const n = toNumber(value, "memoryMb", "memory");
  if (!Number.isInteger(n) || n < LIMITS.minMemoryMb || n > LIMITS.maxMemoryMb) {
    throw badRequest(msg("memory_range", { min: LIMITS.minMemoryMb, max: LIMITS.maxMemoryMb }), {
      field: "memoryMb",
    });
  }
  return n;
}

export function validateTail(value: string | null): number {
  if (value === null || value === "") return 300;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > LIMITS.maxLogTail) {
    throw badRequest(msg("tail_range", { max: LIMITS.maxLogTail }), { field: "tail" });
  }
  return n;
}

export function optionalBoolean(value: unknown, field: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw badRequest(msg("not_boolean", { field }), { field });
}

export interface CreateBoxInput {
  name: string;
  image?: string;
  cpus: number;
  memoryMb: number;
  /** Absent means the host's default profile. */
  profile?: BoxProfile;
}

/** Image reference (repo[:tag] or sha256:...). Kept permissive but rejects whitespace/control chars. */
export function validateImageRef(value: unknown, field = "template"): string {
  if (typeof value !== "string" || !value.trim()) throw badRequest(msg("template_required"), { field });
  const v = value.trim();
  if (v.length > 255 || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]*$/.test(v))
    throw badRequest(msg("image_ref_invalid"), { field });
  return v;
}

export function parseCreateBox(body: unknown, defaults: { cpus: number; memoryMb: number }): CreateBoxInput {
  const o = asObject(body);
  return {
    name: validateName(o.name, "name", "boxName"),
    image: o.template === undefined || o.template === "" ? undefined : validateImageRef(o.template),
    cpus: o.cpus === undefined ? defaults.cpus : validateCpus(o.cpus),
    memoryMb: o.memoryMb === undefined ? defaults.memoryMb : validateMemoryMb(o.memoryMb),
    profile: optionalProfile(o.profile),
  };
}

export function parseResources(body: unknown): { cpus?: number; memoryMb?: number } {
  const o = asObject(body);
  const out: { cpus?: number; memoryMb?: number } = {};
  if (o.cpus !== undefined && o.cpus !== null) out.cpus = validateCpus(o.cpus);
  if (o.memoryMb !== undefined && o.memoryMb !== null) out.memoryMb = validateMemoryMb(o.memoryMb);
  if (out.cpus === undefined && out.memoryMb === undefined) throw badRequest(msg("resources_required"));
  return out;
}
