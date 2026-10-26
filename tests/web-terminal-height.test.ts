import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "../src/config";
import en from "../web/js/i18n/en.js";
import zh from "../web/js/i18n/zh-CN.js";
import {
  availableHeight,
  clampHeight,
  clearHeight,
  ceilingHeight,
  DEFAULT_MAX,
  defaultHeight,
  EXTRA_HEIGHT,
  FALLBACK_CHROME,
  HEIGHT_KEY,
  heightForKey,
  LEGACY_HEIGHT,
  MAX_HEIGHT,
  MIN_HEIGHT,
  parseHeight,
  readHeight,
  resetsHeight,
  STEP,
  stepHeight,
  writeHeight,
} from "../web/js/lib/terminal-height.js";

/**
 * The terminal's height on a desktop: how tall it opens, how far a drag or an arrow key may take it, and what a remembered
 * height means. The browser test next to this file (`web-terminal-height-browser.test.ts`) measures the real frame and
 * drags it; this one pins the arithmetic, the stylesheet and the wiring, so a rule that stops matching or a height that
 * stops fitting the window fails without a browser.
 */
const WEB = join(ROOT, "web");
const PANEL = readFileSync(join(WEB, "js", "components", "terminal-panel.js"), "utf8");
const CSS = readFileSync(join(WEB, "css", "app", "terminal-logs.css"), "utf8");

/** The body of a rule, braces matched. Throws when the selector is not there. */
function block(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  let depth = 0;
  for (let index = css.indexOf("{", at); index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    else if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(at, index + 1);
    }
  }
  throw new Error(`unbalanced rule for ${selector}`);
}

/** The body of the `@media` block that mentions `needle`, braces matched. `query` is the whole at-rule head. */
function mediaBlock(css: string, query: string, needle: string): string {
  const starts = [...css.matchAll(new RegExp(`@media ${query} \\{`, "g"))].map((match) => match.index ?? 0);
  for (const at of starts) {
    let depth = 0;
    for (let index = css.indexOf("{", at); index < css.length; index += 1) {
      if (css[index] === "{") depth += 1;
      else if (css[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          const text = css.slice(at, index + 1);
          if (text.includes(needle)) return text;
          break;
        }
      }
    }
  }
  throw new Error(`no ${query} block mentions ${needle}`);
}

/** Storage as the module reads it: a `Map` behind `getItem`, `setItem` and `removeItem`. */
function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    /** What is stored under the height key, for a test that checks what a page would find on its next visit. */
    get: (key: string) => map.get(key) ?? null,
  };
}

/** Storage a browser can refuse: every call throws, as a full or disabled `localStorage` does. */
const brokenStorage = {
  getItem: () => {
    throw new Error("storage is disabled");
  },
  setItem: () => {
    throw new Error("storage is disabled");
  },
  removeItem: () => {
    throw new Error("storage is disabled");
  },
};

describe("the room the page leaves", () => {
  test("it is the window's height less the screen's own top and what the page draws under the screen", () => {
    // The panel measures three boxes: the screen's top and bottom, and the content's bottom. What is under the screen —
    // the grabber, the help line, the content's bottom padding — is the difference between the last two, so no constant
    // has to guess at it. These are the numbers measured in Chromium on a box's terminal tab.
    const measured = [
      // 1280x800: the box's head wraps to two lines, so the screen starts 398px down and 67px is drawn under it.
      { viewportHeight: 800, screenTop: 398, screenBottom: 858, contentBottom: 925 },
      // 1440x900: the same page, a taller window.
      { viewportHeight: 900, screenTop: 398, screenBottom: 858, contentBottom: 925 },
      // 1920x1080: the head fits one line, so the screen starts 48px higher.
      { viewportHeight: 1080, screenTop: 350, screenBottom: 810, contentBottom: 877 },
      // 901x700: the narrowest desktop, where the help line wraps to two lines as well.
      { viewportHeight: 700, screenTop: 470, screenBottom: 930, contentBottom: 1015 },
    ];
    expect(measured.map((page) => availableHeight(page))).toEqual([335, 435, 663, 145]);
  });

  test("it does not change when the page is scrolled, because the panel measures in the page's coordinates", () => {
    // `getBoundingClientRect()` is relative to the window, so a scrolled page reports a smaller top and a bigger room.
    // The panel adds the scroll back on, which is what keeps the room the same however far the reader has scrolled —
    // including after a drag that scrolled the page itself.
    expect(PANEL).toContain("const scrolled = window.scrollY;");
    expect(PANEL).toContain("screenTop: screenBox.top + scrolled,");
    expect(PANEL).toContain("screenBottom: screenBox.bottom + scrolled,");
    expect(PANEL).toContain("contentBottom: content.getBoundingClientRect().bottom + scrolled,");
    // The same page measured at two scroll positions gives the same room, since only the difference between the screen's
    // foot and the content's foot is used.
    const atTop = { viewportHeight: 800, screenTop: 398, screenBottom: 858, contentBottom: 925 };
    const scrolledBy = 120;
    const shifted = {
      viewportHeight: 800,
      screenTop: atTop.screenTop - scrolledBy,
      screenBottom: atTop.screenBottom - scrolledBy,
      contentBottom: atTop.contentBottom - scrolledBy,
    };
    // Relative to the window both are lower by the scroll, which is why the window's height has to be measured against
    // the un-scrolled top: the panel's arithmetic adds the scroll back and so sees `atTop`.
    expect(availableHeight(atTop)).toBe(335);
    expect(availableHeight(shifted)).toBe(335 + scrolledBy);
  });

  test("a page whose furniture is already taller than the window leaves no room, never a negative one", () => {
    expect(availableHeight({ viewportHeight: 400, screenTop: 470, screenBottom: 930, contentBottom: 1015 })).toBe(0);
    // And a screen that ends below the content's foot leaves nothing under it either.
    expect(availableHeight({ viewportHeight: 900, screenTop: 300, screenBottom: 700, contentBottom: 600 })).toBe(600);
  });
});

describe("the default height", () => {
  test("it is the room the page leaves, between the old height and a ceiling", () => {
    // `clamp(460, room, 980)`: 1280x800 leaves 335px and 1440x900 leaves 435px, so both open at the 460px the terminal
    // always had; 1920x1080 leaves 663px and opens there; a 1440p window's 1023px is held at the 980px ceiling.
    expect([335, 435, 663, 1023, 0].map((room) => defaultHeight(room))).toEqual([460, 460, 663, 980, 460]);
  });

  test("a room too small for the old height still opens at the old height, exactly as the terminal always did", () => {
    // The page scrolls for the rest, which is what it did before this change: a terminal squeezed to nothing is worse.
    expect([145, 235, 300, 459].map((room) => defaultHeight(room))).toEqual([460, 460, 460, 460]);
  });

  test("the default never goes below the old height nor above its own ceiling, whatever the room is", () => {
    for (const room of [0, 100, 460, 800, 2000, 10_000]) {
      const value = defaultHeight(room);
      expect([room, value >= LEGACY_HEIGHT, value <= DEFAULT_MAX]).toEqual([room, true, true]);
    }
  });

  test("a drag has room above the default, and the ceiling stops short of the maximum", () => {
    // The default is what fits the window; the extra is there for a reader who would rather scroll than see fewer lines.
    expect([ceilingHeight(335), ceilingHeight(663), ceilingHeight(1023)]).toEqual([580, 783, 1100]);
    expect(ceilingHeight(1023)).toBe(MAX_HEIGHT);
    expect(ceilingHeight(663)).toBe(defaultHeight(663) + EXTRA_HEIGHT);
    // Even a window with no room at all can be dragged both ways.
    expect([ceilingHeight(0), defaultHeight(0)]).toEqual([580, 460]);
  });

  test("the numbers the stylesheet carries are the numbers this module works with", () => {
    // The fallback is `clamp(460px, calc(100vh - 555px), 980px)` in the 901px block: the same floor and ceiling, and the
    // furniture the widest-headed desktop page has, so it never paints taller than the measured default.
    const desktop = mediaBlock(CSS, "\\(min-width: 901px\\)", ".terminal {");
    expect(block(desktop, ".terminal")).toContain(
      `height: var(--term-h, clamp(${LEGACY_HEIGHT}px, calc(100vh - ${FALLBACK_CHROME}px), ${DEFAULT_MAX}px));`,
    );
    expect([MIN_HEIGHT, DEFAULT_MAX, EXTRA_HEIGHT, STEP, FALLBACK_CHROME]).toEqual([240, 980, 120, 24, 555]);
  });

  test("the fallback never paints taller than the measured default, on any desktop page", () => {
    // The 555px the stylesheet assumes is the largest furniture measured (901px wide), so the height before the panel
    // measures is at most what the panel then draws. A window where the old height is the floor gets exactly it.
    const measured = [
      { viewportHeight: 800, screenTop: 398, screenBottom: 858, contentBottom: 925 },
      { viewportHeight: 900, screenTop: 398, screenBottom: 858, contentBottom: 925 },
      { viewportHeight: 1080, screenTop: 350, screenBottom: 810, contentBottom: 877 },
      { viewportHeight: 700, screenTop: 470, screenBottom: 930, contentBottom: 1015 },
    ];
    const painted = measured.map((page) => defaultHeight(page.viewportHeight - FALLBACK_CHROME));
    const settled = measured.map((page) => defaultHeight(availableHeight(page)));
    for (const [index, page] of measured.entries()) {
      expect([page.viewportHeight, painted[index]! <= settled[index]!]).toEqual([page.viewportHeight, true]);
    }
    // And the two are the same on the windows where the old 460px is the floor: the page does not jump, then settle.
    expect(painted.slice(0, 2)).toEqual([460, 460]);
  });
});

describe("clamping a height", () => {
  test("it stays between the shortest the terminal may be and the room a drag may take", () => {
    const clamped = [0, 100, 240, 600, 2000, Number.NaN, Number.POSITIVE_INFINITY].map((height) =>
      clampHeight(height, 663),
    );
    // Anything below the floor becomes the floor, anything above the ceiling becomes the ceiling (which is also what a
    // height that is not a number falls back to: the default, since a height nobody set is the default).
    expect(clamped).toEqual([240, 240, 240, 600, 783, 663, 663]);
  });

  test("a height is a whole number of pixels, so the frame lands where a drag left it", () => {
    expect(clampHeight(512.6, 663)).toBe(513);
    expect(clampHeight(512.4, 663)).toBe(512);
  });

  test("a window made smaller pulls the ceiling down with it", () => {
    // 700px was fine with 663px of room and is too tall with 335px, whose ceiling is 580px; a window with 145px of room
    // has the same ceiling, since the default is already at its floor.
    expect([clampHeight(700, 663), clampHeight(700, 335), clampHeight(700, 145)]).toEqual([700, 580, 580]);
  });

  test("one arrow key moves a step, and neither end can be stepped past", () => {
    // A 1080p window has room between the floor and its 783px ceiling, so both directions move.
    expect([stepHeight(500, 1, 663), stepHeight(500, -1, 663)]).toEqual([500 + STEP, 500 - STEP]);
    expect(stepHeight(MIN_HEIGHT, -1, 663)).toBe(MIN_HEIGHT);
    expect(stepHeight(770, 1, 663)).toBe(783);
    expect(stepHeight(783, 1, 663)).toBe(783);
    // And a window with no room above the floor still steps down, to the shortest the terminal may be.
    expect([stepHeight(460, 1, 335), stepHeight(460, -1, 335)]).toEqual([484, 436]);
  });
});

describe("a remembered height", () => {
  test("only a whole number of pixels inside the range is a height", () => {
    expect(["240", "500", "1100", " 500 "].map((raw) => parseHeight(raw))).toEqual([240, 500, 1100, 500]);
    // A word, a fraction, a unit, a negative number, a number out of range, an exponent and nothing at all: no height.
    for (const raw of ["", "  ", "abc", "500px", "500.5", "-500", "239", "1101", "1e3", "0x1f4"]) {
      expect([raw, parseHeight(raw)]).toEqual([raw, null]);
    }
    expect(parseHeight(null)).toBeNull();
    expect(parseHeight(undefined)).toBeNull();
  });

  test("it is read from the versioned key, and a value from another version is not one", () => {
    expect(HEIGHT_KEY).toBe("minibox:termHeight:v1");
    const stored = memoryStorage({ [HEIGHT_KEY]: "620" });
    expect(readHeight(stored)).toBe(620);
    // A key that carries no version, or one from a later layout, is simply not this reader's height.
    expect(readHeight(memoryStorage({ "minibox:termHeight": "620" }))).toBeNull();
    expect(readHeight(memoryStorage({ "minibox:termHeight:v2": "620" }))).toBeNull();
    expect(readHeight(memoryStorage())).toBeNull();
  });

  test("writing it keeps the value a page would read back, and clearing it forgets it", () => {
    const stored = memoryStorage();
    writeHeight(stored, 613.7);
    expect(stored.get(HEIGHT_KEY)).toBe("614");
    expect(readHeight(stored)).toBe(614);
    clearHeight(stored);
    expect([stored.get(HEIGHT_KEY), readHeight(stored)]).toEqual([null, null]);
  });

  test("storage that refuses to work is not an error: the page opens at the default and forgets nothing it cannot", () => {
    expect(readHeight(brokenStorage)).toBeNull();
    expect(() => writeHeight(brokenStorage, 600)).not.toThrow();
    expect(() => clearHeight(brokenStorage)).not.toThrow();
    // And a browser with no storage at all, which is what a page in a sandboxed frame gets.
    expect(readHeight(null)).toBeNull();
    expect(() => writeHeight(undefined, 600)).not.toThrow();
  });

  test("a remembered height that still fits is opened at, and one that does not is clamped rather than dropped", () => {
    // The panel keeps the reader's height and draws the clamped value, so a window made smaller keeps as much of it as
    // there is room for and a window that grows back gives the rest back.
    const remembered = memoryStorage({ [HEIGHT_KEY]: "700" });
    expect(clampHeight(readHeight(remembered) ?? 0, 663)).toBe(700);
    expect(clampHeight(readHeight(remembered) ?? 0, 335)).toBe(580);
    expect(clampHeight(readHeight(remembered) ?? 0, 145)).toBe(580);
    // A stored height the grabber could not have set, or none at all, is the default: the panel reads null and falls back.
    // A height that is the reader's but no longer fits the window is clamped to the room there is, not dropped.
    const opened = [
      memoryStorage({ [HEIGHT_KEY]: "1001" }),
      memoryStorage({ [HEIGHT_KEY]: "1200" }),
      memoryStorage({ [HEIGHT_KEY]: "lots" }),
      memoryStorage(),
    ].map((storage) => {
      const stored = readHeight(storage);
      return stored === null ? defaultHeight(335) : clampHeight(stored, 335);
    });
    expect(opened).toEqual([580, 460, 460, 460]);
    expect(readHeight(brokenStorage) ?? defaultHeight(663)).toBe(663);
  });
});

describe("the grabber's keys", () => {
  test("Up grows the terminal and Down shrinks it", () => {
    expect([heightForKey("ArrowUp", 500, 663), heightForKey("ArrowDown", 500, 663)]).toEqual([500 + STEP, 500 - STEP]);
    // A key press never takes the terminal past what the room and the ceiling allow.
    expect(heightForKey("ArrowUp", 770, 663)).toBe(783);
    expect(heightForKey("ArrowDown", 250, 663)).toBe(MIN_HEIGHT);
  });

  test("Home, End and Enter put the default height back", () => {
    for (const key of ["Home", "End", "Enter"]) {
      expect([key, heightForKey(key, 240, 663), resetsHeight(key)]).toEqual([key, 663, true]);
    }
  });

  test("a key the grabber does not handle changes nothing, so the page keeps the keys it does use", () => {
    for (const key of ["PageUp", "PageDown", " ", "a", "ArrowLeft", "Escape", ""]) {
      expect([key, heightForKey(key, 500, 663), resetsHeight(key)]).toEqual([key, null, false]);
    }
  });
});

describe("the grabber in the terminal panel", () => {
  test("it is a horizontal separator a screen reader can name, focus and read the height of", () => {
    expect(PANEL).toContain('role="separator"');
    expect(PANEL).toContain('aria-orientation="horizontal"');
    expect(PANEL).toContain('tabindex="0"');
    expect(PANEL).toContain('aria-label="${esc(t("bd.termResize"))}"');
    expect(PANEL).toContain('title="${esc(t("bd.termResizeHint"))}"');
    // Its ends and where it sits between them are the range a drag may take, so the value reads as a percentage.
    expect(PANEL).toContain('grabber.setAttribute("aria-valuemin", String(MIN_HEIGHT));');
    expect(PANEL).toContain('grabber.setAttribute("aria-valuemax", String(ceilingHeight(space)));');
    expect(PANEL).toContain('grabber.setAttribute("aria-valuenow", String(height));');
  });

  test("the handle is reachable with Tab: it comes before the screen, which keeps Tab for itself", () => {
    // xterm turns Tab into a byte for the session, so a handle after the screen would never be reachable by keyboard. It
    // is marked up before the screen and drawn after it, which is what the stylesheet's `order` does.
    const markup = PANEL.slice(PANEL.indexOf("terminal-frame"), PANEL.indexOf("const list = root.querySelector"));
    expect(markup.indexOf("${grabberHtml()}")).toBeLessThan(markup.indexOf('id="term"'));
    expect(mediaBlock(CSS, "\\(min-width: 901px\\)", "order: 1;")).toContain("order: 1;");
    // And the frame is a column from 901px up, so that order has a line to move the handle to.
    expect(block(mediaBlock(CSS, "\\(min-width: 901px\\)", "flex-direction: column;"), ".terminal-frame")).toContain(
      "flex-direction: column;",
    );
  });

  test("a drag cancels its default, so nothing is selected and the page does not scroll under the pointer", () => {
    expect(PANEL).toContain("event.preventDefault();");
    expect(PANEL).toContain('document.body.classList.add("term-resizing");');
    expect(PANEL).toContain('document.body.classList.remove("term-resizing");');
    // The press is the one that must not scroll or select; the moves keep the handle under the pointer too.
    const down = PANEL.slice(PANEL.indexOf("const onGrabberDown"), PANEL.indexOf("const onGrabberMove"));
    expect(down).toContain("event.preventDefault();");
  });

  test("the room is measured from the page, not assumed: the screen's box and the content's foot", () => {
    // The panel measures the screen's own top and bottom and the content's bottom, so the furniture under the screen
    // (grabber, help line, bottom padding) comes out of the difference instead of a constant that has to guess at it.
    expect(PANEL).toContain("const room = () => {");
    expect(PANEL).toContain('const content = root.closest(".content") ?? document.body;');
    expect(PANEL).toContain("const screenBox = screen.getBoundingClientRect();");
    expect(PANEL).toContain("viewportHeight: window.innerHeight,");
    expect(PANEL).toContain("screenTop: screenBox.top + scrolled,");
    expect(PANEL).toContain("screenBottom: screenBox.bottom + scrolled,");
    expect(PANEL).toContain("contentBottom: content.getBoundingClientRect().bottom + scrolled,");
    // Every apply measures again, so a window resize — which changes the width and with it the page's furniture — is
    // taken into account rather than only the height.
    expect(PANEL).toContain("const space = room();");
    expect(PANEL).toContain("const next = heightForKey(event.key, height, room());");
  });

  test("every height change refits xterm, whose own resize subscription is what tells tmux", () => {
    // The frame is drawn from the module's number, and xterm is fitted to the frame: `fit.fit()` is what recomputes the
    // columns and rows, and the panel's existing `onResize` subscription sends the `{type:"resize"}` frame.
    expect(PANEL).toContain('screen.style.setProperty("--term-h", `${height}px`);');
    expect(PANEL).toContain("if (refit) fit.fit();");
    expect(PANEL).toContain("const resizeSub = xterm.onResize(({ cols, rows }) => {");
    expect(PANEL).toContain('ws.send(JSON.stringify({ type: "resize", cols, rows }));');
    // A drag draws once a frame, so a fast drag does not queue a fit for every pixel it crossed.
    expect(PANEL).toContain("dragFrame = requestAnimationFrame(() => {");
  });

  test("the height is remembered locally, and never sent to the server", () => {
    expect(PANEL).toContain("let preferred = readHeight(storage());");
    expect(PANEL).toContain("const rememberHeight = () => writeHeight(storage(), height);");
    expect(PANEL).toContain("clearHeight(storage());");
    // The only frame this panel sends about the screen is the size tmux needs, in columns and rows: no height goes out.
    const sent = [...PANEL.matchAll(/ws\.send\(JSON\.stringify\((\{[^}]*\})\)/g)].map((match) => match[1] ?? "");
    expect(sent.toSorted()).toEqual(["{ type }", '{ type: "resize", cols, rows }']);
  });

  test("a drag hands the keyboard back to the terminal, so the next character typed still lands in the session", () => {
    expect(PANEL).toContain('const hadKeyboard = document.activeElement?.closest?.(".xterm") != null;');
    expect(PANEL).toContain("if (hadKeyboard) xterm.focus();");
  });

  test("a window that shrinks clamps the height, and growing back restores what the reader asked for", () => {
    // `preferred` keeps the reader's own height and `height` is the clamped one that is drawn, so a window that grows
    // again gives the rest back instead of settling on the smaller height.
    expect(PANEL).toContain("height = clampHeight(preferred ?? defaultHeight(space), space);");
    expect(PANEL).toContain("const onWin = () => reapply();");
    expect(PANEL).toContain('window.addEventListener("resize", onWin);');
    expect(PANEL).toContain('window.removeEventListener("resize", onWin);');
  });

  test("the handle's listeners are all taken off when the panel is torn down", () => {
    for (const event of ["pointerdown", "pointermove", "pointerup", "pointercancel", "keydown", "dblclick"]) {
      expect(PANEL).toContain(`grabber.addEventListener("${event}", `);
      expect(PANEL).toContain(`grabber?.removeEventListener("${event}", `);
    }
  });
});

describe("the grabber's stylesheet", () => {
  test("it is hidden until the desktop breakpoint, so a phone and a tablet keep the height they had", () => {
    expect(block(CSS, ".term-grabber")).toContain("display: none;");
    expect(mediaBlock(CSS, "\\(min-width: 901px\\)", "cursor: row-resize;")).toContain("display: flex;");
    // Nothing draws it below 901px: the phone block is the one that sets its own height, and it says so.
    expect(CSS).not.toContain("@media (max-width: 900px) {\n  .term-grabber");
  });

  test("it looks like a handle: a bar, a resize cursor and a colour when hovered or focused", () => {
    // The desktop block draws the handle. Its first rule only orders it; the one that gives it a body is the one to read.
    const desktop = mediaBlock(CSS, "\\(min-width: 901px\\)", "cursor: row-resize;");
    const handle = desktop.slice(desktop.indexOf("z-index: 1;"));
    expect(handle).toContain("cursor: row-resize;");
    expect(handle).toContain("height: 12px;");
    // A drag on a phone must not scroll the page instead of moving the handle.
    expect(handle).toContain("touch-action: none;");
    expect(handle).toContain("background: #52525b;");
    expect(handle).toContain("background: var(--accent);");
    expect(handle).toContain("outline: 2px solid var(--accent);");
    // And while it is being dragged, the cursor stays a resize arrow over the whole page.
    expect(desktop).toContain("cursor: row-resize !important;");
  });

  test("a phone keeps min(52vh, 340px), with the key row after the screen exactly as before", () => {
    const phone = mediaBlock(CSS, "\\(max-width: 640px\\)", ".terminal {");
    expect(block(phone, ".terminal")).toContain("height: min(52vh, 340px);");
    // The grabber is not in the phone block at all, so it cannot take a line from the key row.
    expect(phone).not.toContain(".term-grabber");
  });
});

describe("the grabber's words", () => {
  test("they are in both dictionaries, and the two languages say different things", () => {
    for (const key of ["bd.termResize", "bd.termResizeHint"] as const) {
      expect([key, key in en, key in zh]).toEqual([key, true, true]);
      expect([key, zh[key] !== en[key]]).toEqual([key, true]);
    }
  });

  test("they say what the handle is and how to use it, in words a person can act on", () => {
    expect([en["bd.termResize"], zh["bd.termResize"]]).toEqual(["Terminal height", "终端高度"]);
    for (const word of ["Drag", "Arrow keys", "Home", "double click"]) expect(en["bd.termResizeHint"]).toContain(word);
    for (const word of ["拖动", "方向键", "Home", "双击"]) expect(zh["bd.termResizeHint"]).toContain(word);
  });
});
