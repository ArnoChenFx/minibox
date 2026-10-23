import { flagValue, type CliIo, fail, printJson, request, readStdinText } from "./shared";

interface ParsedFlags {
  readonly positional: string[];
  readonly values: Map<string, string>;
  readonly switches: Set<string>;
}

function parseBoxFlags(argv: string[], valued: string[], switches: string[]): ParsedFlags {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const on = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (switches.includes(token)) on.add(token);
    else if (valued.includes(token)) {
      values.set(token, flagValue(argv, i, token));
      i += 1;
    } else if (token.startsWith("--")) throw new Error(`Unknown option ${token}`);
    else positional.push(token);
  }
  return { positional, values, switches: on };
}

interface StartupCommandState {
  readonly revision: number;
  readonly command: string | null;
  readonly status: string;
  readonly exitCode: number | null;
  readonly log: string[];
  readonly error: { message: string } | null;
}

function startupStatus(state: StartupCommandState): string {
  if (state.status === "exited") return `exited with code ${state.exitCode ?? "unknown"}`;
  if (state.status === "failed") return `failed: ${state.error?.message ?? "unknown error"}`;
  return state.status;
}

/** The command as typed goes to stdout, and the status and the newest output lines to stderr, so a script can read the command. */
function printStartup(io: CliIo, state: StartupCommandState): number {
  if (state.command !== null) io.stdout(state.command.endsWith("\n") ? state.command : `${state.command}\n`);
  io.stderr(`status: ${startupStatus(state)}\n`);
  for (const line of state.log) io.stderr(`${line}\n`);
  return 0;
}

const STARTUP_SUBCOMMANDS = ["get", "set", "rm", "run"];

export async function boxStartupCommand(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || !STARTUP_SUBCOMMANDS.includes(sub)) {
    throw new Error(`minibox box startup-command needs one of ${STARTUP_SUBCOMMANDS.join(", ")}`);
  }
  const flags = parseBoxFlags(rest, ["--command"], ["--stdin", "--apply", "--json"]);
  const [box, ...more] = flags.positional;
  if (!box || more.length > 0) throw new Error(`minibox box startup-command ${sub} needs one box name or id`);
  const changes = flags.values.has("--command") || flags.switches.has("--stdin") || flags.switches.has("--apply");
  if (sub !== "set" && changes)
    throw new Error(`minibox box startup-command ${sub} takes no --command, --stdin or --apply`);
  const path = `/api/boxes/${encodeURIComponent(box)}/startup-command`;
  const asJson = flags.switches.has("--json");
  const finish = (res: { status: number; json: unknown; text: string }) => {
    if (res.status >= 400) return fail(io, res.status, res.json, res.text);
    if (asJson) return printJson(io, res.json);
    return printStartup(io, res.json as StartupCommandState);
  };

  if (sub === "get") return finish(await request(env, "GET", path));
  if (sub === "run") return finish(await request(env, "POST", `${path}/run`));

  const inline = flags.values.get("--command");
  const fromStdin = flags.switches.has("--stdin");
  if (sub === "set" && fromStdin === (inline !== undefined)) {
    throw new Error("minibox box startup-command set needs exactly one of --command TEXT or --stdin");
  }
  const command = fromStdin ? await readStdinText(io) : inline;
  const current = await request(env, "GET", path);
  if (current.status >= 400) return fail(io, current.status, current.json, current.text);
  const ifMatch = { "if-match": String((current.json as StartupCommandState).revision) };
  if (sub === "rm") return finish(await request(env, "DELETE", path, undefined, ifMatch));
  return finish(await request(env, "PUT", path, { command, applyNow: flags.switches.has("--apply") }, ifMatch));
}
