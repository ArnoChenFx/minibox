import { type CliIo, fail, numberOption, OUTPUT_SWITCHES, parseOptions, printJson, request } from "./shared";
import { awaitStarted } from "./task";

async function trashLs(argv: string[], env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  const options = parseOptions(argv, [], ["--json"]);
  if (options.positional.length > 0) throw new Error("minibox trash ls takes no arguments");
  const res = await request(env, "GET", "/api/trash");
  if (res.status >= 400) return fail(io, res.status, res.json, res.text);
  if (options.switches.has("--json")) return printJson(io, res.json);
  const entries = (res.json as { trash?: Record<string, unknown>[] } | null)?.trash ?? [];
  io.stdout("ID  NAME  KIND  DELETED  EXPIRES  BYTES\n");
  for (const entry of entries) {
    io.stdout(
      `${String(entry.id)}  ${String(entry.sourceName)}  ${String(entry.kind)}  ${String(entry.deletedAt)}  ${String(entry.expiresAt)}  ${String(entry.bytes)}\n`,
    );
  }
  return 0;
}

async function trashRestoreCommand(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  const options = parseOptions(argv, ["--name", "--cpus", "--memory"], OUTPUT_SWITCHES);
  const [id, ...more] = options.positional;
  if (!id || more.length > 0) throw new Error("minibox trash restore needs one entry id");
  const body = {
    name: options.values.get("--name"),
    cpus: numberOption(options, "--cpus"),
    memoryMb: numberOption(options, "--memory"),
  };
  const started = await request(env, "POST", `/api/trash/${encodeURIComponent(id)}/restore`, body);
  if (started.status >= 400) return fail(io, started.status, started.json, started.text);
  return awaitStarted(env, io, started.json, options, (task) => {
    const restored = task.result as { box: { name: string } | null; volume: { name: string } | null };
    return (restored.box ?? restored.volume)?.name ?? id;
  });
}

async function trashPurgeCommand(argv: string[], env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  const options = parseOptions(argv, [], OUTPUT_SWITCHES);
  const [id, ...more] = options.positional;
  if (!id || more.length > 0) throw new Error("minibox trash purge needs one entry id");
  const started = await request(env, "DELETE", `/api/trash/${encodeURIComponent(id)}`);
  if (started.status >= 400) return fail(io, started.status, started.json, started.text);
  return awaitStarted(env, io, started.json, options, () => id);
}

/** `trash ls`, `trash restore` and `trash purge`: the recycle bin of deleted boxes and volumes. */
export async function trashCommand(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "ls" || sub === "list") return trashLs(rest, env, io);
  if (sub === "restore") return trashRestoreCommand(rest, env, io);
  if (sub === "purge") return trashPurgeCommand(rest, env, io);
  throw new Error("minibox trash needs ls, restore or purge");
}
