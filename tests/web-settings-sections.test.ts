import { describe, expect, test } from "bun:test";

import en from "../web/js/i18n/en.js";
import zh from "../web/js/i18n/zh-CN.js";
import { SETTINGS_SECTIONS, sectionOf } from "../web/js/lib/settings-sections.js";

describe("settings categories", () => {
  test("each category has its own id, and the first one is the default", () => {
    const ids = SETTINGS_SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SETTINGS_SECTIONS[0]?.id).toBe("sessions");
  });

  test("a route names a category, and a missing or unknown one shows the default", () => {
    expect(sectionOf("secrets").id).toBe("secrets");
    expect(sectionOf(undefined).id).toBe("sessions");
    expect(sectionOf("").id).toBe("sessions");
    expect(sectionOf("nope").id).toBe("sessions");
  });

  test("each category's label is a translated title in both dictionaries", () => {
    for (const { label } of SETTINGS_SECTIONS) {
      expect([label, label in en, label in zh]).toEqual([label, true, true]);
      expect([label, zh[label] !== en[label]]).toEqual([label, true]);
    }
  });
});
