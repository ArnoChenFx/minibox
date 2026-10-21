/**
 * Pure helpers for driving tmux through its command line: names, targets, formats, and parsed output.
 * Nothing here runs a process; the terminal service passes these values to the runtime.
 */

/** Names are restricted before they reach tmux, which rewrites `:` and `.` and treats `=` as a prefix. */
export const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/** tmux user option that records who created a session: `agent` for the API, `human` for the console. */
export const ORIGIN_OPTION = "@minibox-origin";

export type SessionOrigin = "agent" | "human";

export interface TmuxSession {
  readonly name: string;
  /** Sessions without the mark were not created by MiniBox, so they are treated as agent-driven. */
  readonly origin: SessionOrigin;
  readonly createdAt: number;
  readonly attached: number;
}

export function isSessionName(value: string): boolean {
  return SESSION_NAME_RE.test(value);
}

/** Session-level commands (`has-session`, `kill-session`, `attach-session`). */
export function sessionTarget(name: string): string {
  return `=${name}`;
}

/** Pane-level commands (`send-keys`, `capture-pane`, `set-option`). The trailing colon selects the current window and pane. */
export function paneTarget(name: string): string {
  return `=${name}:`;
}

export const LIST_SESSIONS_FORMAT = [
  "#{session_name}",
  `#{${ORIGIN_OPTION}}`,
  "#{session_created}",
  "#{session_attached}",
].join("\t");

export function parseSessionList(stdout: string): TmuxSession[] {
  const sessions: TmuxSession[] = [];
  for (const line of stdout.split("\n")) {
    const [name, origin, created, attached] = line.split("\t");
    if (!name || !isSessionName(name)) continue;
    sessions.push({
      name,
      origin: origin === "human" ? "human" : "agent",
      createdAt: (Number(created) || 0) * 1000,
      attached: Number(attached) || 0,
    });
  }
  return sessions;
}

/**
 * Lines of a `capture-pane -p -J -S -` result. Trailing blank rows are dropped: they are the empty part of the screen,
 * and keeping them would make every new line look like a change in the middle of the snapshot.
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

/**
 * The lines of `next` that come after `previous`, found as the longest suffix of `previous` that is also a prefix of `next`.
 * Lines that scrolled out of history at the top are skipped on their own. Returns `undefined` when nothing lines up,
 * which means the screen was cleared or redrawn and the reader should start over from the current window.
 */
export function appendedLines(previous: readonly string[], next: readonly string[]): string[] | undefined {
  if (previous.length === 0) return [...next];
  const overlap = longestOverlap(previous, next);
  if (overlap === 0) return undefined;
  return next.slice(overlap);
}

/** Knuth-Morris-Pratt over lines: the longest prefix of `pattern` that ends `text`. */
function longestOverlap(text: readonly string[], pattern: readonly string[]): number {
  const m = pattern.length;
  if (m === 0) return 0;
  const border = Array.from({ length: m }, () => 0);
  for (let i = 1, k = 0; i < m; i++) {
    while (k > 0 && pattern[i] !== pattern[k]) k = border[k - 1] ?? 0;
    if (pattern[i] === pattern[k]) k++;
    border[i] = k;
  }
  let k = 0;
  for (const line of text) {
    while (k > 0 && (k === m || line !== pattern[k])) k = border[k - 1] ?? 0;
    if (line === pattern[k]) k++;
  }
  return k;
}
