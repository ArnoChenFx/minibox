/**
 * The height of the terminal on a desktop screen.
 *
 * The terminal used to be a fixed 460px, which on a 1080p or 1440p screen left a band of empty page under the frame: it
 * ended well above the fold, with nothing below it to scroll to. Here the height follows the window instead, and the
 * reader can drag it to whatever suits them. A phone is untouched: at 640px and below the terminal keeps its
 * `min(52vh, 340px)` height, the key row under it and the keyboard logic, and nothing in this module is consulted.
 *
 * The default is `clamp(LEGACY_HEIGHT, 100vh - CHROME_HEIGHT, DEFAULT_MAX)`, the expression the stylesheet carries for
 * `.terminal` in `terminal-logs.css`, so the two cannot drift apart without a test saying so:
 *
 *   LEGACY_HEIGHT   460px   the height the terminal always had, which the default never opens shorter than
 *   CHROME_HEIGHT   300px   the room the window keeps for the page's own furniture and the band under the frame
 *   DEFAULT_MAX     980px   the ceiling of the default, so a very tall window does not grow a frame nobody can read
 *
 * That gives 500px on a 1280x800 window (the old 460px plus the band that was empty under it), 600px at 1440x900, 780px
 * on a 1080p screen and 980px on a 1440p one. `CHROME_HEIGHT` is measured in Chromium on the box's terminal tab: 398px
 * of page above the screen (top bar 56, content padding 28, page head 102, tab strip 43, session bar 60, terminal bar 45,
 * control bar 45) and 38px of frame under it (the grabber's 12px) and page under that (the help line and the content's
 * bottom padding). Of the rest, 100px is left for the frame to end a little past the fold, so the terminal gets as many
 * lines as it can and the page scrolls the help line into view.
 *
 * A reader can drag the grabber up to `EXTRA_HEIGHT` past the default, as far as `MAX_HEIGHT`: the default is the height
 * that leaves the page comfortable, and the extra 120px is there for a reader who would rather scroll a little than see
 * fewer lines. Downwards the floor is `MIN_HEIGHT`, about a dozen lines, enough to read what a command printed. The
 * height they pick is remembered in `localStorage`, under a key that carries its version, so a later layout can start
 * over instead of inheriting a number that no longer means anything.
 */

/** The key the reader's height is remembered under. The version is part of it, so a later layout can start over. */
export const HEIGHT_KEY = "minibox:termHeight:v1";

/** The shortest the terminal may be dragged to: about a dozen lines at the console's font size. */
export const MIN_HEIGHT = 240;

/** The tallest the default grows to, so a very tall window keeps a frame a person can still read. */
export const DEFAULT_MAX = 980;

/** The tallest the terminal may be dragged to, on any window. */
export const MAX_HEIGHT = 1100;

/** What the default height keeps for the page's own furniture and the band under the frame. */
export const CHROME_HEIGHT = 300;

/** How much further than the default a reader may drag the grabber, before `MAX_HEIGHT` stops it. */
export const EXTRA_HEIGHT = 120;

/** The fixed height the terminal used to have. The default never opens shorter than this, so nothing is lost. */
export const LEGACY_HEIGHT = 460;

/** How far one press of an arrow key on the grabber moves the terminal. */
export const STEP = 24;

/** The terminal height for a window `viewportHeight` pixels tall, before the reader has dragged anything. */
export function defaultHeight(viewportHeight) {
  return Math.round(Math.min(DEFAULT_MAX, Math.max(LEGACY_HEIGHT, viewportHeight - CHROME_HEIGHT)));
}

/**
 * The tallest the terminal may be on a `viewportHeight`-tall window: the default plus the room a drag may take, kept
 * under `MAX_HEIGHT`. A window too short for even the old 460px still has `EXTRA_HEIGHT` above the floor, so the grabber
 * can always be dragged both ways, and the page scrolls rather than squeezing the terminal to nothing.
 */
export function ceilingHeight(viewportHeight) {
  return Math.min(MAX_HEIGHT, defaultHeight(viewportHeight) + EXTRA_HEIGHT);
}

/**
 * `height` brought inside the range the terminal may take on a `viewportHeight`-tall window. A height that is not a
 * finite number falls back to the default.
 */
export function clampHeight(height, viewportHeight) {
  if (typeof height !== "number" || !Number.isFinite(height)) return defaultHeight(viewportHeight);
  const ceiling = ceilingHeight(viewportHeight);
  return Math.round(Math.min(ceiling, Math.max(MIN_HEIGHT, height)));
}

/** The height one step up (`direction` 1) or down (-1) from `height`, kept inside the range above. */
export function stepHeight(height, direction, viewportHeight) {
  return clampHeight(height + direction * STEP, viewportHeight);
}

/**
 * The height a stored value stands for, or null when it stands for none. The value comes from `localStorage`, so it
 * arrives as text: only a whole number of pixels the grabber could have stopped at is a height the reader set, and
 * anything else — a missing key, a value from another version, a word, a negative or absurd number — means nothing.
 */
export function parseHeight(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!/^\d{1,5}$/.test(text)) return null;
  const height = Number(text);
  return height >= MIN_HEIGHT && height <= MAX_HEIGHT ? height : null;
}

/** The height the reader last set, or null when they never have, or when storage cannot be read. */
export function readHeight(storage) {
  try {
    return parseHeight(storage?.getItem(HEIGHT_KEY));
  } catch {
    // Storage can be disabled or full. The terminal then opens at its default, which is what it did before.
    return null;
  }
}

/** Remembers `height` for the next page, box or session. Storage that refuses is not an error. */
export function writeHeight(storage, height) {
  try {
    storage?.setItem(HEIGHT_KEY, String(Math.round(height)));
  } catch {
    // Nothing to do: the height still applies to this page, it is just not remembered after a reload.
  }
}

/** Forgets the reader's height, so the terminal follows the window again. Storage that refuses is not an error. */
export function clearHeight(storage) {
  try {
    storage?.removeItem(HEIGHT_KEY);
  } catch {
    // Same as above: the default applies to this page either way.
  }
}

/**
 * The height the grabber's key press asks for, or null for a key it does not handle. Up grows the terminal and Down
 * shrinks it, which is how the frame moves as the reader watches it; Home, End and Enter put the default height back.
 */
export function heightForKey(key, height, viewportHeight) {
  switch (key) {
    case "ArrowUp":
      return stepHeight(height, 1, viewportHeight);
    case "ArrowDown":
      return stepHeight(height, -1, viewportHeight);
    case "Home":
    case "End":
    case "Enter":
      return defaultHeight(viewportHeight);
    default:
      return null;
  }
}

/** Whether a key press on the grabber puts the default height back, rather than stepping one way or the other. */
export function resetsHeight(key) {
  return key === "Home" || key === "End" || key === "Enter";
}
