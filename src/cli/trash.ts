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

interface EmptyRow {
  id: string;
  sourceName: string;
  kind: string;
  hostId?: string;
  bytes: number;
  blocked?: string | null;
  status?: string;
  error?: { message?: string } | null;
}

/** The preview an unconfirmed empty is answered with, under `error.details`. */
function emptyPreview(json: unknown): { count: number; bytes: number; entries: EmptyRow[] } | null {
  const error = (json as { error?: { details?: { preview?: { action?: string } } } } | null)?.error;
  const preview = error?.details?.preview;
  return preview?.action === "empty_trash" ? (preview as { count: number; bytes: number; entries: EmptyRow[] }) : null;
}

function emptyLine(cells: (string | number | null | undefined)[]): string {
  return `${cells.map((cell) => cell ?? "-").join("  ")}\n`.replace(/\s+\n$/, "\n");
}

/**
 * `trash empty`: lists what emptying the recycle bin would purge. With `--yes` it purges exactly the entries it listed,
 * by id, so an entry deleted in between is kept. An entry that is in use is reported and left, and the exit code is 1.
 */
async function trashEmptyCommand(argv: string[], env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  const options = parseOptions(argv, [], ["--json", "--yes"]);
  if (options.positional.length > 0) throw new Error("minibox trash empty takes no arguments");
  const json = options.switches.has("--json");
  const asked = await request(env, "POST", "/api/trash/empty", { confirm: false });
  const preview = emptyPreview(asked.json);
  if (asked.status !== 409 || !preview) return fail(io, asked.status, asked.json, asked.text);
  if (!options.switches.has("--yes")) {
    if (json) return printJson(io, asked.json);
    io.stdout(emptyLine(["ID", "NAME", "KIND", "HOST", "BYTES", "ACTION"]));
    for (const row of preview.entries) {
      io.stdout(
        emptyLine([
          row.id,
          row.sourceName,
          row.kind,
          row.hostId,
          row.bytes,
          row.blocked ? `skip (${row.blocked})` : "purge",
        ]),
      );
    }
    io.stdout(
      preview.entries.length === 0
        ? "The recycle bin is empty.\n"
        : "Nothing was purged. Add --yes to purge these entries for good; they cannot be restored.\n",
    );
    return 0;
  }
  const ids = preview.entries.map((row) => row.id);
  if (ids.length === 0) {
    if (json) return printJson(io, { removed: 0, refused: 0, failed: 0, bytes: 0, entries: [], hosts: [] });
    io.stdout("The recycle bin is empty.\n");
    return 0;
  }
  const res = await request(env, "POST", "/api/trash/empty", { confirm: true, ids });
  if (res.status >= 400) return fail(io, res.status, res.json, res.text);
  const result = res.json as { removed: number; refused: number; failed: number; entries: EmptyRow[] };
  if (json) printJson(io, res.json);
  else {
    io.stdout(emptyLine(["ID", "NAME", "KIND", "HOST", "STATUS", "DETAIL"]));
    for (const row of result.entries) {
      io.stdout(emptyLine([row.id, row.sourceName, row.kind, row.hostId, row.status, row.error?.message]));
    }
    io.stdout(`${result.removed} purged, ${result.refused} left in use, ${result.failed} failed\n`);
  }
  return result.refused + result.failed > 0 ? 1 : 0;
}

/** `trash ls`, `trash restore`, `trash purge` and `trash empty`: the recycle bin of deleted boxes and volumes. */
export async function trashCommand(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "ls" || sub === "list") return trashLs(rest, env, io);
  if (sub === "restore") return trashRestoreCommand(rest, env, io);
  if (sub === "purge") return trashPurgeCommand(rest, env, io);
  if (sub === "empty") return trashEmptyCommand(rest, env, io);
  throw new Error("minibox trash needs ls, restore, purge or empty");
}
