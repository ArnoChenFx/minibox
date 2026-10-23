import { describe, expect, test } from "bun:test";

import { isLong, LIST_LIMIT, pinFirst, shownItems } from "../web/js/lib/list-limit.js";

const ids = (items: readonly { id: number }[]) => items.map((item) => item.id);
const numbered = (count: number) => Array.from({ length: count }, (_, id) => ({ id }));

describe("the list limit", () => {
  test("a long list shows five items, and a list of five or fewer shows them all", () => {
    expect(LIST_LIMIT).toBe(5);
    expect(ids(shownItems(numbered(12)))).toEqual([0, 1, 2, 3, 4]);
    expect(ids(shownItems(numbered(5)))).toEqual([0, 1, 2, 3, 4]);
    expect(ids(shownItems(numbered(2)))).toEqual([0, 1]);
  });

  test("an expanded list shows every item", () => {
    expect(shownItems(numbered(12), { expanded: true })).toHaveLength(12);
  });

  test("an item that `keep` marks stays visible past the limit, in its place in the list", () => {
    const shown = shownItems(numbered(12), { keep: (item) => item.id === 9 || item.id === 7 });
    expect(ids(shown)).toEqual([0, 1, 2, 3, 4, 7, 9]);
  });

  test("the limit can be set by the caller", () => {
    expect(ids(shownItems(numbered(6), { limit: 2 }))).toEqual([0, 1]);
  });

  test("a list is long when it has more items than the limit", () => {
    expect([isLong(5), isLong(6), isLong(0)]).toEqual([false, true, false]);
    expect(isLong(3, 2)).toBe(true);
  });

  test("pinned items come first, and the others keep their order", () => {
    const pinned = pinFirst(numbered(6), (item) => item.id === 4);
    expect(ids(pinned)).toEqual([4, 0, 1, 2, 3, 5]);
    expect(ids(pinFirst(numbered(3), () => false))).toEqual([0, 1, 2]);
  });

  test("a pinned item is always among the first rows, so the current session stays in view", () => {
    const sessions = Array.from({ length: 9 }, (_, index) => ({ id: index, current: index === 8 }));
    const shown = shownItems(pinFirst(sessions, (session) => session.current));
    expect(shown[0]?.current).toBe(true);
    expect(shown).toHaveLength(LIST_LIMIT);
  });
});
