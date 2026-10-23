import { type CliIo, fail, parseOptions, printJson, request } from "./shared";

/** One volume a delete or a prune reports. A preview row has no status; its `blocked` reason says why it stays. */
interface VolumeRow {
  name: string;
  hostId?: string | null;
  status?: string;
  blocked?: string | null;
  trash?: boolean;
  pool?: string | null;
  bytes?: number | null;
  lastUsedAt?: string | null;
  formerBox?: string | null;
  keepsCopy?: boolean;
  error?: { message?: string } | null;
}

interface HostRow {
  name: string;
  status: string;
  error?: { message?: string } | null;
}

function field(json: unknown, key: string): unknown {
  return (json as Record<string, unknown> | null)?.[key];
}

function rowsOf<T>(json: unknown, key: string): T[] {
  const rows = field(json, key);
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/** The preview a server answers an unconfirmed batch delete with, under `error.details`. */
function previewOf(json: unknown): VolumeRow[] | null {
  const details = (field(json, "error") as { details?: { preview?: { volumes?: VolumeRow[] } } } | null)?.details;
  return Array.isArray(details?.preview?.volumes) ? details.preview.volumes : null;
}

function line(cells: (string | number | null | undefined)[]): string {
  return `${cells.map((cell) => cell ?? "-").join("  ")}\n`.replace(/\s+\n$/, "\n");
}

function willDelete(row: VolumeRow): string {
  if (row.blocked) return `skip (${row.blocked})`;
  return row.trash ? "delete, kept in the recycle bin" : "delete";
}

/** `volume delete <id|name>...`: deletes volumes, each as the API deletes one. Without `--yes`, only the preview prints. */
async function volumeDeleteCommand(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  const options = parseOptions(argv, [], ["--json", "--yes", "--skip-trash"]);
  if (options.positional.length === 0) throw new Error("minibox volume delete needs one or more volume ids or names");
  const confirm = options.switches.has("--yes");
  const res = await request(env, "POST", "/api/volumes/delete", {
    ids: options.positional,
    skipTrash: options.switches.has("--skip-trash"),
    confirm,
  });
  const preview = previewOf(res.json);
  if (res.status === 409 && !confirm && preview) {
    if (options.switches.has("--json")) return printJson(io, res.json);
    io.stdout(line(["NAME", "HOST", "ACTION"]));
    for (const row of preview) io.stdout(line([row.name, row.hostId, willDelete(row)]));
    io.stdout("Nothing was deleted. Add --yes to delete the volumes that are not skipped.\n");
    return 0;
  }
  if (res.status >= 400) return fail(io, res.status, res.json, res.text);
  if (options.switches.has("--json")) printJson(io, res.json);
  else {
    const volumes = rowsOf<VolumeRow>(res.json, "volumes");
    io.stdout(line(["NAME", "HOST", "STATUS", "DETAIL"]));
    for (const row of volumes) io.stdout(line([row.name, row.hostId, row.status, row.error?.message]));
  }
  return rowsOf<VolumeRow>(res.json, "volumes").every((row) => row.status === "removed") ? 0 : 1;
}

/**
 * `volume prune [id|name...]`: lists the volumes MiniBox made that nothing uses. With `--yes` it removes the volumes it
 * listed, by id, so a volume that becomes an orphan in between is not touched; naming volumes limits both steps to them.
 * A volume created or last used in the last five minutes is never listed, and `--older-than` such as `30d` lists only
 * the older ones.
 */
async function volumePruneCommand(argv: string[], env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  const options = parseOptions(argv, ["--older-than"], ["--json", "--yes"]);
  const apply = options.switches.has("--yes");
  const olderThan = options.values.get("--older-than");
  const scope = {
    ...(olderThan === undefined ? {} : { olderThan }),
    ...(options.positional.length > 0 ? { ids: options.positional } : {}),
  };
  let res = await request(env, "POST", "/api/volumes/prune", { dryRun: true, ...scope });
  if (res.status >= 400) return fail(io, res.status, res.json, res.text);
  const listed = rowsOf<VolumeRow & { id: string }>(res.json, "volumes");
  if (apply && listed.length > 0) {
    res = await request(env, "POST", "/api/volumes/prune", {
      dryRun: false,
      ...scope,
      ids: listed.map((row) => row.id),
    });
    if (res.status >= 400) return fail(io, res.status, res.json, res.text);
  }
  if (options.switches.has("--json")) printJson(io, res.json);
  else {
    const volumes = rowsOf<VolumeRow>(res.json, "volumes");
    for (const host of rowsOf<HostRow>(res.json, "hosts")) {
      if (host.status !== "checked") io.stderr(`${host.name}: ${host.error?.message ?? host.status}\n`);
    }
    io.stdout(line(["NAME", "HOST", "POOL", "BYTES", "LAST USED", "FORMER BOX", "STATUS"]));
    for (const row of volumes) {
      io.stdout(
        line([row.name, row.hostId, row.pool, row.bytes, row.lastUsedAt, row.formerBox, row.status ?? "candidate"]),
      );
    }
    if (volumes.length === 0) io.stdout("No orphaned volumes.\n");
    if (!apply) io.stdout("Nothing was removed. Add --yes to remove these volumes.\n");
    if (volumes.some((row) => row.status === "candidate" && row.keepsCopy === false)) {
      io.stdout("Cache volumes keep no copy in the recycle bin: once removed they cannot be restored.\n");
    }
  }
  return rowsOf<VolumeRow>(res.json, "volumes").some((row) => row.status === "refused" || row.status === "failed")
    ? 1
    : 0;
}

/** `volume delete` and `volume prune`: removing volumes, and finding the ones nothing uses. */
export async function volumeCommand(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "delete") return volumeDeleteCommand(rest, env, io);
  if (sub === "prune") return volumePruneCommand(rest, env, io);
  throw new Error("minibox volume needs delete or prune");
}
