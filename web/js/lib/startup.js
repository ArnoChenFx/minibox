/**
 * Startup-command helpers for the create dialog and the box's startup card. No DOM and no translation: the callers turn
 * keys into text, so the tests load this module directly.
 */

/** The most a startup command may hold, in UTF-8 bytes. Mirrors `STARTUP_COMMAND_MAX_BYTES` in src/startup/command.ts. */
export const STARTUP_COMMAND_MAX_BYTES = 4096;

const CONTROL = /\p{Cc}/u;
const LINE_BREAK_OR_TAB = /[\t\n\r]/g;

/**
 * Why a command cannot be sent, or null when it can. Only spaces count as empty, since such a command would do nothing.
 * Mirrors `startupCommandProblem` in src/startup/command.ts.
 */
export function startupProblem(text) {
  if (text.trim() === "") return "empty";
  if (new TextEncoder().encode(text).length > STARTUP_COMMAND_MAX_BYTES) return "too_long";
  if (CONTROL.test(text.replace(LINE_BREAK_OR_TAB, ""))) return "control";
  return null;
}

/** The error key that says why a command was refused. Its text takes `max`, the byte limit. */
export function startupProblemKey(problem) {
  return `err.startup_command_${problem}`;
}

/** The badge tone and the label key of a status, with the label's parameters. */
export function startupStatusView(state) {
  switch (state.status) {
    case "running":
      return { tone: "badge-success", key: "sc.status.running" };
    case "cloning":
      return { tone: "badge-accent", key: "sc.status.cloning" };
    case "waiting":
      return { tone: "badge-accent", key: "sc.status.waiting" };
    case "exited":
      return {
        tone: state.exitCode === 0 ? "" : "badge-danger",
        key: "sc.status.exited",
        params: { code: state.exitCode ?? "?" },
      };
    case "failed":
      return { tone: "badge-danger", key: "sc.status.failed" };
    default:
      return { tone: "", key: "sc.status.none" };
  }
}

/** Whether a card should read the command again soon: a command is set and its run is going. */
export function isWatching(state, running) {
  return running && state.command !== null && state.status === "running";
}
