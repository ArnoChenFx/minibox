import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import type { HostCtx } from "../host/registry";
import { abortError, sleep } from "../lib/abort";
import { badRequest, conflict } from "../lib/errors";
import { msg } from "../lib/messages";
import type { ExecSession } from "../runtime";
import { getBox } from "./boxes";
import { WORKSPACE } from "./git-clone";
import { exposeBoxPort } from "./ports";
import { startInBox, within } from "./tmux-exec";

/** A postCreateCommand that runs longer than this is stopped. The box is kept. */
const POST_CREATE_TIMEOUT_SEC = 1800;
/** How long a finished command's output may take to reach the log. A background child that keeps a pipe open must not hold the task. */
const OUTPUT_DRAIN_MS = 2000;
/** A partial line longer than this is logged as it is, so a command that prints no newline cannot grow the buffer without bound. */
const LINE_MAX_CHARS = 16 * 1024;
const POLL_MAX_MS = 1000;

/** Adds each port to the box's manual preview list, as `port.expose` does. */
export async function forwardBoxPorts(
  host: HostCtx,
  boxId: string,
  ports: readonly number[],
  previewBaseDomain: string | null,
  log: (text: string) => void,
): Promise<void> {
  for (const port of ports) {
    await exposeBoxPort(host, boxId, port, previewBaseDomain);
    log(`Forwarded port ${port}\n`);
  }
}

/**
 * Runs a postCreateCommand once, as the box user `dev`. It runs in /workspace when the box mounts one, and in / otherwise.
 * Its output reaches the task log a line at a time. It is stopped when the task is cancelled or after
 * POST_CREATE_TIMEOUT_SEC, and a non-zero exit fails the task. The box is kept in every case.
 */
export async function runPostCreate(
  host: HostCtx,
  boxId: string,
  argv: readonly string[],
  log: (text: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const box = await getBox(host, boxId);
  if (!box.running) throw conflict(msg("post_create_box_stopped"));
  const cwd = box.mounts.some((mount) => mount.path === WORKSPACE) ? WORKSPACE : "/";
  log(`Running postCreateCommand in ${cwd}\n`);
  const session = await startInBox(host, box.id, {
    cmd: [...argv],
    env: [],
    workingDir: cwd,
    user: "dev",
    // Matches exec: a strict box may only stop a command as the user that started it.
    stopAs: box.profile === "strict" ? "dev" : "root",
    tty: false,
  });
  const drained = Promise.all([pipeLines(session.stdout, log), pipeLines(session.stderr, log)]).then(
    () => true,
    () => true,
  );
  let code: number | null;
  try {
    code = await waitForExit(session, signal);
  } catch (e) {
    await session.kill().catch(() => undefined);
    throw e;
  }
  if ((await within(drained, OUTPUT_DRAIN_MS)) === undefined) {
    session.stdout.destroy();
    session.stderr.destroy();
  }
  if (code !== 0) throw badRequest(msg("post_create_failed", { code: code ?? "unknown" }));
}

/** Polls until the engine reports the command has ended, and returns its exit code. Cancellation and the time limit throw. */
async function waitForExit(session: ExecSession, signal: AbortSignal): Promise<number | null> {
  const deadline = Date.now() + POST_CREATE_TIMEOUT_SEC * 1000;
  let delay = 20;
  for (;;) {
    const status = await session.inspect();
    if (!status.running) return status.exitCode;
    if (signal.aborted) throw abortError();
    if (Date.now() >= deadline) throw conflict(msg("post_create_timeout", { max: POST_CREATE_TIMEOUT_SEC / 60 }));
    await sleep(delay, signal);
    delay = Math.min(delay * 2, POLL_MAX_MS);
  }
}

/** Passes each complete line of a stream to `write` as it arrives, and the last partial line when the stream ends. */
async function pipeLines(stream: Readable, write: (text: string) => void): Promise<void> {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.write(chunk);
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) write(`${line}\n`);
    if (pending.length > LINE_MAX_CHARS) {
      write(pending);
      pending = "";
    }
  }
  pending += decoder.end();
  if (pending !== "") write(pending);
}
