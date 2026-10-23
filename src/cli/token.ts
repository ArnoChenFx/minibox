import { type CliIo, fail, numberOption, parseOptions, printJson, request } from "./shared";

/** The preset a token gets when neither `--preset` nor `--scopes` names one. The console recommends it for agents. */
const DEFAULT_PRESET = "sandboxed-agent";

/**
 * `token create` mints an agent token with the owner's key. The secret goes to stdout, once, so a script can capture it,
 * and the summary goes to stderr. Listing and revoking tokens are in the console and the REST API.
 */
export async function tokenCommand(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== "create") throw new Error("minibox token needs create");
  const options = parseOptions(rest, ["--preset", "--scopes", "--expires-in"], ["--json"]);
  const [name, ...more] = options.positional;
  if (!name || more.length > 0) throw new Error("minibox token create needs exactly one name");

  const preset = options.values.get("--preset");
  const scopes = options.values.get("--scopes");
  const body: Record<string, unknown> = { name };
  if (preset !== undefined) body.preset = preset;
  if (scopes !== undefined) body.scopes = scopes.split(",").map((scope) => scope.trim());
  if (preset === undefined && scopes === undefined) body.preset = DEFAULT_PRESET;
  const expiresInSec = numberOption(options, "--expires-in");
  if (expiresInSec !== undefined) body.expiresInSec = expiresInSec;

  const res = await request(env, "POST", "/api/tokens", body);
  if (res.status >= 400) return fail(io, res.status, res.json, res.text);
  if (options.switches.has("--json")) return printJson(io, res.json);
  const { token, record } = res.json as { token: string; record: { id: string; name: string } };
  io.stderr(`Created token ${record.name} (${record.id}). MiniBox shows the secret once, so store it now.\n`);
  io.stdout(`${token}\n`);
  return 0;
}
