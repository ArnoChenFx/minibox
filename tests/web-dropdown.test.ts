import { describe, expect, test } from "bun:test";

import {
  closedState,
  type DropdownContext,
  type DropdownOption,
  type DropdownState,
  reduceDismiss,
  reduceHover,
  reduceKey,
  reducePick,
  reduceToggle,
  stepEnabled,
  syncState,
  TYPEAHEAD_MS,
  typeAheadMatch,
} from "../web/js/lib/dropdown-state.js";

const opt = (label: string, disabled = false): DropdownOption => ({ label, disabled });

const fruit: DropdownOption[] = [opt("Apple"), opt("Banana"), opt("Cherry", true), opt("Date"), opt("Elderberry")];

const ctx = (selected: number, options: DropdownOption[] = fruit, now = 0): DropdownContext => ({
  options,
  selected,
  now,
});

/** A menu opened on `selected` with Enter, the way a keyboard user opens it. */
const openAt = (selected: number, options: DropdownOption[] = fruit): DropdownState =>
  reduceKey(closedState(), "Enter", ctx(selected, options)).state;

describe("opening the menu", () => {
  test("Enter, Space and the arrow keys open it on the selected option", () => {
    for (const key of ["Enter", " ", "ArrowDown", "ArrowUp"]) {
      const result = reduceKey(closedState(), key, ctx(3));
      expect(result.state).toEqual({ open: true, active: 3, typed: "", typedAt: 0 });
      expect(result.handled).toBe(true);
      expect(result.commit).toBeNull();
    }
  });

  test("a menu opens on the first enabled option when the selected one is disabled", () => {
    expect(openAt(2).active).toBe(0);
  });

  test("a menu opens on no option when nothing is selected and everything is disabled", () => {
    const allDisabled = [opt("A", true), opt("B", true)];
    expect(openAt(-1, allDisabled).active).toBe(-1);
  });

  test("a select without options never opens and lets its keys through", () => {
    for (const key of ["Enter", " ", "ArrowDown", "a"]) {
      const result = reduceKey(closedState(), key, ctx(-1, []));
      expect(result.state.open, key).toBe(false);
      expect(result.handled, key).toBe(false);
    }
  });

  test("keys with no meaning on a closed trigger pass through to the page", () => {
    for (const key of ["Tab", "Escape", "Shift", "F5"]) {
      const result = reduceKey(closedState(), key, ctx(0));
      expect(result.handled, key).toBe(false);
      expect(result.stop, key).toBe(false);
    }
  });

  test("a click opens a closed menu and closes an open one", () => {
    expect(reduceToggle(closedState(), ctx(1)).state.open).toBe(true);
    expect(reduceToggle(openAt(1), ctx(1)).state.open).toBe(false);
  });
});

describe("moving the highlight", () => {
  test("arrows step over disabled options", () => {
    expect(reduceKey(openAt(1), "ArrowDown", ctx(1)).state.active).toBe(3);
    expect(reduceKey(openAt(3), "ArrowUp", ctx(3)).state.active).toBe(1);
  });

  test("arrows stop at either end instead of wrapping", () => {
    expect(reduceKey(openAt(0), "ArrowUp", ctx(0)).state.active).toBe(0);
    expect(reduceKey(openAt(4), "ArrowDown", ctx(4)).state.active).toBe(4);
  });

  test("Home and End jump to the first and last enabled options", () => {
    expect(reduceKey(openAt(3), "Home", ctx(3)).state.active).toBe(0);
    expect(reduceKey(openAt(0), "End", ctx(0)).state.active).toBe(4);
    const trailingDisabled = [opt("A"), opt("B"), opt("C", true)];
    expect(reduceKey(openAt(0, trailingDisabled), "End", ctx(0, trailingDisabled)).state.active).toBe(1);
  });

  test("PageUp and PageDown move ten enabled options and clamp at the ends", () => {
    const long = Array.from({ length: 25 }, (_, i) => opt(`item ${i}`));
    const down = reduceKey(openAt(0, long), "PageDown", ctx(0, long));
    expect(down.state.active).toBe(10);
    expect(reduceKey(down.state, "PageDown", ctx(0, long)).state.active).toBe(20);
    expect(reduceKey(openAt(20, long), "PageDown", ctx(20, long)).state.active).toBe(24);
    expect(reduceKey(openAt(5, long), "PageUp", ctx(5, long)).state.active).toBe(0);
  });

  test("moving with the keyboard never commits a value", () => {
    const result = reduceKey(openAt(0), "ArrowDown", ctx(0));
    expect(result.commit).toBeNull();
    expect(result.handled).toBe(true);
  });

  test("a click on an enabled option chooses it and closes the menu", () => {
    const result = reducePick(openAt(0), 3, ctx(0));
    expect(result).toEqual({ state: closedState(), commit: 3, handled: true, stop: false });
  });

  test("a click on a disabled option does nothing", () => {
    const result = reducePick(openAt(0), 2, ctx(0));
    expect(result.commit).toBeNull();
    expect(result.state.open).toBe(true);
  });

  test("hovering an enabled option highlights it, and hovering a disabled one does not", () => {
    expect(reduceHover(openAt(0), 4, ctx(0)).state.active).toBe(4);
    expect(reduceHover(openAt(0), 2, ctx(0)).state.active).toBe(0);
  });
});

describe("choosing", () => {
  test("Enter commits the highlighted option and closes the menu", () => {
    const moved = reduceKey(openAt(0), "ArrowDown", ctx(0)).state;
    const result = reduceKey(moved, "Enter", ctx(0));
    expect(result).toEqual({ state: closedState(), commit: 1, handled: true, stop: false });
  });

  test("Enter on the selected option closes the menu without a change", () => {
    const result = reduceKey(openAt(2 + 1), "Enter", ctx(3));
    expect(result.commit).toBeNull();
    expect(result.state.open).toBe(false);
  });

  test("Space chooses the highlighted option when no search is in progress", () => {
    const moved = reduceKey(openAt(0), "ArrowDown", ctx(0)).state;
    expect(reduceKey(moved, " ", ctx(0, fruit, 50)).commit).toBe(1);
  });

  test("Escape closes the menu without a change and stops the key, so a dialog stays open", () => {
    const result = reduceKey(openAt(1), "Escape", ctx(1));
    expect(result).toEqual({ state: closedState(), commit: null, handled: true, stop: true });
  });

  test("Tab closes the menu and lets the browser move focus", () => {
    const result = reduceKey(openAt(1), "Tab", ctx(1));
    expect(result).toEqual({ state: closedState(), commit: null, handled: false, stop: false });
  });

  test("an outside press or a lost focus closes the menu without a change", () => {
    expect(reduceDismiss()).toEqual({ state: closedState(), commit: null, handled: false, stop: false });
  });
});

describe("type-ahead", () => {
  test("a letter on the closed trigger commits the next option that starts with it", () => {
    const result = reduceKey(closedState(), "b", ctx(0));
    expect(result.commit).toBe(1);
    expect(result.handled).toBe(true);
  });

  test("a letter that matches the selected option commits nothing", () => {
    expect(reduceKey(closedState(), "b", ctx(1)).commit).toBeNull();
  });

  test("a repeated letter cycles through the options that start with it", () => {
    const options = [opt("Apple"), opt("Avocado"), opt("Banana")];
    const first = reduceKey(closedState(), "a", ctx(0, options, 0));
    expect(first.commit).toBe(1);
    const second = reduceKey(first.state, "a", ctx(1, options, 100));
    expect(second.commit).toBe(0);
  });

  test("letters typed within the window search for the whole prefix", () => {
    const options = [opt("Banana"), opt("Apple"), opt("Apricot")];
    const first = reduceKey(closedState(), "a", ctx(0, options, 0));
    expect(first.commit).toBe(1);
    const second = reduceKey(first.state, "p", ctx(1, options, 100));
    expect(second.commit).toBeNull();
    expect(reduceKey(second.state, "r", ctx(1, options, 200)).commit).toBe(2);
  });

  test("a pause longer than the window starts a new search", () => {
    const options = [opt("Apple"), opt("Apricot"), opt("Banana")];
    const first = reduceKey(closedState(), "a", ctx(0, options, 0));
    expect(reduceKey(first.state, "p", ctx(0, options, TYPEAHEAD_MS + 1)).commit).toBeNull();
  });

  test("a search with no match consumes the key and leaves the selection alone", () => {
    const result = reduceKey(closedState(), "z", ctx(0));
    expect(result.commit).toBeNull();
    expect(result.handled).toBe(true);
    expect(result.state.typed).toBe("z");
  });

  test("matching ignores case and skips disabled options", () => {
    const upper = reduceKey(closedState(), "C", ctx(0));
    expect(upper.commit).toBeNull();
    expect(typeAheadMatch(fruit, 0, "", 0, "C", 0).index).toBe(-1);
  });

  test("labels in other scripts match by their first character", () => {
    const zh = [opt("华东"), opt("华北"), opt("华南")];
    const first = reduceKey(closedState(), "华", ctx(-1, zh, 0));
    expect(first.commit).toBe(0);
    expect(reduceKey(first.state, "华", ctx(0, zh, 10)).commit).toBe(1);
  });

  test("on an open menu, a letter moves the highlight without choosing", () => {
    const result = reduceKey(openAt(0), "d", ctx(0));
    expect(result.state.open).toBe(true);
    expect(result.state.active).toBe(3);
    expect(result.commit).toBeNull();
  });

  test("Space inside a search types a space rather than choosing", () => {
    const typing = reduceKey(openAt(0), "b", ctx(0, fruit, 0)).state;
    const result = reduceKey(typing, " ", ctx(0, fruit, 100));
    expect(result.commit).toBeNull();
    expect(result.state.open).toBe(true);
  });

  test("typeAheadMatch reports the new buffer and its time, and wraps the search", () => {
    const found = typeAheadMatch(fruit, 4, "", 0, "a", 900);
    expect(found).toEqual({ typed: "a", typedAt: 900, index: 0 });
  });
});

describe("keeping an open menu in sync", () => {
  test("it closes when every option is gone", () => {
    expect(syncState(openAt(1), { options: [], selected: -1 })).toEqual(closedState());
  });

  test("it moves the highlight off an option that has become disabled", () => {
    const state = { open: true, active: 1, typed: "", typedAt: 0 };
    const disabled = [opt("Apple", true), opt("Banana", true), opt("Cherry")];
    expect(syncState(state, { options: disabled, selected: 0 }).active).toBe(2);
  });

  test("it keeps a highlight that is still a valid enabled option", () => {
    const state = { open: true, active: 3, typed: "", typedAt: 0 };
    expect(syncState(state, { options: fruit, selected: 0 })).toBe(state);
  });

  test("it leaves a closed menu alone", () => {
    const closed = closedState();
    expect(syncState(closed, { options: fruit, selected: 0 })).toBe(closed);
  });
});

describe("stepEnabled", () => {
  test("it walks over disabled options and stops at the ends", () => {
    expect(stepEnabled(fruit, 1, 1)).toBe(3);
    expect(stepEnabled(fruit, 4, 1)).toBe(4);
    expect(stepEnabled(fruit, 0, -1)).toBe(0);
  });

  test("from before the first option, moving up starts at the bottom", () => {
    expect(stepEnabled(fruit, -1, -1)).toBe(4);
    expect(stepEnabled(fruit, -1, 1)).toBe(0);
  });

  test("a count moves that many enabled options at most", () => {
    expect(stepEnabled(fruit, 0, 1, 2)).toBe(3);
    expect(stepEnabled(fruit, 0, 1, 99)).toBe(4);
  });
});
