import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";

import type { HostCtx } from "../host/registry";
import { AppError, conflict } from "../lib/errors";
import { msg } from "../lib/messages";
import { type ExecSession, type ExecSpec, RuntimeError } from "../runtime";
import { isUnrunnableExec } from "../tmux/format";

const TMUX_TIMEOUT_MS = 10_000;
export const TMUX_ENV = ["TERM=xterm-256color", "LANG=C.UTF-8"];

/** The most output one tmux command is read for. Past it the oldest bytes are dropped, so the newest screen still shows. */
const OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

/** The result of one command run in the box: its status and what it printed. */
export interface BoxRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The box's image cannot run sessions. Rebuilding onto the current base template is the fix, so this is a conflict. */
export function unsupportedImage(): AppError {
  return conflict(msg("session_image_unsupported"), { hint: msg("session_image_unsupported_hint") });
}

/**
 * Starts a command in the box. When the engine refuses to start it because the image lacks the program, the shell or
 * the user, the error says what to do about the image rather than passing the engine's message on.
 */
export async function startInBox(host: HostCtx, containerId: string, spec: ExecSpec): Promise<ExecSession> {
  try {
    return await host.runtime.startExec(containerId, spec);
  } catch (e) {
    if (
      e instanceof RuntimeError &&
      (e.kind === "engine" || e.kind === "invalid") &&
      [e.message, e.detail].some(isUnrunnableExec)
    ) {
      throw unsupportedImage();
    }
    throw e;
  }
}

/** Runs `tmux` in the box as `dev`, collects what it prints, and returns its status. */
export function runTmux(host: HostCtx, containerId: string, args: readonly string[]): Promise<BoxRun> {
  return runInBox(host, containerId, ["tmux", "-u", ...args]);
}

/** Runs a command in the box as `dev` unless another user is named, collects what it prints, and returns its status. */
export async function runInBox(
  host: HostCtx,
  containerId: string,
  cmd: readonly string[],
  user: "dev" | "root" = "dev",
): Promise<BoxRun> {
  const session = await startInBox(host, containerId, {
    cmd: [...cmd],
    env: TMUX_ENV,
    workingDir: "/",
    user,
    tty: false,
  });
  const stdout = collectText(session.stdout);
  const stderr = collectText(session.stderr);
  const closed = await within(
    Promise.all([finished(session.stdout), finished(session.stderr)]).then(
      () => true,
      () => true,
    ),
    TMUX_TIMEOUT_MS,
  );
  if (closed === undefined) {
    await session.kill().catch(() => undefined);
    throw new AppError(502, "docker_error", msg("session_tmux_timeout", { max: TMUX_TIMEOUT_MS / 1000 }));
  }
  return { code: await exitCodeOf(session), stdout: stdout(), stderr: stderr() };
}

/**
 * Collects a command's output as text and keeps only its newest `limit` bytes. The buffer is trimmed once it holds twice
 * that, so the copying stays proportional to the output. A trimmed text starts mid-line, so its first line is dropped. If
 * no line break is left, it starts at the first whole character instead of a cut one.
 */
export function collectText(stream: Readable, limit = OUTPUT_LIMIT_BYTES): () => string {
  let chunks: Buffer[] = [];
  let size = 0;
  let trimmed = false;
  const trim = () => {
    if (size <= limit) return;
    const kept = Buffer.concat(chunks).subarray(size - limit);
    chunks = [kept];
    size = kept.byteLength;
    trimmed = true;
  };
  stream.on("data", (chunk: unknown) => {
    let bytes: Buffer | null = null;
    if (typeof chunk === "string") bytes = Buffer.from(chunk);
    else if (chunk instanceof Uint8Array) bytes = Buffer.from(chunk);
    if (!bytes) return;
    chunks.push(bytes);
    size += bytes.byteLength;
    if (size > 2 * limit) trim();
  });
  stream.on("error", () => undefined);
  return () => {
    trim();
    const bytes = Buffer.concat(chunks);
    if (!trimmed) return bytes.toString("utf8");
    const lineBreak = bytes.indexOf("\n");
    if (lineBreak !== -1) return bytes.subarray(lineBreak + 1).toString("utf8");
    return bytes.subarray(wholeCharacterAt(bytes)).toString("utf8");
  };
}

/** A cut can leave up to three bytes of a split character at the front, since a character is at most four bytes. */
function wholeCharacterAt(bytes: Buffer): number {
  let start = 0;
  while (start < 3 && start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return start;
}

async function exitCodeOf(session: ExecSession): Promise<number> {
  const deadline = Date.now() + TMUX_TIMEOUT_MS;
  for (let delay = 5; ; delay = Math.min(delay * 2, 200)) {
    const status = await session.inspect();
    if (!status.running) return status.exitCode ?? 1;
    if (Date.now() >= deadline) {
      await session.kill().catch(() => undefined);
      throw new AppError(502, "docker_error", msg("session_tmux_timeout", { max: TMUX_TIMEOUT_MS / 1000 }));
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/** Waits for `promise` for at most `ms` milliseconds. Resolves to undefined when the time runs out first. */
export function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}
