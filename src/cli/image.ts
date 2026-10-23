import { type CliIo, parseOptions, OUTPUT_SWITCHES, request, fail } from "./shared";
import { awaitStarted } from "./task";

export async function imageCommand(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== "pull") throw new Error("minibox image needs pull");
  const options = parseOptions(rest, ["--host"], OUTPUT_SWITCHES);
  const [ref, ...more] = options.positional;
  if (!ref || more.length > 0) throw new Error("minibox image pull needs one image reference");
  const host = options.values.get("--host");
  const started = await request(env, "POST", "/api/images/pull", host === undefined ? { ref } : { ref, host });
  if (started.status >= 400) return fail(io, started.status, started.json, started.text);
  return awaitStarted(env, io, started.json, options, (task) => (task.result as { image: { ref: string } }).image.ref);
}
