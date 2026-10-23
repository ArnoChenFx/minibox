import { readFile } from "node:fs/promises";

import { type CliIo, readStdinText, parseOptions, OUTPUT_SWITCHES, request, fail } from "./shared";
import { awaitStarted } from "./task";

const TEMPLATE_CREATE_VALUE_FLAGS = [
  "--host",
  "--dockerfile",
  "--repo",
  "--context",
  "--devcontainer",
  "--description",
  "--branch",
  "--subdir",
  "--dockerfile-path",
  "--devcontainer-path",
  "--secret",
];

interface SourceFlag {
  flag: string;
  kind: string;
  takes: readonly string[];
}

const TEMPLATE_SOURCES: readonly SourceFlag[] = [
  { flag: "--dockerfile", kind: "dockerfile", takes: [] },
  { flag: "--repo", kind: "git", takes: ["--branch", "--subdir", "--dockerfile-path", "--secret"] },
  { flag: "--context", kind: "context", takes: ["--dockerfile-path"] },
  { flag: "--devcontainer", kind: "devcontainer", takes: ["--branch", "--devcontainer-path", "--secret"] },
];

/** The request field each source option is sent as. */
const SOURCE_KEYS = new Map([
  ["--branch", "branch"],
  ["--subdir", "subdir"],
  ["--dockerfile-path", "dockerfile"],
  ["--devcontainer-path", "path"],
  ["--secret", "secretRef"],
]);

async function readDockerfile(io: CliIo, file: string): Promise<string> {
  if (file === "-") return readStdinText(io);
  try {
    return await readFile(file, "utf8");
  } catch {
    throw new Error(`minibox template create cannot read ${file}`);
  }
}

async function templateCreateCommand(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  const options = parseOptions(argv, TEMPLATE_CREATE_VALUE_FLAGS, OUTPUT_SWITCHES);
  const [name, ...more] = options.positional;
  if (!name || more.length > 0) throw new Error("minibox template create needs one template name");
  const chosen = TEMPLATE_SOURCES.filter((source) => options.values.has(source.flag));
  const source = chosen[0];
  if (chosen.length !== 1 || source === undefined) {
    throw new Error(
      "minibox template create needs exactly one of --dockerfile FILE, --repo URL, --context URL or --devcontainer URL",
    );
  }
  const value = options.values.get(source.flag) ?? "";
  const payload: Record<string, unknown> = { kind: source.kind };
  if (source.kind === "dockerfile") payload.text = await readDockerfile(io, value);
  else payload.url = value;
  for (const [flag, key] of SOURCE_KEYS) {
    const given = options.values.get(flag);
    if (given === undefined) continue;
    if (!source.takes.includes(flag)) throw new Error(`${flag} does not apply to ${source.flag}`);
    payload[key] = given;
  }
  const body: Record<string, unknown> = { name, source: payload };
  const description = options.values.get("--description");
  if (description !== undefined) body.description = description;
  const host = options.values.get("--host");
  if (host !== undefined) body.host = host;

  const started = await request(env, "POST", "/api/templates", body);
  if (started.status >= 400) return fail(io, started.status, started.json, started.text);
  return awaitStarted(
    env,
    io,
    started.json,
    options,
    (task) => (task.result as { template: { ref: string } }).template.ref,
  );
}

async function templateRebuildCommand(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  const options = parseOptions(argv, ["--host"], OUTPUT_SWITCHES);
  const [ref, ...more] = options.positional;
  if (!ref || more.length > 0) throw new Error("minibox template rebuild needs one template ref");
  const host = options.values.get("--host");
  const query = host === undefined ? "" : `?host=${encodeURIComponent(host)}`;
  const started = await request(env, "POST", `/api/templates/${encodeURIComponent(ref)}/rebuild${query}`);
  if (started.status >= 400) return fail(io, started.status, started.json, started.text);
  return awaitStarted(
    env,
    io,
    started.json,
    options,
    (task) => (task.result as { template: { ref: string } }).template.ref,
  );
}

async function templateSyncCommand(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  const options = parseOptions(argv, ["--host"], OUTPUT_SWITCHES);
  const [ref, ...more] = options.positional;
  const host = options.values.get("--host");
  if (!ref || more.length > 0 || host === undefined) {
    throw new Error("minibox template sync needs one template ref and --host ID");
  }
  const started = await request(env, "POST", `/api/templates/${encodeURIComponent(ref)}/sync`, { host });
  if (started.status >= 400) return fail(io, started.status, started.json, started.text);
  return awaitStarted(env, io, started.json, options, (task) => (task.result as { ref: string }).ref);
}

/** `template create`, `template rebuild` and `template sync`. Templates are built or copied as a task. */
export async function templateCommand(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "create") return templateCreateCommand(rest, env, io);
  if (sub === "rebuild") return templateRebuildCommand(rest, env, io);
  if (sub === "sync") return templateSyncCommand(rest, env, io);
  throw new Error("minibox template needs create, rebuild or sync");
}
