import { describe, expect, test } from "bun:test";

import en from "../web/js/i18n/en.js";
import zh from "../web/js/i18n/zh-CN.js";

/**
 * The volumes table's phone layout is measured in `web-volumes-browser.test.ts`: the row is a grid of named areas, each
 * field takes its own area, an empty field is left out, a volume over its limit marks its card, and a loading skeleton is
 * one line. What is left here is the wording those cards lean on: the short select-all label the phone header draws, which
 * has to stay a word beside the long accessible name the box keeps.
 */
describe("the select-all label on a phone", () => {
  test("both languages name the header box in a word, beside the long name the box's aria-label keeps", () => {
    for (const [lang, dictionary] of [
      ["en", en],
      ["zh-CN", zh],
    ] as const) {
      const short = dictionary["vol.selectAllShort"] ?? "";
      expect([lang, short.length > 0]).toEqual([lang, true]);
      // A phone header draws it in one line, so it carries no placeholder to fill in.
      expect([lang, short.includes("{")]).toEqual([lang, false]);
      expect([lang, dictionary["vol.selectAll"]!.length > short.length]).toEqual([lang, true]);
    }
    expect(en["vol.selectAllShort"]).toBe("Select all");
    expect(zh["vol.selectAllShort"]).toBe("全选");
  });
});
