import { describe, expect, test } from "bun:test";

import en from "../web/js/i18n/en.js";
import zh from "../web/js/i18n/zh-CN.js";

/**
 * The storage checkpoints table's phone layout is measured in `web-storage-checkpoints-browser.test.ts`: the row is a
 * grid of named areas, each field takes its own area, the contents line is the one field that labels itself, and an empty
 * contents line is left out. What is left here is the word that label shows in each language.
 */
describe("the storage checkpoints table's contents label", () => {
  test("both languages name the column, so the phone card has a word for it", () => {
    expect(en["ck.colContents"]).toBe("Contents");
    expect(zh["ck.colContents"]).toBe("内容");
  });
});
