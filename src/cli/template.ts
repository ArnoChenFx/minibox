import { readFile } from "node:fs/promises";

import { type CliIo, readStdinText, parseOptions, OUTPUT_SWITCHES, printJson, request, fail } from "./shared";
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
  const options = parseOptions(argv, TEMPLATE_CREATE_VALUE_FLAGS, [...OUTPUT_SWITCHES, "--draft"]);
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

  // --draft saves the source and answers at once; nothing is pulled, cloned or built, so there is no task to follow.
  if (options.switches.has("--draft")) {
    const saved = await request(env, "POST", "/api/templates/drafts", body);
    if (saved.status >= 400) return fail(io, saved.status, saved.json, saved.text);
    if (options.switches.has("--json")) return printJson(io, saved.json);
    const template = (saved.json as { template?: { ref?: string } } | null)?.template;
    io.stdout(`${template?.ref ?? ""}\n`);
    io.stderr(`Saved the template draft. It is not built; build it with: minibox template rebuild ${name}\n`);
    return 0;
  }

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

async function templateBuildOfficialCommand(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  const options = parseOptions(argv, ["--host"], OUTPUT_SWITCHES);
  const [name, ...more] = options.positional;
  if (!name || more.length > 0) throw new Error("minibox template build-official needs one official template name");
  const host = options.values.get("--host");
  const query = host === undefined ? "" : `?host=${encodeURIComponent(host)}`;
  const started = await request(env, "POST", `/api/templates/official/${encodeURIComponent(name)}/build${query}`);
  if (started.status >= 400) return fail(io, started.status, started.json, started.text);
  return awaitStarted(
    env,
    io,
    started.json,
    options,
    (task) => (task.result as { template: { ref: string } }).template.ref,
  );
}

/** The options `template edit` takes: every source flag `template create` takes, plus the edit's own. */
const TEMPLATE_EDIT_VALUE_FLAGS = [...TEMPLATE_CREATE_VALUE_FLAGS, "--forward-port", "--post-create"];

/** Source options that only mean something next to a source flag, so `template edit` refuses them on their own. */
const TEMPLATE_EDIT_SOURCE_ONLY_FLAGS = [
  "--branch",
  "--subdir",
  "--dockerfile-path",
  "--devcontainer-path",
  "--secret",
];

async function templateGetCommand(argv: string[], env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  const options = parseOptions(argv, ["--host"], OUTPUT_SWITCHES);
  const [ref, ...more] = options.positional;
  if (!ref || more.length > 0) throw new Error("minibox template get needs one template ref");
  const host = options.values.get("--host");
  const query = host === undefined ? "" : `?host=${encodeURIComponent(host)}`;
  const read = await request(env, "GET", `/api/templates/${encodeURIComponent(ref)}/recipe${query}`);
  if (read.status >= 400) return fail(io, read.status, read.json, read.text);
  if (options.switches.has("--json")) return printJson(io, read.json);
  const recipe = (read.json as { recipe?: { source?: Record<string, string | undefined> } } | null)?.recipe;
  io.stdout(`${recipe?.source?.text ?? recipe?.source?.url ?? ""}\n`);
  return 0;
}

async function templateEditCommand(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  const options = parseOptions(argv, TEMPLATE_EDIT_VALUE_FLAGS, [...OUTPUT_SWITCHES, "--clear-setup"]);
  const [ref, ...more] = options.positional;
  if (!ref || more.length > 0) throw new Error("minibox template edit needs one template ref");
  const chosen = TEMPLATE_SOURCES.filter((source) => options.values.has(source.flag));
  const source = chosen[0];
  if (chosen.length > 1) {
    throw new Error(
      "minibox template edit takes at most one of --dockerfile FILE, --repo URL, --context URL or --devcontainer URL",
    );
  }
  const body: Record<string, unknown> = {};
  if (source) {
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
    body.source = payload;
  } else {
    for (const flag of TEMPLATE_EDIT_SOURCE_ONLY_FLAGS) {
      if (options.values.has(flag)) throw new Error(`${flag} needs one of the source flags`);
    }
  }
  const description = options.values.get("--description");
  if (description !== undefined) body.description = description;
  const ports = options.values.get("--forward-port");
  const command = options.values.get("--post-create");
  // A field the caller names keeps the setup it does not name, which the server merges field by field.
  const init: Record<string, unknown> = {};
  if (ports !== undefined) init.forwardPorts = ports.split(",").map((port) => Number(port.trim()));
  if (command !== undefined) init.postCreate = ["/bin/sh", "-c", command];
  if (Object.keys(init).length > 0) body.init = init;
  if (options.switches.has("--clear-setup")) body.init = null;
  const host = options.values.get("--host");
  if (host !== undefined) body.host = host;
  const query = host === undefined ? "" : `?host=${encodeURIComponent(host)}`;
  const edited = await request(env, "PATCH", `/api/templates/${encodeURIComponent(ref)}${query}`, body);
  if (edited.status >= 400) return fail(io, edited.status, edited.json, edited.text);
  if (options.switches.has("--json")) return printJson(io, edited.json);
  const template = (edited.json as { template?: { ref?: string } } | null)?.template;
  io.stdout(`${template?.ref ?? ""}\n`);
  return 0;
}

async function templateDuplicateCommand(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  const options = parseOptions(argv, ["--description", "--host"], OUTPUT_SWITCHES);
  const [ref, name, ...more] = options.positional;
  if (!ref || !name || more.length > 0)
    throw new Error("minibox template duplicate needs one template ref and one new name");
  const body: Record<string, unknown> = { name };
  const description = options.values.get("--description");
  if (description !== undefined) body.description = description;
  const host = options.values.get("--host");
  if (host !== undefined) body.host = host;
  const query = host === undefined ? "" : `?host=${encodeURIComponent(host)}`;
  const made = await request(env, "POST", `/api/templates/${encodeURIComponent(ref)}/duplicate${query}`, body);
  if (made.status >= 400) return fail(io, made.status, made.json, made.text);
  if (options.switches.has("--json")) return printJson(io, made.json);
  const template = (made.json as { template?: { ref?: string } } | null)?.template;
  io.stdout(`${template?.ref ?? ""}\n`);
  // A copy of a template with a build source is a draft, which has no image until it is built. The draft list says which
  // one it is; a template saved from a box copies an image, and prints no line.
  if (await savedAsDraft(env, name))
    io.stderr(`Duplicated the template as a draft. It is not built; build it with: minibox template rebuild ${name}\n`);
  return 0;
}

/** Whether `name` is a template saved without building it, as the draft list reports it. */
async function savedAsDraft(env: Record<string, string | undefined>, name: string): Promise<boolean> {
  const drafts = await request(env, "GET", "/api/templates/drafts");
  if (drafts.status >= 400) return false;
  const rows = (drafts.json as { templates?: { name?: string }[] } | null)?.templates ?? [];
  return rows.some((row) => row.name === name);
}

/** `template create`, `get`, `edit`, `duplicate`, `rebuild`, `sync` and `build-official`. A build, a rebuild and a copy run as a task; a read, an edit and a duplicate answer at once. */
export async function templateCommand(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "create") return templateCreateCommand(rest, env, io);
  if (sub === "get") return templateGetCommand(rest, env, io);
  if (sub === "edit") return templateEditCommand(rest, env, io);
  if (sub === "duplicate") return templateDuplicateCommand(rest, env, io);
  // The subcommand was renamed with the rest of the template identifiers; the old name says where it went.
  if (sub === "fork") throw new Error("minibox template fork was renamed to minibox template duplicate");
  if (sub === "rebuild") return templateRebuildCommand(rest, env, io);
  if (sub === "sync") return templateSyncCommand(rest, env, io);
  if (sub === "build-official") return templateBuildOfficialCommand(rest, env, io);
  throw new Error("minibox template needs create, get, edit, duplicate, rebuild, sync or build-official");
}
