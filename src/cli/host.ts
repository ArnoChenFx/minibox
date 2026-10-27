import { type CliIo, fail, labelEntries, OUTPUT_SWITCHES, parseOptions, repeatedValues, request } from "./shared";

/** `host labels get <id>` prints the labels the host carries, as JSON, so a script can read them. */
async function hostLabelsGet(argv: string[], env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  const options = parseOptions(argv, [], OUTPUT_SWITCHES);
  const [id, ...more] = options.positional;
  if (!id || more.length > 0) throw new Error("minibox host labels get needs one host id");
  const res = await request(env, "GET", "/api/hosts");
  if (res.status >= 400) return fail(io, res.status, res.json, res.text);
  const hosts = (res.json as { hosts?: { id: string; labels?: Record<string, string> }[] } | null)?.hosts ?? [];
  const host = hosts.find((candidate) => candidate.id === id);
  if (!host) {
    io.stderr(`Host “${id}” was not found.\n`);
    return 1;
  }
  io.stdout(`${JSON.stringify(host.labels ?? {})}\n`);
  return 0;
}

/**
 * `host labels set <id> [--label K=V]...` replaces the labels of one host, the local host included, so an auto create can
 * select it. With no `--label` the host carries none afterwards.
 */
async function hostLabelsSet(argv: string[], env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  const options = parseOptions(argv, ["--label"], OUTPUT_SWITCHES);
  const [id, ...more] = options.positional;
  if (!id || more.length > 0) throw new Error("minibox host labels set needs one host id");
  const labels = labelEntries(repeatedValues(argv, "--label"), "--label");
  const res = await request(env, "PATCH", `/api/hosts/${encodeURIComponent(id)}`, { labels });
  if (res.status >= 400) return fail(io, res.status, res.json, res.text);
  const host = (res.json as { host?: { id: string; labels?: Record<string, string> } } | null)?.host;
  if (options.switches.has("--json")) {
    io.stdout(`${JSON.stringify(res.json)}\n`);
    return 0;
  }
  io.stdout(`${host?.id ?? id} ${JSON.stringify(host?.labels ?? {})}\n`);
  return 0;
}

/** The `host` commands the CLI serves. Reading a host's labels is the owner-only host list filtered to one host. */
export async function hostCommand(argv: string[], env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  const [sub, action, ...rest] = argv;
  if (sub === "labels" && action === "get") return await hostLabelsGet(rest, env, io);
  if (sub === "labels" && action === "set") return await hostLabelsSet(rest, env, io);
  throw new Error("minibox host needs: labels get <id>, or labels set <id> [--label KEY=VALUE]...");
}
