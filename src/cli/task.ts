import { type CliIo, request, fail, type Options } from "./shared";

interface TaskOutcome {
  id: string;
  status: string;
  output?: string;
  result?: unknown;
  error?: { code?: string; message?: string };
}

const TASK_POLL_MS = 500;

/** The server keeps only the newest tail of a log, so the text already shown is found again by its last characters. */
const LOG_ANCHOR_CHARS = 200;

/** The part of a task's log that is new since `shown`. Text trimmed from the start of the tail is skipped over. */
function unshownLog(shown: string, output: string): string {
  if (output.startsWith(shown)) return output.slice(shown.length);
  const anchor = shown.slice(-LOG_ANCHOR_CHARS);
  const at = anchor === "" ? -1 : output.indexOf(anchor);
  return at === -1 ? output : output.slice(at + anchor.length);
}

/** Polls a task until it ends, and writes its log to stderr as it grows. Undefined when a poll fails, after printing why. */
export async function followTask(
  env: Record<string, string | undefined>,
  io: CliIo,
  taskId: string,
): Promise<TaskOutcome | undefined> {
  let shown = "";
  for (;;) {
    const res = await request(env, "GET", `/api/tasks/${encodeURIComponent(taskId)}`);
    if (res.status >= 400) {
      fail(io, res.status, res.json, res.text);
      return undefined;
    }
    const task = res.json as TaskOutcome;
    const output = task.output ?? "";
    const fresh = unshownLog(shown, output);
    if (fresh !== "") io.stderr(fresh);
    shown = output;
    if (task.status !== "running") return task;
    await new Promise((resolve) => setTimeout(resolve, TASK_POLL_MS));
  }
}

/** Ends a command whose task has finished. Prints the task as JSON with --json, or `line` on success. */
function endTask(io: CliIo, task: TaskOutcome, asJson: boolean, line: (task: TaskOutcome) => string): number {
  if (asJson) io.stdout(`${JSON.stringify(task)}\n`);
  if (task.status !== "succeeded") {
    io.stderr(`${task.error?.message ?? `The task ended as ${task.status}`}\n`);
    return 1;
  }
  if (!asJson) io.stdout(`${line(task)}\n`);
  return 0;
}

/** A command that started a task. With --no-wait it prints the task id; otherwise it follows the task to its end. */
export async function awaitStarted(
  env: Record<string, string | undefined>,
  io: CliIo,
  accepted: unknown,
  options: Options,
  line: (task: TaskOutcome) => string,
): Promise<number> {
  const { taskId } = accepted as { taskId: string };
  const asJson = options.switches.has("--json");
  if (options.switches.has("--no-wait")) {
    io.stdout(asJson ? `${JSON.stringify(accepted)}\n` : `${taskId}\n`);
    return 0;
  }
  const task = await followTask(env, io, taskId);
  return task ? endTask(io, task, asJson, line) : 1;
}
