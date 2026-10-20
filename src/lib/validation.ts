import { badRequest } from "./errors";

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
    throw badRequest("请求体必须是 JSON 对象。");
  }
  return body as Obj;
}

export function validateName(value: unknown, field = "name", label = "名称"): string {
  if (typeof value !== "string" || !value.trim()) throw badRequest(`${label}不能为空。`, { field });
  const v = value.trim();
  if (!NAME_RE.test(v)) {
    throw badRequest(`${label}只能包含字母、数字、点、下划线和连字符，须以字母或数字开头，长度不超过 63 个字符。`, {
      field,
    });
  }
  return v;
}

export function optionalName(value: unknown, field: string, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return validateName(value, field, label);
}

function toNumber(value: unknown, field: string, label: string): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) throw badRequest(`${label}必须是数字。`, { field });
  return n;
}

export function validateCpus(value: unknown): number {
  const n = toNumber(value, "cpus", "CPU 核数");
  if (n < LIMITS.minCpus || n > LIMITS.maxCpus) {
    throw badRequest(`CPU 核数须在 ${LIMITS.minCpus} 到 ${LIMITS.maxCpus} 之间。`, { field: "cpus" });
  }
  return Math.round(n * 100) / 100;
}

export function validateMemoryMb(value: unknown): number {
  const n = toNumber(value, "memoryMb", "内存");
  if (!Number.isInteger(n) || n < LIMITS.minMemoryMb || n > LIMITS.maxMemoryMb) {
    throw badRequest(`内存须为 ${LIMITS.minMemoryMb} 到 ${LIMITS.maxMemoryMb} 之间的整数（MB）。`, {
      field: "memoryMb",
    });
  }
  return n;
}

export function validateTail(value: string | null): number {
  if (value === null || value === "") return 300;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > LIMITS.maxLogTail) {
    throw badRequest(`tail 须为 1 到 ${LIMITS.maxLogTail} 之间的整数。`, { field: "tail" });
  }
  return n;
}

export function optionalBoolean(value: unknown, field: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw badRequest(`${field} 必须是布尔值。`, { field });
}

export interface CreateBoxInput {
  name: string;
  image?: string;
  cpus: number;
  memoryMb: number;
}

/** Image reference (repo[:tag] or sha256:...). Kept permissive but rejects whitespace/control chars. */
export function validateImageRef(value: unknown, field = "template"): string {
  if (typeof value !== "string" || !value.trim()) throw badRequest("请选择模板。", { field });
  const v = value.trim();
  if (v.length > 255 || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]*$/.test(v)) throw badRequest("镜像引用格式不正确。", { field });
  return v;
}

export function parseCreateBox(body: unknown, defaults: { cpus: number; memoryMb: number }): CreateBoxInput {
  const o = asObject(body);
  return {
    name: validateName(o.name, "name", "Box 名称"),
    image: o.template === undefined || o.template === "" ? undefined : validateImageRef(o.template),
    cpus: o.cpus === undefined ? defaults.cpus : validateCpus(o.cpus),
    memoryMb: o.memoryMb === undefined ? defaults.memoryMb : validateMemoryMb(o.memoryMb),
  };
}

export function parseResources(body: unknown): { cpus?: number; memoryMb?: number } {
  const o = asObject(body);
  const out: { cpus?: number; memoryMb?: number } = {};
  if (o.cpus !== undefined && o.cpus !== null) out.cpus = validateCpus(o.cpus);
  if (o.memoryMb !== undefined && o.memoryMb !== null) out.memoryMb = validateMemoryMb(o.memoryMb);
  if (out.cpus === undefined && out.memoryMb === undefined) throw badRequest("请至少提供 cpus 或 memoryMb 其中一项。");
  return out;
}
