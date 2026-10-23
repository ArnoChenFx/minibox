import { type CliIo, parseOptions, OUTPUT_SWITCHES, request, fail } from "./shared";
import { awaitStarted } from "./task";

async function checkpointCopyCommand(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  const options = parseOptions(argv, ["--host"], OUTPUT_SWITCHES);
  const [id, ...more] = options.positional;
  const host = options.values.get("--host");
  if (!id || more.length > 0 || host === undefined) {
    throw new Error("minibox checkpoint copy needs one checkpoint id and --host ID");
  }
  const started = await request(env, "POST", `/api/checkpoints/${encodeURIComponent(id)}/copy`, { host });
  if (started.status >= 400) return fail(io, started.status, started.json, started.text);
  return awaitStarted(
    env,
    io,
    started.json,
    options,
    (task) => (task.result as { checkpoint: { id: string } }).checkpoint.id,
  );
}

/** `checkpoint copy`. A checkpoint is copied to another host as a task, which prints the id of the copy. */
export async function checkpointCommand(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "copy") return checkpointCopyCommand(rest, env, io);
  throw new Error("minibox checkpoint needs copy");
}
