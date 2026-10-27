/**
 * The height of the terminal on a desktop screen.
 *
 * The terminal used to be a fixed 460px, which on a 1080p or 1440p screen left a band of empty page under the frame: it
 * ended well above the fold, with nothing below it to scroll to. Here the height follows the room the window actually
 * leaves, measured in the page itself rather than guessed from the window height, and the reader can drag it taller if
 * they want more lines. A phone is untouched: at 640px and below the terminal keeps its `min(52vh, 340px)` height, the
 * key row under it and the keyboard logic, and nothing in this module is consulted.
 *
 * The default is `clamp(LEGACY_HEIGHT, room, DEFAULT_MAX)`, where `room` is what the page leaves for the screen:
 *
 *   room = window.innerHeight - the screen's own top - everything between the screen's foot and the content's foot
 *
 * `availableHeight` works that out from three measurements the panel takes on mount and again on every window resize: the
 * screen's top, its bottom, and the bottom of the page's `.content`. The last two give the furniture under the screen —
 * the grabber's 12px, the help line's 26px and the content's 28px of bottom padding — without this file having to know
 * any of it. Measuring beats a constant: the page above the screen is 398px at 1280px wide (the box's head wraps to two
 * lines) and 350px at 1920px, so no single number fits both.
 *
 * What that gives, in Chromium on the box's terminal tab:
 *
 *   1280x800    room 335   -> 460px (the floor: the old height, which already ran past the fold by 58px, as it did before)
 *   1440x900    room 435   -> 460px (the floor; screen bottom 858 and grabber 870 both inside the window)
 *   1920x1080   room 663   -> 663px (screen bottom 1013 and grabber 1025 both inside the window)
 *
 * So by default the whole screen and its grabber are in the window wherever the old 460px fitted, and where it did not
 * the terminal is exactly as tall as it always was. A reader who wants more lines than that drags the grabber: the
 * ceiling is `EXTRA_HEIGHT` past the default, up to `MAX_HEIGHT`, and the page scrolls for it.
 *
 * The stylesheet carries a first-paint fallback, `clamp(460px, calc(100vh - 555px), 980px)`, so the page paints sensibly
 * before this module has measured anything. Its 555px is the largest furniture any desktop page has (measured at 901px
 * wide, where the box's head wraps to two lines: 470px above the screen and 85px under it), so the fallback never opens
 * taller than the measured default — and on those windows the two are the same. The panel replaces it with the measured
 * height as soon as it mounts, and a test pins the numbers together.
 */

/** The key the reader's height is remembered under. The version is part of it, so a later layout can start over. */
export const HEIGHT_KEY = "minibox:termHeight:v1";

/** The shortest the terminal may be dragged to: about a dozen lines at the console's font size. */
export const MIN_HEIGHT = 240;

/** The tallest the default grows to, so a very tall window keeps a frame a person can still read. */
export const DEFAULT_MAX = 980;

/** The tallest the terminal may be dragged to, on any window. */
export const MAX_HEIGHT = 1100;

/**
 * The furniture the stylesheet's first-paint fallback assumes: the most any desktop page has, its screen's top plus what
 * is under the screen. Measured at 901px wide, where the box's head wraps to two lines (470px + 85px).
 */
export const FALLBACK_CHROME = 555;

/** How much further than the default a reader may drag the grabber, before `MAX_HEIGHT` stops it. */
export const EXTRA_HEIGHT = 120;

/** The fixed height the terminal used to have. The default never opens shorter than this, so nothing is lost. */
export const LEGACY_HEIGHT = 460;

/** How far one press of an arrow key on the grabber moves the terminal. */
export const STEP = 24;

/**
 * The room the page leaves for the screen, from the measurements the panel takes: the screen's `top` and `bottom` and the
 * page content's `bottom`, all from `getBoundingClientRect()`, and the window's own height. What sits under the screen —
 * the grabber, the help line, the content's bottom padding — is the difference between the last two, so no constant has
 * to guess at it. A page whose furniture is already taller than the window leaves no room, never a negative one.
 */
export function availableHeight({ viewportHeight, screenTop, screenBottom, contentBottom }) {
  const below = Math.max(0, contentBottom - screenBottom);
  return Math.max(0, Math.round(viewportHeight - screenTop - below));
}

/** The terminal height for `room` pixels of space, before the reader has dragged anything. */
export function defaultHeight(room) {
  return Math.round(Math.min(DEFAULT_MAX, Math.max(LEGACY_HEIGHT, room)));
}

/**
 * The tallest the terminal may be with `room` pixels of space: the default plus the room a drag may take, kept under
 * `MAX_HEIGHT`. A window too short for even the old 460px still has `EXTRA_HEIGHT` above the floor, so the grabber can
 * always be dragged both ways and a reader who wants more lines than the window holds can have them.
 */
export function ceilingHeight(room) {
  return Math.min(MAX_HEIGHT, defaultHeight(room) + EXTRA_HEIGHT);
}

/** `height` brought inside the range the terminal may take with `room` pixels of space. */
export function clampHeight(height, room) {
  if (typeof height !== "number" || !Number.isFinite(height)) return defaultHeight(room);
  return Math.round(Math.min(ceilingHeight(room), Math.max(MIN_HEIGHT, height)));
}

/** The height one step up (`direction` 1) or down (-1) from `height`, kept inside the range above. */
export function stepHeight(height, direction, room) {
  return clampHeight(height + direction * STEP, room);
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
export function heightForKey(key, height, room) {
  switch (key) {
    case "ArrowUp":
      return stepHeight(height, 1, room);
    case "ArrowDown":
      return stepHeight(height, -1, room);
    case "Home":
    case "End":
    case "Enter":
      return defaultHeight(room);
    default:
      return null;
  }
}

/** Whether a key press on the grabber puts the default height back, rather than stepping one way or the other. */
export function resetsHeight(key) {
  return key === "Home" || key === "End" || key === "Enter";
}
