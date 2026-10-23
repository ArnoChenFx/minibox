import { readFile } from "node:fs/promises";

import { type CliIo, flagValue, request, fail, printJson, readStdinText } from "./shared";

const TOOL_CUSTOM_COMMANDS = ["list", "put", "delete"];

/** `tool custom` manages DATA_DIR/tools.d. The other tool operations are reached over REST and MCP only. */
export async function toolCommand(argv: string[], env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  const [group, sub, ...rest] = argv;
  if (group !== "custom" || sub === undefined || !TOOL_CUSTOM_COMMANDS.includes(sub)) {
    throw new Error(`minibox tool custom needs one of ${TOOL_CUSTOM_COMMANDS.join(", ")}`);
  }
  const positional: string[] = [];
  let asJson = false;
  let file: string | undefined;
  let fromStdin = false;
  let overrideBuiltin = false;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] ?? "";
    if (token === "--json") asJson = true;
    else if (token === "--override-builtin") overrideBuiltin = true;
    else if (token === "--stdin") fromStdin = true;
    else if (token === "--file") {
      file = flagValue(rest, i, token);
      i += 1;
    } else if (token.startsWith("--")) throw new Error(`Unknown option ${token}`);
    else positional.push(token);
  }

  if (sub === "list") {
    if (positional.length > 0 || file !== undefined || fromStdin || overrideBuiltin) {
      throw new Error("minibox tool custom list takes no arguments");
    }
    const res = await request(env, "GET", "/api/tools/custom");
    if (res.status >= 400) return fail(io, res.status, res.json, res.text);
    if (asJson) return printJson(io, res.json);
    const tools = (res.json as { tools?: Record<string, unknown>[] } | null)?.tools ?? [];
    io.stdout("ID  NAME  SOURCE  PACKAGE  BIN  REPLACES BUILT-IN\n");
    for (const tool of tools) {
      io.stdout(
        `${String(tool.id)}  ${String(tool.name)}  ${String(tool.source)}  ${String(tool.package)}  ${String(tool.bin)}  ${String(tool.overridesBuiltin)}\n`,
      );
    }
    return 0;
  }

  const [id, ...more] = positional;
  if (!id || more.length > 0) throw new Error(`minibox tool custom ${sub} needs exactly one id`);
  const path = `/api/tools/custom/${encodeURIComponent(id)}`;

  if (sub === "delete") {
    if (file !== undefined || fromStdin || overrideBuiltin)
      throw new Error("minibox tool custom delete takes only an id");
    const res = await request(env, "DELETE", path);
    if (res.status >= 400) return fail(io, res.status, res.json, res.text);
    if (asJson) return printJson(io, res.json);
    io.stdout(`${id}\n`);
    return 0;
  }

  if (fromStdin === (file !== undefined)) {
    throw new Error("minibox tool custom put needs exactly one of --file or --stdin");
  }
  const text = file !== undefined ? await readFile(file, "utf8") : await readStdinText(io);
  let entry: unknown;
  try {
    entry = JSON.parse(text);
  } catch {
    throw new Error("minibox tool custom put reads one JSON object from --file or stdin");
  }
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error("minibox tool custom put reads one JSON object from --file or stdin");
  }
  const res = await request(env, "PUT", path, {
    ...entry,
    ...(overrideBuiltin ? { overrideBuiltin: true } : {}),
  });
  if (res.status >= 400) return fail(io, res.status, res.json, res.text);
  if (asJson) return printJson(io, res.json);
  io.stdout(`${id}\n`);
  return 0;
}
