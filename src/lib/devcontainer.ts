import { parseJsonc } from "./jsonc";
import { msg, type Msg } from "./messages";

/** Where a reader looks for the file, in order. The first is the spec's location. */
export const DEVCONTAINER_PATHS = [".devcontainer/devcontainer.json", ".devcontainer.json"] as const;

/** Settings minibox reads. `$schema` and `name` are metadata and change nothing. Every other key is refused. */
const TOP_KEYS = new Set(["$schema", "name", "image", "build", "containerEnv"]);
const BUILD_KEYS = new Set(["dockerfile", "context", "args"]);
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]*$/;
const VALUE_MAX = 4096;

export type DevcontainerBase =
  | { kind: "image"; image: string }
  | { kind: "build"; dockerfile: string; context: string; args: Record<string, string> };

export interface DevcontainerPlan {
  base: DevcontainerBase;
  /** containerEnv. Each entry becomes an ENV instruction, so the value is set in the image. */
  env: Record<string, string>;
}

/** The plan, or the problem with the setting that breaks it and, when there is one, what to do about it. */
export type DevcontainerReading = { plan: DevcontainerPlan } | { problem: Msg; hint?: Msg };

type Parsed<T> = { value: T } | { problem: Msg };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function valueProblem(name: string, value: string): boolean {
  return !NAME_RE.test(name) || value.length > VALUE_MAX || /\p{Cc}/u.test(value) || value.includes("${");
}

/** A map of names to one-line strings. A `${…}` reference is refused, because minibox does not expand variables. */
function stringMap(value: unknown, field: string): Parsed<Record<string, string>> {
  if (value === undefined) return { value: {} };
  if (!isObject(value)) return { problem: msg("devcontainer_invalid", { detail: `${field} must be an object` }) };
  const out: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== "string" || valueProblem(name, entry)) {
      return { problem: msg("devcontainer_value_invalid", { name: `${field}.${name}` }) };
    }
    out[name] = entry;
  }
  return { value: out };
}

function unsupportedReading(keys: string[]): { problem: Msg; hint: Msg } {
  return {
    problem: msg("devcontainer_unsupported", { keys: keys.join(", ") }),
    hint: msg(keys.includes("postCreateCommand") ? "devcontainer_post_create" : "devcontainer_unsupported_hint"),
  };
}

function buildBase(build: unknown): Parsed<DevcontainerBase> | { problem: Msg; hint?: Msg } {
  if (!isObject(build)) return { problem: msg("devcontainer_build_invalid") };
  const unsupported = Object.keys(build).filter((key) => !BUILD_KEYS.has(key));
  if (unsupported.length > 0) return unsupportedReading(unsupported.map((key) => `build.${key}`));
  const { dockerfile, context = ".", args } = build;
  if (typeof dockerfile !== "string" || dockerfile === "" || typeof context !== "string") {
    return { problem: msg("devcontainer_build_invalid") };
  }
  const parsed = stringMap(args, "build.args");
  if ("problem" in parsed) return parsed;
  return { value: { kind: "build", dockerfile, context, args: parsed.value } };
}

/**
 * Reads a devcontainer.json as a template plan. The image or the build must be given, and never both. A key minibox does
 * not read, such as features or postCreateCommand, is refused by name rather than dropped, so the template is never built
 * without a setting the file asked for. Lifecycle commands and initializeCommand are never run.
 */
export function readDevcontainer(text: string): DevcontainerReading {
  let value: unknown;
  try {
    value = parseJsonc(text);
  } catch (e) {
    return { problem: msg("devcontainer_invalid", { detail: e instanceof Error ? e.message : String(e) }) };
  }
  if (!isObject(value)) return { problem: msg("devcontainer_invalid", { detail: "the top level must be an object" }) };
  const unsupported = Object.keys(value).filter((key) => !TOP_KEYS.has(key));
  if (unsupported.length > 0) return unsupportedReading(unsupported);
  const env = stringMap(value.containerEnv, "containerEnv");
  if ("problem" in env) return { problem: env.problem };
  if ((value.image === undefined) === (value.build === undefined)) return { problem: msg("devcontainer_source") };
  if (value.image !== undefined) {
    if (typeof value.image !== "string" || !IMAGE_RE.test(value.image)) return { problem: msg("image_ref_invalid") };
    return { plan: { base: { kind: "image", image: value.image }, env: env.value } };
  }
  const base = buildBase(value.build);
  if ("problem" in base) return base;
  return { plan: { base: base.value, env: env.value } };
}

/** One ENV instruction per containerEnv entry. Backslashes, quotes and dollar signs are escaped, so Docker keeps each value as written. */
export function envInstructions(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([name, value]) => `ENV ${name}="${value.replace(/[\\"$]/g, "\\$&")}"\n`)
    .join("");
}
