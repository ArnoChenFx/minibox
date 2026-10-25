import type { HostCtx } from "../host/registry";
import { badRequest, conflict, notFound } from "../lib/errors";
import { msg } from "../lib/messages";
import { pushHistory } from "../specs/history";
import { revisionMismatch } from "../specs/revision";
import type { BoxRecovery, BoxSpec } from "../specs/types";
import {
  cloningView,
  startupCommandProblem,
  startupProblemMessage,
  type StartupView,
  viewOf,
} from "../startup/command";
import { type Box, getBox, locked } from "./boxes";
import { beginChange } from "./moving";
import { failureOf, readPane, runNow, startupFailureOf } from "./startup";

/** A box's startup command with its status. `command` is the text as typed, so only a caller that may read it gets it. */
export interface StartupCommandState extends StartupView {
  /** The box revision this state belongs to. A change sent with it is refused once the box has moved on. */
  readonly revision: number;
  readonly command: string | null;
}

export interface SetStartupCommand {
  readonly command: string;
  /** The revision the caller read. A different one is refused, so an older copy cannot overwrite a newer command. */
  readonly expectedRevision?: number;
  /** Runs the new command now when the box is running, rather than at its next start. */
  readonly applyNow?: boolean;
}

/** The command and its status. Reading does not touch the box's idle timer. */
export async function readStartupCommand(host: HostCtx, ref: string): Promise<StartupCommandState> {
  return stateOf(host, await getBox(host, ref));
}

/**
 * Stores a new startup command. It takes effect at the box's next start, and it does not stop a run already going. With
 * `applyNow` on a running box, the command runs again at once.
 */
export async function setStartupCommand(
  host: HostCtx,
  ref: string,
  input: SetStartupCommand,
): Promise<StartupCommandState> {
  const problem = startupCommandProblem(input.command);
  if (problem) throw badRequest(startupProblemMessage(problem), { field: "command" });
  return locked(host, ref, async (box) => {
    const release = beginChange(box.boxId);
    try {
      await writeCommand(host, box.boxId, input.command, input.expectedRevision);
      if (input.applyNow === true && box.running) {
        host.pulse.touch(box.boxId, "exec");
        await runNow(host, box.boxId);
      }
      return await stateOf(host, box);
    } finally {
      release();
    }
  });
}

/** Removes the startup command. A run already going keeps going until the box stops or restarts. */
export async function clearStartupCommand(
  host: HostCtx,
  ref: string,
  expectedRevision?: number,
): Promise<StartupCommandState> {
  return locked(host, ref, async (box) => {
    const release = beginChange(box.boxId);
    try {
      await writeCommand(host, box.boxId, undefined, expectedRevision);
      return await stateOf(host, box);
    } finally {
      release();
    }
  });
}

/** Runs the stored command again now. The box must be running, and the command must be set and not waiting for a clone. */
export async function runStartupCommand(host: HostCtx, ref: string): Promise<StartupCommandState> {
  return locked(host, ref, async (box) => {
    const release = beginChange(box.boxId);
    try {
      const spec = host.specs.read(box.boxId);
      if (spec?.startupCommand === undefined) throw conflict(msg("startup_command_none"));
      if (!box.running) {
        throw conflict(msg("startup_command_box_stopped"), { hint: msg("startup_command_box_stopped_hint") });
      }
      if (spec.startupAwaitsSetup) throw conflict(msg("startup_command_awaits_clone"));
      host.pulse.touch(box.boxId, "exec");
      await runNow(host, box.boxId);
      return await stateOf(host, box);
    } finally {
      release();
    }
  });
}

/**
 * Writes the command and returns whether it changed. Setting the text it already has changes nothing, so the revision
 * stays. A change is one revision, with the earlier revision kept in history, and it clears the failure of the old text.
 */
async function writeCommand(
  host: HostCtx,
  boxId: string,
  command: string | undefined,
  expectedRevision: number | undefined,
): Promise<boolean> {
  return host.specs.exclusive(async () => {
    const spec = host.specs.read(boxId);
    if (!spec) throw notFound(msg("box_not_found"));
    if (expectedRevision !== undefined && spec.revision !== expectedRevision) {
      throw revisionMismatch(spec.revision, expectedRevision);
    }
    if (spec.startupCommand === command) return false;
    const next: BoxSpec = {
      ...spec,
      revision: spec.revision + 1,
      updatedAt: new Date().toISOString(),
      history: pushHistory(spec),
      recovery: withoutReset(spec.recovery),
    };
    delete next.startupFailure;
    if (command === undefined) delete next.startupCommand;
    else next.startupCommand = command;
    host.specs.write(next);
    return true;
  });
}

/** Setting or removing the command answers the reset a recovered box asked for, so the field stops being listed. */
function withoutReset(recovery: BoxRecovery | null): BoxRecovery | null {
  if (!recovery) return null;
  const needsReset = recovery.needsReset.filter((field) => field !== "startupCommand");
  return needsReset.length === 0 ? null : { ...recovery, needsReset };
}

async function stateOf(host: HostCtx, box: Box): Promise<StartupCommandState> {
  const spec = host.specs.read(box.boxId);
  if (!spec) throw notFound(msg("box_not_found"));
  const command = spec.startupCommand ?? null;
  return { revision: spec.revision, command, ...(await viewFor(host, box, command)) };
}

/**
 * The status of a command. A stopped box has no session, so it reads as waiting, or as failed when its last launch
 * failed. A running box is asked for its pane. A failure to read the pane is reported as the status, so a status read
 * does not fail.
 */
async function viewFor(host: HostCtx, box: Box, command: string | null): Promise<StartupView> {
  if (command === null) return viewOf(null, null);
  const spec = host.specs.read(box.boxId);
  if (spec?.startupAwaitsSetup) {
    return host.startup.isSettingUp(box.boxId)
      ? cloningView()
      : viewOf(command, null, msg("startup_command_clone_unfinished"));
  }
  const failure = startupFailureOf(spec, box.id);
  if (!box.running) return viewOf(command, null, failure);
  try {
    return viewOf(command, await readPane(host, box.id), failure);
  } catch (e) {
    return viewOf(command, null, failureOf(e));
  }
}
