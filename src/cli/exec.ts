import { type CliIo, flagValue, request, fail } from "./shared";

interface ExecResult {
  execId?: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
  timedOut?: boolean;
  outputRef?: string | null;
  background?: boolean;
  status?: string;
}

function printExec(io: CliIo, result: ExecResult): number {
  if (result.stdout) io.stdout(result.stdout);
  if (result.stderr) io.stderr(result.stderr);
  if (result.truncated && result.outputRef) {
    io.stderr(`output truncated; outputRef ${result.outputRef}\n`);
  }
  if (result.timedOut && result.status === "running") {
    io.stderr(
      `the command timed out and could not be stopped. exec ${result.execId ?? ""} is still running; POST /api/execs/${result.execId ?? ""}/kill retries.\n`,
    );
  }
  if (result.timedOut) return 124;
  if (typeof result.exitCode === "number") return result.exitCode;
  return result.status === "running" ? 0 : 1;
}

export async function execCommand(argv: string[], env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  const box = argv[0];
  if (!box || box.startsWith("--")) throw new Error("minibox exec needs a box name or id");
  const body: Record<string, unknown> = {};
  const args: string[] = [];
  let background = false;
  let waitMs: number | undefined;
  let dash = false;
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (!dash && token === "--") {
      dash = true;
      continue;
    }
    if (!dash && token.startsWith("--")) {
      if (token === "--background") {
        background = true;
        continue;
      }
      if (token === "--cwd") body.cwd = flagValue(argv, i, token);
      else if (token === "--user") body.user = flagValue(argv, i, token);
      else if (token === "--timeout") body.timeoutSec = Number(flagValue(argv, i, token));
      else if (token === "--stdin") body.stdin = flagValue(argv, i, token);
      else if (token === "--wait") waitMs = Number(flagValue(argv, i, token));
      else if (token === "--env") {
        const pair = flagValue(argv, i, token);
        const eq = pair.indexOf("=");
        if (eq <= 0) throw new Error("--env needs K=V");
        const envMap = (body.env as Record<string, string> | undefined) ?? {};
        envMap[pair.slice(0, eq)] = pair.slice(eq + 1);
        body.env = envMap;
      } else {
        throw new Error(`Unknown option ${token}`);
      }
      i += 1;
      continue;
    }
    args.push(token);
  }
  if (args.length === 0) throw new Error("minibox exec needs a command after --");
  body.argv = args;
  if (background || waitMs !== undefined) body.background = true;
  const started = await request(env, "POST", `/api/boxes/${encodeURIComponent(box)}/exec`, body);
  if (started.status >= 400) return fail(io, started.status, started.json, started.text);
  const result = started.json as ExecResult;
  if (body.background === true && waitMs === undefined) {
    io.stdout(`${result.execId ?? ""}\n`);
    return 0;
  }
  if (waitMs !== undefined && result.execId) {
    const polled = await request(env, "GET", `/api/execs/${encodeURIComponent(result.execId)}?waitMs=${waitMs}`);
    if (polled.status >= 400) return fail(io, polled.status, polled.json, polled.text);
    const follow = polled.json as ExecResult;
    if (follow.status === "running") {
      io.stdout(`${follow.execId ?? result.execId}\n`);
      return 0;
    }
    return printExec(io, follow);
  }
  return printExec(io, result);
}
