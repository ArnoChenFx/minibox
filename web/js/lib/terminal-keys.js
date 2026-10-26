/**
 * The keys of the terminal's auxiliary row, for a phone whose on-screen keyboard has no Esc, no Ctrl, no Tab and no
 * arrow keys. Each key sends the byte sequence a terminal expects, through the same channel the keyboard uses: xterm's
 * `onData`, which the terminal panel forwards to the box's tmux session.
 *
 * Ctrl is a sticky modifier. It sends nothing on its own; the next character typed on the on-screen keyboard goes out as
 * its control character (Ctrl-C is 0x03), and then Ctrl resets. The row also carries Ctrl-C and Ctrl-D directly, since
 * those two are the ones a phone needs most.
 */

/** The keys in the order the row shows them. `bytes` is what the key sends; the sticky Ctrl has none of its own. */
export const TERM_KEYS = [
  { id: "esc", label: "Esc", aria: "bd.termKeyEsc", bytes: "\u001b" },
  { id: "tab", label: "Tab", aria: "bd.termKeyTab", bytes: "\t" },
  { id: "ctrl", label: "Ctrl", aria: "bd.termKeyCtrl", sticky: true },
  { id: "left", label: "←", aria: "bd.termKeyLeft", bytes: "\u001b[D" },
  { id: "up", label: "↑", aria: "bd.termKeyUp", bytes: "\u001b[A" },
  { id: "down", label: "↓", aria: "bd.termKeyDown", bytes: "\u001b[B" },
  { id: "right", label: "→", aria: "bd.termKeyRight", bytes: "\u001b[C" },
  { id: "ctrlC", label: "^C", aria: "bd.termKeyCtrlC", bytes: "\u0003" },
  { id: "ctrlD", label: "^D", aria: "bd.termKeyCtrlD", bytes: "\u0004" },
];

/** The bytes a key sends. The sticky Ctrl sends nothing on its own, so it has none. */
export function keyBytes(id) {
  const key = TERM_KEYS.find((candidate) => candidate.id === id);
  return typeof key?.bytes === "string" ? key.bytes : null;
}

/**
 * The control character the sticky Ctrl makes out of one typed character, or null when it leaves the character as it is.
 * The mapping is the one a terminal uses: Ctrl-A to Ctrl-Z are 0x01 to 0x1a, and the punctuation next to the letters
 * keeps its bit (Ctrl-[ is ESC), with Ctrl-? as DEL. Anything longer than one character, such as a paste or an
 * input-method composition, is not a single key and is left alone.
 */
export function ctrlChar(data) {
  if (typeof data !== "string" || data.length !== 1) return null;
  const code = data.charCodeAt(0);
  // Ctrl-? sends DEL, which the bit trick would turn into 0x1f instead.
  if (code === 0x3f) return "\u007f";
  if ((code >= 0x40 && code <= 0x5f) || (code >= 0x61 && code <= 0x7a)) return String.fromCharCode(code & 0x1f);
  return null;
}

/**
 * How far the page has to scroll to bring the key row into the part of the window a phone's keyboard leaves visible,
 * `visible` being that part as `{ top, bottom }`. Zero when the row is already inside it, so a row in view never moves
 * the page. A row taller than the visible part is brought in by its top, which keeps its first keys pressable.
 */
export function keysReveal(row, visible) {
  // A row taller than the part the keyboard leaves cannot fit whole; its first keys are the ones to keep reachable.
  if (row.bottom - row.top > visible.bottom - visible.top) return row.top - visible.top;
  if (row.bottom > visible.bottom) return row.bottom - visible.bottom;
  if (row.top < visible.top) return row.top - visible.top;
  return 0;
}
