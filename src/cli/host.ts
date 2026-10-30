import {
  type CliIo,
  fail,
  labelEntries,
  OUTPUT_SWITCHES,
  parseOptions,
  printJson,
  repeatedValues,
  request,
} from "./shared";

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

/** The preview an unconfirmed force removal is answered with, under `error.details`. */
interface HostForceRemovePreview {
  host: { id: string; name: string };
  counts: { boxes: number; volumes: number; checkpoints: number };
  boxes: { id: string; name: string }[];
  volumes: { name: string; engineName: string }[];
  checkpoints: { id: string; label: string }[];
}

function forceRemovePreview(json: unknown): HostForceRemovePreview | null {
  const preview = (json as { error?: { details?: { preview?: HostForceRemovePreview } } } | null)?.error?.details
    ?.preview;
  return preview && Array.isArray(preview.boxes) ? preview : null;
}

function forceRemoveLine(cells: (string | number)[]): string {
  return `${cells.join("  ")}\n`;
}

/** `1 box`, `2 boxes`: the counts a person reads in the preview and the result. */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * `host force-remove <id>`: discards MiniBox's records of a lost, offline host. Without `--yes` it prints the preview and
 * changes nothing. The machine is never contacted, and nothing on it is deleted, which the preview says in as many words.
 */
async function hostForceRemoveCommand(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  const options = parseOptions(argv, [], ["--json", "--yes"]);
  const [id, ...more] = options.positional;
  if (!id || more.length > 0) throw new Error("minibox host force-remove needs one host id");
  const json = options.switches.has("--json");
  const path = `/api/hosts/${encodeURIComponent(id)}/force-remove`;
  // Without --yes the call is the preview alone: nothing changes, and the machine is never contacted either way.
  if (!options.switches.has("--yes")) {
    const asked = await request(env, "POST", path, { confirm: false });
    const preview = forceRemovePreview(asked.json);
    if (asked.status !== 409 || !preview) return fail(io, asked.status, asked.json, asked.text);
    if (json) return printJson(io, asked.json);
    io.stdout(forceRemoveLine(["KIND", "ID", "NAME"]));
    for (const box of preview.boxes) io.stdout(forceRemoveLine(["box", box.id, box.name]));
    for (const volume of preview.volumes) io.stdout(forceRemoveLine(["volume", volume.engineName, volume.name]));
    for (const checkpoint of preview.checkpoints)
      io.stdout(forceRemoveLine(["checkpoint", checkpoint.id, checkpoint.label]));
    io.stdout(
      `${count(preview.counts.boxes, "box", "boxes")}, ${count(preview.counts.volumes, "volume", "volumes")} and ${count(preview.counts.checkpoints, "checkpoint", "checkpoints")} would be forgotten.\n`,
    );
    io.stdout(
      "Nothing was removed. The machine is not contacted, so its containers are not deleted and become orphans MiniBox no longer manages. Add --yes to discard only these records.\n",
    );
    return 0;
  }
  const res = await request(env, "POST", path, { confirm: true });
  if (res.status >= 400) return fail(io, res.status, res.json, res.text);
  const removed = res.json as { host?: { id: string; name: string }; discarded: HostForceRemovePreview };
  if (json) return printJson(io, res.json);
  const discarded = removed.discarded;
  io.stdout(
    `Removed host ${removed.host?.name ?? id} from MiniBox: ${count(discarded.boxes.length, "box", "boxes")}, ${count(discarded.volumes.length, "volume", "volumes")} and ${count(discarded.checkpoints.length, "checkpoint", "checkpoints")} forgotten.\n`,
  );
  return 0;
}

/** The `host` commands the CLI serves. Reading a host's labels is the owner-only host list filtered to one host. */
export async function hostCommand(argv: string[], env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  const [sub, action, ...rest] = argv;
  if (sub === "labels" && action === "get") return await hostLabelsGet(rest, env, io);
  if (sub === "labels" && action === "set") return await hostLabelsSet(rest, env, io);
  if (sub === "force-remove")
    return await hostForceRemoveCommand(action === undefined ? [] : [action, ...rest], env, io);
  throw new Error(
    "minibox host needs: labels get <id>, labels set <id> [--label KEY=VALUE]..., or force-remove <id> [--yes]",
  );
}
