/**
 * Pure helpers for driving tmux through its command line: names, targets, formats, and parsed output.
 * Nothing here runs a process; the terminal service passes these values to the runtime.
 */

/** Names are restricted before they reach tmux, which rewrites `:` and `.` and treats `=` as a prefix. */
export const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/** tmux user option that records who created a session: `agent` for the API, `human` for the console. */
export const ORIGIN_OPTION = "@minibox-origin";

export type SessionOrigin = "agent" | "human";

/**
 * What tmux says identifies one session: its name, its id (such as `$3`) and its creation time. The id and the creation
 * time change when a session is killed and made again, even under the same name, so they tell a new session from the one
 * MiniBox tracked. The origin is read once, when the session is first seen.
 */
export interface SessionIdentity {
  readonly name: string;
  readonly id: string;
  /** Milliseconds since the epoch. */
  readonly createdAt: number;
  /** Sessions without the mark were not created by MiniBox, so they are treated as agent-driven. */
  readonly origin: SessionOrigin;
}

export interface TmuxSession extends SessionIdentity {
  readonly attached: number;
}

export function isSessionName(value: string): boolean {
  return SESSION_NAME_RE.test(value);
}

const SESSION_ID_RE = /^\$\d{1,9}$/;

/** The origin option is written inside the box too, so any text it holds that is not `human` reads as agent-driven. */
function originOf(value: string): SessionOrigin {
  return value === "human" ? "human" : "agent";
}

function millisecondsOf(seconds: string): number {
  return (Number(seconds) || 0) * 1000;
}

/** Session-level commands (`has-session`, `kill-session`, `attach-session`). */
export function sessionTarget(name: string): string {
  return `=${name}`;
}

/** Pane-level commands (`send-keys`, `capture-pane`, `set-option`). The trailing colon selects the current window and pane. */
export function paneTarget(name: string): string {
  return `=${name}:`;
}

/**
 * The fields of each session in `list-sessions`, tab-separated. The origin option comes last: an agent can set it to any
 * text, so a tab inside it must not move the fields before it.
 */
export const LIST_SESSIONS_FORMAT = [
  "#{session_name}",
  "#{session_id}",
  "#{session_created}",
  "#{session_attached}",
  `#{${ORIGIN_OPTION}}`,
].join("\t");

/**
 * The identity of one session, read in a single `display-message`. tmux exits 0 and prints nothing when the target does
 * not exist, so the name in the output is what says whether the session is there.
 */
export const PROBE_FORMAT = ["#{session_name}", "#{session_id}", "#{session_created}", `#{${ORIGIN_OPTION}}`].join(
  "\t",
);

export function parseProbe(stdout: string): SessionIdentity | null {
  const [name = "", id = "", created = "", ...origin] = stdout.trim().split("\t");
  if (!isSessionName(name) || !SESSION_ID_RE.test(id)) return null;
  return { name, id, createdAt: millisecondsOf(created), origin: originOf(origin.join("\t")) };
}

export function parseSessionList(stdout: string): TmuxSession[] {
  const sessions: TmuxSession[] = [];
  for (const line of stdout.split("\n")) {
    const [name = "", id = "", created = "", attached = "", ...origin] = line.split("\t");
    if (!isSessionName(name) || !SESSION_ID_RE.test(id)) continue;
    sessions.push({
      name,
      id,
      origin: originOf(origin.join("\t")),
      createdAt: millisecondsOf(created),
      attached: Number(attached) || 0,
    });
  }
  return sessions;
}

/**
 * Lines of a `capture-pane -p -J` result. Trailing blank rows are dropped: they are the empty part of the screen, and
 * keeping them would make every new line look like a change in the middle of the snapshot.
 */
export function paneLines(stdout: string): string[] {
  const lines = stdout.split("\n").map((line) => line.replace(/\r$/, ""));
  while (lines.length > 0 && (lines.at(-1) ?? "").trim() === "") lines.pop();
  return lines;
}

/** UTF-8 bytes of `text` as two-digit hex, the argument form `send-keys -H` takes. */
export function hexBytes(text: string): string[] {
  return [...Buffer.from(text, "utf8")].map((byte) => byte.toString(16).padStart(2, "0"));
}

const KEY_BASE = "Enter|Tab|BTab|Escape|Space|BSpace|DC|IC|Home|End|PPage|NPage|Up|Down|Left|Right|F(?:[1-9]|1[0-2])";
const KEY_CHAR = "[A-Za-z0-9!#%&()*+,./:<=>?@^_~]";
const KEY_NAME_RE = new RegExp(`^(?:[CMS]-){0,2}(?:${KEY_BASE}|${KEY_CHAR})$`);

/**
 * Key names accepted by `session_send`. `-` and `;` are left out: a `;` ends a tmux command and a leading `-` reads as a flag.
 * Literal text that needs them goes through `text` instead.
 */
export function isKeyName(value: string): boolean {
  return KEY_NAME_RE.test(value);
}

export type TmuxFailure = "missing" | "no_server" | "not_found" | "duplicate" | "failed";

/** What a failed tmux command means to the caller. `127` is the shell reporting that the binary is absent. */
export function classifyTmuxFailure(code: number, stderr: string): TmuxFailure {
  if (code === 127) return "missing";
  if (/duplicate session/.test(stderr)) return "duplicate";
  if (/no server running|error connecting to/.test(stderr)) return "no_server";
  if (/can't find|no such session/.test(stderr)) return "not_found";
  return "failed";
}

/** A tmux version as `tmux -V` prints it. `text` keeps any letter suffix, such as `3.1c`. */
export interface TmuxVersion {
  readonly text: string;
  readonly major: number;
  readonly minor: number;
}

/** Reads the first line of `tmux -V`. An answer without a numbered version, such as `tmux master`, reads as no version. */
export function parseTmuxVersion(stdout: string): TmuxVersion | null {
  const [line = ""] = stdout.trim().split("\n");
  const match = /^tmux (?:next-)?(\d+)\.(\d+)/.exec(line);
  if (!match) return null;
  return { text: line.slice("tmux ".length), major: Number(match[1]), minor: Number(match[2]) };
}

/** `attach-session -f ignore-size` needs tmux 3.2. Older tmux rejects the flag. */
export function acceptsIgnoreSize(version: TmuxVersion): boolean {
  return version.major > 3 || (version.major === 3 && version.minor >= 2);
}

/**
 * The lines of `next` that are new after `previous`. Finds the longest suffix of `previous` that lines up with the start
 * of `next`, so lines that scrolled out of history at the top are skipped. The last line of `previous` is the one being
 * typed on, so it may have grown in `next`; then it is returned again in full. Returns `undefined` when nothing lines up,
 * which means the screen was cleared or redrawn and the reader should start over from the current window.
 */
export function appendedLines(previous: readonly string[], next: readonly string[]): string[] | undefined {
  if (previous.length === 0) return [...next];
  const tail = previous[previous.length - 1] ?? "";
  for (let k = Math.min(previous.length, next.length); k >= 1; k--) {
    if (!alignsAt(previous, next, k, tail)) continue;
    const grown = next[k - 1] !== tail;
    return next.slice(grown ? k - 1 : k);
  }
  return undefined;
}

/** Whether the last `k` lines of `previous` match the first `k` of `next`, the final one allowed to have grown from `tail`. */
function alignsAt(previous: readonly string[], next: readonly string[], k: number, tail: string): boolean {
  const start = previous.length - k;
  for (let i = 0; i < k - 1; i++) {
    if (previous[start + i] !== next[i]) return false;
  }
  return (next[k - 1] ?? "").startsWith(tail);
}
