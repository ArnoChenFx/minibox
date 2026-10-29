import { parseJsonc } from "./jsonc";
import { msg, type Msg } from "./messages";

/** Where a reader looks for the file, in order. The first is the spec's location. */
export const DEVCONTAINER_PATHS = [".devcontainer/devcontainer.json", ".devcontainer.json"] as const;

/** Top-level keys the reader handles. `$schema` and `name` are metadata. Any other key is listed as a warning and not applied. */
const READ_KEYS = new Set([
  "$schema",
  "name",
  "image",
  "build",
  "containerEnv",
  "remoteEnv",
  "remoteUser",
  "postCreateCommand",
  "forwardPorts",
]);
const BUILD_KEYS = new Set(["dockerfile", "context", "args", "target"]);
/** The users a box runs commands as. MiniBox has one box user, `dev`, which is uid 1000 in every MiniBox template. */
const BOX_USERS = new Set(["dev", "1000"]);
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]*$/;
const STAGE_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const VALUE_MAX = 4096;
const POST_CREATE_MAX_BYTES = 64 * 1024;
/** Variables of the spec. MiniBox does not expand them, so a value or command that names one is skipped with a warning. */
const SPEC_VARIABLE_RE =
  /\$\{(?:localEnv|containerEnv|localWorkspaceFolder|containerWorkspaceFolder|localWorkspaceFolderBasename|containerWorkspaceFolderBasename|devcontainerId)(?::[^}]*)?\}/;

type DevcontainerBase =
  | { kind: "image"; image: string }
  | { kind: "build"; dockerfile: string; context: string; args: Record<string, string>; target?: string };

export interface DevcontainerPlan {
  base: DevcontainerBase;
  /** containerEnv, with remoteEnv set over it. Each entry becomes an ENV instruction, so every process in the box sees it. */
  env: Record<string, string>;
  /** postCreateCommand as argv: a string runs under `/bin/sh -c`, and a list runs as written. Absent when there is none. */
  postCreate?: string[];
  /** The forwardPorts entries that name a TCP port in the box, without repeats. */
  forwardPorts: number[];
  /** What the file sets that is not applied, one sentence each. The build log shows them. */
  warnings: string[];
}

/** The plan, or the problem that stops the file from being read. */
export type DevcontainerReading = { plan: DevcontainerPlan } | { problem: Msg };

type Parsed<T> = { value: T } | { problem: Msg };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function valueProblem(name: string, value: string): boolean {
  return !NAME_RE.test(name) || value.length > VALUE_MAX || /\p{Cc}/u.test(value);
}

/**
 * A map of names to one-line strings. A value that names a devcontainer variable, such as `${containerEnv:PATH}`, is left
 * out with a warning, because minibox does not expand variables; any other `${…}` reference is refused. A null in remoteEnv
 * would unset a variable, which minibox cannot do, so that entry is left out with a warning.
 */
function stringMap(value: unknown, field: string, warnings: string[]): Parsed<Record<string, string>> {
  if (value === undefined) return { value: {} };
  if (!isObject(value)) return { problem: msg("devcontainer_invalid", { detail: `${field} must be an object` }) };
  const out: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (entry === null && field === "remoteEnv") {
      warnings.push(
        `remoteEnv.${name} is null, which would unset it. MiniBox cannot unset a variable, so it was not applied.`,
      );
      continue;
    }
    if (typeof entry !== "string" || valueProblem(name, entry)) {
      return { problem: msg("devcontainer_value_invalid", { name: `${field}.${name}` }) };
    }
    const variable = specVariable(entry);
    if (variable !== undefined) {
      warnings.push(
        `${field}.${name} uses ${variable}, a devcontainer variable that MiniBox does not expand, so it was not applied.`,
      );
      continue;
    }
    if (entry.includes("${")) {
      return { problem: msg("devcontainer_value_invalid", { name: `${field}.${name}` }) };
    }
    out[name] = entry;
  }
  return { value: out };
}

function imageBase(image: unknown): Parsed<DevcontainerBase> {
  if (typeof image !== "string" || !IMAGE_RE.test(image)) return { problem: msg("image_ref_invalid") };
  return { value: { kind: "image", image } };
}

function buildBase(build: unknown, warnings: string[]): Parsed<DevcontainerBase> {
  if (!isObject(build)) return { problem: msg("devcontainer_build_invalid") };
  for (const key of Object.keys(build)) {
    if (!BUILD_KEYS.has(key)) warnings.push(`build.${key} is not supported, so it was not applied.`);
  }
  const { dockerfile, context = ".", args, target } = build;
  if (typeof dockerfile !== "string" || dockerfile === "" || typeof context !== "string") {
    return { problem: msg("devcontainer_build_invalid") };
  }
  if (target !== undefined && (typeof target !== "string" || !STAGE_RE.test(target))) {
    return { problem: msg("devcontainer_target_invalid") };
  }
  const parsed = stringMap(args, "build.args", warnings);
  if ("problem" in parsed) return parsed;
  const stage = target === undefined ? {} : { target };
  return { value: { kind: "build", dockerfile, context, args: parsed.value, ...stage } };
}

function specVariable(text: string): string | undefined {
  return SPEC_VARIABLE_RE.exec(text)?.[0];
}

/**
 * The command as argv. A string is a shell command and a list is a program with its arguments. The object form runs several
 * commands in parallel, which is not applied, so it gets a warning instead. So does a command that names a devcontainer
 * variable, which minibox does not expand: it is not run.
 */
function postCreateOf(value: unknown, warnings: string[]): Parsed<string[] | undefined> {
  if (value === undefined || value === null) return { value: undefined };
  if (isObject(value)) {
    warnings.push(
      "postCreateCommand as an object runs several commands in parallel, which is not supported, so it was not run.",
    );
    return { value: undefined };
  }
  if (typeof value === "string" && value.trim() === "") return { value: undefined };
  if (Array.isArray(value) && value.length === 0) return { value: undefined };
  const argv = typeof value === "string" ? ["/bin/sh", "-c", value] : value;
  if (!Array.isArray(argv) || !argv.every((item): item is string => typeof item === "string")) {
    return {
      problem: msg("devcontainer_invalid", { detail: "postCreateCommand must be a string or a list of strings" }),
    };
  }
  const variable = argv.map(specVariable).find((found) => found !== undefined);
  if (variable !== undefined) {
    warnings.push(
      `postCreateCommand uses ${variable}, a devcontainer variable that MiniBox does not expand, so it was not run.`,
    );
    return { value: undefined };
  }
  if (Buffer.byteLength(argv.join(" ")) > POST_CREATE_MAX_BYTES) {
    return { problem: msg("devcontainer_invalid", { detail: "postCreateCommand is longer than 64 KB" }) };
  }
  return { value: argv };
}

function portOf(item: unknown): number | null {
  const port = typeof item === "string" && /^\d+$/.test(item) ? Number(item) : item;
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** A forwarded port is a TCP port in the box. An entry that names another host, such as `db:5432`, is not applied. */
function forwardPortsOf(value: unknown, warnings: string[]): Parsed<number[]> {
  if (value === undefined) return { value: [] };
  if (!Array.isArray(value)) return { problem: msg("devcontainer_invalid", { detail: "forwardPorts must be a list" }) };
  const ports: number[] = [];
  for (const item of value) {
    const port = portOf(item);
    if (port === null) {
      warnings.push(`forwardPorts entry ${JSON.stringify(item)} is not a port in the box, so it was not forwarded.`);
    } else if (!ports.includes(port)) {
      ports.push(port);
    }
  }
  return { value: ports };
}

function remoteUserWarning(value: unknown): string | null {
  if (value === undefined || BOX_USERS.has(String(value))) return null;
  return `remoteUser ${JSON.stringify(value)} is not supported, because MiniBox runs commands as dev. It was not applied.`;
}

/**
 * Reads a devcontainer.json as a template plan. The image or the build must be given, and never both. A setting MiniBox does
 * not apply is not refused: it is listed in the plan's warnings, which the build log shows. So is a value or command that
 * names a devcontainer variable, which MiniBox does not expand: it is skipped, so a template is never built with a different
 * value. Any other `${…}` reference is refused. Lifecycle commands other than postCreateCommand are never run.
 */
export function readDevcontainer(text: string): DevcontainerReading {
  let value: unknown;
  try {
    value = parseJsonc(text);
  } catch (e) {
    return { problem: msg("devcontainer_invalid", { detail: e instanceof Error ? e.message : String(e) }) };
  }
  if (!isObject(value)) return { problem: msg("devcontainer_invalid", { detail: "the top level must be an object" }) };
  const warnings = Object.keys(value)
    .filter((key) => !READ_KEYS.has(key))
    .map((key) => `${key} is not supported, so it was not applied.`);
  const env = stringMap(value.containerEnv, "containerEnv", warnings);
  if ("problem" in env) return { problem: env.problem };
  const remote = stringMap(value.remoteEnv, "remoteEnv", warnings);
  if ("problem" in remote) return { problem: remote.problem };
  if ((value.image === undefined) === (value.build === undefined)) return { problem: msg("devcontainer_source") };
  const base = value.image === undefined ? buildBase(value.build, warnings) : imageBase(value.image);
  if ("problem" in base) return { problem: base.problem };
  const postCreate = postCreateOf(value.postCreateCommand, warnings);
  if ("problem" in postCreate) return { problem: postCreate.problem };
  const ports = forwardPortsOf(value.forwardPorts, warnings);
  if ("problem" in ports) return { problem: ports.problem };
  const user = remoteUserWarning(value.remoteUser);
  if (user !== null) warnings.push(user);
  return {
    plan: {
      base: base.value,
      env: { ...env.value, ...remote.value },
      ...(postCreate.value === undefined ? {} : { postCreate: postCreate.value }),
      forwardPorts: ports.value,
      warnings,
    },
  };
}

/** One ENV instruction per entry. Backslashes, quotes and dollar signs are escaped, so Docker keeps each value as written. */
export function envInstructions(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([name, value]) => `ENV ${name}="${value.replace(/[\\"$]/g, "\\$&")}"\n`)
    .join("");
}
