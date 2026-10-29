import { createHash } from "node:crypto";

import { msg, type Msg } from "../lib/messages";

/** The most a startup command may hold, in UTF-8 bytes. */
export const STARTUP_COMMAND_MAX_BYTES = 4096;

/** The tmux session a startup command runs in. Each run replaces it, so the pane of an earlier run is gone by then. */
export const INIT_SESSION = "minibox-init";

/** Lines of the pane a status reports, the newest ones, and the longest line kept. */
export const LOG_TAIL_LINES = 40;
const LOG_LINE_MAX = 500;

/** Control characters. Tab, line feed and carriage return are allowed, since a command may span lines. */
const CONTROL_RE = /\p{Cc}/u;
const LINE_BREAK_OR_TAB_RE = /[\t\n\r]/g;

export type StartupCommandProblem = "empty" | "too_long" | "control";

/**
 * Why a command cannot be stored, or null when it can. The text is kept as typed, so the surrounding space is allowed; a
 * command that is only space is refused, since running it would do nothing.
 */
export function startupCommandProblem(command: string): StartupCommandProblem | null {
  if (command.trim() === "") return "empty";
  if (Buffer.byteLength(command, "utf8") > STARTUP_COMMAND_MAX_BYTES) return "too_long";
  if (CONTROL_RE.test(command.replace(LINE_BREAK_OR_TAB_RE, ""))) return "control";
  return null;
}

export function startupProblemMessage(problem: StartupCommandProblem): Msg {
  switch (problem) {
    case "empty":
      return msg("startup_command_empty");
    case "too_long":
      return msg("startup_command_too_long", { max: STARTUP_COMMAND_MAX_BYTES });
    case "control":
      return msg("startup_command_control");
  }
}

/** A short, stable fingerprint of a command's text. The runner prints it, so a status can tell which text a run used. */
export function digestOf(command: string): string {
  return createHash("sha256").update(command, "utf8").digest("hex").slice(0, 12);
}

/**
 * The command as base64. tmux reads a `;` that ends a command argument as a command separator, so the text travels
 * encoded and the box decodes it. The stored command is still the text as typed.
 */
export function encodeCommand(command: string): string {
  return Buffer.from(command, "utf8").toString("base64");
}

/**
 * The script the init session runs, as the box user. `$1` is the encoded command and `$2` its digest. It prints a start
 * marker, runs the command with `bash -lc` in the session's directory, prints an exit marker, and exits with the
 * command's status. The session keeps its pane after the exit, so the output and the status can still be read.
 */
export const RUNNER_SCRIPT = [
  'export MINIBOX_STARTUP_RUN="$2"',
  'printf \'[minibox] startup command started at %s (digest %s)\\n\' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$2"',
  "cmd=$(printf '%s' \"$1\" | base64 -d; printf x)",
  "cmd=${cmd%x}",
  'if command -v bash >/dev/null 2>&1; then bash -lc "$cmd"; else sh -lc "$cmd"; fi',
  "code=$?",
  'printf \'[minibox] startup command exited with code %s at %s\\n\' "$code" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
  'exit "$code"',
].join("\n");

/**
 * Ends the processes of earlier runs. Every process a run starts carries `MINIBOX_STARTUP_RUN` in its environment, so
 * this finds them even after they left the init session, for example when they detached with `setsid`. They get
 * SIGTERM, a second to stop, then SIGKILL.
 */
export const SWEEP_SCRIPT = [
  'pids=""',
  "for environ in /proc/[0-9]*/environ; do",
  "  if tr '\\0' '\\n' < \"$environ\" | grep -q '^MINIBOX_STARTUP_RUN='; then",
  "    pid=${environ#/proc/}",
  '    pids="$pids ${pid%/environ}"',
  "  fi",
  "done 2>/dev/null",
  '[ -n "$pids" ] || exit 0',
  "kill -TERM $pids 2>/dev/null",
  "sleep 1",
  'for pid in $pids; do [ -d "/proc/$pid" ] && kill -KILL "$pid" 2>/dev/null; done',
  "exit 0",
].join("\n");

/**
 * Ends the processes of a run from the pid of its pane, `$1`. That pid is the id of the run's session and process group,
 * and a process the run starts keeps them, so the sweep reaches the run even after its shell has exited. A process whose
 * parent is a member joins too. That reaches a process `sudo` started, since `sudo` runs its command under a monitor that
 * stays in the run's session. Each pass follows parents again until none is new. A live pid is used only when its command
 * line names the runner, so a pid the kernel gave to something else is left alone. Members get SIGTERM, a second to stop,
 * then SIGKILL. The caller runs it as the user that may signal the run's processes.
 */
export const TREE_SWEEP_SCRIPT = [
  "anchor=$1",
  "case \"$anchor\" in '' | *[!0-9]*) exit 0 ;; esac",
  "self=$$",
  'members=" "',
  'groups=" $anchor "',
  "grew=0",
  "load() {",
  '  read -r line 2>/dev/null < "/proc/$1/stat" || return 1',
  "  rest=${line##*) }",
  "  set -- $rest",
  "  st_state=$1 st_ppid=$2 st_pgid=$3 st_sid=$4 st_start=${20}",
  "}",
  "known() {",
  '  case $members in *" $1:"*) return 0 ;; esac',
  "  return 1",
  "}",
  "take() {",
  '  members="$members$1:$st_start "',
  "  grew=1",
  "}",
  "scan() {",
  "  for d in /proc/[0-9]*; do",
  "    q=${d#/proc/}",
  '    [ "$q" -gt 1 ] && [ "$q" != "$self" ] || continue',
  '    known "$q" && continue',
  '    load "$q" || continue',
  "    case $st_state in Z | X) continue ;; esac",
  "    joined=0",
  '    case $groups in *" $st_sid "* | *" $st_pgid "*) joined=1 ;; esac',
  '    known "$st_ppid" && joined=1',
  '    [ "$joined" = 1 ] || continue',
  '    take "$q"',
  '    if [ "$st_sid" = "$q" ] || [ "$st_pgid" = "$q" ]; then groups="$groups$q "; fi',
  "  done",
  "}",
  "expand() {",
  "  while :; do",
  "    grew=0",
  "    scan",
  '    [ "$grew" = 1 ] || break',
  "  done",
  "}",
  "signal() {",
  "  for tok in $members; do",
  "    q=${tok%%:*}",
  '    load "$q" || continue',
  '    [ "$st_start" = "${tok#*:}" ] || continue',
  "    case $st_state in Z | X) continue ;; esac",
  '    kill -"$1" "$q" 2>/dev/null',
  "  done",
  "}",
  'if load "$anchor" && [ "$st_state" != Z ] && [ "$st_state" != X ]; then',
  '  case $(cat "/proc/$anchor/cmdline" 2>/dev/null) in *minibox-startup*) ;; *) exit 0 ;; esac',
  "fi",
  "expand",
  '[ "$members" = " " ] && exit 0',
  "signal TERM",
  "sleep 1",
  "for _ in 1 2 3; do",
  "  expand",
  "  signal KILL",
  "done",
  "exit 0",
].join("\n");

const STARTED_RE = /^\[minibox\] startup command started at (\S+) \(digest ([0-9a-f]{12})\)$/;
const EXITED_RE = /^\[minibox\] startup command exited with code (\d+) at (\S+)$/;
/** The line tmux writes into a pane whose process has exited, which is not part of the output. */
const DEAD_PANE_RE = /^Pane is dead \(/;

/** What the runner's markers say about the latest run in a pane. */
export interface RunMarkers {
  readonly startedAt: string | null;
  readonly digest: string | null;
  readonly exitCode: number | null;
  readonly exitedAt: string | null;
}

/** The markers of the latest run. An exit marker counts only when it follows that run's start marker. */
export function markersOf(lines: readonly string[]): RunMarkers {
  let started = -1;
  for (let i = lines.length - 1; i >= 0 && started === -1; i--) {
    if (STARTED_RE.test(lines[i] ?? "")) started = i;
  }
  let exited: RegExpExecArray | null = null;
  for (let i = lines.length - 1; i > started; i--) {
    exited = EXITED_RE.exec(lines[i] ?? "");
    if (exited) break;
  }
  const start = started === -1 ? null : STARTED_RE.exec(lines[started] ?? "");
  return {
    startedAt: start?.[1] ?? null,
    digest: start?.[2] ?? null,
    exitCode: exited ? Number(exited[1]) : null,
    exitedAt: exited?.[2] ?? null,
  };
}

/** The newest output lines a status shows. The dead-pane line tmux adds is left out, and a long line is cut short. */
export function logTail(lines: readonly string[]): string[] {
  return lines
    .filter((line) => !DEAD_PANE_RE.test(line))
    .slice(-LOG_TAIL_LINES)
    .map((line) => {
      const characters = [...line];
      return characters.length > LOG_LINE_MAX ? `${characters.slice(0, LOG_LINE_MAX).join("")}…` : line;
    });
}

/** What the init session's pane shows. `null` in place of a pane means the session does not exist. */
export interface PaneState {
  readonly dead: boolean;
  /** The status tmux kept for the pane, which is the runner's exit status. Null while the pane runs. */
  readonly deadStatus: number | null;
  readonly lines: readonly string[];
}

/**
 * `none`: no command is set. `cloning`: the box's setup has not ended, and the command starts when it has.
 * `waiting`: a command is set and has not run in this box's current start. `running`: its pane is alive. `exited`: the
 * run ended, with its code. `failed`: MiniBox could not start the command.
 */
type StartupStatus = "none" | "cloning" | "waiting" | "running" | "exited" | "failed";

export interface StartupView {
  readonly status: StartupStatus;
  readonly exitCode: number | null;
  readonly startedAt: string | null;
  readonly exitedAt: string | null;
  /** True when the latest run used an earlier text of the command, so a run now would use the current one. */
  readonly stale: boolean;
  readonly log: string[];
  /** Why MiniBox could not start the command, when no run is visible. */
  readonly error: Msg | null;
}

const EMPTY_VIEW: StartupView = {
  status: "none",
  exitCode: null,
  startedAt: null,
  exitedAt: null,
  stale: false,
  log: [],
  error: null,
};

/** The view of a command whose box is still setting up: its clone and its postCreateCommand. Nothing runs until that ends. */
export function cloningView(): StartupView {
  return { ...EMPTY_VIEW, status: "cloning" };
}

/**
 * The status a caller sees. `pane` is null when the init session does not exist. `failure` is the reason the last launch
 * could not start, if it could not, and it is reported only while no run is visible.
 */
export function viewOf(command: string | null, pane: PaneState | null, failure: Msg | null = null): StartupView {
  if (command === null) return EMPTY_VIEW;
  if (pane === null) {
    return failure === null
      ? { ...EMPTY_VIEW, status: "waiting" }
      : { ...EMPTY_VIEW, status: "failed", error: failure };
  }
  const markers = markersOf(pane.lines);
  const stale = markers.digest !== null && markers.digest !== digestOf(command);
  const log = logTail(pane.lines);
  if (!pane.dead) {
    return { ...EMPTY_VIEW, status: "running", startedAt: markers.startedAt, stale, log };
  }
  return {
    ...EMPTY_VIEW,
    status: "exited",
    exitCode: markers.exitCode ?? pane.deadStatus,
    startedAt: markers.startedAt,
    exitedAt: markers.exitedAt,
    stale,
    log,
  };
}
