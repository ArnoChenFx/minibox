import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { chosenSummary, loadFolded, saveFolded } from "../web/js/lib/section-fold.js";

const store = new Map<string, string>();
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
});

afterEach(() => store.clear());
afterAll(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("create dialog sections", () => {
  test("a folded section is saved and the others are kept", () => {
    expect([...loadFolded()]).toEqual([]);
    saveFolded("tools", true);
    saveFolded("templates", true);
    saveFolded("tools", false);
    expect([...loadFolded()]).toEqual(["templates"]);
  });

  test("a broken saved value reads as nothing folded", () => {
    store.set("minibox.createBox.folded", "{oops");
    expect(loadFolded().size).toBe(0);
    store.set("minibox.createBox.folded", JSON.stringify({ tools: true }));
    expect(loadFolded().size).toBe(0);
  });

  test("the summary counts every chosen item and names the first three", () => {
    expect(chosenSummary([])).toEqual({ count: 0, names: "" });
    expect(chosenSummary(["a", "b"])).toEqual({ count: 2, names: "a, b" });
    expect(chosenSummary(["a", "b", "c", "d"])).toEqual({ count: 4, names: "a, b, c, …" });
  });
});
