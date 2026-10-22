import type { HostCtx } from "../host/registry";
import { AppError } from "../lib/errors";
import { log } from "../lib/logger";
import { msg, type Msg } from "../lib/messages";
import { digestOf, encodeCommand, INIT_SESSION, type PaneState, RUNNER_SCRIPT, SWEEP_SCRIPT } from "../startup/command";
import { classifyTmuxFailure, paneLines, paneTarget, sessionTarget } from "../tmux/format";
import { type BoxRun, runInBox, runTmux, unsupportedImage, within } from "./tmux-exec";

/** How long a start waits for its startup command to launch. A launch still running after this is recorded and left to finish. */
export const STARTUP_LAUNCH_BUDGET_MS = 5_000;
/** Rows of history a status reads. This is tmux's default, so the start marker of a long run stays in reach. */
const HISTORY_LINES = 2000;
const WORKDIR = "/workspace";
const PANE_FORMAT = "#{pane_dead} #{pane_dead_status}";
const PANE_STATE_RE = /^([01])(?: (\d+))?$/;

/**
 * Why a box's startup command did not start, by container id. It lasts until the next launch or change of the command, and
 * it is not stored: a control plane that restarts forgets it, and the next start tries again.
 */
export class StartupLaunches {
  private readonly failures = new Map<string, Msg>();

  fail(containerId: string, failure: Msg): void {
    this.failures.set(containerId, failure);
  }

  clear(containerId: string): void {
    this.failures.delete(containerId);
  }

  failureOf(containerId: string): Msg | null {
    return this.failures.get(containerId) ?? null;
  }
}

/**
 * Starts the box's startup command in its init session once the container has started. The runs of an earlier start are
 * ended first, so one command runs at a time. It never throws and never waits longer than the budget, so a box starts
 * whatever the command does; a failure is kept for the status instead.
 */
export async function launchStartup(
  host: HostCtx,
  containerId: string,
  command: string | undefined,
  budgetMs = STARTUP_LAUNCH_BUDGET_MS,
): Promise<void> {
  if (command === undefined) return;
  const outcome = await within(launchOnce(host, containerId, command), budgetMs);
  if (outcome === undefined) {
    host.startup.fail(containerId, msg("startup_command_timeout", { max: budgetMs / 1000 }));
  } else if (outcome === null) {
    host.startup.clear(containerId);
  } else {
    host.startup.fail(containerId, outcome);
  }
}

/**
 * What the init session's pane shows, or null when the box has no such session: no tmux server, or no session of that
 * name. A tmux failure other than that is raised.
 */
export async function readPane(host: HostCtx, containerId: string): Promise<PaneState | null> {
  const probe = await runTmux(host, containerId, [
    "display-message",
    "-p",
    "-t",
    paneTarget(INIT_SESSION),
    PANE_FORMAT,
  ]);
  if (probe.code !== 0) {
    if (isAbsent(probe)) return null;
    throw failedRun(probe);
  }
  const state = PANE_STATE_RE.exec(probe.stdout.trim());
  if (!state) return null;
  const capture = await runTmux(host, containerId, [
    "capture-pane",
    "-p",
    "-J",
    "-S",
    `-${HISTORY_LINES}`,
    "-t",
    paneTarget(INIT_SESSION),
  ]);
  if (capture.code !== 0) {
    if (isAbsent(capture)) return null;
    throw failedRun(capture);
  }
  const dead = state[1] === "1";
  return {
    dead,
    deadStatus: dead && state[2] !== undefined ? Number(state[2]) : null,
    lines: paneLines(capture.stdout),
  };
}

/** The message for a failure that stopped the command from starting or being read. */
export function failureOf(e: unknown): Msg {
  if (e instanceof AppError && e.key === "session_image_unsupported") return msg("session_image_unsupported");
  return msg("startup_command_failed", { detail: e instanceof Error ? firstLine(e.message) : String(e) });
}

async function launchOnce(host: HostCtx, containerId: string, command: string): Promise<Msg | null> {
  try {
    await endRuns(host, containerId);
    const run = await runTmux(host, containerId, launchArgs(command));
    if (run.code === 0) return null;
    if (classifyTmuxFailure(run.code, run.stderr) === "unrunnable") return msg("session_image_unsupported");
    log.warn("startup.launch_failed", { container: containerId, detail: detailOf(run) });
    return msg("startup_command_failed", { detail: detailOf(run) });
  } catch (e) {
    log.warn("startup.launch_failed", { container: containerId, error: e instanceof Error ? e.message : String(e) });
    return failureOf(e);
  }
}

/**
 * Ends the init session and any process an earlier run left behind. The sweep finds those by the variable the runner
 * exports, so a process that detached from the session (for example with `setsid`) is ended too.
 */
async function endRuns(host: HostCtx, containerId: string): Promise<void> {
  await runTmux(host, containerId, ["kill-session", "-t", sessionTarget(INIT_SESSION)]);
  await runInBox(host, containerId, ["sh", "-c", SWEEP_SCRIPT]);
}

/**
 * The init session with the runner as its command, and its pane kept once the run ends. The option is set in the same tmux
 * command, so a run that ends at once cannot close its pane before the option is in place.
 */
function launchArgs(command: string): string[] {
  return [
    "new-session",
    "-d",
    "-s",
    INIT_SESSION,
    "-c",
    WORKDIR,
    "--",
    "sh",
    "-c",
    RUNNER_SCRIPT,
    "minibox-startup",
    encodeCommand(command),
    digestOf(command),
    ";",
    "set-option",
    "-w",
    "-t",
    paneTarget(INIT_SESSION),
    "remain-on-exit",
    "on",
  ];
}

function isAbsent(run: BoxRun): boolean {
  const kind = classifyTmuxFailure(run.code, run.stderr);
  return kind === "not_found" || kind === "no_server";
}

function failedRun(run: BoxRun): AppError {
  if (classifyTmuxFailure(run.code, run.stderr) === "unrunnable") return unsupportedImage();
  return new AppError(502, "docker_error", msg("session_tmux_failed", { detail: detailOf(run) }));
}

function detailOf(run: BoxRun): string {
  return firstLine(run.stderr) || `exit status ${run.code}`;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}
