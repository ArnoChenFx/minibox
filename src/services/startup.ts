import type { HostCtx } from "../host/registry";
import { AppError } from "../lib/errors";
import { log } from "../lib/logger";
import { msg, type Msg } from "../lib/messages";
import type { BoxSpec, StartupFailure } from "../specs/types";
import { digestOf, encodeCommand, INIT_SESSION, type PaneState, RUNNER_SCRIPT, SWEEP_SCRIPT } from "../startup/command";
import { classifyTmuxFailure, paneLines, paneTarget, sessionTarget } from "../tmux/format";
import { type BoxRun, runInBox, runTmux, unsupportedImage, within } from "./tmux-exec";

/** How long a request that runs a launch itself waits for it. A launch still running after this finishes in the background. */
export const STARTUP_LAUNCH_BUDGET_MS = 5_000;
/** Rows of history a status reads. This is tmux's default, so the start marker of a long run stays in reach. */
const HISTORY_LINES = 2000;
const WORKDIR = "/workspace";
const PANE_FORMAT = "#{pane_dead} #{pane_dead_status}";
const PANE_STATE_RE = /^([01])(?: (\d+))?$/;

/**
 * The launches of one host that have not ended. Each box's launches run one after another, so a launch never overlaps the
 * one before it, and a launch that outlives its request keeps the box's later launches waiting. `settle` waits for all of
 * them. A clone is tracked in memory only, since a clone cannot outlive the process that runs it.
 */
export class StartupLaunches {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly cloning = new Set<string>();

  track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    work.finally(() => this.pending.delete(work)).catch(() => undefined);
    return work;
  }

  /** Runs `body` once the box's earlier launch has ended. The result is the body's, and it rejects if the body does. */
  launch(boxId: string, body: () => Promise<void>): Promise<void> {
    const earlier = this.chains.get(boxId) ?? Promise.resolve();
    const run = this.track(earlier.then(body));
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(boxId, tail);
    void tail.then(() => {
      if (this.chains.get(boxId) === tail) this.chains.delete(boxId);
    });
    return run;
  }

  /** Resolves once no launch is left, including those that launches started in turn. */
  async settle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled(this.pending);
  }

  beginClone(boxId: string): void {
    this.cloning.add(boxId);
  }

  endClone(boxId: string): void {
    this.cloning.delete(boxId);
  }

  isCloning(boxId: string): boolean {
    return this.cloning.has(boxId);
  }
}

/** Whether a box has a launch to make: a command, or a clone its command waits for. */
export function hasStartup(spec: BoxSpec): boolean {
  return spec.startupCommand !== undefined || spec.startupAwaitsClone === true;
}

/**
 * Starts a box's command in the background, once the box's power lock is free, and returns at once. A create, a clone that
 * ends, an engine start and a reconcile use it, so none of them waits for the command. A failure is recorded on the box.
 */
export function scheduleStartup(host: HostCtx, boxId: string): void {
  host.startup.track(host.power.run(boxId, () => ensureStartup(host, boxId)));
}

/**
 * Starts a box's command and waits for the launch at most `budgetMs`. A start or a restart calls it while it holds the box's
 * power lock, so it does not take the lock itself. A launch still going at the budget finishes in the background.
 */
export async function startupNow(host: HostCtx, boxId: string, budgetMs = STARTUP_LAUNCH_BUDGET_MS): Promise<void> {
  await within(host.startup.track(ensureStartup(host, boxId)), budgetMs);
}

/**
 * Runs the command of a running box unless its init session already exists. A launch makes the session, and only a new run
 * or the container stopping ends it, so a second start of the same container finds it and does nothing. Docker can start a
 * container without MiniBox, which this covers too.
 */
async function ensureStartup(host: HostCtx, boxId: string): Promise<void> {
  try {
    const spec = host.specs.read(boxId);
    if (!spec || spec.lifecycle.desired !== "running") return;
    if (spec.startupAwaitsClone) {
      await awaitClone(host, boxId);
      return;
    }
    if (spec.startupCommand === undefined) return;
    await host.startup.launch(boxId, () => launchIfMissing(host, boxId));
  } catch (e) {
    log.warn("startup.ensure_failed", { id: boxId, error: e instanceof Error ? e.message : String(e) });
  }
}

async function launchIfMissing(host: HostCtx, boxId: string): Promise<void> {
  const spec = host.specs.read(boxId);
  if (!spec || spec.lifecycle.desired !== "running" || spec.startupCommand === undefined) return;
  if (spec.startupAwaitsClone) return;
  if (!(await isRunning(host, spec.containerId))) return;
  try {
    if (await hasSession(host, spec.containerId)) return;
  } catch (e) {
    await recordLaunch(host, boxId, spec.containerId, failureOf(e));
    return;
  }
  await relaunch(host, boxId, spec.containerId, spec.startupCommand);
}

/**
 * A box whose clone has not ended waits for it. A clone that is still marked on the spec, with no clone running in this
 * process, was cut short by a restart, so the status says so and the command does not start by itself.
 */
async function awaitClone(host: HostCtx, boxId: string): Promise<void> {
  if (host.startup.isCloning(boxId)) return;
  await host.specs.exclusive(async () => {
    const spec = host.specs.read(boxId);
    if (!spec?.startupAwaitsClone || host.startup.isCloning(boxId)) return;
    const next: BoxSpec = {
      ...spec,
      startupFailure: failureRecord(spec.containerId, msg("startup_command_clone_unfinished")),
    };
    delete next.startupAwaitsClone;
    host.specs.write(next);
  });
}

/**
 * Ends a box's clone and releases its command. A clone that worked starts the command, now when the box runs. A clone that
 * failed keeps its reason for the status, and the command waits for the box's next start.
 */
export async function finishClone(host: HostCtx, boxId: string, failure: Msg | null): Promise<void> {
  const awaited = await host.specs.exclusive(async () => {
    host.startup.endClone(boxId);
    const spec = host.specs.read(boxId);
    if (!spec?.startupAwaitsClone) return false;
    const next: BoxSpec = { ...spec };
    delete next.startupAwaitsClone;
    delete next.startupFailure;
    if (failure !== null) next.startupFailure = failureRecord(spec.containerId, failure);
    host.specs.write(next);
    return true;
  });
  if (awaited && failure === null) scheduleStartup(host, boxId);
}

/**
 * Runs the box's command now, ending the run before it, even when a run is already going. The caller holds the box's power
 * lock. The wait is bounded by the budget: a launch still going then finishes in the background, and its outcome is still
 * recorded.
 */
export async function runNow(host: HostCtx, boxId: string, budgetMs = STARTUP_LAUNCH_BUDGET_MS): Promise<void> {
  const spec = host.specs.read(boxId);
  if (spec?.startupCommand === undefined || spec.startupAwaitsClone) return;
  await within(
    host.startup.launch(boxId, async () => {
      const current = host.specs.read(boxId);
      if (current?.startupCommand === undefined) return;
      await relaunch(host, boxId, current.containerId, current.startupCommand);
    }),
    budgetMs,
  );
}

/** The failure a status reports for a container: the one recorded for that container, or none. */
export function startupFailureOf(spec: BoxSpec | null, containerId: string): Msg | null {
  const failure = spec?.startupFailure;
  if (failure?.containerId !== containerId) return null;
  return msg(failure.key, failure.params);
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

/**
 * Starts the command in a new init session and records the outcome on the spec, so a restarted server still says why it did
 * not start. It never rejects.
 */
async function relaunch(host: HostCtx, boxId: string, containerId: string, command: string): Promise<void> {
  try {
    const failure = await launchOnce(host, containerId, command);
    await recordLaunch(host, boxId, containerId, failure);
  } catch (e) {
    log.warn("startup.record_failed", { id: boxId, container: containerId, error: String(e) });
  }
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

/** Ends the run before a new one: its init session goes, and then the processes that carry the runner's variable. */
async function endRuns(host: HostCtx, containerId: string): Promise<void> {
  await runTmux(host, containerId, ["kill-session", "-t", sessionTarget(INIT_SESSION)]);
  await runInBox(host, containerId, ["sh", "-c", SWEEP_SCRIPT]);
}

async function hasSession(host: HostCtx, containerId: string): Promise<boolean> {
  const probe = await runTmux(host, containerId, ["has-session", "-t", sessionTarget(INIT_SESSION)]);
  return probe.code === 0;
}

async function isRunning(host: HostCtx, containerId: string): Promise<boolean> {
  try {
    return (await host.runtime.inspectContainer(containerId)).running;
  } catch {
    return false;
  }
}

async function recordLaunch(host: HostCtx, boxId: string, containerId: string, failure: Msg | null): Promise<void> {
  await host.specs.exclusive(async () => {
    const spec = host.specs.read(boxId);
    if (!spec || spec.containerId !== containerId) return;
    if (failure === null && spec.startupFailure === undefined) return;
    const next: BoxSpec = { ...spec };
    delete next.startupFailure;
    if (failure !== null) next.startupFailure = failureRecord(containerId, failure);
    host.specs.write(next);
  });
}

function failureRecord(containerId: string, failure: Msg): StartupFailure {
  return {
    containerId,
    key: failure.key,
    ...(failure.params === undefined ? {} : { params: failure.params }),
    at: new Date().toISOString(),
  };
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
