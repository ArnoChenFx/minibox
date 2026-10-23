import { type CliIo, flagValue, request, fail, printJson } from "./shared";

interface SessionRead {
  lines?: string[];
  cursor?: string;
  reset?: boolean;
  truncated?: boolean;
}

const SESSION_VALUE_FLAGS = ["--lines", "--since", "--text", "--key"];

const SESSION_COMMANDS = ["ls", "start", "read", "send", "close"];

export async function sessionCommand(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || !SESSION_COMMANDS.includes(sub)) {
    throw new Error(`minibox session needs one of ${SESSION_COMMANDS.join(", ")}`);
  }
  const positional: string[] = [];
  const values = new Map<string, string[]>();
  let asJson = false;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] ?? "";
    if (token === "--json") asJson = true;
    else if (SESSION_VALUE_FLAGS.includes(token)) {
      values.set(token, [...(values.get(token) ?? []), flagValue(rest, i, token)]);
      i += 1;
    } else if (token.startsWith("--")) throw new Error(`Unknown option ${token}`);
    else positional.push(token);
  }
  const [box, name] = positional;
  if (!box) throw new Error(`minibox session ${sub} needs a box name or id`);
  const sessions = `/api/boxes/${encodeURIComponent(box)}/sessions`;
  if (sub === "ls") {
    const res = await request(env, "GET", sessions);
    if (res.status >= 400) return fail(io, res.status, res.json, res.text);
    if (asJson) return printJson(io, res.json);
    const listed = (res.json as { sessions?: Record<string, unknown>[] } | null)?.sessions ?? [];
    io.stdout("NAME  ORIGIN  CONTROLLER  ATTACHED  CREATED\n");
    for (const item of listed) {
      io.stdout(
        `${String(item.name)}  ${String(item.origin)}  ${String(item.controller)}  ${String(item.attached)}  ${String(item.createdAt)}\n`,
      );
    }
    return 0;
  }
  if (name === undefined) throw new Error(`minibox session ${sub} needs a session name`);
  const path = `${sessions}/${encodeURIComponent(name)}`;
  if (sub === "start") {
    const res = await request(env, "POST", sessions, { name });
    if (res.status >= 400) return fail(io, res.status, res.json, res.text);
    if (asJson) return printJson(io, res.json);
    io.stdout(`${name}\n`);
    return 0;
  }
  if (sub === "read") {
    const query = new URLSearchParams();
    const lines = values.get("--lines")?.at(-1);
    const since = values.get("--since")?.at(-1);
    if (lines !== undefined) query.set("lines", lines);
    if (since !== undefined) query.set("since", since);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const res = await request(env, "GET", `${path}${suffix}`);
    if (res.status >= 400) return fail(io, res.status, res.json, res.text);
    if (asJson) return printJson(io, res.json);
    const read = res.json as SessionRead;
    const rows = read.lines ?? [];
    if (rows.length > 0) io.stdout(`${rows.join("\n")}\n`);
    io.stderr(`cursor ${read.cursor ?? ""}${read.reset ? " (reset)" : ""}\n`);
    return 0;
  }
  if (sub === "send") {
    const texts = values.get("--text") ?? [];
    const keys = values.get("--key") ?? [];
    if (texts.length > 1 || texts.length > 0 === keys.length > 0) {
      throw new Error("minibox session send needs one --text TEXT, or one or more --key KEY, but not both");
    }
    const body = texts.length === 1 ? { text: texts[0] } : { keys };
    const res = await request(env, "POST", `${path}/input`, body);
    if (res.status >= 400) return fail(io, res.status, res.json, res.text);
    return 0;
  }
  const res = await request(env, "DELETE", path);
  if (res.status >= 400) return fail(io, res.status, res.json, res.text);
  io.stdout(`${name}\n`);
  return 0;
}
